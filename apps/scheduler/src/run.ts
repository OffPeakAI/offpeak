import { createHash } from "node:crypto"
import { Queue, Worker } from "bullmq"
import { MAX_REQUEST_S, hourIndex, keccakUtf8, quoteCost, type Hex } from "@offpeak/shared"
import type { Db } from "../../../services/common/src/db.ts"
import { eligibleHours, fillHours, type BatchLine, type HourSlot } from "./plan.ts"

export const HOUR_CLOSE_QUEUE = "offpeak-hour-close"
export const NIGHT_QUEUE = "offpeak-night-jobs"

/** Lines a router runs at once for one slot. The worker calls again until the slot is empty. */
const LINES_PER_CALL = 8
/** Past a request's limit, a line still marked running belongs to a router that died. */
const STALE_AFTER_S = MAX_REQUEST_S + 120
const OUTPUT_TTL_S = 7 * 86_400
const MAX_ATTEMPTS = 3

export type JobRow = {
  id: string
  account_id: string
  wallet: string
  model: string
  model_digest: Hex
  status: string
  deadline: string
  last_hour: string
  locked_price_in: string
  locked_price_out: string
  fee_bps: number
  /** Locked at the buyer's cap, below the plan's average, so it never runs above that price. */
  cap_locked: boolean
  estimated_max_micro: string
  actual_micro: string
  input_file_id: string
  output_file_id: string
}

export type LineRow = { job_id: string; line_no: number; custom_id: string; tokens_in: number; max_tokens_out: number; hour: string; attempt: number }

export type LineResult = { status: number; body: unknown; costMicro: bigint; retry: boolean }

/** What a slot needs from the router: its live prices, its holds and its pipeline. */
export type SlotDeps = {
  db: Db
  clock: () => number
  livePrice(job: JobRow): Promise<{ in: bigint; out: bigint } | null>
  forecast(job: JobRow, fromHour: number, count: number): Promise<{ hours: HourSlot[]; hourlyCapMicro: bigint }>
  placeHold(job: JobRow, amount: bigint): Promise<string | null>
  dropHold(job: JobRow, holdId: string): Promise<void>
  serveLine(job: JobRow, line: LineRow, reqId: Hex, fromHold?: string): Promise<LineResult>
}

export type SlotResult = { ran: number; moved: number; left: number }

const big = (value: unknown) => BigInt(String(value ?? 0))
const locked = (job: JobRow) => ({ in: big(job.locked_price_in), out: big(job.locked_price_out) })
const costOf = (job: JobRow, line: { tokens_in: number; max_tokens_out: number }) =>
  quoteCost({ tokensIn: line.tokens_in, tokensOut: line.max_tokens_out, priceIn: big(job.locked_price_in), priceOut: big(job.locked_price_out), feeBps: job.fee_bps }).totalMicro

/** Stable for a given attempt, so a crash can be told apart from a line that billed. */
export const lineReqId = (jobId: string, lineNo: number, attempt: number) => keccakUtf8(`night-line:${jobId}:${lineNo}:${attempt}`)

async function readJob(db: Db, jobId: string) {
  return (await db.query<JobRow>("SELECT * FROM serving.jobs WHERE id = $1", [jobId])).rows[0]
}

/** Rebuilds the plan's view from the lines. A slot with a hold stays until that hold is dropped. */
async function syncSlots(tx: Db, job: JobRow) {
  const lines = await tx.query<{ line_no: number; hour: string; tokens_in: number; max_tokens_out: number }>("SELECT line_no, hour, tokens_in, max_tokens_out FROM serving.job_lines WHERE job_id = $1 AND status = 'queued' ORDER BY line_no", [job.id])
  const slots = new Map<string, { lines: number[]; tokens: number; est: bigint }>()
  for (const line of lines.rows) {
    const slot = slots.get(line.hour) ?? { lines: [], tokens: 0, est: 0n }
    slot.lines.push(line.line_no)
    slot.tokens += line.tokens_in + line.max_tokens_out
    slot.est += costOf(job, line)
    slots.set(line.hour, slot)
  }
  await tx.query("DELETE FROM serving.job_slots WHERE job_id = $1 AND hold_id IS NULL AND NOT (hour = ANY($2::bigint[]))", [job.id, [...slots.keys()]])
  await tx.query("UPDATE serving.job_slots SET line_nos = '{}', tokens = 0, est_micro = 0 WHERE job_id = $1 AND NOT (hour = ANY($2::bigint[]))", [job.id, [...slots.keys()]])
  for (const [hour, slot] of slots) {
    await tx.query(
      `INSERT INTO serving.job_slots (job_id, hour, line_nos, tokens, est_micro) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (job_id, hour) DO UPDATE SET line_nos = EXCLUDED.line_nos, tokens = EXCLUDED.tokens, est_micro = EXCLUDED.est_micro`,
      [job.id, hour, slot.lines, slot.tokens, slot.est.toString()],
    )
  }
}

