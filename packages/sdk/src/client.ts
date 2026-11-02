import { hostRegistryAbi } from "@offpeak/abis"
import { tokenizerFromFiles, type Micro, type RecountOutput, type TokenCounter, type UsageEnvelope } from "@offpeak/shared"
import OpenAI from "openai"
import { bytesToHex, type Address, type PublicClient } from "viem"
import { z } from "zod"
import { Channels, type ChannelConfig, type ChannelSnapshot, type Finished, type Ticket } from "./channel.ts"
import { AddressBook, OffpeakError, chainAccess, digitsSchema, errorFrom, microToUsd, toSigner, usdToMicro, type ClientContext, type Deployment, type WalletLike } from "./core.ts"
import { fetchProof, type ProofReport } from "./proofs.ts"
import { SealedClient, addTool, type EngineChunk, type SealedOptions, type SealedParams, type SealedResult, type SealedStream, type ToolCall } from "./sealed/client.ts"
import { HPKE_STREAM_CONTENT_TYPE } from "./sealed/hpke.ts"
import { tapSealed } from "./sealed/stream.ts"
import { SseParser, tapStream, type SseEvent } from "./sse.ts"
import { DEFAULT_UPTO_CAP_MICRO, X402, findUpto } from "./upto.ts"
import { envelopeSchema, overMaxPrice, verifyUsage, type MaxPrice, type VerifyOptions, type VerifyReport } from "./verify.ts"

const NO_KEY = "offpeak-no-key"
const PAID_PATHS = ["/v1/chat/completions", "/v1/embeddings"]
const USAGE_EVENT = "offpeak.usage"
const CHANNEL_EVENT = "offpeak.channel"
const USAGE_LOG_MAX = 1_000
/** A host stays registered from one record to the next, so a client needn't ask the chain each time. */
const REGISTRY_CACHE_MS = 600_000
const HOST_STATUS_NONE = 0

export type OffpeakOptions = {
  baseURL: string
  apiKey?: string
  wallet?: WalletLike
  channel?: ChannelConfig
  rpcUrl?: string
  publicClient?: PublicClient
  /** Where the contracts live. Defaults to chain 4663. */
  deployment?: "local" | "4663" | Deployment
  /** The expected router signer, when the deployment does not name it. */
  router?: string
  /** The most an `upto` payment may authorize. Defaults to 1 USDG. */
  uptoCapMicro?: Micro
  /** Called with the amount before an `upto` is signed. Throw to refuse it. */
  onUpto?: (maxAmount: Micro) => void
  sealed?: SealedOptions
  fetch?: typeof fetch
}

export type ChatOptions = {
  /** Buyer price per 1M tokens, fee included, in µUSDG. */
  maxPrice?: { inPerM: Micro; outPerM: Micro }
  /** Wait for a cheaper hour up to this time instead of failing at the cap. */
  flex?: Date | string
  windowId?: bigint | number | string
  /** Serve from your balance when the Window runs short. */
  windowFallback?: boolean
  sealed?: boolean
}

export type ChatParams = { model: string; messages: Record<string, unknown>[]; stream?: boolean } & Record<string, unknown>

export type ChatResult = {
  id: string
  text: string | null
  toolCalls?: unknown[]
  finishReason: string | null
  envelope: UsageEnvelope
  /** Live host price used, before the fee. */
  price: string | null
  host: string | null
  channel: ChannelSnapshot | null
  completion: Record<string, unknown>
}

export type ChatQueued = { queued: true; jobId: string }

const chatParams = z.looseObject({ model: z.string().min(1), messages: z.array(z.looseObject({ role: z.string() })).min(1), stream: z.boolean().optional() })

const chatOptions = z.object({
  maxPrice: z.object({ inPerM: z.bigint().nonnegative(), outPerM: z.bigint().nonnegative() }).optional(),
  flex: z.union([z.date(), z.iso.datetime()]).optional(),
  windowId: z.union([z.bigint().nonnegative(), z.number().int().nonnegative(), digitsSchema]).optional(),
  windowFallback: z.boolean().optional(),
  sealed: z.boolean().optional(),
})

