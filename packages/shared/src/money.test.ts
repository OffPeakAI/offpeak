import { describe, expect, test } from "bun:test"
import { buyerUnitPrice, ceilDiv, feeBpsFor, feeMicro, hostCostMicro, quoteCost, windowResaleFeeMicro } from "./money.ts"

describe("money", () => {
  test("ceilDiv rounds away from zero for positive integers", () => {
    expect(ceilDiv(1n, 2n)).toBe(1n)
    expect(ceilDiv(10n, 5n)).toBe(2n)
    expect(ceilDiv(0n, 5n)).toBe(0n)
  })

  test("host cost matches the worked example of $0.20 / 1M", () => {
    const price = 200_000n
    expect(hostCostMicro(1_000_000, 0, price, 0n)).toBe(200_000n)
    expect(hostCostMicro(1, 0, price, 0n)).toBe(1n)
    expect(hostCostMicro(0, 0, price, price)).toBe(0n)
  })

  test("fee bps: audit opt-in is 296 and the floor is 100", () => {
    expect(feeBpsFor({})).toBe(400)
    expect(feeBpsFor({ auditOptIn: true })).toBe(296)
    expect(feeBpsFor({ ofpkDiscountBps: 350 })).toBe(100)
    expect(feeBpsFor({ auditOptIn: true, ofpkDiscountBps: 500 })).toBe(100)
  })

  test("buyer pays host cost plus fee", () => {
    const q = quoteCost({ tokensIn: 500_000, tokensOut: 100_000, priceIn: 200_000n, priceOut: 800_000n, feeBps: 400 })
    expect(q.hostCostMicro).toBe(hostCostMicro(500_000, 100_000, 200_000n, 800_000n))
    expect(q.feeMicro).toBe(feeMicro(q.hostCostMicro, 400))
    expect(q.totalMicro).toBe(q.hostCostMicro + q.feeMicro)
  })

  test("buyer unit price includes the fee", () => {
    expect(buyerUnitPrice(1_000_000n, 400)).toBe(1_040_000n)
  })

  test("window resale fee is 1% of sale plus 10% of markup", () => {
    expect(windowResaleFeeMicro(10_000n, 8_000n)).toBe(100n + 200n)
  })
})
