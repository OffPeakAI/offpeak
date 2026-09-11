import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { PERMIT2, channelAuthHeader, permitWitnessTypes, type ChannelChain } from "@offpeak/shared"
import { keccak256, toBytes, type Hex } from "viem"
import { sweepExact } from "../src/pay/captures.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"
import { uptoHeader } from "./support/upto.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const buyer = roleAccount("buyer")
const body = (input: string | string[] = "hello embeddings") => JSON.stringify({ model: "ofm-embed", input })

async function exactHeader(booted: Booted, reqId: Hex, amount: bigint) {
  const { stack } = booted
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const witness = { reqId, payee: stack.vault as Hex, amount, validBefore: deadline, resourceHash: keccak256(toBytes("resource")) }
  const message = { permitted: { token: stack.usdg as Hex, amount }, spender: stack.escrow as Hex, nonce: BigInt(`0x${reqId.slice(2, 10)}`), deadline, witness }
  const signature = await buyer.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 },
    types: permitWitnessTypes("ExactWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  } as never)
  return JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    payload: {
      signature,
      permitted: { token: stack.usdg, amount: amount.toString() },
      spender: stack.escrow,
      nonce: message.nonce.toString(),
      deadline: deadline.toString(),
      witness: { ...witness, amount: amount.toString(), validBefore: deadline.toString() },
    },
  })
}

const embed = (booted: Booted, headers: Record<string, string>, text = body()) => booted.app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text })

async function quoted(booted: Booted, text = body()) {
  const res = await embed(booted, {}, text)
  expect(res.status).toBe(402)
  const payment = (await res.json()) as { accepts: { scheme: string; maxAmountRequired?: string; extra: { reqId: Hex } }[] }
  return payment.accepts
}

const payments = (booted: Booted) => booted.stack.db.query<{ payment_id: string; kind: string; payer: string; amount_micro: string; req_ids: string[] }>("SELECT * FROM shared.agent_payments")
const records = (booted: Booted) => booted.stack.db.query<{ pay_mode: number; pay_ref: string; host_cost_micro: string; fee_micro: string; req_id: string }>("SELECT * FROM shared.usage_records")

