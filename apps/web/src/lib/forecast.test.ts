import { describe, expect, test } from "bun:test"
import { belowPercent, chartModel, type Slot } from "./forecast.ts"

const slot = (index: number, price: string): Slot => ({ hour: 100 + index, how: index, forecast_in: price, forecast_out: `${price}0` })

describe("the forecast chart", () => {
  const slots = [slot(0, "300"), slot(1, "100"), slot(2, "200"), slot(3, "100")]

  test("scales between the lowest and highest price and keeps the lowest visible", () => {
    const chart = chartModel(slots, "in")
    expect(chart.low).toBe(100n)
    expect(chart.high).toBe(300n)
    expect(chart.bars.map((bar) => bar.heightBps)).toEqual([10_000, 1_200, 5_600, 1_200])
  })

  test("reads the chosen leg", () => {
    expect(chartModel(slots, "out").high).toBe(3_000n)
  })

  test("marks the first cheapest hour only", () => {
    const chart = chartModel(slots, "in")
    expect(chart.cheapest?.index).toBe(1)
    expect(chart.bars.filter((bar) => bar.cheapest)).toHaveLength(1)
  })

  test("a flat week draws full bars, not a divide by zero", () => {
    const chart = chartModel([slot(0, "5"), slot(1, "5")], "in")
    expect(chart.bars.map((bar) => bar.heightBps)).toEqual([10_000, 10_000])
  })

  test("nothing to chart is an empty model", () => {
    expect(chartModel([], "in")).toEqual({ bars: [], low: 0n, high: 0n, days: [], cheapest: null })
  })

  test("day marks fall on midnight and night covers 00 to 06 UTC", () => {
    const week = Array.from({ length: 48 }, (_, index) => slot(index + 20, "100"))
    const chart = chartModel(week, "in")
    expect(chart.days).toEqual([
      { index: 4, how: 24 },
      { index: 28, how: 48 },
    ])
    expect(chart.bars[4]?.night).toBe(true)
    expect(chart.bars[9]?.night).toBe(true)
    expect(chart.bars[10]?.night).toBe(false)
  })

  test("prices beyond a float's reach stay exact", () => {
    const big = "9007199254740993"
    expect(chartModel([slot(0, big), slot(1, "1")], "in").bars[0]?.price).toBe(9_007_199_254_740_993n)
  })
})

describe("percent below", () => {
  test("rounds down, so it never claims more than the data", () => {
    expect(belowPercent(104_000n, 208_000n)).toBe(50)
    expect(belowPercent(104_001n, 208_000n)).toBe(49)
  })

  test("no reference or no drop is zero", () => {
    expect(belowPercent(5n, 0n)).toBe(0)
    expect(belowPercent(6n, 5n)).toBe(0)
  })
})
