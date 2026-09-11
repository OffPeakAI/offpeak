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

function deadlineOf(stack: Stack, body: z.infer<typeof createBody>) {
  if (body.metadata?.offpeak_deadline) return Math.floor(Date.parse(body.metadata.offpeak_deadline) / 1000)
  if (body.completion_window === undefined || body.completion_window === "24h") return stack.clock() + DEFAULT_WINDOW_S
  return null
}

export async function serveCreateBatch(stack: Stack, req: Request): Promise<Response> {
  if (!stack.flags.night_jobs) return featureOff("Night jobs")
  const payer = await auth(stack, req)
  if (payer instanceof Response) return payer
  if (payer.mode !== 0) return refuse("Night jobs are prepaid", "prepaid_only")
  const body = createBody.safeParse(await req.json().catch(() => null))
  if (!body.success) return body.error.issues.some((issue) => issue.path[0] === "metadata") ? refuse("metadata.offpeak_deadline must be an ISO 8601 time", "bad_deadline") : refuse("Unknown file", "bad_file")
  const deadline = deadlineOf(stack, body.data)
  if (deadline === null || deadline > stack.clock() + FORECAST_HOURS * 3600) return refuse("completion_window takes 24h, or metadata.offpeak_deadline within 7 days", "bad_deadline")
  let cap: Cap | undefined
  try {
    cap = parseMaxPrice(req.headers.get("x-offpeak-max-price") ?? body.data.metadata?.offpeak_max_price)
  } catch {
    return refuse("X-Offpeak-Max-Price cannot be read", "bad_max_price")
  }
  const file = await readFileRow(stack, body.data.input_file_id)
  if (!file || file.account_id !== payer.accountId) return refuse("Unknown file", "bad_file")
  // Before the lines are read and tokenized, which is real work to do for a buyer with no money.
  const broke = buyerRefused(stack, await stack.indexer.buyer(payer.wallet, stack.clock()))
  if (broke) return broke
  const lines = parseLines((await readFileBytes(stack.db, file.storage_key)).toString("utf8"))
  if (lines instanceof Response) return lines
  const model = stack.models.find((row) => row.name === lines[0]!.body.model && row.kind === "chat")
  if (!model) return oai(404, "Unknown model", "invalid_request", "model_not_found")
  const sized = lines.map((line, index) => sizeLine(line, index, model))
  if (sized.some((line) => line === null)) return refuse("A line is longer than the model's context, or has a bad max_tokens", "bad_file")
  const created = await createJob(stack, { payer, model, lines, sized: sized as BatchLine[], deadline, cap, waitForCap: false, inputFileId: file.id, completionWindow: body.data.completion_window ?? "24h", status: 200 })
  return created ?? refuse("No hour fits the job before its deadline", "no_hours")
}

/** A chat request that can wait. Answers 202 with a job, or `null` when no hour fits and it must be served now or refused. */
export async function intakeFlex(stack: Stack, payer: Prepaid, modelName: string, body: Record<string, unknown>, flexDeadline: number, cap?: Cap) {
  const model = stack.models.find((row) => row.name === modelName && row.kind === "chat")
  if (!model) return null
  // Plans reach as far as the forecast does, so a later deadline is held to that.
  const deadline = Math.min(flexDeadline, stack.clock() + FORECAST_HOURS * 3600)
  const { stream: _stream, ...request } = body
  const line: Line = { custom_id: "flex", method: "POST", url: "/v1/chat/completions", body: request as Line["body"] }
  const sized = sizeLine(line, 0, model)
  if (!sized) return null
  const inputFileId = newFileId()
  const text = JSON.stringify(line)
  await insertFile(stack.db, { id: inputFileId, accountId: payer.accountId, purpose: "batch", bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), expiresAt: deadline + 3600 })
  const created = await createJob(stack, { payer, model, lines: [line], sized: [sized], deadline, cap, waitForCap: true, inputFileId, completionWindow: "flex", status: 202 })
  if (!created || !created.ok) await stack.db.query("DELETE FROM serving.files WHERE id = $1", [inputFileId])
  return created
}

async function ownedJob(stack: Stack, req: Request, id: string) {
  const payer = await auth(stack, req)
  if (payer instanceof Response) return payer
  const job = (await stack.db.query<JobRow>("SELECT * FROM serving.jobs WHERE id = $1", [id])).rows[0]
  if (!job || payer.mode !== 0 || job.account_id !== payer.accountId) return oai(404, "Not found", "invalid_request", "not_found")
  return job
}

