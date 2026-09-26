export type Slot = { hour: number; how: number; forecast_in: string; forecast_out: string }
export type Leg = "in" | "out"

export type Bar = { index: number; hour: number; how: number; price: bigint; heightBps: number; night: boolean; cheapest: boolean }

export type Chart = { bars: Bar[]; low: bigint; high: bigint; days: { index: number; how: number }[]; cheapest: Bar | null }

const NIGHT_UNTIL = 6
// Bars keep a sliver of height at the bottom of the range, so the lowest price is still a mark.
const FLOOR_BPS = 1_200

function priceOf(slot: Slot, leg: Leg) {
  return BigInt(leg === "in" ? slot.forecast_in : slot.forecast_out)
}

/** Heights are basis points of the plotted range. Prices stay bigints all the way to the label. */
export function chartModel(slots: Slot[], leg: Leg): Chart {
  if (slots.length === 0) return { bars: [], low: 0n, high: 0n, days: [], cheapest: null }
  const prices = slots.map((slot) => priceOf(slot, leg))
  const low = prices.reduce((a, b) => (b < a ? b : a))
  const high = prices.reduce((a, b) => (b > a ? b : a))
  const range = high - low
  const firstCheapest = prices.indexOf(low)
  const bars = slots.map((slot, index) => {
    const price = prices[index]!
    const span = range === 0n ? 10_000 : FLOOR_BPS + Number(((price - low) * BigInt(10_000 - FLOOR_BPS)) / range)
    return { index, hour: slot.hour, how: slot.how, price, heightBps: span, night: slot.how % 24 < NIGHT_UNTIL, cheapest: index === firstCheapest }
  })
  const days = bars.filter((bar) => bar.how % 24 === 0).map((bar) => ({ index: bar.index, how: bar.how }))
  return { bars, low, high, days, cheapest: bars[firstCheapest] ?? null }
}

/** Whole percent below `reference`, rounded down so the claim never overstates. */
export function belowPercent(price: bigint, reference: bigint) {
  if (reference <= 0n || price >= reference) return 0
  return Number(((reference - price) * 100n) / reference)
}
