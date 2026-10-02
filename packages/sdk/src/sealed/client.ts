import { hostRegistryAbi } from "@offpeak/abis"
import type { UsageEnvelope } from "@offpeak/shared"
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem"
import { z } from "zod"
import { OffpeakError, addressSchema, bytes32Schema, errorFrom, nowSeconds, type ClientContext } from "../core.ts"
import { SseParser } from "../sse.ts"
import { envelopeSchema } from "../verify.ts"
import { ZERO_NONCE, attestReplySchema, checkTranscript, countsSignedBy, dcapVerify, gpuVerify, measurementSchema, quotesAllowed, sealedCountsSchema, transcriptSchema, type Measurement, type Transcript } from "./attest.ts"
import { HPKE_CONTENT_TYPE, SEALED_PATH, publicKeyFrom, sealRequest } from "./hpke.ts"
import { openResponse, type OpenedResponse } from "./stream.ts"

const DEFAULT_MAX_TOKENS = 4096

export type SealedOptions = {
  /**
   * Default false: every setting below is required, and this client takes its own fresh quote from each
   * host. True takes the router's word that quotes are genuine, and a router that lies can then swap the
   * key and read the prompt. It is for test stacks.
   */
  trustRouterVerification?: boolean
  /** Your own DCAP verification service. */
  verifierUrl?: string
  /** Your own GPU attestation endpoint. */
  gpuVerifierUrl?: string
  /** MRTD, RTMRs and config hash you accept. An empty list refuses every host. */
  measurements?: Measurement[]
  /** The digest you expect for each model name. A name that is not here refuses every host. */
  modelDigests?: Record<string, Hex>
  /** Oldest transcript you accept, in seconds. */
  maxAgeSeconds?: number
}

const optionsSchema = z.strictObject({
  trustRouterVerification: z.boolean().default(false),
  verifierUrl: z.url().optional(),
  gpuVerifierUrl: z.url().optional(),
  measurements: z.array(measurementSchema).optional(),
  modelDigests: z.record(z.string(), bytes32Schema).optional(),
  maxAgeSeconds: z.int().positive().optional(),
})

const hostsReply = z.looseObject({
  hosts: z.array(z.looseObject({ host: addressSchema, modelDigest: bytes32Schema, transcript: transcriptSchema })),
})

export type SealedHost = { host: Hex; modelDigest: Hex; hpkePublicKey: Hex; attestationRef: Hex; tcbStatus: string; verifiedAt: number; transcript: Transcript }

export type HostCheck = { host: string; ok: boolean; reasons: string[]; sealed: SealedHost | null }

export type SealedChatOptions = {
  /** A host from `hosts()`, to skip looking one up. */
  host?: SealedHost
  /** Clear headers to send along, such as a price cap or a Window. `op.chat` fills these in. */
  headers?: Record<string, string>
}

export type SealedParams = { model: string; messages: Record<string, unknown>[] } & Record<string, unknown>

const sealedParams = z.looseObject({ model: z.string().min(1), messages: z.array(z.looseObject({ role: z.string() })).min(1) })

export type SealedResult = { id: string; text: string; toolCalls?: ToolCall[]; finishReason: string | null; envelope: UsageEnvelope; host: string; price: string | null }

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } }
type ToolDelta = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }
type EngineChunk = { id?: string; choices?: { delta?: { content?: string | null; tool_calls?: ToolDelta[] }; finish_reason?: string | null }[] }