/** Appends to the output file and closes the line in one transaction, so a line is written exactly once. */
async function writeOutput(db: Db, job: JobRow, line: LineRow, reqId: Hex, result: LineResult, status: "done" | "failed") {
  const ok = status === "done"
  const text = `${JSON.stringify({
    id: `batch_req_${job.id}_${line.line_no}`,
    custom_id: line.custom_id,
    response: { status_code: result.status, request_id: reqId, body: ok ? result.body : null },
    error: ok ? null : result.body,
  })}\n`
  const bytes = Buffer.from(text)
  await db.transaction(async (tx) => {
    const totals = await tx.query<{ output_bytes: string; output_lines: number }>(
      "UPDATE serving.jobs SET output_bytes = output_bytes + $2, output_lines = output_lines + 1, actual_micro = actual_micro + $3 WHERE id = $1 RETURNING output_bytes, output_lines",
      [job.id, bytes.length, result.costMicro.toString()],
    )
    const after = totals.rows[0]!
    await tx.query("INSERT INTO serving.file_chunks (storage_key, seq, content) VALUES ($1,$2,$3)", [job.output_file_id, after.output_lines, bytes])
    await tx.query("UPDATE serving.job_lines SET status = $3, req_id = $4, actual_micro = $5, output_offset = $6, output_bytes = $7 WHERE job_id = $1 AND line_no = $2", [
      job.id,
      line.line_no,
      status,
      reqId,
      result.costMicro.toString(),
      (BigInt(after.output_bytes) - BigInt(bytes.length)).toString(),
      bytes.length,
    ])
  })
}

/** Moves lines to later eligible hours, spread by forecast. What does not fit goes to the last one, which runs anyway. */
async function moveLines(deps: SlotDeps, job: JobRow, lines: LineRow[], fromHour: number) {
  const last = Number(job.last_hour)
  const { hours, hourlyCapMicro } = await deps.forecast(job, fromHour + 1, last - fromHour)
  const eligible = eligibleHours(hours, Number(job.deadline), deps.clock())
  const batch: BatchLine[] = lines.map((line) => ({ index: line.line_no, tokensIn: line.tokens_in, maxTokensOut: line.max_tokens_out }))
  const placed = eligible.length > 0 ? fillHours(batch, eligible, hourlyCapMicro, job.fee_bps) : null
  await deps.db.transaction(async (tx) => {
    for (const line of lines) {
      const target = placed ? [...placed].find(([, rows]) => rows.some((row) => row.index === line.line_no))![0] : last
      await tx.query("UPDATE serving.job_lines SET hour = $3, status = 'queued' WHERE job_id = $1 AND line_no = $2", [job.id, line.line_no, target])
    }
    await syncSlots(tx, job)
  })
}

/** Called with no lines left to run. Deletes the prompts, which were only kept until the job ended. */
async function finishIfDone(deps: SlotDeps, job: JobRow) {
  const open = await deps.db.query("SELECT 1 FROM serving.job_lines WHERE job_id = $1 AND status IN ('queued','running') LIMIT 1", [job.id])
  if (open.rows.length > 0) return
  const counts = await deps.db.query<{ status: string; n: string }>("SELECT status, COUNT(*) AS n FROM serving.job_lines WHERE job_id = $1 GROUP BY status", [job.id])
  const count = (status: string) => Number(counts.rows.find((row) => row.status === status)?.n ?? 0)
  const status = count("cancelled") > 0 ? "cancelled" : count("done") > 0 ? "completed" : count("expired") > 0 ? "expired" : "failed"
  const chunks = await deps.db.query<{ content: Uint8Array }>("SELECT content FROM serving.file_chunks WHERE storage_key = $1 ORDER BY seq", [job.output_file_id])
  const hash = createHash("sha256")
  let bytes = 0
  for (const chunk of chunks.rows) {
    hash.update(chunk.content)
    bytes += chunk.content.length
  }
  await deps.db.transaction(async (tx) => {
    const updated = await tx.query("UPDATE serving.jobs SET status = $2 WHERE id = $1 AND status = 'in_progress' RETURNING id", [job.id, status])
    if (updated.rows.length === 0) return
    await tx.query("UPDATE serving.files SET bytes = $2, sha256 = $3, expires_at = to_timestamp($4) WHERE id = $1", [job.output_file_id, bytes, hash.digest("hex"), deps.clock() + OUTPUT_TTL_S])
    await tx.query("DELETE FROM serving.file_chunks WHERE storage_key = $1", [job.input_file_id])
    await tx.query("DELETE FROM serving.files WHERE id = $1", [job.input_file_id])
    await tx.query("DELETE FROM serving.job_slots WHERE job_id = $1 AND hold_id IS NULL", [job.id])
  })
}

