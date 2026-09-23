import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Offpeak, Recount } from "@offpeak/sdk"
import { serializeEnvelope, type UsageEnvelope } from "@offpeak/shared"
import { z } from "zod"
import { tool, verification } from "./result.ts"

const LIST_MAX = 50

const input = {
  req_id: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .describe("One request id."),
  since: z.iso.datetime().optional().describe("ISO 8601 time. Lists your records since then."),
  recount: z
    .object({
      prompt: z.record(z.string(), z.unknown()).describe("The request body as you sent it."),
      output: z.string().describe("The output text you received."),
      tool_calls: z.array(z.unknown()).optional(),
      finish_reason: z.string().optional(),
    })
    .optional()
    .describe("With req_id, recounts that record with the model's own tokenizer and checks both hashes. Nothing here leaves this server."),
}

type Input = z.output<z.ZodObject<typeof input>>

async function entry(op: Offpeak, reqId: string, envelope: UsageEnvelope | null | undefined, recount?: Recount) {
  return {
    req_id: reqId,
    usage: envelope ? serializeEnvelope(envelope) : null,
    verification: envelope ? await verification(op, envelope, recount) : { ok: false, status: "not_checked", reason: "The router has no such record, so there is nothing to check" },
    proof: await op.proof(reqId),
  }
}

const toRecount = (recount: Input["recount"]): Recount | undefined => recount && { prompt: recount.prompt, output: { text: recount.output, toolCalls: recount.tool_calls, finish: recount.finish_reason } }

export function registerUsage(server: McpServer, op: Offpeak) {
  server.registerTool(
    "offpeak_usage",
    {
      description:
        "Fetch signed usage records with the local verification result and proof status. Records are signed by the router and the host. " +
        "You can recount your own requests and dispute any request within 7 days. Pass recount with req_id to recount one. " +
        "Without req_id this lists your records with an API key, or the records this server has seen with a wallet alone.",
      inputSchema: input,
    },
    tool(async ({ req_id, since, recount }: Input) => {
      if (req_id) return { records: [await entry(op, req_id, op.usageRecord(req_id) ?? (await op.fetchUsage(req_id)), toRecount(recount))] }
      const from = since ? Math.floor(Date.parse(since) / 1000) : 0
      const seen = op.canListUsage ? await op.usage({ since: from, limit: LIST_MAX }) : op.recentUsage(from).slice(0, LIST_MAX)
      return { records: await Promise.all(seen.map((envelope) => entry(op, envelope.record.reqId, envelope))) }
    }),
  )
}
