import { beforeAll, describe, expect, test } from "bun:test"
import { addressOf } from "../../../packages/abis/src/index.ts"
import { ZERO_BYTES32, merkleRoot } from "../../../packages/shared/src/index.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { keccak256, toBytes, type Hex } from "viem"
import { buildBatch, type BuyerFacts, type HourInput, type PaymentRow } from "./build.ts"
import { signRow, type RowOptions } from "./test-rows.ts"
import type { UsageRow, VerifyContext } from "./verify.ts"

const HOUR = 472_300
const ledger = addressOf("UsageLedger")
const router = roleAccount("router")
const buyer = roleAccount("buyer").address.toLowerCase()
const other = roleAccount("settlerA").address.toLowerCase()
const hostAddress = roleAccount("host").address.toLowerCase()

function signedRow(o: Omit<RowOptions, "hour" | "payer"> & { payer?: string }) {
  return signRow({ payer: buyer, ...o, hour: HOUR }, ledger)
}

const ctx: VerifyContext = {
  routerAddress: router.address,
  usageLedger: ledger,
  hostServingAt: () => true,
  discountBps: () => 0,
}

const openFacts: BuyerFacts = { hourlyCap: 1_000_000_000n, dailyCap: 4_000_000_000n, withdrawRequestedAt: 0n, dayDebited: 0n }

function input(rows: UsageRow[], overrides: Partial<HourInput> = {}): HourInput {
  return {
    hour: HOUR,
    chainId: 4663,
    vault: addressOf("OffpeakVault"),
    rows,
    buyers: new Map([
      [buyer, openFacts],
      [other, openFacts],
    ]),
    payments: [],
    protocolReserve: 0n,
    agentPool: 10n ** 12n,
    windows: new Map([[`9:${buyer}`, { available: 10n ** 12n, firstHour: HOUR, endHour: HOUR + 1, host: hostAddress }]]),
    closeRoot: null,
    ctx,
    ...overrides,
  }
}

let rows: UsageRow[]

beforeAll(async () => {
  rows = await Promise.all([
    signedRow({ i: 1 }),
    signedRow({ i: 2, tokensIn: 5000 }),
    signedRow({ i: 3, payer: other }),
    signedRow({ i: 4, ts: HOUR * 3600 + 900 }),
  ])
  rows.sort((a, b) => (a.req_id < b.req_id ? -1 : 1))
})

