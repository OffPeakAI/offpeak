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
