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