async function dropSlotHold(deps: SlotDeps, job: JobRow, hour: number) {
  const slot = await deps.db.query<{ hold_id: string | null }>("SELECT hold_id FROM serving.job_slots WHERE job_id = $1 AND hour = $2", [job.id, hour])
  const holdId = slot.rows[0]?.hold_id
  if (!holdId) return
  await deps.db.query("DELETE FROM serving.job_slots WHERE job_id = $1 AND hour = $2 AND array_length(line_nos, 1) IS NULL", [job.id, hour])
  await deps.db.query("UPDATE serving.job_slots SET hold_id = NULL WHERE job_id = $1 AND hour = $2", [job.id, hour])
  await deps.dropHold(job, holdId)
}

/** The hour's hold, placed when the hour starts. Without one, each line still takes its own. */
async function slotHold(deps: SlotDeps, job: JobRow, hour: number) {
  const slot = await deps.db.query<{ hold_id: string | null; est_micro: string }>("SELECT hold_id, est_micro FROM serving.job_slots WHERE job_id = $1 AND hour = $2", [job.id, hour])
  const row = slot.rows[0]
  if (!row) return undefined
  if (row.hold_id) return row.hold_id
  const holdId = await deps.placeHold(job, big(row.est_micro))
  if (holdId) await deps.db.query("UPDATE serving.job_slots SET hold_id = $3 WHERE job_id = $1 AND hour = $2", [job.id, hour, holdId])
  return holdId ?? undefined
}

async function claimLines(deps: SlotDeps, jobId: string, hour: number | undefined) {
  const claimed = await deps.db.query<LineRow>(
    `UPDATE serving.job_lines SET status = 'running', attempt = attempt + 1, claimed_at = $1
     WHERE (job_id, line_no) IN (
       SELECT job_id, line_no FROM serving.job_lines
       WHERE job_id = $2 AND status = 'queued' AND ($3::bigint IS NULL OR hour = $3)
       ORDER BY line_no LIMIT $4 FOR UPDATE SKIP LOCKED
     ) RETURNING job_id, line_no, custom_id, tokens_in, max_tokens_out, hour, attempt`,
    [deps.clock(), jobId, hour ?? null, LINES_PER_CALL],
  )
  return claimed.rows.sort((a, b) => a.line_no - b.line_no)
}

async function runLine(deps: SlotDeps, job: JobRow, line: LineRow, fromHold: string | undefined, lastChance: boolean) {
  const reqId = lineReqId(job.id, line.line_no, line.attempt)
  const result = await deps.serveLine(job, line, reqId, fromHold).catch((err): LineResult => ({ status: 503, body: { message: String(err).slice(0, 200) }, costMicro: 0n, retry: true }))
  if (result.status === 200) {
    await writeOutput(deps.db, job, line, reqId, result, "done")
    return "ran" as const
  }
  if (result.retry && !lastChance) return "retry" as const
  if (result.retry && line.attempt < MAX_ATTEMPTS) {
    await deps.db.query("UPDATE serving.job_lines SET status = 'queued' WHERE job_id = $1 AND line_no = $2", [job.id, line.line_no])
    return "again" as const
  }
  await writeOutput(deps.db, job, line, reqId, result, "failed")
  return "ran" as const
}

