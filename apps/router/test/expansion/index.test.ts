import { describe, expect, test } from "bun:test"
import { aggregatePrints, type Print } from "../../src/expansion/index-feed.ts"
import { verifyIndex } from "../../../../packages/sdk/src/index-feed.ts"
import { bootStack } from "../support/stack.ts"
const prints = (): Print[] =>
  Array.from({ length: 15 }, (_, i) => ({
    id: `id${i}`,
    ts: 3600,
    payer: `buyer${i % 5}`,
    host: `host${i % 3}`,
    model: "m",
    input: 100,
    output: 100,
    cost: "100",
    fee: "4",
    settled: true,
  }))
describe("signed price index", () => {
  test("deduplicates, excludes self payments and unpaid data, and uses exact integer prices", () => {
    const p = prints(),
      r = aggregatePrints([...p, p[0]!, { ...p[0]!, id: "self", payer: "HOST0" }, { ...p[0]!, id: "unpaid", settled: false }])
    expect(r.records).toBe(15)
    expect(r.blendedMicroPerMillion).toBe("520000")
    expect(r.buyers).toBe(5)
  })
  test("suppresses sparse and concentrated markets rather than reporting zero", () => {
    expect(aggregatePrints([]).blendedMicroPerMillion).toBeNull()
    expect(aggregatePrints(prints().map((r, i) => ({ ...r, host: i < 12 ? "host0" : `host${i}` }))).reason).toBe("concentrated_supply")
  })
  test("empty database signs a truthful no-data publication; alteration and wrong signer fail", async () => {
    const { app, stack } = await bootStack()
    try {
      const r = await app.request("/v1/index")
      expect(r.status).toBe(200)
      const f = await r.json()
      expect(f.payload.status).toBe("insufficient_data")
      const pin = { signer: stack.router.address, usageLedger: stack.usageLedger as `0x${string}`, chainId: 4663, now: stack.clock() }
      expect(await verifyIndex(f, pin)).toBe(true)
      expect(await verifyIndex({ ...f, payload: { ...f.payload, status: "published" } }, pin)).toBe(false)
      expect(await verifyIndex(f, { ...pin, now: stack.clock() + 121 })).toBe(false)
    } finally {
      /* bootStack owns the in-process database */
    }
  })
})

test("the public feed excludes unsettled and refunded requests", async () => {
  const { app, stack, key } = await bootStack()
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "receipt" }], max_tokens: 8 }),
  })
  expect(response.status).toBe(200)
  const { offpeak_usage } = await response.json()
  stack.setClock(stack.clock() + 3600)
  expect((await (await app.request("/v1/index")).json()).payload.points.length).toBe(0)
  await stack.db.query("UPDATE shared.usage_records SET settled_hour_tx=$1", [`0x${"ab".repeat(32)}`])
  const feed = await (await app.request("/v1/index")).json()
  expect(feed.payload.points[0].records).toBe(1)
  expect(feed.payload.points[0].blendedMicroPerMillion).toBeNull()
  await stack.db.query("INSERT INTO shared.refunds (id,payer,amount,reason,req_ids) VALUES ('refund',$1,1,'test',$2)", [
    key.accountId,
    [offpeak_usage.record.reqId],
  ])
  expect((await (await app.request("/v1/index")).json()).payload.points.length).toBe(0)
})
