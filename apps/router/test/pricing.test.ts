import { describe, expect, test } from "bun:test"
import { floorWithinRule, validateSheet } from "../src/pricing/pricebook.ts"
import { livePrice, loadFactorBps } from "../src/pricing/live.ts"
import { HoldLedger } from "../src/pay/prepaid.ts"
import { paymentRequired } from "../src/pay/x402.ts"
import { admitChannel } from "../src/pay/channel.ts"
import { ZERO_BYTES32 } from "@offpeak/shared"
import type { Hex } from "viem"

describe("pricebook", () => {
  test("idle utilisation stays at or under 60% of base", () => {
    for (let n = 0; n < 40; n++) {
      const base = Array.from({ length: 168 }, (_, i) => 100_000n + BigInt((n * 17 + i * 13) % 50) * 10_000n)
      const min = base.reduce((m, v) => (v < m ? v : m))
      const floor = (min * 6000n) / 10000n
      expect(floorWithinRule(floor, base)).toBe(true)
      const lf = loadFactorBps(0)
      expect(lf).toBe(4000)
      for (let how = 0; how < 168; how++) {
        const price = livePrice({ baseIn: base, baseOut: base, floorIn: floor, floorOut: floor }, how, lf)
        expect(price.in * 10_000n <= base[how]! * 6_000n).toBe(true)
      }
    }
  })

  test("load factor is clamped", () => {
    expect(loadFactorBps(-1)).toBe(4000)
    expect(loadFactorBps(0)).toBe(4000)
    expect(loadFactorBps(2)).toBe(12000)
  })

  test("a sheet that breaks the floor is rejected", async () => {
    const base = Array.from({ length: 168 }, () => 100_000n)
    const result = await validateSheet(
      {
        host: "0x0000000000000000000000000000000000000001",
        modelDigest: ZERO_BYTES32,
        baseIn: base,
        baseOut: base,
        floorIn: 90_000n,
        floorOut: 10_000n,
        validFrom: 4_000_000_000,
        nonce: 1n,
      },
      "0x" as Hex,
      "0x0000000000000000000000000000000000000001",
      1_000,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("floor_above_0_6_min_base")
  })
})

describe("holds", () => {
  test("1000 parallel admits never pass the cap or the balance", async () => {
    const ledger = new HoldLedger()
    const view = { servable: true, hourlyCap: 100n, dailyCap: 100n, balance: 100n, hour: 1, day: 1, lastSettledHour: 0n }
    const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => ledger.admit("0xabc", 1n, view, `h${i}`, 1_000, 900)))
    const ok = results.filter((r) => r.ok).length
    expect(ok).toBe(100)
    expect([...ledger.books.holds.values()].reduce((sum, hold) => sum + hold.amount, 0n)).toBe(100n)
  })
})

describe("402 ordering", () => {
  test("channel is first and upto is omitted under 0.05 USDG", () => {
    const small = paymentRequired({
      asset: "0x0000000000000000000000000000000000000002",
      channelManager: "0x0000000000000000000000000000000000000003",
      payee: "0x0000000000000000000000000000000000000004",
      vault: "0x0000000000000000000000000000000000000005",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      escrow: "0x0000000000000000000000000000000000000006",
      maxAmount: 49_999n,
      reqId: ZERO_BYTES32,
      validBefore: 10,
      resourceHash: ZERO_BYTES32,
      exact: false,
      creditLimit: "250000",
    })
    expect(small.accepts.map((a) => a.scheme)).toEqual(["channel"])
    const large = paymentRequired({ ...{
      asset: "0x0000000000000000000000000000000000000002",
      channelManager: "0x0000000000000000000000000000000000000003",
      payee: "0x0000000000000000000000000000000000000004",
      vault: "0x0000000000000000000000000000000000000005",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      escrow: "0x0000000000000000000000000000000000000006",
      maxAmount: 50_000n,
      reqId: ZERO_BYTES32,
      validBefore: 10,
      resourceHash: ZERO_BYTES32,
      exact: true,
      creditLimit: "250000",
    } })
    expect(large.accepts.map((a) => a.scheme)).toEqual(["channel", "upto", "exact"])
  })

  test("channel admission stops when close is requested", () => {
    const closed = admitChannel({
      status: 2,
      expiry: 10_000_000,
      closeRequested: true,
      now: 100,
      deposit: 1_000_000n,
      voucherCumulative: 0n,
      unvouchered: 0n,
      newMax: 1n,
    })
    expect(closed.ok).toBe(false)
  })
})
