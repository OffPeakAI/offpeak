import { describe, expect, test } from "bun:test"
import { buyerUnitPrice, channelAuthHeader, hourIndex, type ChannelChain } from "@offpeak/shared"
import { keccak256, toBytes, type Hex } from "viem"
import { bootStack, liveBuyer } from "./support/stack.ts"
import { runBatch } from "../src/openai/batches.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const chatBody = (text: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: text }], max_tokens: 8, ...extra })
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

const chat = (booted: Booted, headers: Record<string, string>, body = chatBody("later")) =>
  booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", ...headers }, body })

/** Base cap on the sheet is 0.20/0.80 per 1M, so idle live is 0.10/0.40 at the floor. */
const LOW_CAP = "in=0.000001,out=0.000001"
const HIGH_CAP = "in=5,out=5"

describe("a price above the cap", () => {
  test("is 429 with the best price and the next cheaper hour", async () => {
    const booted = await bootStack()
    const live = liveBuyer(booted.stack, booted.host)
    const res = await chat(booted, { "x-offpeak-max-price": "in=0.20,out=0.70" })
    expect(res.status).toBe(200)
    const dear = await chat(booted, { "x-offpeak-max-price": `in=0.0999,out=0.40` })
    expect(dear.status).toBe(429)
    const { error } = (await dear.json()) as { error: { code: string; best_price: { in: string; out: string }; next_cheaper_hour: number; next_cheaper_price: { in: string; out: string } } }
    expect(error.code).toBe("price_above_cap")
    expect(BigInt(error.best_price.in)).toBe(live.buyerIn)
    expect(error.next_cheaper_hour).toBeGreaterThan(hourIndex(booted.stack.clock()))
    expect(BigInt(error.next_cheaper_price.in)).toBe(buyerUnitPrice(140_000n, 400))
  })

  test("with flex becomes a job, whose price stays at or under the cap", async () => {
    const booted = await bootStack()
    const now = booted.stack.clock()
    const res = await chat(booted, { "x-offpeak-max-price": "in=0.10,out=0.40", "x-offpeak-flex": iso(now + 12 * 3600) })
    expect(res.status).toBe(202)
    const job = (await res.json()) as { id: string; object: string; status: string; offpeak: { locked_price: { in: string; out: string }; planned_hours: number[]; deadline: string } }
    expect(res.headers.get("location")).toBe(`/v1/batches/${job.id}`)
    expect(job.object).toBe("batch")
    expect(job.status).toBe("in_progress")
    expect(BigInt(job.offpeak.locked_price.in)).toBeLessThanOrEqual(100_000n)
    expect(BigInt(job.offpeak.locked_price.out)).toBeLessThanOrEqual(400_000n)
    expect((await booted.stack.db.query("SELECT 1 FROM shared.usage_records")).rows.length).toBe(0)
  })

  test("a flex job that can never reach its cap lapses unbilled", async () => {
    const booted = await bootStack()
    const now = booted.stack.clock()
    const res = await chat(booted, { "x-offpeak-max-price": LOW_CAP, "x-offpeak-flex": iso(now + 12 * 3600) })
    expect(res.status).toBe(202)
    const { id } = (await res.json()) as { id: string }
    await runBatch(booted.stack, id)
    await runBatch(booted.stack, id)
    await runBatch(booted.stack, id)
    expect((await booted.stack.db.query("SELECT 1 FROM shared.usage_records")).rows.length).toBe(0)
  })
})

