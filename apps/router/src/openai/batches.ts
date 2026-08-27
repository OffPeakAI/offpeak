import { createHash, randomBytes } from "node:crypto"
import { MAX_OUTPUT_TOKENS, askedTokens, buyerUnitPrice, dayIndex, hourIndex, outputLimit, type ChatMessage, type Hex } from "@offpeak/shared"
import { z } from "zod"
import { countChat } from "../metering/tokenize.ts"
import { lockAtCap, planJob, type BatchLine, type HourSlot, type Plan } from "../../../scheduler/src/plan.ts"
import { cancelJob, dueSlots, runSlot, type JobRow, type LineResult, type LineRow, type SlotDeps } from "../../../scheduler/src/run.ts"
import { accountPayer, auth, serveChat, type Payer, type Stack } from "../pipeline.ts"
import { candidates, hostPrice, messagesOk, tokenLimits } from "./chat.ts"
import { insertFile, newFileId, readFileBytes, readFileRow, storeLines } from "./files.ts"
import { featureOff, oai } from "../http.ts"
import { forecastSlots } from "../offpeak/forecast.ts"
import { buyerRefused, holdView, insufficientReserve } from "../pay/authorize.ts"
import { parseMaxPrice } from "../pay/quote.ts"
import { selectHost } from "../routing/select.ts"

/** The forecast reaches this far, so a plan can too. */
const FORECAST_HOURS = 168
const DEFAULT_WINDOW_S = 86_400
const MAX_LINES = 50_000
const HOUR_HOLD_TTL_S = 3600 + 600

const lineSchema = z.object({
  custom_id: z.string().min(1).max(256),
  method: z.literal("POST").optional(),
  url: z.literal("/v1/chat/completions").optional(),
  body: z.looseObject({ model: z.string().min(1), messages: z.array(z.unknown()).min(1) }),
})

const createBody = z.object({
  input_file_id: z.string().min(1),
  completion_window: z.string().optional(),
  metadata: z.looseObject({ offpeak_deadline: z.iso.datetime({ offset: true }).optional(), offpeak_max_price: z.string().optional() }).optional(),
})

const runBody = z.object({ hour: z.number().int().nonnegative().optional() })

type Line = z.infer<typeof lineSchema>
type Prepaid = Extract<Payer, { mode: 0 }>
type Cap = { inPerM: bigint; outPerM: bigint }
type Sized = { digest: Hex; contextLength: number }

const refuse =(message: string, code: string) => oai(400, message, "invalid_request", code)

function parseLines(text: string): Line[] | Response {
  const raw = text.split("\n").map((line) => line.trim()).filter(Boolean)
  if (raw.length === 0 || raw.length > MAX_LINES) return refuse(`A batch needs 1 to ${MAX_LINES} lines`, "bad_file")
  const lines: Line[] = []
  for (const [i, line] of raw.entries()) {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      return refuse(`Line ${i + 1} is not valid JSON`, "bad_file")
    }
    const parsed = lineSchema.safeParse(json)
    if (!parsed.success || !messagesOk(parsed.data.body.messages)) return refuse(`Line ${i + 1} is not a chat request`, "bad_file")
    lines.push(parsed.data)
  }
  if (new Set(lines.map((line) => line.custom_id)).size !== lines.length) return refuse("custom_id must be unique", "bad_file")
  if (new Set(lines.map((line) => line.body.model)).size !== 1) return refuse("All lines must use one model", "bad_file")
  return lines
}

function sizeLine(line: Line, index: number, model: Sized): BatchLine | null {
  if (!tokenLimits.safeParse(line.body).success) return null
  const asked = askedTokens(line.body)
  let tokensIn: number
  try {
    tokensIn = countChat(model, line.body as { messages: ChatMessage[]; tools?: unknown })
  } catch {
    return null
  }
  const room = model.contextLength - tokensIn
  return room < 1 ? null : { index, tokensIn, maxTokensOut: outputLimit(asked, room) }
}

