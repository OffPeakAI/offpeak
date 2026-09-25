import { describe, expect, test } from "bun:test"
import { buyTotal, depositRoom, resaleFeeLine, resalePreview } from "./fees.ts"

describe("resale fee preview", () => {
  test("a markup pays both parts", () => {
    const preview = resalePreview({ units: 2n, pricePerUnit: 300_000n, costBasisPerUnit: 208_000n })
    expect(preview).toEqual({ sale: 600_000n, markup: 184_000n, fee: 24_400n, proceeds: 575_600n })
  })

  test("a sale at a loss pays only the 1%", () => {
    expect(resalePreview({ units: 1n, pricePerUnit: 100_000n, costBasisPerUnit: 208_000n })).toEqual({ sale: 100_000n, markup: 0n, fee: 1_000n, proceeds: 99_000n })
  })

  test("each part floors on its own, as the contract does", () => {
    // sale 199 → 1; markup 99 → 9. Flooring the sum would give 11 instead of 10.
    expect(resalePreview({ units: 1n, pricePerUnit: 199n, costBasisPerUnit: 100n }).fee).toBe(10n)
  })

  test("the line uses the required wording and an exact amount", () => {
    expect(resaleFeeLine({ units: 2n, pricePerUnit: 300_000n, costBasisPerUnit: 208_000n })).toBe("1% of sale price + 10% of markup = 0.0244 USDG")
    expect(resaleFeeLine({ units: 1n, pricePerUnit: 1n, costBasisPerUnit: 0n })).toBe("1% of sale price + 10% of markup = 0.00 USDG")
  })
})

describe("spending", () => {
  test("a buy multiplies in integers", () => {
    expect(buyTotal(3n, 208_000n)).toBe(624_000n)
  })

  test("the beta cap leaves what is left", () => {
    expect(depositRoom(400_000_000n, 500_000_000n)).toBe(100_000_000n)
    expect(depositRoom(600_000_000n, 500_000_000n)).toBe(0n)
    expect(depositRoom(1n, null)).toBeNull()
  })
})
