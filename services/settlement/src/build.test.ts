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

  test("write-offs draw only what the reserve holds, and the rest wait", async () => {
    const payments = [payment("a", 60n, true), payment("b", 60n, true)]
    const built = await buildBatch(input([], { payments, protocolReserve: 100n }))
    expect(built.b.reserveDraw).toBe(60n)
    expect(built.writtenOff).toHaveLength(1)
  })

  test("a payment that paid for an excluded record draws what it owes and refunds the difference", async () => {
    const paid = { ...payment("a", 100n), amountMicro: 130n }
    const built = await buildBatch(input([], { payments: [paid] }))
    expect(built.b.agentPoolDraw).toBe(100n)
    expect(built.b.fees).toBe(1n)
    expect(built.b.credits).toEqual([{ host: hostAddress as Hex, amount: 99n }])
    expect(built.refunds).toEqual([
      { id: `agent-excess:${paid.paymentId}`, payer: buyer as Hex, amount: 30n, reason: "excluded_record", reqIds: ["a"] },
    ])
  })

  test("a host is not paid for a record this same hour excluded", async () => {
    const bad = { ...(await signedRow({ i: 60, payMode: 1 })), fee_micro: "1" }
    const paid: PaymentRow = {
      ...payment("x", 500n),
      reqIds: [bad.req_id],
      covered: [{ reqId: bad.req_id, host: hostAddress, hostCost: 499n, fee: 1n }],
    }
    const built = await buildBatch(input([bad], { payments: [paid] }))
    expect(built.rejects.map((r) => r.reqId)).toEqual([bad.req_id])
    expect(built.b.credits).toEqual([])
    expect(built.b.agentPoolDraw).toBe(0n)
    expect(built.b.fees).toBe(0n)
    expect(built.refunds[0]!.amount).toBe(500n)
  })

  test("a payment that undercharged takes the gap from the reserve", async () => {
    const short = { ...payment("a", 100n), amountMicro: 90n }
    const built = await buildBatch(input([], { payments: [short], protocolReserve: 10n }))
    expect(built.b.agentPoolDraw).toBe(90n)
    expect(built.b.reserveDraw).toBe(10n)
    expect(built.b.credits).toEqual([{ host: hostAddress as Hex, amount: 99n }])
    expect(built.refunds).toEqual([])
  })

  test("an undercharge the reserve cannot cover waits", async () => {
    const short = { ...payment("a", 100n), amountMicro: 90n }
    const built = await buildBatch(input([], { payments: [short], protocolReserve: 9n }))
    expect(built.drawn).toEqual([])
    expect(built.b.agentPoolDraw).toBe(0n)
  })

  test("money arriving after a write-off draws into fees", async () => {
    const late: PaymentRow = { ...payment("a", 100n), covered: [], lateCollection: true }
    const built = await buildBatch(input([], { payments: [late] }))
    expect(built.b.agentPoolDraw).toBe(100n)
    expect(built.b.fees).toBe(100n)
    expect(built.b.credits).toEqual([])
    expect(built.drawn).toEqual([late.paymentId])
    expect(built.refunds).toEqual([])
  })

  test("a record the reserve already paid for joins fees when its payment arrives", async () => {
    const recovered: PaymentRow = { ...payment("a", 100n), covered: [], recoveredMicro: 100n }
    const built = await buildBatch(input([], { payments: [recovered] }))
    expect(built.b.agentPoolDraw).toBe(100n)
    expect(built.b.fees).toBe(100n)
    expect(built.refunds).toEqual([])
  })

  test("orphan write-offs pay the host from the reserve and name the record", async () => {
    const orphan: PaymentRow = { ...payment("a", 100n, true), orphanReqId: "a" }
    const built = await buildBatch(input([], { payments: [orphan], protocolReserve: 100n }))
    expect(built.b.reserveDraw).toBe(100n)
    expect(built.orphans).toEqual(["a"])
    expect(built.b.credits).toEqual([{ host: hostAddress as Hex, amount: 99n }])
  })

  test("a draw never passes what the pool holds, so one bad row cannot stall the hour", async () => {
    const built = await buildBatch(input([], { payments: [payment("a", 100n), payment("b", 100n)], agentPool: 150n }))
    expect(built.b.agentPoolDraw).toBe(100n)
    expect(built.drawn).toHaveLength(1)
  })

  test("money with no payment row draws into fees and names its source", async () => {
    const stray: PaymentRow = { ...payment("a", 100n), covered: [], lateCollection: true, sweptFrom: "0xsource" }
    const built = await buildBatch(input([], { payments: [stray] }))
    expect(built.b.agentPoolDraw).toBe(100n)
    expect(built.b.fees).toBe(100n)
    expect(built.swept).toEqual([{ paymentId: stray.paymentId, source: "0xsource", amount: 100n }])
  })

  test("an hour too big for one transaction keeps its largest buyers and lands", async () => {
    const payers = Array.from({ length: 500 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
    const many = await Promise.all(payers.map((payer, i) => signedRow({ payer, i: 1000 + i, tokensIn: 1000 + i * 10 })))
    const buyers = new Map(payers.map((payer) => [payer, openFacts]))
    const built = await buildBatch(input(many, { buyers }))
    expect(built.b.debits.length).toBe(465)
    expect(new Set(built.rejects.map((r) => r.reason))).toEqual(new Set(["over_batch_capacity"]))
    expect(built.rejects).toHaveLength(35)
    const smallest = many.slice(0, 35).map((r) => r.req_id).sort()
    expect(built.rejects.map((r) => r.reqId)).toEqual(smallest)
    const again = await buildBatch(input([...many].reverse(), { buyers }))
    expect(again.batchHash).toBe(built.batchHash)
  }, 30_000)

  test("buyers already debited today take less of the budget", async () => {
    const payers = Array.from({ length: 500 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
    const many = await Promise.all(payers.map((payer, i) => signedRow({ payer, i: 2000 + i })))
    const buyers = new Map(payers.map((payer) => [payer, { ...openFacts, dayDebited: 1n }]))
    const built = await buildBatch(input(many, { buyers }))
    expect(built.rejects).toEqual([])
    expect(built.b.debits).toHaveLength(500)
  }, 30_000)

  test("a draw past what the holder has left is excluded by rule", async () => {
    const a = await signedRow({ i: 70, payMode: 4 })
    const b = await signedRow({ i: 71, payMode: 4 })
    const windows = new Map([[`9:${buyer}`, { available: 1_100n, firstHour: HOUR, endHour: HOUR + 1, host: hostAddress }]])
    const built = await buildBatch(input([a, b], { windows }))
    expect(built.rejects).toEqual([{ reqId: b.req_id, reason: "over_window_balance" }])
    expect(built.b.windowDraws).toEqual([{ windowId: 9n, holder: buyer as Hex, tokens: 1100n }])
  })

  test("a draw outside the Window's hours is excluded", async () => {
    const a = await signedRow({ i: 72, payMode: 4 })
    const windows = new Map([[`9:${buyer}`, { available: 10n ** 12n, firstHour: HOUR + 1, endHour: HOUR + 2, host: hostAddress }]])
    const built = await buildBatch(input([a], { windows }))
    expect(built.rejects).toEqual([{ reqId: a.req_id, reason: "over_window_balance" }])
    expect(built.b.windowDraws).toEqual([])
  })

  test("a draw served by the wrong host is excluded", async () => {
    const a = await signedRow({ i: 74, payMode: 4 })
    const windows = new Map([[`9:${buyer}`, { available: 10n ** 12n, firstHour: HOUR, endHour: HOUR + 1, host: "0x0000000000000000000000000000000000000001" }]])
    const built = await buildBatch(input([a], { windows }))
    expect(built.rejects.map((r) => r.reason)).toEqual(["over_window_balance"])
  })

  test("a record whose window id does not match what was signed is excluded", async () => {
    const a = { ...(await signedRow({ i: 75, payMode: 4 })), window_id: "10" }
    const built = await buildBatch(input([a]))
    expect(built.rejects.map((r) => r.reason)).toEqual(["window_ref"])
  })

  test("a record with no window id is excluded rather than stopping the tick", async () => {
    const a = { ...(await signedRow({ i: 76, payMode: 4 })), window_id: null }
    const built = await buildBatch(input([a]))
    expect(built.rejects.map((r) => r.reason)).toEqual(["window_ref"])
  })

  test("draws past what one transaction holds keep the largest and exclude the rest", async () => {
    const holders = Array.from({ length: 450 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
    const rows_ = await Promise.all(holders.map((payer, i) => signedRow({ payer, i: 3000 + i, payMode: 4, tokensIn: 1000 + i })))
    const windows = new Map(holders.map((payer) => [`9:${payer}`, { available: 10n ** 12n, firstHour: HOUR, endHour: HOUR + 1, host: hostAddress }]))
    const built = await buildBatch(input(rows_, { windows }))
    expect(built.b.windowDraws.length).toBeLessThanOrEqual(415)
    expect(built.b.windowDraws.length + built.rejects.length).toBe(450)
    expect(new Set(built.rejects.map((r) => r.reason))).toEqual(new Set(["over_batch_capacity"]))
    expect(built.rejects.map((r) => r.reqId)).toContain(rows_[0]!.req_id)
    expect(built.rejects.map((r) => r.reqId)).not.toContain(rows_[449]!.req_id)
  }, 30_000)

  test("agent payments that would not fit wait for a later hour", async () => {
    const payers = Array.from({ length: 300 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
    const many: PaymentRow[] = payers.map((h, i) => ({
      ...payment(`p${i}`, 100n),
      covered: [{ reqId: `p${i}`, host: h, hostCost: 99n, fee: 1n }],
    }))
    const built = await buildBatch(input([], { payments: many }))
    expect(built.drawn.length).toBeLessThan(300)
    expect(built.drawn.length).toBeGreaterThan(190)
    expect(built.b.credits).toHaveLength(built.drawn.length)
  })

  test("a draw with no Window on chain is excluded rather than sinking the batch", async () => {
    const a = await signedRow({ i: 73, payMode: 4 })
    const built = await buildBatch(input([a], { windows: new Map() }))
    expect(built.rejects.map((r) => r.reason)).toEqual(["over_window_balance"])
  })

  test("conservation holds across every funding source", async () => {
    const built = await buildBatch(input(rows, { payments: [payment("a", 100n), payment("b", 50n, true)], protocolReserve: 50n }))
    const credits = built.b.credits.reduce((sum, c) => sum + c.amount, 0n)
    expect(built.t.prepaidDebit + built.b.agentPoolDraw + built.b.reserveDraw).toBe(credits + built.b.fees)
  })

  test("window draws group by window and holder", async () => {
    const a = await signedRow({ i: 50, payMode: 4 })
    const b = await signedRow({ i: 51, payMode: 4 })
    const built = await buildBatch(input([a, b]))
    expect(built.b.windowDraws).toEqual([{ windowId: 9n, holder: buyer as Hex, tokens: 2200n }])
    expect(built.b.debits).toEqual([])
    expect(built.t.windowDrawn).toBe(2200n)
  })
})
