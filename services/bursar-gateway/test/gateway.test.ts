import { expect, test } from "bun:test"
import { PGlite } from "@electric-sql/pglite"
import { wrapPglite } from "@offpeak/common"
import { capabilityId, hashRequest, requestCommit, requestDocument } from "@bursar/core"
import { createGateway, gatewaySql, type Config, type Ports, type Lock } from "../src/gateway.ts"
const address = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`
const config: Config = {
  origin: "https://merchant.example",
  merchant: address("1"),
  escrow: address("2"),
  asset: address("3"),
  priceMicro: 10000n,
  models: ["model"],
  capability: "service:inference.text",
}
const body = JSON.stringify({ model: "model", messages: [{ role: "user", content: "Hello" }] })
const binding = { requestHash: hashRequest(body), salt: `0x${"ab".repeat(32)}` as `0x${string}` }
const inputCommit = requestCommit(requestDocument({ method: "POST", url: config.origin + "/v1/chat/completions", binding }))
const proof = Buffer.from(
  JSON.stringify({
    payload: { lock: { escrow: config.escrow, id: "1", mandate: address("4"), transaction: `0x${"cd".repeat(32)}`, inputCommit }, binding },
  }),
).toString("base64")
async function setup(overrides: Partial<Ports> = {}, lockChanges: Partial<Lock> = {}) {
  const pg = new PGlite(),
    db = wrapPglite(pg)
  await db.exec(gatewaySql)
  let completions = 0,
    releases = 0
  const lock: Lock = {
    payer: address("4"),
    payee: config.merchant,
    amount: config.priceMicro,
    deadline: 1000n,
    status: 1,
    inputCommit,
    capabilityId: capabilityId(config.capability),
    ...lockChanges,
  }
  const ports: Ports = {
    readLock: async () => lock,
    isMandate: async () => true,
    lockedIn: async () => true,
    complete: async (_body, cap) => {
      expect(cap).toBe(10000n)
      completions++
      return { choices: [{ message: { content: "hello" } }] }
    },
    release: async () => {
      releases++
      return `0x${"ef".repeat(32)}`
    },
    ...overrides,
  }
  const app = createGateway(config, db, ports, async () => 100)
  const send = (raw = body, token: string | undefined = proof, cap = "10000") =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-offpeak-max-charge": cap, ...(token ? { "x-payment": token } : {}) },
      body: raw,
    })
  return { pg, app, send, lock, counts: () => ({ completions, releases }) }
}
test("quotes fixed task price, rejects malformed input, and never starts above the cap", async () => {
  const s = await setup()
  try {
    expect((await s.send("{")).status).toBe(400)
    expect((await s.send(body, undefined, "9999")).status).toBe(429)
    const r = await s.send(body, "")
    expect(r.status).toBe(402)
    expect((await r.json()).accepts[0].maxAmountRequired).toBe("10000")
    expect(s.counts()).toEqual({ completions: 0, releases: 0 })
  } finally {
    await s.pg.close()
  }
})
test("binds proof to exact body and verifies merchant, amount, capability, deadline and mandate", async () => {
  for (const change of [
    { payee: address("9") },
    { payer: address("9") },
    { amount: 9999n },
    { status: 2 },
    { deadline: 400n },
    { capabilityId: capabilityId("service:other") },
  ]) {
    const s = await setup({}, change)
    try {
      expect((await s.send()).status).toBe(402)
      expect(s.counts().completions).toBe(0)
    } finally {
      await s.pg.close()
    }
  }
  for (const override of [{ isMandate: async () => false }, { lockedIn: async () => false }]) {
    const s = await setup(override)
    try {
      expect((await s.send()).status).toBe(402)
    } finally {
      await s.pg.close()
    }
  }
  const s = await setup()
  try {
    expect((await s.send(body.replace("Hello", "changed"))).status).toBe(402)
  } finally {
    await s.pg.close()
  }
})
test("concurrent replays execute one task and one release; subsequent retries reuse output", async () => {
  const s = await setup()
  try {
    const results = await Promise.all([s.send(), s.send(), s.send()])
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0)
    const retry = await s.send()
    expect(retry.status).toBe(200)
    expect((await retry.json()).choices[0].message.content).toBe("hello")
    expect(s.counts()).toEqual({ completions: 1, releases: 1 })
  } finally {
    await s.pg.close()
  }
})
test("a failed inference never releases escrow or reruns on retry", async () => {
  const s = await setup({
    complete: async () => {
      throw Error("host unavailable")
    },
  })
  try {
    expect((await s.send()).status).toBe(502)
    expect((await s.send()).status).toBe(409)
    expect(s.counts().releases).toBe(0)
  } finally {
    await s.pg.close()
  }
})
test("failed settlement preserves output; concurrent retries settle without repeating inference", async () => {
  let releases = 0
  const s = await setup({
    release: async () => {
      if (++releases === 1) throw Error("RPC unavailable")
      return null
    },
  })
  try {
    expect((await s.send()).status).toBe(503)
    const responses = await Promise.all([s.send(), s.send()])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    expect(s.counts().completions).toBe(1)
    expect(releases).toBe(2)
    const settlement = JSON.parse(Buffer.from(responses[0]!.headers.get("x-payment-response")!, "base64").toString())
    expect(settlement.transaction).toBeNull()
  } finally {
    await s.pg.close()
  }
})
