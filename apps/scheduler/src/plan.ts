import { buyerUnitPrice, quoteCost } from "@offpeak/shared"

export type BatchLine = { index: number; tokensIn: number; maxTokensOut: number }

export type HourSlot = {
  hour: number
  forecastIn: bigint
  forecastOut: bigint
  idleTokens: number
  /** Already promised to other jobs: tokens of this hour's idle share, and µUSDG of this buyer's cap. */
  takenTokens?: number
  takenMicro?: bigint
}

export type PlannedSlot = { hour: number; lines: number[]; tokens: number; estMicro: bigint }

export type Plan = {
  /** The host price records carry. The buyer pays this plus fee. */
  lockedPrice: { in: bigint; out: bigint }
  /** The same price with the fee on top, which is what a cap compares against. */
  buyerPrice: { in: bigint; out: bigint }
  estimatedMaxMicro: bigint
  slots: PlannedSlot[]
}

export type PlanError = { error: "price_above_cap" | "no_hours"; cheapestDeadline?: number }

type Input = {
  lines: BatchLine[]
  hours: HourSlot[]
  deadline: number
  hourlyCapMicro: bigint
  feeBps: number
  maxPrice?: { in: bigint; out: bigint }
  now: number
}

const IDLE_SHARE_DIVISOR = 5
const MARGIN_BEFORE_DEADLINE_S = 1800

export function eligibleHours(hours: HourSlot[], deadline: number, now: number) {
  const current = Math.floor(now / 3600)
  return hours
    .filter((h) => h.hour > current && (h.hour + 1) * 3600 <= deadline - MARGIN_BEFORE_DEADLINE_S)
    .sort((a, b) => {
      const priceA = a.forecastIn + a.forecastOut
      const priceB = b.forecastIn + b.forecastOut
      return priceA < priceB ? -1 : priceA > priceB ? 1 : a.hour - b.hour
    })
}

/**
 * Water-fills lines into hours, cheapest first. An hour takes at most 20% of its idle tokens and at most
 * the buyer's hourly cap. The cap is checked at the dearest hour's price, because the locked price can
 * sit above the forecast of a cheap hour. Returns where each line goes, or null if one does not fit.
 */
export function fillHours(lines: BatchLine[], eligible: HourSlot[], hourlyCapMicro: bigint, feeBps: number) {
  const dearestIn = eligible.reduce((max, h) => (h.forecastIn > max ? h.forecastIn : max), 0n)
  const dearestOut = eligible.reduce((max, h) => (h.forecastOut > max ? h.forecastOut : max), 0n)
  const idleLeft = new Map(eligible.map((h) => [h.hour, Math.floor(h.idleTokens / IDLE_SHARE_DIVISOR) - (h.takenTokens ?? 0)]))
  const capLeft = new Map(eligible.map((h) => [h.hour, hourlyCapMicro - (h.takenMicro ?? 0n)]))
  const placed = new Map<number, BatchLine[]>()
  for (const line of lines) {
    const need = line.tokensIn + line.maxTokensOut
    const worst = quoteCost({ tokensIn: line.tokensIn, tokensOut: line.maxTokensOut, priceIn: dearestIn, priceOut: dearestOut, feeBps }).totalMicro
    const hour = eligible.find((h) => (idleLeft.get(h.hour) ?? 0) >= need && (capLeft.get(h.hour) ?? 0n) >= worst)
    if (!hour) return null
    idleLeft.set(hour.hour, idleLeft.get(hour.hour)! - need)
    capLeft.set(hour.hour, capLeft.get(hour.hour)! - worst)
    placed.set(hour.hour, [...(placed.get(hour.hour) ?? []), line])
  }
  return placed
}

