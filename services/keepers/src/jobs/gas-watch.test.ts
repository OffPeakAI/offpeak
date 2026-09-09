import { describe, expect, test } from "bun:test"
import { GasBurn, daysLeft } from "./gas-watch.ts"

const ETH = 10n ** 18n

describe("gas burn", () => {
  test("measures spend from falling balances", () => {
    const burn = new GasBurn()
    burn.observe("relay", 0, ETH)
    expect(burn.observe("relay", 86_400, ETH - 100n)).toBe(100)
  })

  test("a top-up is not spend and does not raise the rate", () => {
    const burn = new GasBurn()
    burn.observe("relay", 0, ETH)
    burn.observe("relay", 86_400, ETH - 100n)
    expect(burn.observe("relay", 172_800, ETH * 2n)).toBe(100)
  })

  test("the rate smooths rather than jumping on one busy period", () => {
    const burn = new GasBurn()
    burn.observe("relay", 0, 10_000n)
    burn.observe("relay", 86_400, 9_900n)
    expect(burn.observe("relay", 172_800, 9_400n)).toBe(180)
  })

  test("no measured burn means no estimate", () => {
    expect(daysLeft(ETH, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(daysLeft(300n, 100)).toBe(3)
  })
})
