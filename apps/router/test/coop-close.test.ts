import { describe, expect, test } from "bun:test"
import { ChannelManagerAbi } from "@offpeak/abis"
import { channelAuthHeader, channelPaymentId, coopCloseTypes, domain, voucherTypes, type ChannelChain } from "@offpeak/shared"
import { decodeFunctionData, keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem"
import { readChannel, reserveChannel, sweepCloses } from "../src/pay/channel-store.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const payerKey = roleAccount("buyer")
const id = keccak256(toBytes("close-channel"))

function openChannel(booted: Booted, deposit = 50_000_000n, claimed = 0n) {
  const row: ChannelChain = { payer: booted.buyer as Hex, deposit, claimed, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false }
  booted.indexer.channels.set(id, row)
  return row
}

async function chat(booted: Booted, text: string) {
  const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: text }], max_tokens: 8 })
  const auth = await channelAuthHeader(payerKey, { channelId: id, ts: booted.stack.clock(), body })
  return booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
}

async function close(booted: Booted, finalCumulative: bigint, deadline = BigInt(booted.stack.clock() + 600), signer = payerKey) {
  const payerSig = await signer.signTypedData({
    domain: domain("OffpeakChannel", booted.stack.channelManager),
    types: coopCloseTypes,
    primaryType: "CooperativeClose",
    message: { channelId: id, finalCumulative, deadline },
  })
  return booted.app.request(`/v1/channels/${id}/close`, { method: "POST", body: JSON.stringify({ finalCumulative: finalCumulative.toString(), deadline: deadline.toString(), payerSig }) })
}

const owed = async (booted: Booted) => {
  const local = await readChannel(booted.stack.db, id)
  return local.cumulative + local.unvouchered
}

const closeRow = (booted: Booted) => booted.stack.db.query<{ amount_micro: string; req_ids: string[]; kind: string }>("SELECT * FROM shared.agent_payments WHERE payment_id = $1", [channelPaymentId(id, 2n ** 64n - 1n)])

