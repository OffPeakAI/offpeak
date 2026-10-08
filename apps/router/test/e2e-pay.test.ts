import { describe, expect, test } from "bun:test"
import { keccak256, toBytes, type Hex } from "viem"
import { domain, permitWitnessTypes, voucherTypes, PERMIT2, channelAuthHeader } from "@offpeak/shared"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"

async function signVoucher(channelId: Hex, seq: bigint, cumulative: bigint, verifyingContract: string) {
  const buyer = roleAccount("buyer")
  const sig = await buyer.signTypedData({
    domain: domain("OffpeakChannel", verifyingContract),
    types: voucherTypes,
    primaryType: "Voucher",
    message: { channelId, seq, cumulative },
  })
  return Buffer.from(JSON.stringify({ seq: seq.toString(), cumulative: cumulative.toString(), sig })).toString("base64url")
}

describe("channel vouchers", () => {
  test("one thousand calls accept a voucher each time", async () => {
    const { app, key, stack, buyer, indexer } = await bootStack()
    await stack.db.query("UPDATE serving.api_keys SET rpm_limit = 5000")
    const channelId = keccak256(toBytes("chan-e2e"))
    indexer.channels.set(channelId, {
      payer: buyer as Hex,
      deposit: 50_000_000n,
      claimed: 0n,
      lastSeq: 0n,
      expiry: BigInt(stack.clock() + 86_400),
      challengeEndsAt: 0n,
      status: 1,
      closeRequested: false,
    })
    let owed = 0n
    let seq = 0n
    for (let i = 0; i < 1000; i++) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
        "x-offpeak-channel": channelId,
      }
      if (i > 0) headers["x-offpeak-voucher"] = await signVoucher(channelId, seq, owed, stack.channelManager)
      const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: `ping ${i}` }], max_tokens: 8 })
      headers["x-offpeak-channel-auth"] = await channelAuthHeader(roleAccount("buyer"), { channelId, ts: stack.clock(), body })
      const res = await app.request("/v1/chat/completions", { method: "POST", headers, body })
      expect(res.status).toBe(200)
      owed = BigInt(res.headers.get("x-offpeak-channel-owed") ?? "0")
      seq += 1n
    }
    const finalBody = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "final voucher" }], max_tokens: 8 })
    const tail = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
        "x-offpeak-channel": channelId,
        "x-offpeak-voucher": await signVoucher(channelId, seq, owed, stack.channelManager),
        "x-offpeak-channel-auth": await channelAuthHeader(roleAccount("buyer"), { channelId, ts: stack.clock(), body: finalBody }),
      },
      body: finalBody,
    })
    expect(tail.status).toBe(200)
    const state = await stack.db.query<{ latest_seq: string; cumulative: string }>("SELECT latest_seq, cumulative FROM shared.channel_state WHERE channel_id = $1", [channelId])
    expect(String(state.rows[0]?.latest_seq)).toBe("1000")
    expect(BigInt(state.rows[0]!.cumulative)).toBe(owed)
    const payments = await stack.db.query("SELECT payment_id FROM shared.agent_payments WHERE kind = 'channel'")
    expect(payments.rows.length).toBe(1000)
  }, 180_000)
})

describe("upto preconfirm", () => {
  test("pauses at 256 tokens until authorization, and a failure is unbilled", async () => {
    const { app, stack, facilitator } = await bootStack()
    facilitator.delayMs = 700
    const buyer = roleAccount("buyer")
    const reqOk = keccak256(toBytes("upto-ok"))
    const payload = await uptoPayload(stack, buyer, reqOk)
    const t0 = performance.now()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": JSON.stringify(payload) },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "longform please" }], max_tokens: 320, stream: true }),
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let firstAt = 0
    let chars = 0
    let sawPauseGap = false
    let last = performance.now()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const now = performance.now()
      if (!firstAt) firstAt = now
      if (now - last > 400) sawPauseGap = true
      last = now
      buf += dec.decode(chunk.value)
      chars = [...buf.matchAll(/"content":"(x+)"/g)].reduce((sum, match) => sum + match[1]!.length, 0)
    }
    expect(firstAt - t0).toBeLessThan(400)
    expect(sawPauseGap).toBe(true)
    expect(chars).toBeGreaterThanOrEqual(256)
    expect(buf).toContain("event: offpeak.usage")
    const rows = await stack.db.query("SELECT req_id FROM shared.usage_records")
    expect(rows.rows.length).toBe(1)

    facilitator.delayMs = 40
    const reqBad = keccak256(toBytes("upto-bad"))
    facilitator.failReqIds.add(reqBad)
    const bad = await uptoPayload(stack, buyer, reqBad)
    const failed = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": JSON.stringify(bad) },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "longform again" }], max_tokens: 320, stream: true }),
    })
    const text = await failed.text()
    expect(text).toContain("authorize_failed")
    const after = await stack.db.query("SELECT req_id FROM shared.usage_records")
    expect(after.rows.length).toBe(1)
  }, 30_000)
})

describe("window draw-down", () => {
  test("writes a window_perf sample and a zero-price record", async () => {
    const { app, key, stack, buyer, host, indexer } = await bootStack()
    indexer.windows.set("7", {
      id: 7n,
      host: host as Hex,
      modelDigest: stack.models[0]!.digest,
      t0: BigInt(stack.clock() - 10),
      t1: BigInt(stack.clock() + 3600),
      minTps: 1,
      units: 10n,
      hostPricePerUnit: 1n,
      buyerPricePerUnit: 1n,
      failed: false,
    })
    indexer.holders.set(`7:${buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json", "x-offpeak-window": "7" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "draw" }], max_tokens: 8 }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.offpeak_usage.record.payMode).toBe(4)
    expect(json.offpeak_usage.record.priceIn).toBe("0")
    const perf = await stack.db.query<{ demanded: boolean }>("SELECT window_id, demanded FROM shared.window_perf")
    expect(perf.rows.length).toBe(1)
    expect(perf.rows[0]?.demanded).toBe(true)
  })
})

async function uptoPayload(stack: Awaited<ReturnType<typeof bootStack>>["stack"], buyer: ReturnType<typeof roleAccount>, reqId: Hex) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const message = {
    permitted: { token: stack.usdg as Hex, amount: 2_000_000n },
    spender: stack.escrow as Hex,
    nonce: BigInt(`0x${reqId.slice(2, 10)}`),
    deadline,
    witness: {
      reqId,
      payee: stack.vault as Hex,
      maxAmount: 2_000_000n,
      validBefore: deadline,
      resourceHash: keccak256(toBytes("resource")),
    },
  }
  const signature = await buyer.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 },
    types: permitWitnessTypes("UptoWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  })
  return {
    x402Version: 2,
    scheme: "upto" as const,
    payload: {
      signature,
      permitted: { token: stack.usdg, amount: "2000000" },
      spender: stack.escrow,
      nonce: message.nonce.toString(),
      deadline: deadline.toString(),
      witness: {
        reqId,
        payee: stack.vault,
        maxAmount: "2000000",
        validBefore: deadline.toString(),
        resourceHash: message.witness.resourceHash,
      },
    },
  }
}