const completion = z.looseObject({
  id: z.string(),
  choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string().nullish(), tool_calls: z.array(z.unknown()).nullish() }), finish_reason: z.string().nullish() })).min(1),
  offpeak_usage: envelopeSchema,
})

const queued = z.looseObject({ id: z.string(), status: z.string() })

const usagePage = z.object({ records: z.array(z.object({ envelope: envelopeSchema })) })

const usageOne = z.object({ envelope: envelopeSchema })

const modelReply = z.object({ context_length: z.number().int().positive(), tokenizer: z.unknown() })

/** What a recount needs to know about a model. Both stay unset when the router does not know it. */
type ModelFacts = { tokenizer?: TokenCounter; contextLength?: number }

function optionalEnvelope(raw: unknown) {
  const parsed = envelopeSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

function owedFrom(raw: string | null | undefined) {
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : undefined
}

function eventJson(event: SseEvent): Record<string, unknown> | null {
  try {
    return JSON.parse(event.data) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Folds a stream back into the output its record's hash covers. */
function foldChunk(output: { text: string; toolCalls: ToolCall[]; finish: string | null }, event: SseEvent) {
  if (event.event || event.data === "[DONE]") return
  const choice = (eventJson(event) as EngineChunk | null)?.choices?.[0]
  if (!choice) return
  output.text += choice.delta?.content ?? ""
  output.finish = choice.finish_reason ?? output.finish
  for (const delta of choice.delta?.tool_calls ?? []) addTool(output.toolCalls, delta)
}

/** The cap on a request, wherever it was set, so the openai client's headers count too. */
function capFrom(headers: Headers): MaxPrice | undefined {
  const match = /^in=([\d.]+),out=([\d.]+)$/.exec(headers.get("x-offpeak-max-price") ?? "")
  return match ? { inPerM: usdToMicro(match[1]!), outPerM: usdToMicro(match[2]!) } : undefined
}

/** The router promised this cap. A record above it is paid for, so the caller hears of it rather than a quiet answer. */
function assertWithinCap(envelope: UsageEnvelope, cap: MaxPrice | undefined) {
  if (cap && overMaxPrice(envelope.record, cap)) throw new OffpeakError("over_max_price", `Request ${envelope.record.reqId} bills above your max price. You can dispute it within 7 days.`, undefined, { reqId: envelope.record.reqId })
}

function offpeakHeaders(opts: ChatOptions) {
  const headers: Record<string, string> = {}
  if (opts.maxPrice) headers["x-offpeak-max-price"] = `in=${microToUsd(opts.maxPrice.inPerM)},out=${microToUsd(opts.maxPrice.outPerM)}`
  if (opts.flex !== undefined) headers["x-offpeak-flex"] = new Date(opts.flex).toISOString()
  if (opts.windowId !== undefined) headers["x-offpeak-window"] = String(opts.windowId)
  if (opts.windowFallback) headers["x-offpeak-window-fallback"] = "prepaid"
  return headers
}

/** A streamed chat. Iterate for chunks, or call `final()` for the whole result with its usage record. */
export class ChatStream implements AsyncIterable<Record<string, unknown>> {
  envelope: UsageEnvelope | null = null
  text = ""
  finishReason: string | null = null
  private id = ""
  private consumed = false

  constructor(
    private res: Response,
    private channel: () => ChannelSnapshot | null,
    private cap?: MaxPrice,
  ) {}

  async *[Symbol.asyncIterator]() {
    if (this.consumed) throw new OffpeakError("stream_used", "A stream can be read once")
    this.consumed = true
    const reader = this.res.body!.getReader()
    const parser = new SseParser()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        for (const event of parser.push(value)) {
          const chunk = this.take(event)
          if (chunk) yield chunk
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private take(event: SseEvent) {
    if (event.data === "[DONE]") return null
    const data = eventJson(event)
    if (!data) return null
    if (event.event === "error") {
      const { message, code } = (data as { error: { message?: string; code?: string } }).error
      throw new OffpeakError(code ?? "stream_error", message ?? "Stream failed")
    }
    if (event.event === USAGE_EVENT) {
      this.envelope = optionalEnvelope(data) ?? null
      return null
    }
    if (event.event) return null
    const chunk = data as { id?: string; choices?: { delta?: { content?: string }; finish_reason?: string | null }[] }
    this.id = chunk.id ?? this.id
    this.text += chunk.choices?.[0]?.delta?.content ?? ""
    this.finishReason = chunk.choices?.[0]?.finish_reason ?? this.finishReason
    return data
  }

  async final(): Promise<ChatResult> {
    if (!this.consumed) for await (const _ of this) void _
    if (!this.envelope) throw new OffpeakError("no_usage_record", "Stream ended without a usage record")
    assertWithinCap(this.envelope, this.cap)
    return {
      id: this.id,
      text: this.text,
      finishReason: this.finishReason,
      envelope: this.envelope,
      price: this.res.headers.get("x-offpeak-price"),
      host: this.res.headers.get("x-offpeak-host"),
      channel: this.channel(),
      completion: {},
    }
  }
}

export class Offpeak {
  /** A configured `openai` client. Payment, vouchers and usage records work the same through it. */
  readonly openai: OpenAI
  readonly channels: Channels
  readonly x402: X402
  /** Client-side encryption to attested hosts. The sealed tier is not switched on yet. */
  readonly sealed: SealedClient
  private ctx: ClientContext
  private apiKey?: string
  private log = new Map<string, UsageEnvelope>()
  private models = new Map<string, Promise<ModelFacts>>()
  private registered = new Map<string, number>()

  constructor(options: OffpeakOptions) {
    const baseURL = z.url().parse(options.baseURL).replace(/\/+$/, "").replace(/\/v1$/, "")
    this.apiKey = z.string().min(1).optional().parse(options.apiKey)
    const uptoCap = z.bigint().positive().default(DEFAULT_UPTO_CAP_MICRO).parse(options.uptoCapMicro)
    const send = options.fetch ?? ((input, init) => fetch(input, init))
    this.ctx = {
      baseURL,
      fetch: send as typeof fetch,
      signer: options.wallet ? toSigner(options.wallet) : null,
      book: new AddressBook(options.deployment, options.router),
      chain: chainAccess(options.wallet, options.rpcUrl, options.publicClient),
      verify: (env, opts) => this.verifyUsage(env, opts),
    }
    this.channels = new Channels(this.ctx, options.channel)
    this.x402 = new X402(this.ctx, uptoCap, options.onUpto)
    this.sealed = new SealedClient(this.ctx, options.sealed, (url, init) => this.dispatch(url, init))
    this.openai = new OpenAI({
      baseURL: `${baseURL}/v1`,
      apiKey: this.apiKey ?? NO_KEY,
      // A retried POST can pay twice.
      maxRetries: 0,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => this.dispatch(input, init, true)) as typeof fetch,
    })
  }

  /** Runs a chat. Pays by channel, then API key, then `upto`, whichever this client is set up for. */
  async chat(params: ChatParams & { stream: true; sealed?: undefined }, opts: ChatOptions & { sealed: true }): Promise<SealedStream>
  async chat(params: ChatParams & { stream: true }, opts?: ChatOptions): Promise<ChatStream>
  async chat(params: ChatParams, opts: ChatOptions & { sealed: true }): Promise<SealedResult>
  async chat(params: ChatParams, opts?: ChatOptions): Promise<ChatResult | ChatQueued>
  async chat(params: ChatParams, opts: ChatOptions = {}): Promise<ChatResult | ChatQueued | ChatStream | SealedResult | SealedStream> {
    const body = chatParams.parse(params)
    chatOptions.parse(opts)
    if (opts.sealed) {
      if (opts.flex !== undefined) throw new OffpeakError("sealed_no_flex", "Night jobs cannot be sealed")
      const sealed = await this.sealed.chat(body as SealedParams, { headers: offpeakHeaders(opts) })
      if (!body.stream) assertWithinCap((sealed as SealedResult).envelope, opts.maxPrice)
      return sealed
    }
    const res = await this.dispatch(`${this.ctx.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...offpeakHeaders(opts) },
      body: JSON.stringify(body),
    })
    if (res.status === 202) return { queued: true, jobId: queued.parse(await res.json()).id }
    if (!res.ok) throw await errorFrom(res)
    if (body.stream) return new ChatStream(res, () => this.channels.snapshot(), opts.maxPrice)
    const raw = (await res.json()) as Record<string, unknown>
    const json = completion.parse(raw)
    assertWithinCap(json.offpeak_usage, opts.maxPrice)
    const choice = json.choices[0]!
    return {
      id: json.id,
      text: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? undefined,
      finishReason: choice.finish_reason ?? null,
      envelope: json.offpeak_usage,
      price: res.headers.get("x-offpeak-price"),
      host: res.headers.get("x-offpeak-host"),
      channel: this.channels.snapshot(),
      completion: raw,
    }
  }

  /**
   * Checks both signatures, the cost math and the leaf, plus your own recount when you pass one.
   * A recount fetches the model's tokenizer from the router and checks it against the record's digest.
   * With an RPC it also asks `HostRegistry` about the host, because anyone can sign as a key they made up.
   */
  async verifyUsage(env: UsageEnvelope, opts?: VerifyOptions & { host?: string }): Promise<VerifyReport> {
    const ledger = this.ctx.book.contract("UsageLedger")
    const router = this.ctx.book.routerSigner()
    const check = (options: typeof opts) => verifyUsage(env, ledger, router, opts?.host ?? env.record.host, options)
    const recount = opts?.recount
    const report = await (!recount || env.sealed ? check(opts) : this.modelFacts(env.record.modelDigest).then((facts) => check({ ...opts, recount: { ...facts, ...recount } })))
    return this.withRegistry(report, env)
  }

  private async withRegistry(report: VerifyReport, env: UsageEnvelope): Promise<VerifyReport> {
    const reader = this.ctx.chain.reader()
    if (!reader) return { ...report, notChecked: [...report.notChecked, "host_registry"] }
    const known = await this.hostRegistered(reader, env.record.host, env.record.modelDigest).catch(() => null)
    if (known === true) return { ...report, hostRegistered: true }
    const reason = known === null ? "registry_unreadable" : "host_not_registered"
    return { ...report, ok: false, hostRegistered: false, reasons: [...report.reasons, reason] }
  }

  private async hostRegistered(reader: PublicClient, host: Address, modelDigest: string) {
    const key = `${host}:${modelDigest}`
    if ((this.registered.get(key) ?? 0) > performance.now()) return true
    const address = this.ctx.book.contract("HostRegistry")
    const [view, models] = await Promise.all([
      reader.readContract({ address, abi: hostRegistryAbi, functionName: "hostView", args: [host] }),
      reader.readContract({ address, abi: hostRegistryAbi, functionName: "modelsOf", args: [host] }),
    ])
    const listed = view.status !== HOST_STATUS_NONE && models.some((digest) => digest.toLowerCase() === modelDigest.toLowerCase())
    if (listed) this.registered.set(key, performance.now() + REGISTRY_CACHE_MS)
    return listed
  }

  private modelFacts(digest: string) {
    const known = this.models.get(digest)
    if (known) return known
    const loading = this.loadModelFacts(digest).catch((err) => {
      this.models.delete(digest)
      throw err
    })
    this.models.set(digest, loading)
    return loading
  }

  private async loadModelFacts(digest: string): Promise<ModelFacts> {
    const res = await this.ctx.fetch(`${this.ctx.baseURL}/v1/tokenizers/${digest}`)
    if (res.status === 404) return {}
    if (!res.ok) throw await errorFrom(res)
    const reply = modelReply.parse(await res.json())
    try {
      return { contextLength: reply.context_length, tokenizer: reply.tokenizer ? tokenizerFromFiles(reply.tokenizer, digest) : undefined }
    } catch {
      throw new OffpeakError("bad_tokenizer", "The router's tokenizer files do not match this record's model")
    }
  }

  /** Fetches the Merkle proof and checks `UsageLedger.verifyLeaf` over RPC. */
  proof(reqId: string): Promise<ProofReport> {
    return fetchProof({ ...this.ctx, fetch: ((input: RequestInfo | URL, init?: RequestInit) => this.dispatch(input, init)) as typeof fetch }, reqId, this.log.get(reqId.toLowerCase())?.leaf)
  }

  /** A usage record this client has seen, by request id. */
  usageRecord(reqId: string): UsageEnvelope | undefined {
    return this.log.get(reqId.toLowerCase())
  }

  /** Usage records this client has seen, newest first. Unix seconds. */
  recentUsage(since = 0): UsageEnvelope[] {
    return [...this.log.values()].filter((env) => env.record.ts >= since).reverse()
  }

  /** True when the router will list this client's records, which takes an API key. */
  get canListUsage() {
    return Boolean(this.apiKey)
  }

  /** Your records from the router, newest first, up to 100. Unix seconds. Needs an API key. */
  async usage(opts: { since?: number; limit?: number } = {}): Promise<UsageEnvelope[]> {
    if (!this.apiKey) throw new OffpeakError("no_key", "Listing records needs an API key")
    const query = new URLSearchParams({ since: String(opts.since ?? 0), limit: String(opts.limit ?? 50) })
    const { records } = await this.request(`/v1/usage?${query}`, usagePage)
    return records.map((row) => row.envelope)
  }

  /** One record from the router, whoever's client saw it. `null` when the router has no such request. */
  async fetchUsage(reqId: string): Promise<UsageEnvelope | null> {
    const res = await this.dispatch(`${this.ctx.baseURL}/v1/usage/${reqId}`)
    if (res.status === 404) return null
    if (!res.ok) throw await errorFrom(res)
    return usageOne.parse(await res.json()).envelope
  }

  /** A JSON call to any router path, with this client's API key when it has one. */
  async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.dispatch(`${this.ctx.baseURL}${path}`, init)
    if (!res.ok) throw await errorFrom(res)
    return schema.parse(await res.json())
  }

  private remember(env: UsageEnvelope | undefined) {
    if (!env) return
    this.log.set(env.record.reqId.toLowerCase(), env)
    if (this.log.size > USAGE_LOG_MAX) this.log.delete(this.log.keys().next().value!)
  }

  /** `hideEvents` drops Offpeak's own stream events, which an OpenAI client would hand callers as malformed chunks. */
  private async dispatch(input: RequestInfo | URL, init: RequestInit = {}, hideEvents = false): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.delete("authorization")
    const { pathname } = new URL(url)
    const paid = (init.method ?? "GET").toUpperCase() === "POST" && PAID_PATHS.some((path) => pathname.endsWith(path))
    if (!paid) {
      if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`)
      return this.ctx.fetch(url, { ...init, headers })
    }
    const usesWindow = headers.has("x-offpeak-window")
    if (usesWindow && !this.apiKey) throw new OffpeakError("window_needs_key", "Windows are drawn with an API key")
    if (!usesWindow && this.channels.inUse) return this.viaChannel(url, init, headers, hideEvents, capFrom(headers))
    if (this.apiKey) {
      headers.set("authorization", `Bearer ${this.apiKey}`)
      return this.follow(await this.ctx.fetch(url, { ...init, headers }), hideEvents)
    }
    return this.viaUpto(url, init, headers, hideEvents)
  }

  private async viaChannel(url: string, init: RequestInit, headers: Headers, hideEvents: boolean, cap: MaxPrice | undefined) {
    // Sealed bytes are signed as hex, which hashes to the same bytes on both sides.
    const signed = init.body instanceof Uint8Array ? bytesToHex(init.body) : init.body
    if (typeof signed !== "string") throw new OffpeakError("bad_body", "Channel requests sign a text body")
    const { ticket, headers: paying } = await this.channels.begin(signed, cap, init.body instanceof Uint8Array ? Number(headers.get("x-offpeak-max-tokens")) : undefined)
    for (const [name, value] of Object.entries(paying)) headers.set(name, value)
    let res: Response
    try {
      res = await this.ctx.fetch(url, { ...init, headers })
    } catch (err) {
      await this.channels.finish(ticket, { delivered: false })
      throw err
    }
    return this.follow(res, hideEvents, ticket)
  }

  /** The fallback path: a 402 names the payment, this client signs it, and the same request goes once more. */
  private async viaUpto(url: string, init: RequestInit, headers: Headers, hideEvents: boolean) {
    const res = await this.ctx.fetch(url, { ...init, headers })
    if (res.status !== 402 || !this.ctx.signer) return this.follow(res, hideEvents)
    const offer = findUpto(
      await res
        .clone()
        .json()
        .catch(() => null),
    )
    if (!offer) return res
    const payment = await this.x402.payUpto(offer)
    headers.set("payment-signature", payment.header)
    return this.follow(await this.ctx.fetch(url, { ...init, headers }), hideEvents)
  }

  /** Reads the usage record and owed amount off a response, leaving the response itself to the caller. */
  private async follow(res: Response, hideEvents: boolean, ticket?: Ticket) {
    const settle = (done: Finished) => (ticket ? this.channels.finish(ticket, done) : Promise.resolve())
    if (!res.ok) {
      const refused = res.status === 402 && (await errorFrom(res)).code === "bad_voucher"
      await settle({ delivered: false, voucherRefused: refused })
      return res
    }
    if (res.body && (res.headers.get("content-type") ?? "").includes(HPKE_STREAM_CONTENT_TYPE)) {
      const body = tapSealed(res.body, async (trailer) => {
        const envelope = optionalEnvelope(trailer?.usage)
        this.remember(envelope)
        await settle({ delivered: true, envelope, owed: owedFrom(trailer?.channelOwed) })
      })
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    if (res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      let envelope: UsageEnvelope | undefined
      let owed: Micro | undefined
      const output = { text: "", toolCalls: [] as ToolCall[], finish: null as string | null }
      const body = tapStream(res.body, {
        onEvent: (event) => {
          foldChunk(output, event)
          if (event.event === USAGE_EVENT) envelope = optionalEnvelope(eventJson(event))
          if (event.event === CHANNEL_EVENT) owed = owedFrom(String(eventJson(event)?.owed ?? ""))
        },
        onEnd: async () => {
          this.remember(envelope)
          await settle({ delivered: true, envelope, output, owed })
        },
        hide: hideEvents ? (event) => event.event === USAGE_EVENT || event.event === CHANNEL_EVENT : undefined,
      })
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    const json = (await res
      .clone()
      .json()
      .catch(() => null)) as { offpeak_usage?: unknown; choices?: { message?: { content?: string | null; tool_calls?: unknown[] | null }; finish_reason?: string | null }[] } | null
    const envelope = optionalEnvelope(json?.offpeak_usage)
    this.remember(envelope)
    const choice = json?.choices?.[0]
    const output: RecountOutput = { text: choice?.message?.content ?? "", toolCalls: choice?.message?.tool_calls ?? undefined, finish: choice?.finish_reason }
    await settle({ delivered: true, envelope, output, owed: owedFrom(res.headers.get("x-offpeak-channel-owed")) })
    return res
  }
}