describe("cooperative close", () => {
  test("signs what the contract checks, stops the channel, and leaves a payment row for what was unvouchered", async () => {
    const booted = await bootStack()
    openChannel(booted)
    expect((await chat(booted, "one")).status).toBe(200)
    expect((await chat(booted, "two")).status).toBe(200)
    const final = await owed(booted)
    const deadline = BigInt(booted.stack.clock() + 600)
    const res = await close(booted, final, deadline)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { routerSig: Hex; to: Hex; data: Hex; value: string; chainId: number }
    expect(Object.keys(body).sort()).toEqual(["chainId", "data", "routerSig", "to", "value"])
    expect(body.value).toBe("0")
    expect(body.chainId).toBe(4663)
    expect(body.to).toBe(booted.stack.channelManager as Hex)
    const typed = { domain: domain("OffpeakChannel", booted.stack.channelManager), types: coopCloseTypes, primaryType: "CooperativeClose", message: { channelId: id, finalCumulative: final, deadline } } as const
    expect((await recoverTypedDataAddress({ ...typed, signature: body.routerSig })).toLowerCase()).toBe(booted.stack.payee!.address.toLowerCase())
    const { functionName, args } = decodeFunctionData({ abi: ChannelManagerAbi, data: body.data })
    expect(functionName).toBe("cooperativeClose")
    expect(args![0]).toBe(id)
    expect(args![1]).toEqual({ channelId: id, finalCumulative: final, deadline })
    expect(args![3]).toBe(body.routerSig)

    const refused = await chat(booted, "after")
    expect(refused.status).toBe(402)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("channel_closing")

    const row = (await closeRow(booted)).rows[0]!
    expect(row.kind).toBe("channel")
    expect(BigInt(row.amount_micro)).toBe(final)
    expect(row.req_ids.length).toBe(2)
    const left = await booted.stack.db.query("SELECT 1 FROM serving.owed_boundaries WHERE channel_id = $1", [id])
    expect(left.rows.length).toBe(0)
  })

  test("a figure below what is owed is refused, keeps the channel still, and names the figure that works", async () => {
    const booted = await bootStack()
    openChannel(booted)
    expect((await chat(booted, "one")).status).toBe(200)
    const final = await owed(booted)
    const low = await close(booted, final - 1n)
    expect(low.status).toBe(409)
    const { error } = (await low.json()) as { error: { code: string; required: string; owed: string; in_flight: string } }
    expect(error.code).toBe("close_below_owed")
    expect(BigInt(error.required)).toBe(final)
    expect((await chat(booted, "more")).status).toBe(402)
    expect((await closeRow(booted)).rows.length).toBe(0)
    expect((await close(booted, final)).status).toBe(200)
  })

  test("in-flight reservations count, and a record that lands after the signature is still paid for", async () => {
    const booted = await bootStack()
    const row = openChannel(booted)
    const { db } = booted.stack
    expect((await chat(booted, "served")).status).toBe(200)
    const served = await owed(booted)
    const held = await reserveChannel(db, row, id, 100_000n, booted.stack.clock())
    if (!held.ok) throw new Error("not admitted")
    const short = await close(booted, served)
    expect(short.status).toBe(409)
    const { error } = (await short.json()) as { error: { required: string; in_flight: string } }
    expect(BigInt(error.in_flight)).toBe(100_000n)
    expect(BigInt(error.required)).toBe(served + 100_000n)
    expect((await close(booted, served + 100_000n)).status).toBe(200)
    expect((await closeRow(booted)).rows.length).toBe(0)
    const { noteChannel } = await import("../src/pay/channel-store.ts")
    await db.transaction((tx) => noteChannel(tx, row.payer, id, held.reservationId, 7_000n, "0xlate"))
    const paid = (await closeRow(booted)).rows[0]!
    expect(BigInt(paid.amount_micro)).toBe(served + 100_000n)
    expect(paid.req_ids).toContain("0xlate")
    expect(paid.req_ids.length).toBe(2)
  })

  test("a reservation left by a dead router expires, so the close can finish", async () => {
    const booted = await bootStack()
    const row = openChannel(booted)
    const { db } = booted.stack
    await reserveChannel(db, row, id, 100_000n, booted.stack.clock())
    expect((await close(booted, 100_000n)).status).toBe(200)
    await sweepCloses(db, booted.stack.clock())
    expect((await closeRow(booted)).rows.length).toBe(0)
    await sweepCloses(db, booted.stack.clock() + 901)
    expect((await closeRow(booted)).rows.length).toBe(1)
  })

  test("requests racing a close can never leave more owed than the signed figure", async () => {
    for (let round = 0; round < 5; round++) {
      const booted = await bootStack()
      openChannel(booted)
      expect((await chat(booted, "first")).status).toBe(200)
      const racing = Array.from({ length: 12 }, (_, i) => chat(booted, `race ${round} ${i}`))
      const required = async () => {
        const local = await readChannel(booted.stack.db, id)
        const held = await booted.stack.db.query<{ total: string | null }>("SELECT SUM(amount) AS total FROM serving.channel_reservations WHERE channel_id = $1", [id])
        return local.cumulative + local.unvouchered + BigInt(held.rows[0]?.total ?? 0)
      }
      await Bun.sleep(round)
      let signed = await close(booted, await required())
      for (let i = 0; i < 5 && signed.status === 409; i++) {
        const { error } = (await signed.json()) as { error: { required: string } }
        signed = await close(booted, BigInt(error.required))
      }
      expect(signed.status).toBe(200)
      const final = decodeFunctionData({ abi: ChannelManagerAbi, data: ((await signed.json()) as { data: Hex }).data }).args![1] as { finalCumulative: bigint }
      await Promise.all(racing)
      const records = await booted.stack.db.query<{ cost: string }>("SELECT SUM(host_cost_micro + fee_micro) AS cost FROM shared.usage_records")
      expect(BigInt(records.rows[0]!.cost)).toBeLessThanOrEqual(final.finalCumulative)
      expect((await chat(booted, "after")).status).toBe(402)
    }
  }, 30_000)

  test("a voucher after the signature is refused, so nothing is counted twice", async () => {
    const booted = await bootStack()
    openChannel(booted)
    expect((await chat(booted, "one")).status).toBe(200)
    const final = await owed(booted)
    expect((await close(booted, final)).status).toBe(200)
    const sig = await payerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: final } })
    const res = await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: final.toString(), sig }) })
    expect(res.status).toBe(409)
    const state = await booted.stack.db.query("SELECT 1 FROM shared.channel_state WHERE channel_id = $1", [id])
    expect(state.rows.length).toBe(0)
  })

  test("what was vouchered stays with its row, and the close row holds only the rest", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const first = await chat(booted, "one")
    const vouchered = BigInt(first.headers.get("x-offpeak-channel-owed")!)
    const sig = await payerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: vouchered } })
    expect((await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: vouchered.toString(), sig }) })).status).toBe(200)
    expect((await chat(booted, "two")).status).toBe(200)
    const final = await owed(booted)
    expect((await close(booted, final)).status).toBe(200)
    const rows = await booted.stack.db.query<{ amount_micro: string; voucher_seq: string }>("SELECT amount_micro, voucher_seq FROM shared.agent_payments WHERE channel_id = $1 ORDER BY voucher_seq", [id])
    expect(rows.rows.map((row) => [BigInt(row.amount_micro), Number(row.voucher_seq)])).toEqual([
      [vouchered, 1],
      [final - vouchered, 2],
    ])
  })

  test("once signed the amount is final, and a lapsed deadline can be signed again", async () => {
    const booted = await bootStack()
    openChannel(booted)
    expect((await chat(booted, "one")).status).toBe(200)
    const final = await owed(booted)
    expect((await close(booted, final + 5n)).status).toBe(200)
    const other = await close(booted, final)
    expect(other.status).toBe(409)
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("close_already_signed")
    expect((await close(booted, final + 5n, BigInt(booted.stack.clock() + 7200))).status).toBe(200)
  })

  test("a claim already on chain sets the lowest figure the contract would take", async () => {
    const booted = await bootStack()
    openChannel(booted, 50_000_000n, 900n)
    expect((await close(booted, 899n)).status).toBe(409)
    expect((await close(booted, 900n)).status).toBe(200)
  })

  test("refuses a stranger, bad input, and anything the contract would revert, without freezing", async () => {
    const booted = await bootStack()
    openChannel(booted, 1_000n)
    expect((await close(booted, 0n, undefined, roleAccount("host"))).status).toBe(401)
    expect((await close(booted, 0n, BigInt(booted.stack.clock() - 1))).status).toBe(400)
    expect((await close(booted, 1_001n)).status).toBe(400)
    const garbled = await booted.app.request(`/v1/channels/${id}/close`, { method: "POST", body: JSON.stringify({ finalCumulative: "-1", deadline: "x", payerSig: "nope" }) })
    expect(garbled.status).toBe(400)
    expect((await readChannel(booted.stack.db, id)).frozenUntil).toBe(0)
    expect((await readChannel(booted.stack.db, id)).closeFinal).toBe(null)
    expect((await chat(booted, "still open")).status).toBe(200)
    expect((await booted.app.request(`/v1/channels/${keccak256(toBytes("nobody"))}/close`, { method: "POST", body: "{}" })).status).toBe(400)
  })

  test("a closed channel, an unknown one, and a router that is not the payee all refuse", async () => {
    const booted = await bootStack()
    const row = openChannel(booted)
    row.status = 3
    expect((await close(booted, 0n)).status).toBe(409)
    booted.indexer.channels.delete(id)
    expect((await close(booted, 0n)).status).toBe(404)
    openChannel(booted)
    booted.stack.channelPayee = roleAccount("settlerA").address
    const res = await close(booted, 0n)
    expect(res.status).toBe(503)
    expect((await readChannel(booted.stack.db, id)).frozenUntil).toBe(0)
  })

  test("a refused close stops freezing the channel after a while, and a payer can close while a challenge runs", async () => {
    const booted = await bootStack()
    const row = openChannel(booted)
    expect((await chat(booted, "one")).status).toBe(200)
    expect((await close(booted, 0n)).status).toBe(409)
    expect((await chat(booted, "frozen")).status).toBe(402)
    booted.stack.setClock(booted.stack.clock() + 901)
    expect((await chat(booted, "thawed")).status).toBe(200)
    row.status = 2
    row.closeRequested = true
    expect((await close(booted, await owed(booted))).status).toBe(200)
  })
})
