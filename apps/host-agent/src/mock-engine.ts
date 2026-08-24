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

  const serveDirect = async (body: Record<string, unknown>, headerValue: string | undefined) => {
    const header = await verifyRouterReq(headerValue, opts.routerAddress)
    if (!header) return Response.json({ error: { message: "router signature required", type: "auth", code: "bad_router_req" } }, { status: 401 })
    if (opts.fail) return Response.json({ error: { message: "backend down", type: "engine", code: "engine_down" } }, { status: 503 })
    const prompt = JSON.stringify(body.messages ?? body)
    const tool = Array.isArray(body.tools) && prompt.includes("tool")
    const long = prompt.includes("longform")
    const limit = Number(body.max_tokens ?? 4096)
    const text = opts.serving
      ? servedText(opts.serving, prompt, header.reqId, body, limit)
      : body.response_format
        ? '{"ok":true}'
        : long
          ? "x".repeat(Math.min(800, Math.max(320, limit)))
          : mockText(prompt, opts.swap).slice(0, limit)
    const toolCalls = tool ? [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"1"}' } }] : undefined
    const counted = body.stream ? null : meterChat(body, text, toolCalls)
    served.set(header.reqId, {
      tokensIn: counted?.tokensIn ?? -1,
      tokensOut: counted?.tokensOut ?? -1,
      output: text,
      body,
      toolCalls,
    })
    if (opts.firstByteMs) await new Promise((r) => setTimeout(r, opts.firstByteMs))
    if (!body.stream) {
      return Response.json({
        id: header.reqId,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text, tool_calls: toolCalls },
            finish_reason: tool ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: counted!.tokensIn, completion_tokens: counted!.tokensOut, total_tokens: counted!.tokensIn + counted!.tokensOut },
      })
    }
    return streamChunks(header.reqId, text, toolCalls, tool ? "tool_calls" : "stop")
  }
  app.post("/offpeak/v1/chat/completions", async (c) => serveDirect(await c.req.json(), c.req.header("x-offpeak-req")))

  app.post("/offpeak/v1/embeddings", async (c) => {
    const header = await verifyRouterReq(c.req.header("x-offpeak-req"), opts.routerAddress)
    if (!header) return c.json({ error: { message: "router signature required", type: "auth", code: "bad_router_req" } }, 401)
    const body = await c.req.json()
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const data = inputs.map((text: string, index: number) => ({
      object: "embedding",
      index,
      embedding: [String(text).length, 1, 0, 0],
    }))
    const tokens = inputs.reduce((sum: number, text: string) => sum + countText(LAUNCH_TOKENIZER, String(text)), 0)
    served.set(header.reqId, { tokensIn: tokens, tokensOut: 0, output: "" })
    return c.json({ object: "list", data, model: opts.modelName, usage: { prompt_tokens: tokens, total_tokens: tokens } })
  })

  // Reference hosts only: per-token log-probabilities of an output under the claimed model.
  app.post("/offpeak/v1/score", async (c) => {
    const raw = await c.req.text()
    if (opts.auditorAddress && !(await verifyAuditScore(c.req.header("x-offpeak-audit"), raw, opts.auditorAddress))) {
      return c.json({ error: { message: "auditor signature required", type: "auth", code: "bad_auditor_req" } }, 401)
    }
    const body = JSON.parse(raw) as { messages?: unknown; output?: unknown }
    const tokens = textToTokens(String(body.output ?? ""))
    const spec = { ...CLAIMED, gpuNoise: opts.serving?.gpuNoise ?? 0, gpuSeed: opts.serving?.gpuSeed ?? 0 }
    const scored = scoreTokens(spec, seedOf(JSON.stringify(body.messages ?? [])), tokens)
    return c.json({ model: opts.modelName, modelDigest: opts.modelDigest, tokens: tokens.length, ll_mean: scored.reduce((sum, value) => sum + value, 0) / scored.length, logprobs: scored.map((logprob, i) => ({ id: tokens[i], logprob })) })
  })

  app.post("/offpeak/v1/sign", async (c) => {
    const body = await c.req.json()
    const record = parseRecord(body.record)
    const local = served.get(record.reqId)
    if (!local) return c.json({ error: "unknown_request" }, 404)
    if (local.tokensIn < 0) {
      const counts = meterChat(local.body ?? {}, local.output, local.toolCalls)
      local.tokensIn = counts.tokensIn
      local.tokensOut = counts.tokensOut
    }
    const hostCounts = { tokensIn: local.tokensIn, tokensOut: local.tokensOut }
    if (record.modelDigest.toLowerCase() !== opts.modelDigest.toLowerCase()) return c.json({ refused: true, reason: "digest", hostCounts }, 409)
    // A cut stream stops early on the router's side, so it may bill less output than the host produced, never more.
    const countsOk = body.partial
      ? bothCountsOk(record.tokensIn, 0, local.tokensIn, 0) && record.tokensOut <= local.tokensOut
      : bothCountsOk(record.tokensIn, record.tokensOut, local.tokensIn, local.tokensOut)
    if (!countsOk) return c.json({ refused: true, reason: "counts", hostCounts }, 409)
    const sig = await signTyped(opts.operator, {
      domain: domain("OffpeakUsage", opts.usageLedger),
      types: usageTypes,
      primaryType: "UsageRecord",
      message: recordToMessage(record) as never,
    })
    return c.json({ hostSig: sig, hostCounts, leaf: leafFor(record, body.routerSig, sig) })
  })

  app.post("/offpeak/v1/sealed", async (c) => {
    const enc = c.req.header("x-offpeak-enc") ?? ""
    if (seenEnc.has(enc)) return c.json({ error: "replay" }, 409)
    if (enc) seenEnc.add(enc)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    served.set(c.req.header("x-offpeak-reqid") ?? "sealed", { tokensIn: bytes.length, tokensOut: 4, output: "" })
    return c.json({ ciphertext: Buffer.from(bytes).toString("base64"), tokensIn: Math.max(1, Math.floor(bytes.length / 4)), tokensOut: 4 })
  })

  return { app, served }
}
