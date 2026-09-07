import { describe, expect, test } from "bun:test"
import type { Address } from "viem"
import { splitRewards, uptimeBps, weekOf, weekStart } from "./rewards.ts"

const WEEK = 604_800
const a = "0x000000000000000000000000000000000000000a" as Address
const b = "0x000000000000000000000000000000000000000b" as Address
const c = "0x000000000000000000000000000000000000000c" as Address

describe("weeks", () => {
  test("a week starts on Monday at 00:00 UTC", () => {
    const start = weekStart(weekOf(1_800_000_000))
    expect(new Date(start * 1000).getUTCDay()).toBe(1)
    expect(start % 86_400).toBe(0)
    expect(weekOf(start)).toBe(weekOf(start + WEEK - 1))
    expect(weekOf(start + WEEK)).toBe(weekOf(start) + 1)
  })
})

describe("uptime", () => {
  const start = 1_000_000
  const end = start + WEEK

  test("active all week is the whole of it", () => {
    expect(uptimeBps([{ ts: 0, status: 2 }], start, end)).toBe(10_000n)
  })

  test("never active is nothing", () => {
    expect(uptimeBps([], start, end)).toBe(0n)
    expect(uptimeBps([{ ts: 0, status: 1 }], start, end)).toBe(0n)
  })

  test("activating halfway counts half", () => {
    expect(uptimeBps([{ ts: start + WEEK / 2, status: 2 }], start, end)).toBe(5_000n)
  })

  test("frozen time does not count", () => {
    const changes = [
      { ts: 0, status: 2 },
      { ts: start + WEEK / 4, status: 3 },
      { ts: start + WEEK / 2, status: 2 },
    ]
    expect(uptimeBps(changes, start, end)).toBe(7_500n)
  })

  test("a change after the week does not reach back", () => {
    expect(uptimeBps([{ ts: 0, status: 2 }, { ts: end + 100, status: 3 }], start, end)).toBe(10_000n)
  })
})

describe("split", () => {
  test("the bucket follows bond times uptime", () => {
    const credits = splitRewards(1_000n, [
      { host: a, bond: 2_000n, uptime: 10_000n },
      { host: b, bond: 2_000n, uptime: 5_000n },
      { host: c, bond: 4_000n, uptime: 5_000n },
    ])
    expect(credits).toEqual([
      { host: a, amount: 400n },
      { host: b, amount: 200n },
      { host: c, amount: 400n },
    ])
  })

  test("the split never pays more than the bucket", () => {
    const credits = splitRewards(100n, [
      { host: a, bond: 1n, uptime: 1n },
      { host: b, bond: 1n, uptime: 1n },
      { host: c, bond: 1n, uptime: 1n },
    ])
    expect(credits.reduce((sum, x) => sum + x.amount, 0n)).toBe(99n)
  })

  test("hosts stay sorted for the contract", () => {
    const credits = splitRewards(1_000n, [
      { host: c, bond: 9n, uptime: 1n },
      { host: a, bond: 1n, uptime: 1n },
    ])
    expect(credits.map((x) => x.host)).toEqual([a, c])
  })

  test("nobody earned anything, so nothing is paid", () => {
    expect(splitRewards(1_000n, [{ host: a, bond: 0n, uptime: 10_000n }])).toEqual([])
  })
})
