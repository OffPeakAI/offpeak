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