describe("exact for embeddings", () => {
  test("an unpaid call is offered the channel first and exact last, at the known cost", async () => {
    const booted = await bootStack()
    const accepts = await quoted(booted)
    expect(accepts.map((row) => row.scheme)).toEqual(["channel", "exact"])
    expect(BigInt(accepts[1]!.maxAmountRequired!)).toBeGreaterThan(0n)
    expect(accepts[1]!.extra.reqId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test("a paid call is served, recorded as exact, and owes what was collected", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const [, exact] = await quoted(booted)
    const amount = BigInt(exact!.maxAmountRequired!)
    const reqId = keccak256(toBytes("exact-ok"))
    const res = await embed(booted, { "payment-signature": await exactHeader(booted, reqId, amount) })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { offpeak_usage: { record: { payMode: number; payRef: string } } }
    expect(json.offpeak_usage.record.payMode).toBe(2)
    expect(json.offpeak_usage.record.payRef).toBe(reqId)
    expect(res.headers.get("payment-response")).toBeTruthy()
    const paid = (await payments(booted)).rows
    expect(paid.length).toBe(1)
    expect(paid[0]!.kind).toBe("exact")
    expect(paid[0]!.payment_id).toBe(reqId)
    expect(paid[0]!.payer).toBe(booted.buyer)
    const row = (await records(booted)).rows[0]!
    expect(BigInt(paid[0]!.amount_micro)).toBe(BigInt(row.host_cost_micro) + BigInt(row.fee_micro))
    expect(paid[0]!.req_ids).toEqual([row.req_id])
    expect(row.pay_mode).toBe(2)
    expect(booted.facilitator.captured.length).toBe(0)
    await sweepExact(booted.stack)
    expect((await booted.stack.db.query("SELECT 1 FROM shared.refunds")).rows.length).toBe(0)
  })

  test("a payment under the cost gets a fresh quote and takes no money", async () => {
    const booted = await bootStack()
    const [, exact] = await quoted(booted)
    const amount = BigInt(exact!.maxAmountRequired!)
    let settled = 0
    booted.stack.facilitator.settle = () => {
      settled += 1
      return { success: true }
    }
    const res = await embed(booted, { "payment-signature": await exactHeader(booted, keccak256(toBytes("exact-short")), amount - 1n) })
    expect(res.status).toBe(402)
    expect(((await res.json()) as { accepts: { maxAmountRequired?: string }[] }).accepts.at(-1)!.maxAmountRequired).toBe(amount.toString())
    expect(settled).toBe(0)
    expect((await records(booted)).rows.length).toBe(0)
  })

  test("paying over a price that fell leaves the difference for settlement to return", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const [, exact] = await quoted(booted)
    const amount = BigInt(exact!.maxAmountRequired!)
    const res = await embed(booted, { "payment-signature": await exactHeader(booted, keccak256(toBytes("exact-over")), amount + 9n) })
    expect(res.status).toBe(200)
    expect(BigInt((await payments(booted)).rows[0]!.amount_micro)).toBe(amount + 9n)
    const row = (await records(booted)).rows[0]!
    expect(BigInt(row.host_cost_micro) + BigInt(row.fee_micro)).toBe(amount)
  })

  test("a settlement that fails returns nothing and bills nothing", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 5
    const reqId = keccak256(toBytes("exact-fail"))
    booted.facilitator.failReqIds.add(reqId)
    const [, exact] = await quoted(booted)
    const res = await embed(booted, { "payment-signature": await exactHeader(booted, reqId, BigInt(exact!.maxAmountRequired!)) })
    expect(res.status).toBe(402)
    expect(await res.text()).not.toContain("embedding")
    expect((await records(booted)).rows.length).toBe(0)
    expect((await payments(booted)).rows.length).toBe(0)
  })

  test("over the budget the chain goes first, and a failure never reaches the host", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 5
    const large = body("word ".repeat(60_000))
    const [, exact] = (await quoted(booted, large)).filter((row) => row.scheme !== "upto")
    const amount = BigInt(exact!.maxAmountRequired!)
    expect(amount).toBeGreaterThan(20_000n)
    let calls = 0
    const real = booted.hostApps.get(booted.host)!
    const spy = new Hono()
    spy.all("*", async (c) => {
      const raw = c.req.method === "POST" ? await c.req.text() : undefined
      if (c.req.path.endsWith("/embeddings")) calls += 1
      return real.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: raw })
    })
    booted.hostApps.set(booted.host, spy)
    const failed = keccak256(toBytes("exact-large-fail"))
    booted.facilitator.failReqIds.add(failed)
    expect((await embed(booted, { "payment-signature": await exactHeader(booted, failed, amount) }, large)).status).toBe(402)
    expect(calls).toBe(0)
    expect((await embed(booted, { "payment-signature": await exactHeader(booted, keccak256(toBytes("exact-large-ok")), amount) }, large)).status).toBe(200)
    expect(calls).toBe(1)
  })

  test("money taken for a request no host served comes back, once, and only if it was taken", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const [, exact] = await quoted(booted)
    const amount = BigInt(exact!.maxAmountRequired!)
    const down = new Hono()
    down.all("*", (c) => c.text("down", 500))
    const healthy = booted.hostApps.get(booted.host)!
    booted.hostApps.set(booted.host, down)
    const reqId = keccak256(toBytes("exact-unserved"))
    expect((await embed(booted, { "payment-signature": await exactHeader(booted, reqId, amount) })).status).toBe(503)
    await Bun.sleep(20)
    expect(booted.indexer.escrows.get(reqId)?.status).toBe("captured")
    await sweepExact(booted.stack)
    await sweepExact(booted.stack)
    const refunds = await booted.stack.db.query<{ id: string; payer: string; amount: string; reason: string }>("SELECT * FROM shared.refunds")
    expect(refunds.rows.length).toBe(1)
    expect(refunds.rows[0]!.payer).toBe(booted.buyer)
    expect(BigInt(refunds.rows[0]!.amount)).toBe(amount)
    booted.hostApps.set(booted.host, healthy)
  })

  test("a payment the chain never took is not refunded, and stops being looked at once it expires", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const [, exact] = await quoted(booted)
    const down = new Hono()
    down.all("*", (c) => c.text("down", 500))
    booted.hostApps.set(booted.host, down)
    const reqId = keccak256(toBytes("exact-never-settled"))
    booted.facilitator.failReqIds.add(reqId)
    expect((await embed(booted, { "payment-signature": await exactHeader(booted, reqId, BigInt(exact!.maxAmountRequired!)) })).status).toBe(503)
    await Bun.sleep(20)
    const status = async () => (await booted.stack.db.query<{ status: string }>("SELECT status FROM serving.x402_requests WHERE req_id = $1", [reqId])).rows[0]!.status
    await sweepExact(booted.stack)
    expect((await booted.stack.db.query("SELECT 1 FROM shared.refunds")).rows.length).toBe(0)
    expect(await status()).toBe("refund_due")
    await booted.stack.db.query("UPDATE serving.x402_requests SET valid_before = 1")
    await sweepExact(booted.stack)
    expect(await status()).toBe("unpaid")
    expect((await booted.stack.db.query("SELECT 1 FROM shared.refunds")).rows.length).toBe(0)
  })

  test("a crash that loses a paid request is refunded by the sweep", async () => {
    const booted = await bootStack()
    const reqId = keccak256(toBytes("exact-crashed"))
    const now = booted.stack.clock()
    await booted.stack.db.query("INSERT INTO serving.x402_requests (req_id, payer, max_amount, status, valid_before, created_at) VALUES ($1,$2,500,'submitted',$3,$4)", [reqId, booted.buyer, now + 3600, now - 1000])
    booted.indexer.escrows.set(reqId, { status: "captured", maxAmount: 500n, captured: 500n })
    await sweepExact(booted.stack)
    expect((await booted.stack.db.query("SELECT 1 FROM shared.refunds")).rows.length).toBe(1)
  })

  test("exact stays refused on chat, whose cost is not known first", async () => {
    const booted = await bootStack()
    const res = await booted.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": await exactHeader(booted, keccak256(toBytes("exact-chat")), 1_000n) },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "x" }] }),
    })
    expect(res.status).toBe(400)
  })
})