/** What other jobs have already promised, by hour: capacity across buyers, money for this buyer. */
async function promised(stack: Stack, model: Hex, wallet: string, fromHour: number) {
  const rows = await stack.db.query<{ hour: string; tokens: string | null; mine: string | null }>(
    `SELECT s.hour, SUM(s.tokens) FILTER (WHERE j.model_digest = $1) AS tokens, SUM(s.est_micro) FILTER (WHERE j.wallet = $2) AS mine
     FROM serving.job_slots s JOIN serving.jobs j ON j.id = s.job_id
     WHERE j.status = 'in_progress' AND s.hour >= $3 GROUP BY s.hour`,
    [model, wallet, fromHour],
  )
  return new Map(rows.rows.map((row) => [Number(row.hour), { tokens: Number(row.tokens ?? 0), mine: BigInt(row.mine ?? 0) }]))
}

async function forecastFor(stack: Stack, model: Hex, wallet: string, fromHour: number, count: number) {
  const taken = await promised(stack, model, wallet, fromHour)
  const hours = await forecastSlots(stack, model, fromHour, count)
  return hours.map((slot): HourSlot => ({ ...slot, takenTokens: taken.get(slot.hour)?.tokens ?? 0, takenMicro: taken.get(slot.hour)?.mine ?? 0n }))
}

/** The whole estimate has to fit the balance and the daily cap now, across this buyer's other jobs too. */
async function fitsBuyer(stack: Stack, buyer: Awaited<ReturnType<Stack["indexer"]["buyer"]>>, wallet: string, plan: Plan, hours: HourSlot[]) {
  const view = holdView(stack, buyer)
  const committed = await stack.ledger.committed(wallet, buyer.lastSettledHour)
  const others = hours.reduce((sum, hour) => sum + (hour.takenMicro ?? 0n), 0n)
  if (committed + others + plan.estimatedMaxMicro > buyer.balance) return insufficientReserve(buyer, view)
  const days = new Map<number, bigint>()
  for (const hour of hours) days.set(dayIndex(hour.hour * 3600), (days.get(dayIndex(hour.hour * 3600)) ?? 0n) + (hour.takenMicro ?? 0n))
  for (const slot of plan.slots) {
    const day = dayIndex(slot.hour * 3600)
    const total = (days.get(day) ?? 0n) + slot.estMicro
    if (total > view.dailyCap) return insufficientReserve(buyer, view)
    days.set(day, total)
  }
  return null
}

type Intake = {
  payer: Prepaid
  model: { name: string; digest: Hex; contextLength: number }
  lines: Line[]
  sized: BatchLine[]
  deadline: number
  cap?: Cap
  /** A chat request with flex waits for its cap. A batch over its cap is refused, with a deadline that would work. */
  waitForCap: boolean
  inputFileId: string
  completionWindow: string
  status: 200 | 202
}

function batchObject(job: JobRow & { total?: string; completed?: string; failed?: string }, hours: number[], completionWindow?: string) {
  const buyerPrice = (price: string) => buyerUnitPrice(BigInt(price), job.fee_bps).toString()
  return {
    id: job.id,
    object: "batch",
    status: job.status,
    completion_window: completionWindow ?? "24h",
    output_file_id: job.output_file_id,
    request_counts: { total: Number(job.total ?? 0), completed: Number(job.completed ?? 0), failed: Number(job.failed ?? 0) },
    offpeak: {
      locked_price: { in: buyerPrice(job.locked_price_in), out: buyerPrice(job.locked_price_out) },
      deadline: new Date(Number(job.deadline) * 1000).toISOString(),
      planned_hours: hours,
      estimated_cost: String(job.estimated_max_micro),
      actual_cost: String(job.actual_micro),
    },
  }
}

