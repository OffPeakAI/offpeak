import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { usdToMicro, type ChatResult, type Offpeak } from "@offpeak/sdk"
import { serializeEnvelope } from "@offpeak/shared"
import { z } from "zod"
import { maxPriceInput, tool, verification } from "./result.ts"

export const chatMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))]).nullable(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
})

const input = {
  model: z.string().min(1).describe("Model id from /v1/models. Model ids describe compatibility only."),
  messages: z.array(chatMessage).min(1),
  max_tokens: z.number().int().positive().describe("Most output tokens to pay for."),
  max_price: maxPriceInput.optional().describe("Most you will pay per 1M tokens, in USD, fee included. Above it the call fails with price_above_cap."),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  response_format: z.object({ type: z.enum(["text", "json_object", "json_schema"]) }).loose().optional(),
}

type Input = z.output<z.ZodObject<typeof input>>

export function registerComplete(server: McpServer, op: Offpeak) {
  server.registerTool(
    "offpeak_complete",
    {
      description:
        "Run a chat completion on an open-weight model at the off-peak live price, with the signed usage record and its local verification, which recounts your tokens with the model's own tokenizer. " +
        "Prices move: the live price at request start is what you pay, and max_price caps it. Open hosts and the router can read prompts.",
      inputSchema: input,
    },
    tool(async ({ max_price, ...body }: Input) => {
      const maxPrice = max_price ? { inPerM: usdToMicro(max_price.in), outPerM: usdToMicro(max_price.out) } : undefined
      const result = (await op.chat(body, { maxPrice })) as ChatResult
      const channel = result.channel
      return {
        text: result.text,
        tool_calls: result.toolCalls,
        finish_reason: result.finishReason,
        host: result.host,
        usage: serializeEnvelope(result.envelope),
        verification: await verification(op, result.envelope, { prompt: body, output: { text: result.text ?? "", toolCalls: result.toolCalls, finish: result.finishReason } }),
        channel: channel && { id: channel.id, signed: channel.signed, voucher_problem: channel.refused },
      }
    }),
  )
}