describe("buildBatch", () => {
  test("three signers get a byte-identical hash, whatever order rows arrive in", async () => {
    const first = await buildBatch(input(rows))
    const second = await buildBatch(input([...rows].reverse()))
    const third = await buildBatch(input([rows[2]!, rows[0]!, rows[3]!, rows[1]!]))
    expect(second.batchHash).toBe(first.batchHash)
    expect(third.batchHash).toBe(first.batchHash)
  })

  test("debits and credits are sorted, unique and sum to the records", async () => {
    const { b, t } = await buildBatch(input(rows))
    const owed = (payer: string) =>
      rows.filter((r) => r.payer === payer).reduce((sum, r) => sum + BigInt(r.host_cost_micro) + BigInt(r.fee_micro), 0n)
    expect(b.debits.map((d) => d.buyer)).toEqual([buyer, other].sort() as Hex[])
    expect(b.debits.find((d) => d.buyer === buyer)!.amount).toBe(owed(buyer))
    expect(b.debits.find((d) => d.buyer === buyer)!.lastTs).toBe(BigInt(HOUR * 3600 + 900))
    expect(b.credits).toHaveLength(1)
    expect(t.prepaidDebit).toBe(owed(buyer) + owed(other))
    expect(b.credits[0]!.amount + b.fees).toBe(t.prepaidDebit)
  })

  test("an empty hour has a zero root and no records", async () => {
    const { b, t } = await buildBatch(input([]))
    expect(b.root).toBe(ZERO_BYTES32)
    expect(t.records).toBe(0)
  })

  const tampered: [string, Partial<UsageRow>, string][] = [
    ["router signature", { router_sig: "0x" + "ab".repeat(65) }, "router_sig"],
    ["host signature", { host_sig: "0x" + "ab".repeat(65) }, "host_sig"],
    ["hour", { hour: HOUR + 1 }, "wrong_hour"],
    ["payer", { payer: other }, "buyer_ref"],
    ["leaf", { leaf: keccak256(toBytes("wrong")) }, "leaf"],
    ["fee rate", { fee_bps: 100 }, "fee"],
  ]
  for (const [name, change, reason] of tampered) {
    test(`a bad ${name} is excluded as ${reason} and the rest settles`, async () => {
      const bad = { ...rows[0]!, ...change }
      const { rejects, t } = await buildBatch(input([bad, ...rows.slice(1)]))
      expect(rejects).toEqual([{ reqId: bad.req_id, reason: reason as never }])
      expect(t.records).toBe(rows.length - 1)
    })
  }

  test("a host that was not serving at the record's time is excluded", async () => {
    const { rejects } = await buildBatch(input(rows, { ctx: { ...ctx, hostServingAt: () => false } }))
    expect(rejects.map((r) => r.reason)).toEqual(rows.map(() => "host_status"))
  })

  test("the audit opt-in rate and an $OFPK discount are both valid fee rates", async () => {
    const optIn = await signedRow({ i: 10, feeBps: 296 })
    expect((await buildBatch(input([optIn]))).rejects).toEqual([])
    const discounted = await signedRow({ i: 11, feeBps: 350 })
    const withDiscount = { ...ctx, discountBps: () => 50 }
    expect((await buildBatch(input([discounted], { ctx: withDiscount }))).rejects).toEqual([])
    expect((await buildBatch(input([discounted]))).rejects).toHaveLength(1)
  })

  test("an excluded record charges nobody and pays nobody", async () => {
    const bad = { ...rows[0]!, host_sig: "0x" + "ab".repeat(65) }
    const clean = await buildBatch(input(rows.slice(1)))
    const withBad = await buildBatch(input([bad, ...rows.slice(1)]))
    expect(withBad.b.root).toBe(clean.b.root)
    expect(withBad.b.debits).toEqual(clean.b.debits)
    expect(withBad.b.credits).toEqual(clean.b.credits)
    expect(withBad.b.fees).toBe(clean.b.fees)
  })

  test("records after a withdraw request are excluded by rule", async () => {
    const early = await signedRow({ i: 20, ts: HOUR * 3600 + 10 })
    const late = await signedRow({ i: 21, ts: HOUR * 3600 + 500 })
    const buyers = new Map([[buyer, { ...openFacts, withdrawRequestedAt: BigInt(HOUR * 3600 + 100) }]])
    const { rejects, b } = await buildBatch(input([early, late], { buyers }))
    expect(rejects).toEqual([{ reqId: late.req_id, reason: "after_withdraw_request" }])
    expect(b.debits[0]!.lastTs).toBe(BigInt(HOUR * 3600 + 10))
  })

  test("usage over the hourly cap is excluded latest first", async () => {
    const first = await signedRow({ i: 30, ts: HOUR * 3600 + 1 })
    const second = await signedRow({ i: 31, ts: HOUR * 3600 + 2 })
    const cost = BigInt(first.host_cost_micro) + BigInt(first.fee_micro)
    const buyers = new Map([[buyer, { ...openFacts, hourlyCap: cost }]])
    const { rejects, b } = await buildBatch(input([second, first], { buyers }))
    expect(rejects).toEqual([{ reqId: second.req_id, reason: "over_hourly_cap" }])
    expect(b.debits[0]!.amount).toBe(cost)
  })

  test("usage over what remains of the daily cap is excluded", async () => {
    const row = await signedRow({ i: 40 })
    const cost = BigInt(row.host_cost_micro) + BigInt(row.fee_micro)
    const buyers = new Map([[buyer, { ...openFacts, dailyCap: 1_000n, dayDebited: 1_000n - cost + 1n }]])
    expect((await buildBatch(input([row], { buyers }))).rejects[0]!.reason).toBe("over_daily_cap")
  })

  test("a close that disagrees is noted and never stops the hour", async () => {
    const built = await buildBatch(input(rows, { closeRoot: keccak256(toBytes("other")) }))
    expect(built.closeMatched).toBe(false)
    expect(built.b.root).toBe(merkleRoot(rows.map((r) => r.leaf as Hex)))
  })

  const payment = (id: string, amount: bigint, writeOff = false): PaymentRow => ({
    paymentId: keccak256(toBytes(id)),
    payer: buyer as Hex,
    amountMicro: amount,
    reqIds: [id],
    covered: [{ reqId: id, host: hostAddress, hostCost: amount - 1n, fee: 1n }],
    writeOff,
    recoveredMicro: 0n,
    lateCollection: false,
  })

  test("collected payments draw from the pool and join credits and fees", async () => {
    const built = await buildBatch(input([], { payments: [payment("a", 100n)] }))
    expect(built.b.agentPoolDraw).toBe(100n)
    expect(built.b.credits).toEqual([{ host: hostAddress as Hex, amount: 99n }])
    expect(built.b.fees).toBe(1n)
    expect(built.drawn).toEqual([keccak256(toBytes("a"))])
  })
