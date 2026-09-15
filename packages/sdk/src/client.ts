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
