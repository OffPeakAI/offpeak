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
