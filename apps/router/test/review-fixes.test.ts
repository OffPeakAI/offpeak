import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { keccak256, toBytes, type Hex } from "viem"
import { LiveChain } from "../src/chainview/live.ts"
import { sweepCaptures } from "../src/pay/captures.ts"
import { acceptVoucher, noteChannel, readChannel, reserveChannel } from "../src/pay/channel-store.ts"
import { channelAuthHeader, domain, voucherTypes, type ChannelChain } from "@offpeak/shared"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"

const buyerKey = roleAccount("buyer")
const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const prepaid = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...extra })

function openChannel(booted: Awaited<ReturnType<typeof bootStack>>, id: Hex, deposit = 50_000_000n) {
  const row: ChannelChain = {
    payer: booted.buyer as Hex,
    deposit,
    claimed: 0n,
    lastSeq: 0n,
    expiry: BigInt(booted.stack.clock() + 86_400),
    challengeEndsAt: 0n,
    status: 1,
    closeRequested: false,
  }
  booted.indexer.channels.set(id, row)
  return row
}

const usageRows = (booted: Awaited<ReturnType<typeof bootStack>>) =>
  booted.stack.db.query<{ pay_mode: number; price_in: string; tokens_out: number; host_cost_micro: string; fee_micro: string }>("SELECT * FROM shared.usage_records ORDER BY ts")

describe("Window fallback", () => {
  test("a non-holder falling back pays the prepaid price, in a prepaid record", async () => {
    const booted = await bootStack()
    booted.indexer.windows.set("7", { id: 7n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: 0n, t1: BigInt(booted.stack.clock() + 3600), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
    const refused = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token, { "x-offpeak-window": "7" }), body: chatBody("window") })
    expect(refused.status).toBe(402)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token, { "x-offpeak-window": "7", "x-offpeak-window-fallback": "prepaid" }), body: chatBody("window") })
    expect(res.status).toBe(200)
    const rows = await usageRows(booted)
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0]!.pay_mode).toBe(0)
    expect(BigInt(rows.rows[0]!.price_in)).toBeGreaterThan(0n)
  })
})

describe("channel requests", () => {
  const id = keccak256(toBytes("review-channel"))

  test("a channel id alone spends nothing", async () => {
    const booted = await bootStack()
    openChannel(booted, id)
    const body = chatBody("steal")
    const bare = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id }, body })
    expect(bare.status).toBe(401)
    const wrong = await channelAuthHeader(roleAccount("host"), { channelId: id, ts: booted.stack.clock(), body })
    expect((await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": wrong }, body })).status).toBe(401)
    const stale = await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock() - 120, body })
    expect((await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": stale }, body })).status).toBe(401)
    const otherBody = await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body: chatBody("different") })
    expect((await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": otherBody }, body })).status).toBe(401)
    const good = await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body })
    const send = () => booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": good }, body })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(401)
  })

  test("a stale voucher from a retry does not fail the request", async () => {
    const booted = await bootStack()
    openChannel(booted, id)
    const body = chatBody("retry")
    const proof = async (text: string) => channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body: text })
    const first = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": await proof(body) }, body })
    const owed = BigInt(first.headers.get("x-offpeak-channel-owed")!)
    const sig = await buyerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: owed } })
    const voucher = Buffer.from(JSON.stringify({ seq: "1", cumulative: owed.toString(), sig })).toString("base64url")
    for (const text of [chatBody("one"), chatBody("two")]) {
      const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-voucher": voucher, "x-offpeak-channel-auth": await proof(text) }, body: text })
      expect(res.status).toBe(200)
    }
  })

  test("owed never includes another request's reservation, and a dead request's reservation expires", async () => {
    const booted = await bootStack()
    const row = openChannel(booted, id, 2_000_000n)
    const { db } = booted.stack
    const now = booted.stack.clock()
    const held = await reserveChannel(db, row, id, 100_000n, now)
    const mine = await reserveChannel(db, row, id, 50_000n, now)
    if (!held.ok || !mine.ok) throw new Error("not admitted")
    const owed = await db.transaction((tx) => noteChannel(tx, row.payer, id, mine.reservationId, 7n, "0xaa"))
    expect(owed).toBe(7n)
    expect((await reserveChannel(db, row, id, 150_000n, now)).ok).toBe(false)
    expect((await reserveChannel(db, row, id, 150_000n, now + 901)).ok).toBe(true)
  })

  test("a voucher cannot lower what is owed, and only what it covers leaves pending", async () => {
    const booted = await bootStack()
    const row = openChannel(booted, id)
    const { db } = booted.stack
    const now = booted.stack.clock()
    const serve = async (reqId: string, amount: bigint) => {
      const reserved = await reserveChannel(db, row, id, amount, now)
      if (!reserved.ok) throw new Error("not admitted")
      return db.transaction((tx) => noteChannel(tx, row.payer, id, reserved.reservationId, amount, reqId))
    }
    const low = await serve("0xa", 19n)
    const high = await serve("0xb", 38n)
    const sig = async (seq: bigint, cumulative: bigint) =>
      buyerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq, cumulative } })
    expect(await acceptVoucher(db, row, id, { seq: 1n, cumulative: low, sig: await sig(1n, low) })).toBe("ok")
    expect((await readChannel(db, id)).pending).toEqual(["0xb"])
    const covered = await db.query<{ req_ids: string[] }>("SELECT req_ids FROM serving.owed_boundaries WHERE channel_id = $1", [id])
    expect(covered.rows.map((r) => r.req_ids)).toEqual([["0xb"]])
    expect(await acceptVoucher(db, row, id, { seq: 2n, cumulative: high, sig: await sig(2n, high) })).toBe("ok")
    expect(await acceptVoucher(db, row, id, { seq: 3n, cumulative: low, sig: await sig(3n, low) })).toBe("stale")
    expect(await acceptVoucher(db, row, id, { seq: 3n, cumulative: high + 1n, sig: await sig(3n, high + 1n) })).toBe("bad_boundary")
    const paid = await db.query<{ amount_micro: string; req_ids: string[] }>("SELECT amount_micro, req_ids FROM shared.agent_payments WHERE channel_id = $1 ORDER BY voucher_seq", [id])
    expect(paid.rows.map((r) => [BigInt(r.amount_micro), r.req_ids])).toEqual([
      [19n, ["0xa"]],
      [38n, ["0xb"]],
    ])
    expect((await readChannel(db, id)).cumulative).toBe(high)
    await db.query("INSERT INTO serving.owed_boundaries (channel_id, cumulative, req_ids) VALUES ($1,$2,'{0xa}')", [id, low.toString()])
    expect(await acceptVoucher(db, row, id, { seq: 4n, cumulative: low, sig: await sig(4n, low) })).toBe("stale")
  })
})
