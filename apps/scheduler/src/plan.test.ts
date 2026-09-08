import { describe, expect, test } from "bun:test"
import { buyerUnitPrice, quoteCost } from "@offpeak/shared"
import { lockAtCap, planJob, type Plan } from "../src/plan.ts"

const flat = (hour: number, forecastIn: bigint, forecastOut: bigint, idleTokens: number) => ({ hour, forecastIn, forecastOut, idleTokens })
const lineSet = (n: number, tokensIn = 100, maxTokensOut = 50) => Array.from({ length: n }, (_, index) => ({ index, tokensIn, maxTokensOut }))

function planned(result: ReturnType<typeof planJob>): Plan {
  if ("error" in result) throw new Error(result.error)
  return result
}

describe("scheduler", () => {
  test("water-fill respects idle share and hourly cap and locks the weighted average", () => {
    const hours = [0, 1, 2, 3].map((i) => flat(100 + i, BigInt(100_000 + i * 50_000), BigInt(400_000 + i * 50_000), 800))
    const lines = lineSet(4)
    const plan = planned(planJob({ lines, hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 }))
    for (const slot of plan.slots) {
      const hour = hours.find((h) => h.hour === slot.hour)!
      expect(slot.lines.length * 150).toBeLessThanOrEqual(Math.floor(hour.idleTokens * 0.2))
    }
    expect(plan.lockedPrice.in >= 100_000n).toBe(true)
    expect(plan.slots.length).toBeGreaterThan(1)
  })

  test("the lock is the token-weighted average of the hours used, not their minimum, and the fee sits on top", () => {
    // 20% of 800 idle tokens has room for one 150-token line an hour.
    const hours = [flat(100, 100_000n, 400_000n, 800), flat(101, 300_000n, 800_000n, 800), flat(102, 900_000n, 900_000n, 800)]
    const plan = planned(planJob({ lines: lineSet(2), hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 }))
    expect(plan.slots.map((slot) => slot.hour)).toEqual([100, 101])
    expect(plan.lockedPrice).toEqual({ in: 200_000n, out: 600_000n })
    expect(plan.buyerPrice).toEqual({ in: buyerUnitPrice(200_000n, 400), out: buyerUnitPrice(600_000n, 400) })
    const each = quoteCost({ tokensIn: 100, tokensOut: 50, priceIn: 200_000n, priceOut: 600_000n, feeBps: 400 }).totalMicro
    expect(plan.estimatedMaxMicro).toBe(each * 2n)
    expect(plan.slots[0]!.estMicro).toBe(each)
  })

  test("an unused dear hour does not move the lock", () => {
    const hours = [flat(100, 100_000n, 400_000n, 80_000), flat(101, 900_000n, 900_000n, 80_000)]
    const plan = planned(planJob({ lines: lineSet(2), hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 }))
    expect(plan.lockedPrice).toEqual({ in: 100_000n, out: 400_000n })
  })

  test("the lock never falls below a floor every hour held", () => {
    const hours = [flat(100, 100_001n, 400_000n, 800), flat(101, 100_002n, 400_001n, 800), flat(102, 100_002n, 400_001n, 800)]
    const plan = planned(planJob({ lines: lineSet(3, 7, 3), hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 }))
    expect(plan.lockedPrice.in).toBeGreaterThanOrEqual(100_001n)
    expect(plan.lockedPrice.out).toBeGreaterThanOrEqual(400_000n)
  })

  test("no hour goes over the buyer's hourly cap, even at the locked price", () => {
    const hours = [flat(100, 100_000n, 400_000n, 8_000_000), flat(101, 900_000n, 1_600_000n, 8_000_000)]
    const lines = lineSet(2, 1000, 1000)
    const cap = 3_000n
    const plan = planned(planJob({ lines, hours, deadline: 106 * 3600, hourlyCapMicro: cap, feeBps: 400, now: 99 * 3600 }))
    for (const slot of plan.slots) expect(slot.estMicro).toBeLessThanOrEqual(cap)
    expect(plan.slots.length).toBe(2)
  })

  test("the next hour is eligible from any point in this one, and the last is the hour before deadline less 30 minutes", () => {
    const hours = [99, 100, 101, 102, 103].map((hour) => flat(hour, 100_000n, 400_000n, 8_000_000))
    const now = 99 * 3600 + 1800
    const single = planned(planJob({ lines: lineSet(1), hours, deadline: 103 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now }))
    expect(single.slots[0]!.hour).toBe(100)
    const tight = lineSet(1, 1_000_000, 1_000_000)
    const reachesLast = planned(planJob({ lines: Array.from({ length: 2 }, (_, index) => ({ ...tight[0]!, index })), hours: hours.map((h) => ({ ...h, idleTokens: 10_000_000 })), deadline: 103 * 3600 - 1, hourlyCapMicro: 10_000_000_000n, feeBps: 400, now }))
    expect(Math.max(...reachesLast.slots.map((slot) => slot.hour))).toBe(101)
  })

  test("other jobs' promises leave less room", () => {
    const hours = [{ ...flat(100, 100_000n, 400_000n, 800), takenTokens: 100 }, flat(101, 200_000n, 400_000n, 800)]
    const plan = planned(planJob({ lines: lineSet(1), hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 }))
    expect(plan.slots[0]!.hour).toBe(101)
    const capped = [{ ...flat(100, 100_000n, 400_000n, 8000), takenMicro: 10_000_000n }, flat(101, 200_000n, 400_000n, 8000)]
    expect(planned(planJob({ lines: lineSet(1), hours: capped, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 })).slots[0]!.hour).toBe(101)
  })

  test("a price over the cap is refused with the earliest deadline that gets under it", () => {
    const hours = [flat(100, 900_000n, 900_000n, 80_000), flat(101, 900_000n, 900_000n, 80_000), flat(102, 100_000n, 100_000n, 80_000)]
    const cap = { in: buyerUnitPrice(100_000n, 400), out: buyerUnitPrice(100_000n, 400) }
    const refused = planJob({ lines: lineSet(1), hours, deadline: 102 * 3600 + 1800, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600, maxPrice: cap })
    expect(refused).toEqual({ error: "price_above_cap", cheapestDeadline: 103 * 3600 + 1800 })
    expect("error" in planJob({ lines: lineSet(1), hours, deadline: 103 * 3600 + 1800, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600, maxPrice: cap })).toBe(false)
  })

  test("a job with no hour to run in, or too big for its hours, is refused", () => {
    const hours = [flat(100, 100_000n, 400_000n, 800)]
    expect(planJob({ lines: lineSet(1), hours, deadline: 100 * 3600, hourlyCapMicro: 1n, feeBps: 400, now: 99 * 3600 })).toEqual({ error: "no_hours" })
    expect(planJob({ lines: lineSet(9), hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 })).toEqual({ error: "no_hours" })
  })

  test("a lock at the cap comes to the cap or less once the fee is on", () => {
    const lines = lineSet(2)
    const hours = [flat(100, 900_000n, 900_000n, 80_000)]
    const plan = planned(planJob({ lines, hours, deadline: 106 * 3600, hourlyCapMicro: 10_000_000n, feeBps: 400, now: 99 * 3600 }))
    const cap = { in: 104_001n, out: 104_000n }
    const held = lockAtCap(plan, lines, cap, 400)
    expect(held.buyerPrice.in).toBeLessThanOrEqual(cap.in)
    expect(held.buyerPrice.out).toBeLessThanOrEqual(cap.out)
    expect(held.lockedPrice.out).toBe(100_000n)
    expect(held.estimatedMaxMicro).toBeLessThan(plan.estimatedMaxMicro)
    expect(lockAtCap(plan, lines, { in: 10_000_000n, out: 10_000_000n }, 400).lockedPrice).toEqual(plan.lockedPrice)
  })
})
