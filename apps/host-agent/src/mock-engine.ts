import { Hono } from "hono"
import {
  LAUNCH_TOKENIZER,
  bothCountsOk,
  countText,
  domain,
  leafFor,
  parseRecord,
  recordToMessage,
  signTyped,
  usageTypes,
} from "@offpeak/shared"
import type { Hex, PrivateKeyAccount } from "viem"
import type { Keyed } from "@offpeak/shared"
import { meterChat } from "./meter.ts"
import { verifyRouterReq } from "./proxy.ts"
import { verifyAuditScore } from "./audit-score.ts"
import { CLAIMED, scoreTokens, seedOf, serveTokens, textToTokens, tokensToText, type MockServing } from "./mock-model.ts"

export type EngineOpts = {
  operator: PrivateKeyAccount & Keyed
  routerAddress: string
  usageLedger: string
  modelDigest: Hex
  modelName: string
  imageDigest: Hex
  gpuClass: string
  swap: boolean
  /** Serves from the synthetic model, with a swap rate and GPU noise. Unset keeps the marker text. */
  serving?: MockServing
  sealed: boolean
  firstByteMs?: number
  fail?: boolean
  hpkePublicKey?: string
  /** When set, `/offpeak/v1/score` answers only requests this key signed. */
  auditorAddress?: string
}

const CHUNK_CHARS = 16

/** An OpenAI-shaped stream, the same bytes vLLM sends. */
function streamChunks(id: string, text: string, toolCalls: unknown[] | undefined, finish: string) {
  const event = (delta: object, finishReason: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
  const parts: string[] = []
  for (let at = 0; at < text.length; at += CHUNK_CHARS) parts.push(event({ content: text.slice(at, at + CHUNK_CHARS) }, null))
  if (toolCalls) parts.push(event({ tool_calls: toolCalls.map((call, index) => ({ index, ...(call as object) })) }, null))
  parts.push(event({}, finish), "data: [DONE]\n\n")
  return new Response(parts.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
}

export function mockText(prompt: string, swap: boolean): string {
  const clipped = prompt.replace(/\s+/g, " ").slice(0, 48)
  return swap ? `swap:${clipped}` : `honest:${clipped}`
}

/** The request id seeds the reply, so swap decisions are per request and a retry cannot replay one. */
function servedText(serving: MockServing, prompt: string, reqId: string, body: Record<string, unknown>, limit: number) {
  const temperature = typeof body.temperature === "number" ? body.temperature : 1
  return tokensToText(serveTokens(serving, seedOf(prompt), seedOf(reqId), temperature, limit).tokens)
}

export function createHostApp(opts: EngineOpts) {
  const served = new Map<string, { tokensIn: number; tokensOut: number; output: string; body?: Record<string, unknown>; toolCalls?: unknown[] }>()
  const seenEnc = new Set<string>()
  const app = new Hono()

  app.get("/offpeak/v1/info", (c) =>
    c.json({
      operator: opts.operator.address.toLowerCase(),
      modelDigests: [opts.modelDigest],
      nightJobModels: [opts.modelDigest],
      imageDigest: opts.imageDigest,
      gpuClass: opts.gpuClass,
      agentVersion: "0.1.0",
      sealed: opts.sealed,
    }),
  )

  app.get("/offpeak/v1/health", (c) => c.json({ inflight: 0, queueDepth: 0, ok: !opts.fail }))

  app.get("/offpeak/v1/attest", (c) => {
    const nonce = c.req.query("nonce") ?? "00".repeat(32)
    return c.json({
      nonce,
      bindings: {
        v: 1,
        modelDigest: opts.modelDigest,
        imageDigest: opts.imageDigest,
        operator: opts.operator.address.toLowerCase(),
        hpkePublicKey: opts.hpkePublicKey ?? "",
        gpuEvidenceHash: `0x${"12".repeat(32)}`,
      },
      quote: `mock-quote-${nonce}`,
      gpuEvidence: { result: true },
      sealed: opts.sealed,
    })
  })
