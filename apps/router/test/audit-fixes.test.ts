import { describe, expect, test } from "bun:test"
import { PERMIT2, channelAuthHeader, channelPaymentId, domain, permitWitnessTypes, voucherTypes } from "@offpeak/shared"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"
import { uptoHeader } from "./support/upto.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const buyer = roleAccount("buyer")
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const chat = (booted: Booted, body = chatBody("hello")) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body })
const records = (booted: Booted) => booted.stack.db.query<{ req_id: string }>("SELECT req_id FROM shared.usage_records")
const flags = async (booted: Booted) => (await booted.stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")).rows.map((row) => row.reason)

/** Rewrites what the host answers on one path, and leaves the rest alone. */
function rewriteReply(booted: Booted, path: string, rewrite: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const inner = booted.stack.hosts.request
  booted.stack.hosts = {
    request: async (host, endpoint, target, init) => {
      const res = await inner(host, endpoint, target, init)
      if (target !== path || !res.ok) return res
      return Response.json(await rewrite((await res.json()) as Record<string, unknown>))
    },
  }
}

describe("the host's signature on a record", () => {
  test("a signature from another key leaves no record, and the hold goes back", async () => {
    const booted = await bootStack()
    rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostSig: await roleAccount("settlerB").signMessage({ message: "not a usage record" }) }))
    const res = await chat(booted)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unbilled")
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bad_host_sig"])
    expect(await booted.stack.ledger.committed(booted.buyer, 0n)).toBe(0n)
  })

  test("a signature that cannot be read is refused the same way", async () => {
    const booted = await bootStack()
    rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostSig: "0xjunk" }))
    expect((await chat(booted)).status).toBe(502)
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bad_host_sig"])
  })

  test("the host's own signature is stored", async () => {
    const booted = await bootStack()
    expect((await chat(booted)).status).toBe(200)
    expect((await records(booted)).rows.length).toBe(1)
    expect(await flags(booted)).toEqual([])
  })
})

const channelId = keccak256(toBytes("audit-channel"))

function openChannel(booted: Booted, id: Hex = channelId, deposit = 50_000_000n) {
  booted.indexer.channels.set(id, { payer: booted.buyer as Hex, deposit, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false })
}

/** Serves one channel request, which leaves a boundary a voucher can land on. */
async function owedOnChannel(booted: Booted, id: Hex = channelId) {
  const body = chatBody("one cheap call", { max_tokens: 4 })
  const auth = await channelAuthHeader(buyer, { channelId: id, ts: booted.stack.clock(), body })
  const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
  expect(res.status).toBe(200)
  return BigInt(res.headers.get("x-offpeak-channel-owed")!)
}

async function postVoucher(booted: Booted, seq: bigint, cumulative: bigint) {
  const sig = await buyer.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId, seq, cumulative } })
  return booted.app.request(`/v1/channels/${channelId}/voucher`, { method: "POST", body: JSON.stringify({ seq: seq.toString(), cumulative: cumulative.toString(), sig }) })
}

async function exactHeader(booted: Booted, reqId: Hex, amount: bigint) {
  const { stack } = booted
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const witness = { reqId, payee: stack.vault as Hex, amount, validBefore: deadline, resourceHash: keccak256(toBytes("resource")) }
  const message = { permitted: { token: stack.usdg as Hex, amount }, spender: stack.escrow as Hex, nonce: BigInt(`0x${reqId.slice(2, 10)}`), deadline, witness }
  const signature = await buyer.signTypedData({ domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 }, types: permitWitnessTypes("ExactWitness"), primaryType: "PermitWitnessTransferFrom", message } as never)
  return JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    payload: { signature, permitted: { token: stack.usdg, amount: amount.toString() }, spender: stack.escrow, nonce: message.nonce.toString(), deadline: deadline.toString(), witness: { ...witness, amount: amount.toString(), validBefore: deadline.toString() } },
  })
}

const streamed = (booted: Booted, payment: string) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "payment-signature": payment }, body: chatBody("write a long reply", { stream: true, max_tokens: 64 }) })
const embedded = (booted: Booted, payment: string) => booted.app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", "payment-signature": payment }, body: JSON.stringify({ model: "ofm-embed", input: "hello embeddings" }) })
const embedQuote = async (booted: Booted) => {
  const res = await booted.app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ofm-embed", input: "hello embeddings" }) })
  const payment = (await res.json()) as { accepts: { scheme: string; maxAmountRequired?: string; maxAmount?: string }[] }
  const exact = payment.accepts.find((row) => row.scheme === "exact")!
  return BigInt(exact.maxAmountRequired ?? exact.maxAmount!)
}

describe("x402 payment ids", () => {
  async function paidVoucher(booted: Booted) {
    openChannel(booted)
    const owed = await owedOnChannel(booted)
    expect((await postVoucher(booted, 1n, owed)).status).toBe(200)
    return channelPaymentId(channelId, 1n)
  }

  test("an upto reqId equal to a voucher's payment id is refused before a host is asked", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const paymentId = await paidVoucher(booted)
    const before = (await records(booted)).rows.length
    const res = await streamed(booted, await uptoHeader(booted.stack, buyer, paymentId))
    expect(res.status).toBe(402)
    expect(await errorCode(res)).toBe("payment_id_taken")
    expect((await records(booted)).rows.length).toBe(before)
    expect(booted.facilitator.captured.length).toBe(0)
  })

  test("an exact reqId equal to a voucher's payment id takes no money", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const paymentId = await paidVoucher(booted)
    const res = await embedded(booted, await exactHeader(booted, paymentId, await embedQuote(booted)))
    expect(res.status).toBe(402)
    expect(await errorCode(res)).toBe("payment_id_taken")
    expect((await booted.stack.db.query("SELECT 1 FROM serving.x402_requests")).rows.length).toBe(0)
  })

  test("a voucher cannot land on the id of a payment already being served", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    openChannel(booted)
    const owed = await owedOnChannel(booted)
    const res = await streamed(booted, await uptoHeader(booted.stack, buyer, channelPaymentId(channelId, 1n)))
    expect(res.status).toBe(200)
    const refused = await postVoucher(booted, 1n, owed)
    expect(refused.status).toBe(409)
    expect(await errorCode(refused)).toBe("payment_id_taken")
    expect(await res.text()).toContain("offpeak.usage")
    expect((await postVoucher(booted, 2n, owed)).status).toBe(200)
  })

  test("an unserved upto gives its id back", async () => {
    const booted = await bootStack({ failHost: true })
    booted.facilitator.delayMs = 1
    const reqId = keccak256(toBytes("never-served"))
    expect((await streamed(booted, await uptoHeader(booted.stack, buyer, reqId))).status).toBe(503)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.x402_requests")).rows.length).toBe(0)
  })

  test("a fresh reqId is billed and captured", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    await paidVoucher(booted)
    const before = (await records(booted)).rows.length
    const res = await streamed(booted, await uptoHeader(booted.stack, buyer, keccak256(toBytes("a-fresh-req-id"))))
    expect(await res.text()).toContain("offpeak.usage")
    expect((await records(booted)).rows.length).toBe(before + 1)
  })
})