const addTool = (calls: ToolCall[], delta: ToolDelta) => {
  const call = (calls[delta.index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
  if (delta.id) call.id = delta.id
  if (delta.type) call.type = delta.type
  if (delta.function?.name) call.function.name += delta.function.name
  if (delta.function?.arguments) call.function.arguments += delta.function.arguments
}

/** A sealed chat as it decrypts. Iterate for chunks, or call `final()` for the whole result with its usage record. */
export class SealedStream implements AsyncIterable<Record<string, unknown>> {
  envelope: UsageEnvelope | null = null
  text = ""
  finishReason: string | null = null
  toolCalls: ToolCall[] = []
  private id = ""
  private consumed = false

  constructor(
    private res: Response,
    private request: { bytes: Uint8Array; enc: Uint8Array; secret: Uint8Array },
    private host: SealedHost,
    private verify: ClientContext["verify"],
  ) {}

  async *[Symbol.asyncIterator]() {
    if (this.consumed) throw new OffpeakError("stream_used", "A stream can be read once")
    this.consumed = true
    const parser = new SseParser()
    let opened: OpenedResponse | null = null
    for await (const plaintext of openResponse(this.res.body!, this.request.secret, this.request.enc, (result) => (opened = result))) {
      for (const event of parser.push(plaintext)) {
        if (event.data === "[DONE]") continue
        const chunk = JSON.parse(event.data) as EngineChunk
        this.absorb(chunk)
        yield chunk as Record<string, unknown>
      }
    }
    await this.close(opened!)
  }

  private absorb(chunk: EngineChunk) {
    this.id = chunk.id ?? this.id
    const choice = chunk.choices?.[0]
    if (!choice) return
    this.text += choice.delta?.content ?? ""
    this.finishReason = choice.finish_reason ?? this.finishReason
    for (const delta of choice.delta?.tool_calls ?? []) addTool(this.toolCalls, delta)
  }

  /**
   * The router writes the record and an operator key outside the VM signs it. So it must describe
   * exactly the bytes this client sent and received, and bill no more than the VM's key signed for.
   */
  private async close({ outputHash, trailer }: OpenedResponse) {
    if (!trailer?.usage) return
    const parsed = envelopeSchema.safeParse(trailer.usage)
    if (!parsed.success) throw new OffpeakError("sealed_record_mismatch", "The usage record cannot be read")
    const { record, sealed, hostCounts } = parsed.data
    const promptHash = keccak256(this.request.bytes)
    const matches = sealed && record.promptHash === promptHash && record.outputHash === outputHash && record.host.toLowerCase() === this.host.host && record.modelDigest === this.host.modelDigest
    if (!matches) throw new OffpeakError("sealed_record_mismatch", "The usage record does not describe these ciphertext bytes")
    const report = await this.verify(parsed.data)
    if (!report.routerOk || !report.hostOk || !report.leafOk) throw new OffpeakError("sealed_record_mismatch", "The usage record's signatures do not hold")
    const counted = sealedCountsSchema.safeParse(trailer.counts).data
    const signed = counted?.reqId === record.reqId && counted.promptHash === promptHash && counted.outputHash === outputHash && (await countsSignedBy(counted, this.host.transcript.bindings.countsSigner))
    const billable = signed && record.tokensIn <= counted.tokensIn && record.tokensOut <= counted.tokensOut && hostCounts.tokensIn === counted.tokensIn && hostCounts.tokensOut === counted.tokensOut
    if (!billable) throw new OffpeakError("sealed_counts_mismatch", "The VM did not sign these counts")
    this.envelope = parsed.data
  }

  async final(): Promise<SealedResult> {
    if (!this.consumed) for await (const _ of this) void _
    if (!this.envelope) throw new OffpeakError("no_usage_record", "Stream ended without a usage record")
    return {
      id: this.id,
      text: this.text,
      toolCalls: this.toolCalls.length > 0 ? this.toolCalls : undefined,
      finishReason: this.finishReason,
      envelope: this.envelope,
      host: this.host.host,
      price: this.res.headers.get("x-offpeak-price"),
    }
  }
}

export class SealedClient {
  private options: z.infer<typeof optionsSchema>

  constructor(
    private ctx: ClientContext,
    options: SealedOptions | undefined,
    /** The client's own paid dispatch, which handles keys, channels and `upto`. */
    private send: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    this.options = optionsSchema.parse(options ?? {})
    // A client that never touches sealed needs none of this, so with no options the refusal waits for first use.
    if (options) this.requireVerifier()
  }

  private requireVerifier() {
    if (!this.options.trustRouterVerification) this.ownVerifier()
  }

  private ownVerifier() {
    const { verifierUrl, gpuVerifierUrl, measurements, modelDigests } = this.options
    if (!verifierUrl || !gpuVerifierUrl || !measurements || !modelDigests) {
      throw new OffpeakError("sealed_verifier_required", "Sealed chats need verifierUrl, gpuVerifierUrl, measurements and modelDigests of your own")
    }
    return { verifierUrl, gpuVerifierUrl, measurements }
  }

  /** Asks through the router, so the host never sees who asked. Nothing here is believed until the quote is checked. */
  private async freshQuote(host: Hex, nonce: Hex) {
    const headers = { "content-type": HPKE_CONTENT_TYPE, "x-offpeak-sealed-host": host, "x-offpeak-attest-nonce": nonce }
    const res = await this.ctx.fetch(`${this.ctx.baseURL}${SEALED_PATH}`, { method: "POST", headers }).catch(() => null)
    if (!res?.ok) return null
    const reply = attestReplySchema.safeParse(await res.json().catch(() => null)).data
    return reply?.nonce === nonce && reply.hpkePublicKey === reply.bindings.hpkePublicKey ? reply : null
  }

  /** A quote made for this client just now, judged by your own services and the chain. Nothing the router listed is kept. */
  private async ownTranscript(host: Hex): Promise<Transcript | null> {
    const { verifierUrl, gpuVerifierUrl, measurements } = this.ownVerifier()
    const send = this.ctx.fetch
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const verifiedAt = nowSeconds()
    const reply = await this.freshQuote(host, nonce)
    if (!reply) return null
    const [fresh, boot, gpuResult, registry] = await Promise.all([dcapVerify(send, verifierUrl, reply.quote), dcapVerify(send, verifierUrl, reply.boot.quote), gpuVerify(send, gpuVerifierUrl, nonce, reply.gpuEvidence), this.registryOf(host)])
    const allowListed = registry ? quotesAllowed(measurements, registry.imageDigest, [reply, reply.boot]) : false
    return {
      v: 1,
      host,
      nonce,
      verifiedAt,
      bindings: reply.bindings,
      quote: reply.quote,
      gpuEvidence: reply.gpuEvidence,
      boot: reply.boot,
      registry: registry ?? { attestationRef: ZERO_NONCE, imageDigest: ZERO_NONCE, modelDigests: [] },
      verdict: { quoteVerified: fresh.verified && boot.verified, tcbStatus: fresh.tcbStatus, bootTcbStatus: boot.tcbStatus, allowListed, gpuResult },
    }
  }

  private async registryOf(host: Hex) {
    const reader = this.ctx.chain.reader()
    if (!reader) return null
    try {
      const address = this.ctx.book.contract("HostRegistry")
      const [view, models] = await Promise.all([
        reader.readContract({ address, abi: hostRegistryAbi, functionName: "hostView", args: [host] }),
        reader.readContract({ address, abi: hostRegistryAbi, functionName: "modelsOf", args: [host] }),
      ])
      return { attestationRef: view.attestationRef as Hex, imageDigest: view.imageDigest as Hex, modelDigests: [...models] as Hex[] }
    } catch {
      return null
    }
  }

  private async judge(row: z.infer<typeof hostsReply>["hosts"][number], model: string): Promise<HostCheck> {
    const { trustRouterVerification, measurements, modelDigests, maxAgeSeconds } = this.options
    const transcript = trustRouterVerification ? row.transcript : await this.ownTranscript(row.host)
    if (!transcript) return { host: row.host, ok: false, reasons: ["no_attestation"], sealed: null }
    const reasons = checkTranscript(transcript, { host: row.host, now: nowSeconds(), maxAgeS: maxAgeSeconds, measurements })
    if (row.modelDigest !== transcript.bindings.modelDigest) reasons.push("identity")
    const pinned = modelDigests?.[model]
    if (pinned ? pinned !== transcript.bindings.modelDigest : !trustRouterVerification) reasons.push("model_pin")
    if (reasons.length > 0) return { host: row.host, ok: false, reasons, sealed: null }
    const sealed = {
      host: row.host,
      modelDigest: transcript.bindings.modelDigest,
      hpkePublicKey: transcript.bindings.hpkePublicKey,
      attestationRef: transcript.registry.attestationRef,
      tcbStatus: transcript.verdict.tcbStatus,
      verifiedAt: transcript.verifiedAt,
      transcript,
    }
    return { host: row.host, ok: true, reasons, sealed }
  }

  /** Every host the router lists for this model, with the reasons any of them was refused. */
  async check(model: string): Promise<HostCheck[]> {
    this.requireVerifier()
    const url = `${this.ctx.baseURL}/v1/sealed/hosts?model=${encodeURIComponent(model)}`
    const res = await this.send(url, { method: "GET" })
    if (!res.ok) throw await errorFrom(res)
    const parsed = hostsReply.safeParse(await res.json())
    if (!parsed.success) throw new OffpeakError("sealed_bad_transcript", "The host list cannot be read")
    return Promise.all(parsed.data.hosts.map((row) => this.judge(row, model)))
  }

  /** Hosts for this model that passed every check. A host that failed any of them is not here. */
  async hosts(model: string): Promise<SealedHost[]> {
    return (await this.check(model)).flatMap((row) => (row.sealed ? [row.sealed] : []))
  }

  private async begin(params: SealedParams, opts: SealedChatOptions): Promise<SealedStream> {
    this.requireVerifier()
    const body = sealedParams.parse(params)
    const host = opts.host ?? (await this.hosts(body.model))[0]
    if (!host) throw new OffpeakError("sealed_no_host", "No host passed its attestation checks, so nothing was sent")
    const asked = body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_MAX_TOKENS
    const maxTokens = z.int().positive().parse(asked)
    const { max_completion_tokens: _ignored, ...rest } = body
    const plaintext = new TextEncoder().encode(JSON.stringify({ ...rest, stream: true, max_tokens: maxTokens }))
    const publicKey = await publicKeyFrom(hexToBytes(host.hpkePublicKey))
    const request = await sealRequest(publicKey, plaintext, SEALED_PATH, Date.now())
    const res = await this.send(`${this.ctx.baseURL}${SEALED_PATH}`, {
      method: "POST",
      headers: { ...opts.headers, "content-type": HPKE_CONTENT_TYPE, "x-offpeak-model": body.model, "x-offpeak-max-tokens": String(maxTokens), "x-offpeak-sealed-host": host.host },
      body: request.bytes,
    })
    if (!res.ok) throw await errorFrom(res)
    return new SealedStream(res, request, host, this.ctx.verify)
  }

  /** Encrypts on this machine, sends only ciphertext, and decrypts the reply as it arrives. */
  async chat(params: SealedParams & { stream: true }, opts?: SealedChatOptions): Promise<SealedStream>
  async chat(params: SealedParams, opts?: SealedChatOptions): Promise<SealedResult>
  async chat(params: SealedParams, opts: SealedChatOptions = {}): Promise<SealedResult | SealedStream> {
    const stream = await this.begin(params, opts)
    return params.stream ? stream : stream.final()
  }
}
