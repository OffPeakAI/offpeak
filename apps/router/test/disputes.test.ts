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

  test("a price above the sheet's top is refunded down to it, with no material needed", async () => {
    const booted = await bootStack()
    const { reqId, record } = await served(booted)
    const dear = await resignedOverbill(booted, reqId, record.tokensOut, { in: 900_000n, out: 3_600_000n })
    const result = await dispute(booted, { req_ids: [reqId], reason: "price" })
    expect(result.outcome).toBe("upheld")
    expect(result.checks[0]!.reasons).toContain("price_above_sheet")
    const top = quoteCost({ tokensIn: record.tokensIn, tokensOut: record.tokensOut, priceIn: 240_000n, priceOut: 960_000n, feeBps: 400 })
    expect(BigInt(result.refund_micro)).toBe(dear.totalMicro - top.totalMicro)
  })

  test("a record signed against a sheet that is not the host's comes back in full", async () => {
    const booted = await bootStack()
    const { reqId, record } = await served(booted)
    booted.stack.sheets = booted.stack.sheets.map((sheet) => ({ ...sheet, sheetHash: `0x${"ab".repeat(32)}` }))
    const result = await dispute(booted, { req_ids: [reqId], reason: "sheet" })
    expect(result.checks[0]!.reasons).toEqual(["sheet_mismatch"])
    expect(BigInt(result.refund_micro)).toBe(BigInt(record.hostCostMicro) + BigInt(record.feeMicro))
  })

  test("the locked price of a night job is the top for its lines, whatever hour they ran in", async () => {
    const booted = await bootStack()
    const { reqId } = await served(booted)
    await booted.stack.db.query("INSERT INTO serving.jobs (id, account_id, wallet, model, model_digest, status, deadline, last_hour, locked_price_in, locked_price_out, fee_bps, estimated_max_micro, input_file_id, output_file_id) VALUES ('batch_x',$1,$2,'m','0x','completed',0,0,1,1,400,0,'i','o')", [booted.key.accountId, booted.buyer])
    await booted.stack.db.query("INSERT INTO serving.job_lines (job_id, line_no, custom_id, tokens_in, max_tokens_out, hour, status, req_id) VALUES ('batch_x',0,'a',1,1,0,'done',$1)", [reqId])
    const result = await dispute(booted, { req_ids: [reqId], reason: "locked" })
    expect(result.outcome).toBe("upheld")
    expect(result.checks[0]!.reasons).toContain("price_above_sheet")
  })

  test("a record whose signatures do not hold is never debited, so nothing comes back", async () => {
    const booted = await bootStack()
    const { reqId } = await served(booted)
    await booted.stack.db.exec("ALTER TABLE shared.usage_records DISABLE TRIGGER USER")
    await booted.stack.db.query("UPDATE shared.usage_records SET router_sig = host_sig")
    await booted.stack.db.exec("ALTER TABLE shared.usage_records ENABLE TRIGGER USER")
    const result = await dispute(booted, { req_ids: [reqId], reason: "forged" })
    expect(result.outcome).toBe("rejected")
    expect(result.checks[0]!.reasons).toEqual(["bad_signature"])
    expect((await refunds(booted)).rows.length).toBe(0)
  })

  test("a record settlement left out of a settled hour is never debited, so nothing comes back", async () => {
    const booted = await bootStack()
    const { reqId, output } = await served(booted)
    await resignedOverbill(booted, reqId, 5_000)
    const [{ hour }] = (await booted.stack.db.query<{ hour: string }>("SELECT hour FROM shared.usage_records")).rows as [{ hour: string }]
    await booted.stack.db.query("INSERT INTO shared.usage_hours (hour, records, root, totals, totals_hash, router_close_sig, settle_tx) VALUES ($1,1,'0x','{}','0x','0x','0xfeed')", [hour])
    const result = await dispute(booted, { req_ids: [reqId], reason: "too many tokens", material: { prompt: request, output } })
    expect(result.outcome).toBe("rejected")
    expect(result.checks[0]!.reasons).toEqual(["settlement_rejected"])
    await booted.stack.db.query("UPDATE shared.usage_records SET settled_hour_tx = '0xfeed'")
    expect((await dispute(booted, { req_ids: [reqId], reason: "kept", material: { prompt: request, output } })).outcome).toBe("upheld")
  })

  test("a record is refunded at most once, however often it is disputed", async () => {
    const booted = await bootStack()
    const { reqId, output, record } = await served(booted)
    await resignedOverbill(booted, reqId, record.tokensOut + 500)
    const body = { req_ids: [reqId], reason: "again", material: { prompt: request, output } }
    const [one, two] = await Promise.all([dispute(booted, body), dispute(booted, body)])
    expect([one.outcome, two.outcome].sort()).toEqual(["rejected", "upheld"])
    expect((await dispute(booted, body)).checks[0]!.reasons).toContain("already_refunded")
    expect((await refunds(booted)).rows.length).toBe(1)
  })

  test("outside the window, another's record, and bad bodies are refused", async () => {
    const booted = await bootStack()
    const { reqId } = await served(booted)
    expect((await post(booted, { req_ids: [], reason: "x" })).status).toBe(400)
    expect((await post(booted, { req_ids: ["0x12"], reason: "x" })).status).toBe(400)
    expect((await post(booted, { req_ids: [`0x${"ab".repeat(32)}`], reason: "x" })).status).toBe(400)
    await booted.stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ('sess_other', '0x000000000000000000000000000000000000dead', '', to_timestamp($1))", [booted.stack.clock() + 60])
    expect((await booted.app.request("/v1/disputes", { method: "POST", headers: { authorization: "Bearer sess_other" }, body: JSON.stringify({ req_ids: [reqId], reason: "mine now" }) })).status).toBe(400)
    booted.stack.setClock(booted.stack.clock() + DISPUTE_WINDOW_S + 1)
    const late = await post(booted, { req_ids: [reqId], reason: "late" })
    expect(late.status).toBe(400)
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe("dispute_window")
  })

  test("a dispute survives a restart", async () => {
    const before = await bootStack()
    const { reqId } = await served(before)
    const opened = await dispute(before, { req_ids: [reqId], reason: "kept" })
    const after = await bootStack({ db: before.stack.db })
    expect(await listDisputes(after.stack, after.buyer)).toMatchObject([{ id: opened.id, reqIds: [reqId], reason: "kept", status: "decided", outcome: "rejected" }])
  })

  test("embeddings are recounted from their input", async () => {
    const booted = await bootStack()
    const body = JSON.stringify({ model: "ofm-embed", input: "hello embeddings" })
    const res = await booted.app.request("/v1/embeddings", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body })
    const { reqId } = ((await res.json()) as { offpeak_usage: { record: { reqId: string } } }).offpeak_usage.record
    const result = await dispute(booted, { req_ids: [reqId], reason: "embed", material: { prompt: { input: ["hello embeddings"] }, output: "" } })
    expect(result.outcome).toBe("rejected")
    expect(result.checks[0]!.reasons).toEqual([])
  })
})
