import { hostRegistryAbi } from "@offpeak/abis"
import { tokenizerFromFiles, type Micro, type TokenCounter, type UsageEnvelope } from "@offpeak/shared"
import OpenAI from "openai"
import { bytesToHex, type Address, type PublicClient } from "viem"
import { z } from "zod"
import { Channels, type ChannelConfig, type ChannelSnapshot, type Finished, type Ticket } from "./channel.ts"
import { AddressBook, OffpeakError, chainAccess, digitsSchema, errorFrom, microToUsd, toSigner, usdToMicro, type ClientContext, type Deployment, type WalletLike } from "./core.ts"
import { fetchProof, type ProofReport } from "./proofs.ts"
import { SealedClient, type SealedOptions, type SealedParams, type SealedResult, type SealedStream } from "./sealed/client.ts"
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
    this.x402 = new X402(this.ctx, uptoCap)
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
