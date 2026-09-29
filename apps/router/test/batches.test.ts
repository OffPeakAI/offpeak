import { describe, expect, test } from "bun:test"
import { MAX_REQUEST_S, hourIndex } from "@offpeak/shared"
import { createApp } from "../src/app.ts"
import { dueNightSlots, runBatch } from "../src/openai/batches.ts"
import { lineReqId } from "../../scheduler/src/run.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const owner = (booted: Booted) => ({ authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" })
const line = (customId: string, extra: object = {}) => JSON.stringify({ custom_id: customId, method: "POST", url: "/v1/chat/completions", body: { model: "ofm-8b", messages: [{ role: "user", content: `line ${customId}` }], max_tokens: 8, ...extra } })

async function upload(booted: Booted, content: string, headers = owner(booted)) {
  const res = await booted.app.request("/v1/files", { method: "POST", headers, body: JSON.stringify({ purpose: "batch", content }) })
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: string }).id
}

type Batch = { id: string; status: string; output_file_id: string; offpeak: { planned_hours: number[]; locked_price: { in: string; out: string }; estimated_cost: string; actual_cost: string; deadline: string } }

async function createBatch(booted: Booted, lines: string[], extra: object = {}, headers: Record<string, string> = {}) {
  const fileId = await upload(booted, lines.join("\n"))
  return booted.app.request("/v1/batches", { method: "POST", headers: { ...owner(booted), ...headers }, body: JSON.stringify({ input_file_id: fileId, completion_window: "24h", ...extra }) })
}

async function created(booted: Booted, lines: string[], extra: object = {}) {
  const res = await createBatch(booted, lines, extra)
  expect(res.status).toBe(200)
  return (await res.json()) as Batch
}

const view = async (booted: Booted, id: string) => (await booted.app.request(`/v1/batches/${id}`, { headers: owner(booted) })).json() as Promise<Batch & { request_counts: { total: number; completed: number; failed: number } }>
const records = (booted: Booted) => booted.stack.db.query<{ req_id: string; price_in: string; price_out: string; payer: string }>("SELECT * FROM shared.usage_records")
const lines = (booted: Booted, id: string) => booted.stack.db.query<{ line_no: number; status: string; hour: string; attempt: number }>("SELECT line_no, status, hour, attempt FROM serving.job_lines WHERE job_id = $1 ORDER BY line_no", [id])

async function drain(booted: Booted, id: string, hour: number) {
  for (let i = 0; i < 20; i++) {
    const step = await runBatch(booted.stack, id, { hour })
    if (step.left === 0 || step.ran + step.moved === 0) return step
  }
  throw new Error("slot did not drain")
}

async function runTo(booted: Booted, id: string, hour: number) {
  booted.stack.setClock(hour * 3600 + 5)
  return drain(booted, id, hour)
}