describe("the other schemes the 402 offers", () => {
  test("a channel pays for embeddings, with the owed figure on the reply", async () => {
    const booted = await bootStack()
    const channelId = keccak256(toBytes("embed-channel"))
    const row: ChannelChain = { payer: booted.buyer as Hex, deposit: 50_000_000n, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false }
    booted.indexer.channels.set(channelId, row)
    const text = body()
    const res = await embed(booted, { "x-offpeak-channel": channelId, "x-offpeak-channel-auth": await channelAuthHeader(buyer, { channelId, ts: booted.stack.clock(), body: text }) }, text)
    expect(res.status).toBe(200)
    const owed = BigInt(res.headers.get("x-offpeak-channel-owed")!)
    const paid = (await records(booted)).rows[0]!
    expect(owed).toBe(BigInt(paid.host_cost_micro) + BigInt(paid.fee_micro))
    expect(paid.pay_mode).toBe(3)
  })

  test("upto pays for embeddings and captures only the cost", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const reqId = keccak256(toBytes("embed-upto"))
    const res = await embed(booted, { "payment-signature": await uptoHeader(booted.stack, buyer, reqId) })
    expect(res.status).toBe(200)
    const paid = (await records(booted)).rows[0]!
    expect(paid.pay_mode).toBe(1)
    expect(booted.facilitator.captured).toEqual([{ reqId, actual: BigInt(paid.host_cost_micro) + BigInt(paid.fee_micro) }])
  })

  test("prepaid still holds and captures, an unknown model is refused, and bad input says so", async () => {
    const booted = await bootStack()
    const auth = { authorization: `Bearer ${booted.key.token}` }
    expect((await embed(booted, auth)).status).toBe(200)
    expect((await records(booted)).rows[0]!.pay_mode).toBe(0)
    expect((await embed(booted, auth, JSON.stringify({ model: "ofm-8b", input: "x" }))).status).toBe(404)
    expect((await embed(booted, auth, JSON.stringify({ model: "ofm-embed", input: 7 }))).status).toBe(400)
    expect((await embed(booted, auth, JSON.stringify({ model: "ofm-embed", input: Array.from({ length: 2049 }, () => "x") }))).status).toBe(400)
    expect((await embed(booted, { ...auth, "x-offpeak-window": "1" })).status).toBe(400)
  })
})
