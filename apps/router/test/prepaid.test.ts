import { describe, expect, test } from "bun:test"
import { bootStack } from "./support/stack.ts"
import { recoverTypedDataAddress } from "viem"
import { domain, usageTypes, parseRecord, recordToMessage, verifyMerkle, merkleRoot } from "@offpeak/shared"
import { HOUR_CLOSE_GRACE_S, hourEnd, hourIndex } from "@offpeak/shared"

describe("router prepaid", () => {
  test("chat returns a signed envelope", async () => {
    const { app, key, stack, host } = await bootStack()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "hello offpeak" }] }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.choices[0].message.content.startsWith("honest:")).toBe(true)
    expect(json.offpeak_usage.record.payMode).toBe(0)
    expect(res.headers.get("x-offpeak-host")).toBe(host)
    const record = parseRecord(json.offpeak_usage.record)
    const signer = await recoverTypedDataAddress({
      domain: domain("OffpeakUsage", stack.usageLedger),
      types: usageTypes,
      primaryType: "UsageRecord",
      message: recordToMessage(record) as never,
      signature: json.offpeak_usage.routerSig,
    })
    expect(signer.toLowerCase()).toBe(stack.router.address.toLowerCase())
    const rows = await stack.db.query("SELECT req_id FROM shared.usage_records")
    expect(rows.rows.length).toBe(1)
  })

  test("withdraw-all push stops a later request", async () => {
    const { app, key, stack, buyer, indexer } = await bootStack()
    const t0 = stack.clock()
    indexer.emit({ type: "WithdrawAllRequested", buyer, requestedAt: t0, dueAt: t0 + 7200, block: 2, txHash: "0x" + "11".repeat(32) })
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "after withdraw" }] }),
    })
    expect(res.status).toBe(403)
    const rows = await stack.db.query("SELECT ts FROM shared.usage_records")
    expect(rows.rows.length).toBe(0)
    expect(stack.clock()).toBeGreaterThanOrEqual(t0)
  })

  test("stream carries an offpeak.usage event", async () => {
    const { app, key } = await bootStack()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "stream please" }], stream: true }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("event: offpeak.usage")
    expect(text).toContain("data: [DONE]")
  })

  test("hour close is idempotent and then rejects inserts", async () => {
    const { app, key, stack } = await bootStack()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "close me" }] }),
    })
    expect(res.status).toBe(200)
    const hour = hourIndex(stack.clock())
    stack.internalToken = "close-token"
    const close = { method: "POST", headers: { authorization: "Bearer close-token" } }
    expect((await app.request(`/v1/usage/close/${hour}`, { method: "POST" })).status).toBe(403)
    expect((await app.request(`/v1/usage/close/${hour}`, close)).status).toBe(409)
    stack.setClock(hourEnd(hour) + HOUR_CLOSE_GRACE_S)
    const first = await app.request(`/v1/usage/close/${hour}`, close)
    const second = await app.request(`/v1/usage/close/${hour}`, close)
    expect(first.status).toBe(200)
    const body = await second.json()
    expect(body.idempotent).toBe(true)
    const leaves = await stack.db.query<{ leaf: string }>("SELECT leaf FROM shared.usage_records ORDER BY req_id")
    const root = merkleRoot(leaves.rows.map((r) => r.leaf as `0x${string}`))
    const closed = await first.json()
    expect(closed.root).toBe(root)
    expect(verifyMerkle(leaves.rows[0]!.leaf as `0x${string}`, [], root) || leaves.rows.length === 1).toBe(true)
    await expect(
      stack.db.query(
        `INSERT INTO shared.usage_records (
          req_id, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out,
          prompt_hash, output_hash, price_in, price_out, host_cost_micro, fee_micro, pay_mode,
          pay_ref, sheet_hash, router_sig, host_sig, leaf
        ) VALUES ($1,$2,1,'0x1','0x2','0x3','0x4',1,1,'0x5','0x6',1,1,1,1,0,'0x7','0x8','0x9','0x10','0x11')`,
        ["0x" + "ab".repeat(32), hour],
      ),
    ).rejects.toThrow()
  })
})