function lockPrice(input: Input, eligible: HourSlot[]): Plan | null {
  const placed = fillHours(input.lines, eligible, input.hourlyCapMicro, input.feeBps)
  if (!placed) return null
  let weightIn = 0n
  let weightOut = 0n
  let tokensIn = 0n
  let tokensOut = 0n
  for (const hour of eligible) {
    for (const line of placed.get(hour.hour) ?? []) {
      weightIn += hour.forecastIn * BigInt(line.tokensIn)
      weightOut += hour.forecastOut * BigInt(line.maxTokensOut)
      tokensIn += BigInt(line.tokensIn)
      tokensOut += BigInt(line.maxTokensOut)
    }
  }
  // Rounding down cannot cross a floor: every value averaged is at or above it, and floors are whole numbers.
  const lockedIn = tokensIn > 0n ? weightIn / tokensIn : 0n
  const lockedOut = tokensOut > 0n ? weightOut / tokensOut : 0n
  return priced(placed, { in: lockedIn, out: lockedOut }, input.feeBps)
}

function priced(placed: Map<number, BatchLine[]>, price: { in: bigint; out: bigint }, feeBps: number): Plan {
  const costOf = (line: BatchLine) => quoteCost({ tokensIn: line.tokensIn, tokensOut: line.maxTokensOut, priceIn: price.in, priceOut: price.out, feeBps }).totalMicro
  const slots: PlannedSlot[] = [...placed.entries()]
    .map(([hour, lines]) => ({
      hour,
      lines: lines.map((line) => line.index),
      tokens: lines.reduce((sum, line) => sum + line.tokensIn + line.maxTokensOut, 0),
      estMicro: lines.reduce((sum, line) => sum + costOf(line), 0n),
    }))
    .sort((a, b) => a.hour - b.hour)
  return {
    lockedPrice: price,
    buyerPrice: { in: buyerUnitPrice(price.in, feeBps), out: buyerUnitPrice(price.out, feeBps) },
    estimatedMaxMicro: slots.reduce((sum, slot) => sum + slot.estMicro, 0n),
    slots,
  }
}

/**
 * A chat request that can wait keeps its cap rather than being refused: the plan locks the host price
 * that comes to the cap with fee on, and its lines wait for an hour at that price or lapse unbilled.
 */
export function lockAtCap(plan: Plan, lines: BatchLine[], cap: { in: bigint; out: bigint }, feeBps: number): Plan {
  const under = (price: bigint, limit: bigint) => {
    const most = (limit * 10_000n) / (10_000n + BigInt(feeBps))
    return price < most ? price : most
  }
  const byIndex = new Map(lines.map((line) => [line.index, line]))
  const placed = new Map(plan.slots.map((slot) => [slot.hour, slot.lines.map((index) => byIndex.get(index)!)]))
  return priced(placed, { in: under(plan.lockedPrice.in, cap.in), out: under(plan.lockedPrice.out, cap.out) }, feeBps)
}

const withinCap = (plan: Plan, cap?: { in: bigint; out: bigint }) => !cap || (plan.buyerPrice.in <= cap.in && plan.buyerPrice.out <= cap.out)

/** The first later deadline that gets under the cap, which is what a refused buyer needs to hear. */
function cheapestDeadline(input: Input) {
  const hours = [...input.hours].sort((a, b) => a.hour - b.hour)
  for (const hour of hours) {
    const deadline = (hour.hour + 1) * 3600 + MARGIN_BEFORE_DEADLINE_S
    if (deadline <= input.deadline) continue
    const plan = lockPrice(input, eligibleHours(input.hours, deadline, input.now))
    if (plan && withinCap(plan, input.maxPrice)) return deadline
  }
  return undefined
}

/**
 * Water-fills lines into whole hours from the next hour until 30 minutes before the deadline. The locked
 * price is the token-weighted average forecast price of the hours actually used, not the cheapest of them.
 */
export function planJob(input: Input): Plan | PlanError {
  const eligible = eligibleHours(input.hours, input.deadline, input.now)
  if (eligible.length === 0) return { error: "no_hours" }
  const plan = lockPrice(input, eligible)
  if (!plan) return { error: "no_hours" }
  if (!withinCap(plan, input.maxPrice)) return { error: "price_above_cap", cheapestDeadline: cheapestDeadline(input) }
  return plan
}
