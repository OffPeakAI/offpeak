import { describe, expect, test } from "bun:test"
import { DISPUTE_WINDOW_S, quoteCost } from "@offpeak/shared"
import { listDisputes } from "../src/offpeak/disputes.ts"
import { resignedOverbill } from "./support/overbill.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const request = { model: "ofm-8b", messages: [{ role: "user", content: "count my tokens" }], max_tokens: 8 }
type Dispute = { id: string; status: string; outcome: string; refund_id: string | null; refund_micro: string; checks: { req_id: string; upheld: boolean; refund_micro: string; reasons: string[] }[] }

async function served(booted: Booted, body: object = request) {
  const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  const json = (await res.json()) as { choices: { message: { content: string } }[]; offpeak_usage: { record: { reqId: string; tokensIn: number; tokensOut: number; hostCostMicro: string; feeMicro: string } } }
  return { reqId: json.offpeak_usage.record.reqId, output: json.choices[0]!.message.content, record: json.offpeak_usage.record }
}

async function session(booted: Booted) {
  await booted.stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ('sess_test', $1, '', to_timestamp($2))", [booted.buyer, booted.stack.clock() + 86_400 * 30])
  return { authorization: "Bearer sess_test", "content-type": "application/json" }
}

const post = async (booted: Booted, body: object) => booted.app.request("/v1/disputes", { method: "POST", headers: await sessionOnce(booted), body: JSON.stringify(body) })

const sessions = new WeakMap<Booted, Promise<Record<string, string>>>()
function sessionOnce(booted: Booted) {
  const known = sessions.get(booted) ?? session(booted)
  sessions.set(booted, known)
  return known
}

async function dispute(booted: Booted, body: object) {
  const res = await post(booted, body)
  expect(res.status).toBe(200)
  return (await res.json()) as Dispute
}

const refunds = (booted: Booted) => booted.stack.db.query<{ id: string; payer: string; amount: string; reason: string; req_ids: string[] }>("SELECT * FROM shared.refunds")
const flags = (booted: Booted) => booted.stack.db.query<{ req_id: string; reason: string }>("SELECT req_id, reason FROM serving.metering_flags")

describe("disputes", () => {
  test("an honest record with the buyer's own material is rejected, with the reasons", async () => {
    const booted = await bootStack()
    const { reqId, output } = await served(booted)
    const result = await dispute(booted, { req_ids: [reqId], reason: "looks high", material: { prompt: request, output } })
    expect(result.outcome).toBe("rejected")
    expect(result.refund_id).toBe(null)
    expect(result.checks[0]!.upheld).toBe(false)
    expect((await refunds(booted)).rows.length).toBe(0)
    expect((await flags(booted)).rows.length).toBe(0)
  })

  test("a recount that finds too many tokens is upheld: a refund of the difference and a metering flag", async () => {
    const booted = await bootStack()
    const { reqId, output, record } = await served(booted)
    const padded = await resignedOverbill(booted, reqId, record.tokensOut + 500)
    const result = await dispute(booted, { req_ids: [reqId], reason: "too many tokens", material: { prompt: request, output } })
    expect(result.outcome).toBe("upheld")
    expect(result.checks[0]!.reasons).toContain("tokens_overcounted")
    const fair = BigInt(record.hostCostMicro) + BigInt(record.feeMicro)
    expect(BigInt(result.refund_micro)).toBe(padded.totalMicro - fair)
    const rows = (await refunds(booted)).rows
    expect(rows.length).toBe(1)
    expect(rows[0]!.id).toBe(result.refund_id!)
    expect(rows[0]!.payer).toBe(booted.buyer)
    expect(BigInt(rows[0]!.amount)).toBe(padded.totalMicro - fair)
    expect(rows[0]!.req_ids).toEqual([reqId])
    expect((await flags(booted)).rows).toEqual([{ req_id: reqId, reason: "dispute_upheld" }])
  })

  test("material that does not hash to the record proves nothing, however large the claim", async () => {
    const booted = await bootStack()
    const { reqId, record, output } = await served(booted)
    await resignedOverbill(booted, reqId, record.tokensOut + 500)
    const result = await dispute(booted, { req_ids: [reqId], reason: "made up", material: { prompt: request, output: "something else" } })
    expect(result.outcome).toBe("rejected")
    expect(result.checks[0]!.reasons).toContain("material_mismatch")
    const swapped = await dispute(booted, { req_ids: [reqId], reason: "another prompt", material: { prompt: { ...request, max_tokens: 9 }, output } })
    expect(swapped.checks[0]!.reasons).toContain("material_mismatch")
    expect((await refunds(booted)).rows.length).toBe(0)
  })
