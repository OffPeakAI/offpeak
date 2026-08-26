import { LAUNCH_TOKENIZER, MAX_REQUEST_S, countChat, countOutput, outputHashOf, type ChatBody, type ChatMessage, type Hex, type ModelTokenizer } from "@offpeak/shared"
import { z } from "zod"

export function meterChat(body: { messages?: ChatMessage[]; tools?: unknown }, output: string, toolCalls?: unknown[]) {
  const messages = body.messages ?? []
  return {
    tokensIn: countChat(LAUNCH_TOKENIZER, messages, body.tools),
    tokensOut: countOutput(LAUNCH_TOKENIZER, output, toolCalls),
  }
}

/** The counting a served model needs. The router counts through the same `ModelTokenizer`. */
export type AgentTokenizer = Pick<ModelTokenizer, "render" | "encode" | "decodeToken" | "countChat" | "countOutput" | "countInputs">

export type Counts = { tokensIn: number; tokensOut: number }

export type EngineUsage = { prompt_tokens?: number; completion_tokens?: number }

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } }

const toolDelta = z.looseObject({
  index: z.number().optional(),
  id: z.string().nullish(),
  type: z.string().nullish(),
  function: z.looseObject({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
})

const usageSchema = z.looseObject({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).nullish()

const chunkSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z.looseObject({ content: z.string().nullish(), tool_calls: z.array(toolDelta).nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: usageSchema,
})

const completionSchema = z.looseObject({
  choices: z.array(
    z.looseObject({
      message: z.looseObject({ content: z.string().nullish(), tool_calls: z.array(toolDelta).nullish() }).nullish(),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: usageSchema,
})

/** What vLLM sent back, folded the way the router folds it, so both sides count the same text. */
export class EngineOutput {
  text = ""
  toolCalls: ToolCall[] = []
  finish: string | null = null
  usage: EngineUsage | null = null

  private addTool(delta: z.infer<typeof toolDelta>) {
    const index = delta.index ?? this.toolCalls.length
    const call = (this.toolCalls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
    if (delta.id) call.id = delta.id
    if (delta.type) call.type = delta.type
    if (delta.function?.name) call.function.name += delta.function.name
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments
  }

  chunk(raw: unknown) {
    const parsed = chunkSchema.safeParse(raw)
    if (!parsed.success) return
    if (parsed.data.usage) this.usage = parsed.data.usage
    const choice = parsed.data.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) this.finish = choice.finish_reason
    for (const delta of choice.delta?.tool_calls ?? []) this.addTool(delta)
    this.text += choice.delta?.content ?? ""
  }

  /** False when the body is not a completion, which leaves nothing to count. */
  completion(raw: unknown): boolean {
    const parsed = completionSchema.safeParse(raw)
    if (!parsed.success) return false
    this.usage = parsed.data.usage ?? null
    const choice = parsed.data.choices[0]
    this.finish = choice?.finish_reason ?? null
    this.text = choice?.message?.content ?? ""
    for (const delta of choice?.message?.tool_calls ?? []) this.addTool(delta)
    return true
  }
}

/** Reads `data:` events out of an SSE byte stream without holding the bytes back from the caller. */
export class SseReader {
  private readonly decoder = new TextDecoder()
  private buffer = ""

  push(bytes: Uint8Array): unknown[] {
    this.buffer += this.decoder.decode(bytes, { stream: true }).replaceAll("\r\n", "\n")
    const events: unknown[] = []
    for (let cut = this.buffer.indexOf("\n\n"); cut >= 0; cut = this.buffer.indexOf("\n\n")) {
      const block = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 2)
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
          events.push(JSON.parse(data))
        } catch {
          /* A line vLLM never meant as JSON is forwarded as it came and counts for nothing. */
        }
      }
    }
    return events
  }
}

export type ServedRequest = {
  reqId: Hex
  ts: number
  modelDigest: Hex
  /** Resolves once the stream has ended and the counts below are final. */
  settled: Promise<void>
  counts: Counts | null
  usage: EngineUsage | null
  outputHash: Hex | null
  /** The one record this host will ever sign for this request. */
  signing: { message: string; reply: Promise<SignReply> } | null
  /** Set for a sealed request: what the record's hashes must be, over the ciphertext this agent handled. */
  sealed?: { promptHash: Hex; outputHash: Hex | null }
}

export type SignReply = { status: number; body: Record<string, unknown> }

const KEEP_S = MAX_REQUEST_S + 600

/** Deeper than any real tool schema, and shallow enough for every template and serializer on the way. */
const MAX_JSON_DEPTH = 64

/** Walks level by level, so the check cannot run out of stack the way a count can. */
export function withinDepth(value: unknown, limit = MAX_JSON_DEPTH) {
  let level = [value]
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth > limit) return false
    level = level.flatMap((row) => (typeof row === "object" && row !== null ? Object.values(row) : []))
  }
  return true
}

/** The input's count, or `null` for a body the tokenizer cannot read. */
export function countInput(tokenizer: AgentTokenizer, body: ChatBody) {
  try {
    return tokenizer.countChat(body)
  } catch {
    return null
  }
}

/** Requests this host served, kept long enough for the router to ask for a signature. No prompt or output stays here. */
export class ServedBook {
  private readonly rows = new Map<string, { expiresAt: number; request: ServedRequest | null }>()

  /** False for a `reqId` already seen, so a captured request cannot be sent again. */
  claim(reqId: string, now: number): boolean {
    for (const [id, row] of this.rows) {
      if (row.expiresAt >= now) break
      this.rows.delete(id)
    }
    if (this.rows.has(reqId)) return false
    this.rows.set(reqId, { expiresAt: now + KEEP_S, request: null })
    return true
  }

  /** Called once the engine has taken the request. Until then the id is claimed but nothing can be signed for it. */
  begin(input: { reqId: Hex; ts: number; modelDigest: Hex }) {
    let finish = () => {}
    const settled = new Promise<void>((resolve) => {
      finish = resolve
    })
    const request: ServedRequest = { ...input, settled, counts: null, usage: null, outputHash: null, signing: null }
    this.rows.get(input.reqId)!.request = request
    return { request, finish }
  }

  get(reqId: string): ServedRequest | null {
    return this.rows.get(reqId)?.request ?? null
  }
}

/** Counts one chat once its output is complete. A failure leaves the counts empty, and the host then refuses to sign. Pass `tokensIn` if the input was counted up front. */
export function settleChat(row: ServedRequest, tokenizer: AgentTokenizer, body: ChatBody, output: EngineOutput, tokensIn?: number) {
  row.usage = output.usage
  const toolCalls = output.toolCalls.length > 0 ? output.toolCalls : undefined
  row.outputHash = outputHashOf(output.text, toolCalls ?? [])
  try {
    row.counts = { tokensIn: tokensIn ?? tokenizer.countChat(body), tokensOut: tokenizer.countOutput(output.text, toolCalls, output.finish) }
  } catch (err) {
    console.error(JSON.stringify({ service: "host-agent", event: "count_failed", reqId: row.reqId, error: err instanceof Error ? err.name : "unknown" }))
  }
}

export function settleEmbeddings(row: ServedRequest, tokenizer: AgentTokenizer, inputs: string[], usage: EngineUsage | null) {
  row.usage = usage
  row.counts = { tokensIn: tokenizer.countInputs(inputs), tokensOut: 0 }
}