const queuedLines = async (deps: SlotDeps, jobId: string, hour?: number) => {
  const left = await deps.db.query<{ n: string }>("SELECT COUNT(*) AS n FROM serving.job_lines WHERE job_id = $1 AND status = 'queued' AND ($2::bigint IS NULL OR hour = $2)", [jobId, hour ?? null])
  return Number(left.rows[0]?.n ?? 0)
}

/**
 * Runs up to a call's worth of an hour's lines. Above the locked price it moves them on instead, unless
 * this is the last eligible hour, which runs anyway at the locked price. With no hour, runs what is queued now.
 * A job locked at its cap never runs above its price: hosts get the plan's average or a live price this low,
 * so its last lines wait, and lapse unbilled at the deadline.
 */
export async function runSlot(deps: SlotDeps, jobId: string, hour?: number): Promise<SlotResult> {
  const job = await readJob(deps.db, jobId)
  if (!job || job.status !== "in_progress") return { ran: 0, moved: 0, left: 0 }
  const now = deps.clock()
  const current = hourIndex(now)
  if (hour !== undefined && hour > current) return { ran: 0, moved: 0, left: 0 }
  const lastChance = hour === undefined || current >= Number(job.last_hour)
  let moved = 0
  if (job.cap_locked || (hour !== undefined && !lastChance)) {
    const live = await deps.livePrice(job)
    const lock = locked(job)
    if (!live || live.in > lock.in || live.out > lock.out) {
      if (lastChance) return { ran: 0, moved: 0, left: await queuedLines(deps, job.id, hour) }
      const lines = await deps.db.query<LineRow>("SELECT * FROM serving.job_lines WHERE job_id = $1 AND status = 'queued' AND hour = $2 ORDER BY line_no", [job.id, hour])
      await moveLines(deps, job, lines.rows, current)
      moved = lines.rows.length
    }
  }
  const fromHold = hour !== undefined && moved === 0 ? await slotHold(deps, job, hour) : undefined
  const lines = moved === 0 ? await claimLines(deps, job.id, hour) : []
  const outcomes = await Promise.all(lines.map((line) => runLine(deps, job, line, fromHold, lastChance)))
  const again = lines.filter((_, i) => outcomes[i] === "retry")
  if (again.length > 0) {
    await moveLines(deps, job, again, current)
    moved += again.length
  }
  const remaining = await queuedLines(deps, job.id, hour)
  if (remaining === 0 && hour !== undefined) await dropSlotHold(deps, job, hour)
  await finishIfDone(deps, job)
  return { ran: outcomes.filter((row) => row === "ran").length, moved, left: remaining }
}

/** Lines not yet run are released. Lines already running finish, and stay in the output. */
export async function cancelJob(deps: SlotDeps, job: JobRow) {
  await deps.db.query("UPDATE serving.job_lines SET status = 'cancelled' WHERE job_id = $1 AND status = 'queued'", [job.id])
  const slots = await deps.db.query<{ hour: string }>("SELECT hour FROM serving.job_slots WHERE job_id = $1 AND hold_id IS NOT NULL", [job.id])
  for (const slot of slots.rows) await dropSlotHold(deps, job, Number(slot.hour))
  await deps.db.transaction((tx) => syncSlots(tx, job))
  await finishIfDone(deps, job)
}

/** A router died with these lines running. A record means the buyer paid for output nobody kept, so it comes back. */
async function reclaimLines(deps: SlotDeps, now: number) {
  const stale = await deps.db.query<LineRow>("SELECT * FROM serving.job_lines WHERE status = 'running' AND claimed_at <= $1 LIMIT 500", [now - STALE_AFTER_S])
  for (const line of stale.rows) {
    const job = await readJob(deps.db, line.job_id)
    if (!job) continue
    const reqId = lineReqId(job.id, line.line_no, line.attempt)
    const billed = await deps.db.query<{ cost: string }>("SELECT host_cost_micro + fee_micro AS cost FROM shared.usage_records WHERE req_id = $1", [reqId])
    const cost = billed.rows[0]?.cost
    if (cost !== undefined) {
      await deps.db.query("INSERT INTO shared.refunds (id, payer, amount, reason, req_ids) VALUES ($1,$2,$3,'night_line_lost',$4) ON CONFLICT (id) DO NOTHING", [`night-line:${reqId}`, job.wallet, cost, [reqId]])
      await writeOutput(deps.db, job, line, reqId, { status: 500, body: { message: "The reply was lost, and its cost is refunded" }, costMicro: 0n, retry: false }, "failed")
    } else {
      const cancelled = await deps.db.query("SELECT 1 FROM serving.job_lines WHERE job_id = $1 AND status = 'cancelled' LIMIT 1", [job.id])
      await deps.db.query("UPDATE serving.job_lines SET status = $3 WHERE job_id = $1 AND line_no = $2", [job.id, line.line_no, cancelled.rows.length > 0 ? "cancelled" : "queued"])
    }
    await finishIfDone(deps, job)
  }
}

