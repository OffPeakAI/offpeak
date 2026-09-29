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