/** Plans a job and stores it. `null` means no hour fits the deadline, which is not always a refusal. */
async function createJob(stack: Stack, intake: Intake): Promise<Response | null> {
  const { payer, model, lines, sized, deadline, cap, waitForCap } = intake
  const limit = cap ? { in: cap.inPerM, out: cap.outPerM } : undefined
  const now = stack.clock()
  const buyer = await stack.indexer.buyer(payer.wallet, now)
  const refused = buyerRefused(stack, buyer)
  if (refused) return refused
  const view = holdView(stack, buyer)
  const fromHour = hourIndex(now) + 1
  const hours = await forecastFor(stack, model.digest, payer.wallet, fromHour, FORECAST_HOURS)
  const planned = planJob({ lines: sized, hours, deadline, hourlyCapMicro: view.hourlyCap, feeBps: payer.feeBps, now, maxPrice: waitForCap ? undefined : limit })
  if ("error" in planned) {
    if (planned.error === "no_hours") return null
    return oai(429, "The locked price would be above the cap", "rate_limit", "price_above_cap", { cheapest_deadline: planned.cheapestDeadline ? new Date(planned.cheapestDeadline * 1000).toISOString() : null })
  }
  const plan = waitForCap && limit ? lockAtCap(planned, sized, limit, payer.feeBps) : planned
  // Below the plan's average, hosts were not promised this price, so 4.7's last-hour rule cannot apply to it.
  const capLocked = plan.lockedPrice.in < planned.lockedPrice.in || plan.lockedPrice.out < planned.lockedPrice.out
  const short = await fitsBuyer(stack, buyer, payer.wallet, plan, hours)
  if (short) return short
  const id = `batch_${randomBytes(12).toString("hex")}`
  const outputFileId = newFileId()
  const lastHour = Math.floor((deadline - 1800) / 3600) - 1
  const hourOf = new Map(plan.slots.flatMap((slot) => slot.lines.map((line) => [line, slot.hour] as const)))
  await stack.db.transaction(async (tx) => {
    await insertFile(tx, { id: outputFileId, accountId: payer.accountId, purpose: "batch_output", bytes: 0, sha256: "", expiresAt: deadline + 86_400 })
    await tx.query("UPDATE serving.files SET expires_at = GREATEST(expires_at, to_timestamp($2)) WHERE id = $1", [intake.inputFileId, deadline + 3600])
    await tx.query(
      `INSERT INTO serving.jobs (id, account_id, wallet, model, model_digest, status, deadline, last_hour, locked_price_in, locked_price_out, fee_bps, cap_locked, estimated_max_micro, input_file_id, output_file_id)
       VALUES ($1,$2,$3,$4,$5,'in_progress',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, payer.accountId, payer.wallet, model.name, model.digest, deadline, lastHour, plan.lockedPrice.in.toString(), plan.lockedPrice.out.toString(), payer.feeBps, capLocked, plan.estimatedMaxMicro.toString(), intake.inputFileId, outputFileId],
    )
    await tx.query(
      `INSERT INTO serving.job_lines (job_id, line_no, custom_id, tokens_in, max_tokens_out, hour, status)
       SELECT $1, line_no, custom_id, tokens_in, max_tokens_out, hour, 'queued'
       FROM unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::bigint[]) AS t(line_no, custom_id, tokens_in, max_tokens_out, hour)`,
      [id, sized.map((line) => line.index), lines.map((line) => line.custom_id), sized.map((line) => line.tokensIn), sized.map((line) => line.maxTokensOut), sized.map((line) => hourOf.get(line.index)!)],
    )
    for (const slot of plan.slots) {
      await tx.query("INSERT INTO serving.job_slots (job_id, hour, line_nos, tokens, est_micro) VALUES ($1,$2,$3,$4,$5)", [id, slot.hour, slot.lines, slot.tokens, slot.estMicro.toString()])
    }
    await storeLines(tx, intake.inputFileId, lines.map((line) => JSON.stringify(line)))
  })
  const job = (await stack.db.query<JobRow>("SELECT * FROM serving.jobs WHERE id = $1", [id])).rows[0]!
  return Response.json(batchObject({ ...job, total: String(lines.length) }, plan.slots.map((slot) => slot.hour), intake.completionWindow), { status: intake.status, headers: { location: `/v1/batches/${id}` } })
}