async function viewJob(stack: Stack, job: JobRow) {
  const counts = await stack.db.query<{ total: string; completed: string; failed: string }>(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'done') AS completed, COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM serving.job_lines WHERE job_id = $1",
    [job.id],
  )
  const hours = await stack.db.query<{ hour: string }>("SELECT DISTINCT hour FROM serving.job_lines WHERE job_id = $1 ORDER BY hour", [job.id])
  return batchObject({ ...job, ...counts.rows[0] }, hours.rows.map((row) => Number(row.hour)))
}

export async function serveGetBatch(stack: Stack, req: Request, id: string): Promise<Response> {
  const job = await ownedJob(stack, req, id)
  return job instanceof Response ? job : Response.json(await viewJob(stack, job))
}

export async function serveCancelBatch(stack: Stack, req: Request, id: string): Promise<Response> {
  const job = await ownedJob(stack, req, id)
  if (job instanceof Response) return job
  await cancelJob(slotDeps(stack), job)
  const fresh = (await stack.db.query<JobRow>("SELECT * FROM serving.jobs WHERE id = $1", [id])).rows[0]!
  return Response.json(await viewJob(stack, fresh))
}

async function serveLine(stack: Stack, job: JobRow, line: LineRow, reqId: Hex, fromHold?: string): Promise<LineResult> {
  const body = await stack.db.query<{ content: Uint8Array }>("SELECT content FROM serving.file_chunks WHERE storage_key = $1 AND seq = $2", [job.input_file_id, line.line_no])
  const actor = await accountPayer(stack, job.account_id, job.fee_bps)
  const stored = body.rows[0]
  if (!stored || !actor) return { status: 410, body: { message: "The request is gone" }, costMicro: 0n, retry: false }
  const { body: request } = JSON.parse(Buffer.from(stored.content).toString("utf8")) as Line
  const res = await serveChat(stack, new Request("http://router/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, stream: false }) }), {
    lockedPrice: { in: BigInt(job.locked_price_in), out: BigInt(job.locked_price_out) },
    actor,
    reqId,
    fromHold,
  })
  const json = (await res.json()) as { offpeak_usage?: { record: { hostCostMicro: string; feeMicro: string } }; error?: unknown }
  const record = json.offpeak_usage?.record
  const costMicro = record ? BigInt(record.hostCostMicro) + BigInt(record.feeMicro) : 0n
  return { status: res.status, body: res.status === 200 ? json : json.error, costMicro, retry: res.status === 402 || res.status === 403 || res.status === 429 || res.status >= 500 }
}

function slotDeps(stack: Stack): SlotDeps {
  return {
    db: stack.db,
    clock: stack.clock,
    livePrice: async (job) => {
      const now = stack.clock()
      const top = selectHost(await candidates(stack, job.model_digest, now, job.fee_bps), { sealed: false, canary: false, interactive: false })[0]
      const priced = top ? hostPrice(stack, top, job.model_digest, now) : null
      return priced ? priced.price : null
    },
    forecast: async (job, fromHour, count) => {
      const buyer = await stack.indexer.buyer(job.wallet, stack.clock())
      return { hours: await forecastFor(stack, job.model_digest, job.wallet, fromHour, count), hourlyCapMicro: holdView(stack, buyer).hourlyCap }
    },
    placeHold: async (job, amount) => {
      const now = stack.clock()
      const buyer = await stack.indexer.buyer(job.wallet, now)
      const holdId = `slot_${randomBytes(8).toString("hex")}`
      const placed = await stack.ledger.admit(job.wallet, amount, holdView(stack, buyer), holdId, now, HOUR_HOLD_TTL_S)
      return placed.ok ? holdId : null
    },
    dropHold: (job, holdId) => stack.ledger.release(job.wallet, holdId),
    serveLine: (job, line, reqId, fromHold) => serveLine(stack, job, line, reqId, fromHold),
  }
}

export const dueNightSlots = (stack: Stack) => dueSlots(slotDeps(stack))

/** With an hour, one call's worth of that slot, as the scheduler drives it. With none, everything queued, at once. */
export async function runBatch(stack: Stack, id: string, raw?: unknown) {
  const body = runBody.safeParse(raw ?? {})
  const deps = slotDeps(stack)
  if (body.success && body.data.hour !== undefined) return runSlot(deps, id, body.data.hour)
  const total = { ran: 0, moved: 0, left: 0 }
  for (;;) {
    const step = await runSlot(deps, id)
    total.ran += step.ran
    total.left = step.left
    if (step.left === 0 || step.ran === 0) return total
  }
}
