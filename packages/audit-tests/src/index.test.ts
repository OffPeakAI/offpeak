import { describe, expect, test } from "bun:test"
import { PAYER_CAP, PUBLISHED_BASELINE, Z_CLAMP, llrTerm, mulberry32, normalFrom, publishedBaseline, scan, score, simulateWeek, TEST_ID, TEST_VERSION, type LlrSample } from "./index.ts"

const rate = (runs: number, hit: (i: number) => boolean) => {
  let hits = 0
  for (let i = 0; i < runs; i++) if (hit(i)) hits++
  return hits / runs
}

describe("llr-mix-v1", () => {
  test("id and version are stable", () => {
    expect(TEST_ID).toBe("llr-mix-v1")
    expect(TEST_VERSION).toBe("2")
  })

  test("the term is the doc's mixture ratio", () => {
    const { epsilon, delta } = PUBLISHED_BASELINE
    const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
    for (const z of [-3, -1, 0, 0.5, 2]) {
      const direct = Math.log((1 - epsilon) * phi(z) + epsilon * phi(z + delta)) - Math.log(phi(z))
      expect(llrTerm(z, epsilon, delta)).toBeCloseTo(direct, 10)
    }
  })

  test("honest host-weeks flag at most 1 percent over 20,000 runs", () => {
    const rng = mulberry32(20261101)
    const flagged = rate(20_000, () => score(simulateWeek(rng, 200, 0, PUBLISHED_BASELINE.delta), PUBLISHED_BASELINE).flagged)
    expect(flagged).toBeLessThanOrEqual(0.01)
  })

  test("a 10 percent swap is flagged within 200 samples in at least 95 percent of 20,000 runs", () => {
    const rng = mulberry32(20261102)
    const flagged = rate(20_000, () => score(simulateWeek(rng, 200, 0.1, PUBLISHED_BASELINE.delta), PUBLISHED_BASELINE).flagged)
    expect(flagged).toBeGreaterThanOrEqual(0.95)
  })

  test("reading on through a longer week keeps the false-flag bound", () => {
    const rng = mulberry32(20261103)
    const flagged = rate(3_000, () => scan(simulateWeek(rng, 1_000, 0, PUBLISHED_BASELINE.delta), PUBLISHED_BASELINE).flagged)
    expect(flagged).toBeLessThanOrEqual(0.01)
  })

  test("does not flag before minN", () => {
    const samples = Array.from({ length: 199 }, () => ({ z: -10 }))
    expect(score(samples, PUBLISHED_BASELINE).flagged).toBe(false)
    expect(scan(samples, PUBLISHED_BASELINE).flagged).toBe(false)
  })

  test("a bundle cut at the crossing scores exactly as the scan read it", () => {
    const rng = mulberry32(5)
    let crossed = 0
    for (let run = 0; run < 200; run++) {
      const week = simulateWeek(rng, 600, 0.25, PUBLISHED_BASELINE.delta)
      const read = scan(week, PUBLISHED_BASELINE)
      if (!read.flagged) continue
      crossed++
      const ruled = score(week.slice(0, read.n), PUBLISHED_BASELINE)
      expect(ruled.statistic).toBe(read.statistic)
      expect(ruled.flagged).toBe(true)
    }
    expect(crossed).toBeGreaterThan(190)
  })

  test("the statistic does not depend on sample order", () => {
    const week = simulateWeek(mulberry32(9), 300, 0.1, PUBLISHED_BASELINE.delta)
    expect(score([...week].reverse(), PUBLISHED_BASELINE)).toEqual(score(week, PUBLISHED_BASELINE))
  })

  test("the statistic survives a JSON round trip", () => {
    const week = simulateWeek(mulberry32(10), 300, 0.1, PUBLISHED_BASELINE.delta)
    expect(score(JSON.parse(JSON.stringify(week)), PUBLISHED_BASELINE)).toEqual(score(week, PUBLISHED_BASELINE))
  })

  test("one wild response cannot flag a host", () => {
    const rng = mulberry32(11)
    const week = simulateWeek(rng, 200, 0, PUBLISHED_BASELINE.delta)
    const before = score(week, PUBLISHED_BASELINE)
    week[100] = { z: -1e9 }
    const after = score(week, PUBLISHED_BASELINE)
    expect(Number.isFinite(after.statistic)).toBe(true)
    expect(after.flagged).toBe(false)
    expect(after.statistic - before.statistic).toBeLessThan(llrTerm(-Z_CLAMP, 0.1, 2.5) + 1)
  })

  test("no single response can reach the threshold, however low it scores", () => {
    const { epsilon, delta, logA } = PUBLISHED_BASELINE
    expect(llrTerm(-1e9, epsilon, delta)).toBeLessThan(logA)
    expect(llrTerm(-1e9, epsilon, delta)).toBe(llrTerm(-Z_CLAMP, epsilon, delta))
  })

  const framedWeek = (rng: () => number, low: number, payer: (i: number) => string | null): LlrSample[] => {
    const week: LlrSample[] = simulateWeek(rng, 200, 0, PUBLISHED_BASELINE.delta)
    for (let i = 0; i < low; i++) week[i] = { z: -5, payer: payer(i) }
    return week
  }

  test("three forced low scores no longer flag an honest week", () => {
    const rng = mulberry32(21)
    expect(rate(5_000, () => score(framedWeek(rng, 3, () => null), PUBLISHED_BASELINE).flagged)).toBeLessThan(0.08)
    expect(rate(5_000, () => score(framedWeek(rng, 3, () => "one-buyer"), PUBLISHED_BASELINE).flagged)).toBeLessThanOrEqual(0.01)
  })

  test("one payer cannot flag a host, however many low scores it forces, once planning has topped up the rest", () => {
    const rng = mulberry32(22)
    const week = () => [...simulateWeek(rng, 190, 0, PUBLISHED_BASELINE.delta), ...Array.from({ length: 150 }, () => ({ z: -9, payer: "one-buyer" }))]
    expect(rate(5_000, () => score(week(), PUBLISHED_BASELINE).flagged)).toBeLessThan(0.002)
  })

  test("a payer adds at most the cap, and a negative sum counts in full", () => {
    const honest = simulateWeek(mulberry32(23), 200, 0, PUBLISHED_BASELINE.delta)
    const base = score(honest, PUBLISHED_BASELINE).statistic
    const low = Array.from({ length: 50 }, () => ({ z: -9, payer: "one-buyer" }))
    expect(score([...honest, ...low], PUBLISHED_BASELINE).statistic - base).toBeCloseTo(PAYER_CAP, 6)
    const high = Array.from({ length: 50 }, () => ({ z: 2, payer: "one-buyer" }))
    expect(score([...honest, ...high], PUBLISHED_BASELINE).statistic - base).toBeCloseTo(50 * llrTerm(2, 0.1, 2.5), 6)
  })

  test("the cap holds a payer's whole sum, so order and interleaving cannot matter", () => {
    const rng = mulberry32(24)
    const week = simulateWeek(rng, 400, 0.2, PUBLISHED_BASELINE.delta).map((row, i) => ({ ...row, payer: i % 3 === 0 ? null : `buyer-${i % 7}` }))
    const reversed = [...week].reverse()
    expect(score(reversed, PUBLISHED_BASELINE)).toEqual(score(week, PUBLISHED_BASELINE))
  })

  test("a bundle cut at the crossing scores as the scan read it, with payers too", () => {
    let crossed = 0
    for (let seed = 0; seed < 200; seed++) {
      const week = simulateWeek(mulberry32(seed), 600, 0.25, PUBLISHED_BASELINE.delta).map((row, i) => ({ ...row, payer: i % 2 ? `buyer-${i % 40}` : null }))
      const read = scan(week, PUBLISHED_BASELINE)
      if (!read.flagged) continue
      crossed++
      expect(score(week.slice(0, read.n), PUBLISHED_BASELINE).statistic).toBe(read.statistic)
    }
    expect(crossed).toBeGreaterThan(150)
  })

  test("a swap across many small payers keeps the power the cap would otherwise cost", () => {
    const rng = mulberry32(25)
    const flagged = rate(20_000, () => score(simulateWeek(rng, 200, 0.1, PUBLISHED_BASELINE.delta).map((row, i) => ({ ...row, payer: `buyer-${i % 40}` })), PUBLISHED_BASELINE).flagged)
    expect(flagged).toBeGreaterThanOrEqual(0.95)
  })

  test("an unknown model reads the default baseline, in any case", () => {
    expect(publishedBaseline(`0x${"AB".repeat(32)}`)).toEqual(PUBLISHED_BASELINE)
  })

  test("the generators stay deterministic", () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect(Array.from({ length: 8 }, () => normalFrom(a))).toEqual(Array.from({ length: 8 }, () => normalFrom(b)))
  })
})