async function expireJobs(deps: SlotDeps, now: number) {
  const late = await deps.db.query<JobRow>("SELECT * FROM serving.jobs WHERE status = 'in_progress' AND deadline <= $1 LIMIT 100", [now])
  for (const job of late.rows) {
    await deps.db.query("UPDATE serving.job_lines SET status = 'expired' WHERE job_id = $1 AND status = 'queued'", [job.id])
    const slots = await deps.db.query<{ hour: string }>("SELECT hour FROM serving.job_slots WHERE job_id = $1 AND hold_id IS NOT NULL", [job.id])
    for (const slot of slots.rows) await dropSlotHold(deps, job, Number(slot.hour))
    await finishIfDone(deps, job)
  }
}

/** Every job and hour with lines ready. The lines are the record, so a restart loses nothing. */
export async function dueSlots(deps: SlotDeps) {
  const now = deps.clock()
  await reclaimLines(deps, now)
  await expireJobs(deps, now)
  const rows = await deps.db.query<{ job_id: string; hour: string }>(
    `SELECT DISTINCT l.job_id, l.hour FROM serving.job_lines l JOIN serving.jobs j ON j.id = l.job_id
     WHERE l.status = 'queued' AND l.hour <= $1 AND j.status = 'in_progress' ORDER BY l.hour`,
    [hourIndex(now)],
  )
  return rows.rows.map((row) => ({ jobId: row.job_id, hour: Number(row.hour) }))
}

export type NightOptions = { redisUrl: string; routerUrl: string; token: string; everyMs?: number }

async function askRouter<T>(opts: NightOptions, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${opts.routerUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
    signal: AbortSignal.timeout((MAX_REQUEST_S + 60) * 1000),
  })
  if (!res.ok) throw new Error(`router ${path}: ${res.status}`)
  return (await res.json()) as T
}

async function drainSlot(opts: NightOptions, slot: { jobId: string; hour: number }) {
  for (;;) {
    const result = await askRouter<SlotResult>(opts, `/v1/batches/${slot.jobId}/run`, { method: "POST", body: JSON.stringify({ hour: slot.hour }) })
    if (result.left === 0 || result.ran + result.moved === 0) return result
  }
}

/** The clock of the night jobs. It holds no keys and no prompts: Postgres has the plan, and the router runs it. */
export async function startNightService(opts: NightOptions) {
  const connection = { url: opts.redisUrl }
  const queue = new Queue(NIGHT_QUEUE, { connection })
  const worker = new Worker(
    NIGHT_QUEUE,
    async (job) => {
      if (job.name === "slot") return drainSlot(opts, job.data as { jobId: string; hour: number })
      const { slots } = await askRouter<{ slots: { jobId: string; hour: number }[] }>(opts, "/internal/night-jobs/due")
      // The id keeps one run per slot in the queue. A finished run leaves no trace, so the next tick can add a late one.
      for (const slot of slots) await queue.add("slot", slot, { jobId: `slot-${slot.jobId}-${slot.hour}`, removeOnComplete: true, removeOnFail: true })
      return slots.length
    },
    { connection, concurrency: 4 },
  )
  await queue.upsertJobScheduler("night-tick", { every: opts.everyMs ?? 60_000 }, { name: "tick", opts: { removeOnComplete: true, removeOnFail: 20 } })
  return {
    queue,
    worker,
    close: async () => {
      await worker.close()
      await queue.close()
    },
  }
}

export function hourCloseQueue(url = process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379") {
  const connection = { url }
  return new Queue(HOUR_CLOSE_QUEUE, { connection })
}

export function startHourCloseWorker(handler: (hour: number) => Promise<unknown>, url = process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379") {
  return new Worker(
    HOUR_CLOSE_QUEUE,
    async (job) => handler(Number(job.data.hour)),
    { connection: { url } },
  )
}
