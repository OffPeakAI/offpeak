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