describe("X-Offpeak-Flex", () => {
  test("under the cap the request is simply served", async () => {
    const booted = await bootStack()
    const res = await chat(booted, { "x-offpeak-max-price": HIGH_CAP, "x-offpeak-flex": iso(booted.stack.clock() + 12 * 3600) })
    expect(res.status).toBe(200)
  })

  test("a locked line goes only to a host that takes night jobs", async () => {
    const booted = await bootStack()
    const now = booted.stack.clock()
    const res = await chat(booted, { "x-offpeak-flex": iso(now + 12 * 3600) })
    const job = (await res.json()) as { id: string; offpeak: { planned_hours: number[] } }
    booted.stack.nightModels = new Map([[booted.host.toLowerCase(), new Set()]])
    booted.stack.setClock(job.offpeak.planned_hours.at(-1)! * 3600 + 5)
    await runBatch(booted.stack, job.id, { hour: job.offpeak.planned_hours.at(-1)! })
    const served = await booted.stack.db.query("SELECT 1 FROM shared.usage_records")
    expect(served.rows).toHaveLength(0)
  })

  test("with no cap the deadline alone says it can wait, and the job runs at its locked price", async () => {
    const booted = await bootStack()
    const now = booted.stack.clock()
    const res = await chat(booted, { "x-offpeak-flex": iso(now + 12 * 3600) }, chatBody("wait for me", { stream: true }))
    expect(res.status).toBe(202)
    const job = (await res.json()) as { id: string; output_file_id: string; offpeak: { planned_hours: number[] } }
    booted.stack.setClock(job.offpeak.planned_hours[0]! * 3600 + 5)
    await runBatch(booted.stack, job.id, { hour: job.offpeak.planned_hours[0]! })
    const view = await (await booted.app.request(`/v1/batches/${job.id}`, { headers: { authorization: `Bearer ${booted.key.token}` } })).json()
    expect(view.status).toBe("completed")
    expect(view.request_counts).toEqual({ total: 1, completed: 1, failed: 0 })
    const output = await (await booted.app.request(`/v1/files/${job.output_file_id}/content`, { headers: { authorization: `Bearer ${booted.key.token}` } })).text()
    expect(JSON.parse(output.trim()).response.status_code).toBe(200)
    const row = await booted.stack.db.query<{ price_in: string; pay_mode: number }>("SELECT price_in, pay_mode FROM shared.usage_records")
    expect(row.rows[0]!.pay_mode).toBe(0)
    expect(BigInt(row.rows[0]!.price_in)).toBe(140_000n)
  })

  test("too close to its deadline for any hour, it is served now, or refused over a cap", async () => {
    const booted = await bootStack()
    const soon = iso(booted.stack.clock() + 600)
    expect((await chat(booted, { "x-offpeak-flex": soon })).status).toBe(200)
    expect((await chat(booted, { "x-offpeak-flex": soon, "x-offpeak-max-price": LOW_CAP })).status).toBe(429)
  })

  test("a bad header is refused, and agents have no night jobs yet", async () => {
    const booted = await bootStack()
    const bad = await chat(booted, { "x-offpeak-flex": "soon" })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_flex")
    const channelId = keccak256(toBytes("flex-channel"))
    const row: ChannelChain = { payer: booted.buyer as Hex, deposit: 50_000_000n, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false }
    booted.indexer.channels.set(channelId, row)
    const { roleAccount } = await import("../../../packages/shared/src/test-keys.ts")
    const body = chatBody("agent")
    const auth = await channelAuthHeader(roleAccount("buyer"), { channelId, ts: booted.stack.clock(), body })
    const agent = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": channelId, "x-offpeak-channel-auth": auth, "x-offpeak-flex": iso(booted.stack.clock() + 86_400) }, body })
    expect(agent.status).toBe(400)
    expect(((await agent.json()) as { error: { code: string } }).error.code).toBe("prepaid_only")
  })

  test("a buyer who cannot be served cannot queue a job either", async () => {
    const booted = await bootStack()
    booted.indexer.buyers.get(booted.buyer)!.withdrawRequestedAt = 5n
    const res = await chat(booted, { "x-offpeak-flex": iso(booted.stack.clock() + 12 * 3600) })
    expect(res.status).toBe(403)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.jobs")).rows.length).toBe(0)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.files")).rows.length).toBe(0)
  })
})

describe("the price header", () => {
  test("shows the buyer's price with fee, as the spec has it", async () => {
    const booted = await bootStack()
    const live = liveBuyer(booted.stack, booted.host)
    const res = await chat(booted, {})
    expect(res.headers.get("x-offpeak-price")).toBe(`in=${live.buyerIn},out=${live.buyerOut}`)
  })
})