describe("night jobs in Postgres", () => {
  test("a job survives a restart and finishes on a new router, with no key kept anywhere", async () => {
    const before = await bootStack()
    const job = await created(before, [line("a"), line("b")])
    const hour = job.offpeak.planned_hours[0]!

    const stored = JSON.stringify((await before.stack.db.query("SELECT * FROM serving.jobs")).rows) + JSON.stringify((await before.stack.db.query("SELECT * FROM serving.job_lines")).rows) + JSON.stringify((await before.stack.db.query("SELECT * FROM serving.job_slots")).rows)
    expect(stored).not.toContain(before.key.token)
    expect(stored).not.toContain("op_live_")

    const after = await bootStack({ db: before.stack.db, now: hour * 3600 + 5 })
    await after.stack.db.query("UPDATE serving.api_keys SET revoked_at = now()")
    expect((await dueNightSlots(after.stack)).map((slot) => slot.jobId)).toEqual([job.id])
    const step = await drain(after, job.id, hour)
    expect(step.left).toBe(0)
    const rows = await records(after)
    expect(rows.rows.length).toBe(2)
    expect(rows.rows.every((row) => row.payer === after.buyer)).toBe(true)
    const fresh = await bootStack({ db: before.stack.db, now: hour * 3600 + 10 })
    const seen = await view(fresh, job.id)
    expect(seen.status).toBe("completed")
    expect(seen.request_counts).toEqual({ total: 2, completed: 2, failed: 0 })
    expect(BigInt(seen.offpeak.actual_cost)).toBeGreaterThan(0n)
    expect(BigInt(seen.offpeak.actual_cost)).toBeLessThanOrEqual(BigInt(seen.offpeak.estimated_cost))
  })

  test("the output is OpenAI batch JSONL with each line's envelope, and the prompts go when the job ends", async () => {
    const booted = await bootStack()
    const job = await created(booted, [line("a"), line("b")])
    const inputs = await booted.stack.db.query<{ input_file_id: string }>("SELECT input_file_id FROM serving.jobs")
    expect((await booted.stack.db.query("SELECT 1 FROM serving.file_chunks WHERE storage_key = $1", [inputs.rows[0]!.input_file_id])).rows.length).toBe(2)
    await runTo(booted, job.id, job.offpeak.planned_hours[0]!)
    const text = await (await booted.app.request(`/v1/files/${job.output_file_id}/content`, { headers: owner(booted) })).text()
    const rows = text.trim().split("\n").map((row) => JSON.parse(row))
    expect(rows.map((row) => row.custom_id).sort()).toEqual(["a", "b"])
    expect(rows[0].response.status_code).toBe(200)
    expect(rows[0].response.body.offpeak_usage.routerSig).toMatch(/^0x/)
    const offsets = await booted.stack.db.query<{ output_offset: string; output_bytes: number }>("SELECT output_offset, output_bytes FROM serving.job_lines ORDER BY output_offset")
    expect(Number(offsets.rows[1]!.output_offset)).toBe(offsets.rows[0]!.output_bytes)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.file_chunks WHERE storage_key = $1", [inputs.rows[0]!.input_file_id])).rows.length).toBe(0)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.files WHERE id = $1", [inputs.rows[0]!.input_file_id])).rows.length).toBe(0)
  })

  test("lines bill the locked price even when the live price has moved, and a line's own max_tokens is honoured", async () => {
    const booted = await bootStack()
    const job = await created(booted, [line("a", { max_tokens: 3 })])
    await booted.stack.db.query("UPDATE serving.jobs SET locked_price_in = 150000, locked_price_out = 600000")
    await runTo(booted, job.id, job.offpeak.planned_hours[0]!)
    const row = (await records(booted)).rows[0]! as unknown as { price_in: string; price_out: string; tokens_out: number }
    expect(String(row.price_in)).toBe("150000")
    expect(String(row.price_out)).toBe("600000")
    expect(row.tokens_out).toBeLessThanOrEqual(3)
  })

  test("cancelling releases lines not yet run, and they never bill", async () => {
    const booted = await bootStack()
    const job = await created(booted, [line("a"), line("b")])
    const res = await booted.app.request(`/v1/batches/${job.id}/cancel`, { method: "POST", headers: owner(booted) })
    expect(((await res.json()) as { status: string }).status).toBe("cancelled")
    const hour = job.offpeak.planned_hours[0]!
    booted.stack.setClock(hour * 3600 + 5)
    expect(await dueNightSlots(booted.stack)).toEqual([])
    expect((await runBatch(booted.stack, job.id, { hour })).ran).toBe(0)
    expect((await records(booted)).rows.length).toBe(0)
  })

  test("another account cannot see, cancel or start a job on someone else's file", async () => {
    const booted = await bootStack()
    const job = await created(booted, [line("a")])
    const { issueKey } = await import("../src/pipeline.ts")
    const other = await issueKey(booted.stack, "0x000000000000000000000000000000000000dead")
    const stranger = { authorization: `Bearer ${other.token}`, "content-type": "application/json" }
    expect((await booted.app.request(`/v1/batches/${job.id}`, { headers: stranger })).status).toBe(404)
    expect((await booted.app.request(`/v1/batches/${job.id}/cancel`, { method: "POST", headers: stranger })).status).toBe(404)
    const fileId = await upload(booted, line("mine"))
    expect((await booted.app.request("/v1/batches", { method: "POST", headers: stranger, body: JSON.stringify({ input_file_id: fileId }) })).status).toBe(400)
  })

  test("the internal routes need the internal token", async () => {
    const booted = await bootStack()
    booted.stack.internalToken = "internal"
    const app = createApp(booted.stack)
    expect((await app.request("/internal/night-jobs/due")).status).toBe(403)
    expect((await app.request("/internal/night-jobs/due", { headers: owner(booted) })).status).toBe(403)
    expect((await app.request("/internal/night-jobs/due", { headers: { authorization: "Bearer internal" } })).status).toBe(200)
    expect((await app.request("/v1/batches/x/run", { method: "POST" })).status).toBe(403)
  })

  test("files expire, and bad files are refused line by line", async () => {
    const booted = await bootStack()
    const { sweepFiles } = await import("../src/openai/files.ts")
    const fileId = await upload(booted, line("a"))
    booted.stack.setClock(booted.stack.clock() + 8 * 86_400)
    expect((await booted.app.request(`/v1/files/${fileId}/content`, { headers: owner(booted) })).status).toBe(404)
    await sweepFiles(booted.stack)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.file_chunks")).rows.length).toBe(0)
    for (const bad of ["not json", JSON.stringify({ custom_id: "x" }), [line("a"), line("a")].join("\n"), [line("a"), line("b", { model: "ofm-70b" })].join("\n"), line("a", { max_tokens: -1 })]) {
      expect((await createBatch(booted, [bad])).status).toBe(400)
    }
    expect((await createBatch(booted, [line("a", { model: "unknown" })])).status).toBe(404)
    expect((await createBatch(booted, [line("a")], { completion_window: "1h" })).status).toBe(400)
  })
})

describe("planning a job", () => {
  test("the deadline in metadata is honoured, and a job that does not fit before it is refused", async () => {
    const booted = await bootStack()
    const now = booted.stack.clock()
    const metadata = { offpeak_deadline: new Date((hourIndex(now) + 4) * 3600 * 1000).toISOString() }
    const job = await created(booted, [line("a")], { metadata })
    expect(job.offpeak.deadline).toBe(metadata.offpeak_deadline)
    expect(job.offpeak.planned_hours.every((hour) => (hour + 1) * 3600 <= (hourIndex(now) + 4) * 3600 - 1800)).toBe(true)
    const tooSoon = await createBatch(booted, [line("b")], { metadata: { offpeak_deadline: new Date((now + 1800) * 1000).toISOString() } })
    expect(tooSoon.status).toBe(400)
  })
