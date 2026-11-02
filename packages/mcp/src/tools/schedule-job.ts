import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { OffpeakError, microToUsd, usdToMicro, type Offpeak } from "@offpeak/sdk"
import { MAX_OUTPUT_TOKENS } from "@offpeak/shared"
import { z } from "zod"
import type { Budget } from "../budget.ts"
import { chatMessage } from "./complete.ts"
import { maxPriceInput, tool } from "./result.ts"

const input = {
  model: z.string().min(1),
  requests: z.array(z.object({ custom_id: z.string().min(1).optional(), messages: z.array(chatMessage).min(1), max_tokens: z.number().int().positive().optional() })).min(1),
  deadline: z.iso.datetime().describe("ISO 8601 time, UTC, by which the job must be done."),
  max_price: maxPriceInput.optional().describe("Most you will pay per 1M tokens, in USD, fee included. A higher locked price refuses the job and names a deadline that would work. The server's own cap applies when this is missing or higher."),
}

type Input = z.output<z.ZodObject<typeof input>>

const uploaded = z.looseObject({ id: z.string() })

const batch = z.looseObject({
  id: z.string(),
  offpeak: z.object({
    locked_price: z.object({ in: z.string().regex(/^\d+$/), out: z.string().regex(/^\d+$/) }),
    planned_hours: z.array(z.number().int()),
    estimated_cost: z.string().regex(/^\d+$/),
  }),
})

function batchFile(model: string, requests: Input["requests"]) {
  const lines = requests.map((row, index) => JSON.stringify({ custom_id: row.custom_id ?? `line-${index}`, method: "POST", url: "/v1/chat/completions", body: { model, messages: row.messages, max_tokens: row.max_tokens } }))
  const form = new FormData()
  form.set("purpose", "batch")
  form.set("file", new File([lines.join("\n")], "job.jsonl", { type: "application/jsonl" }))
  return form
}

export function registerScheduleJob(server: McpServer, op: Offpeak, budget: Budget) {
  server.registerTool(
    "offpeak_schedule_job",
    {
      description:
        "Schedule a night job on a prepaid API key. The locked price is the weighted average of the forecast hours the plan uses, fee included, not the lowest hour. " +
        "The answer has the job id, locked price, planned hours and estimated cost. The server's limits per call and per day refuse with call_cap or day_cap, and count the whole job as one call.",
      inputSchema: input,
    },
    tool(async ({ model, requests, deadline, max_price }: Input) => {
      if (Date.parse(deadline) <= Date.now()) throw new OffpeakError("deadline_too_soon", "The deadline has passed")
      const cap = budget.maxPrice(max_price && { inPerM: usdToMicro(max_price.in), outPerM: usdToMicro(max_price.out) })
      const worst = requests.reduce((sum, row) => sum + budget.worstCase(JSON.stringify(row.messages), row.max_tokens ?? MAX_OUTPUT_TOKENS, cap), 0n)
      const job = await budget.spend(
        worst,
        async () => {
          const file = await op.request("/v1/files", uploaded, { method: "POST", body: batchFile(model, requests) })
          // The router plans inside the deadline and refuses a locked price over the cap, so nothing is created that would break either.
          return op.request("/v1/batches", batch, {
            method: "POST",
            headers: { "content-type": "application/json", "x-offpeak-max-price": `in=${microToUsd(cap.inPerM)},out=${microToUsd(cap.outPerM)}` },
            body: JSON.stringify({ input_file_id: file.id, endpoint: "/v1/chat/completions", completion_window: "24h", metadata: { offpeak_deadline: deadline } }),
          })
        },
        (created) => BigInt(created.offpeak.estimated_cost),
      )
      return { job_id: job.id, locked_price: job.offpeak.locked_price, planned_hours: job.offpeak.planned_hours, estimated_cost_micro: job.offpeak.estimated_cost }
    }),
  )
}
