import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PUBLISHED_BASELINE, mulberry32, normalFrom } from "@offpeak/audit-tests"
import { bootStack } from "../../router/test/support/stack.ts"
import { openDb } from "../../router/src/store.ts"
import { calibrateModel, calibrationReport, chooseLogA, falseFlagProxy, filingCalibrated, fitBaselines, latestCalibration, readScoredRows, recalibrateLive, saveCalibration, shiftedBuckets, wilsonLower, wilsonUpper, type ScoredRow, type SwapRow } from "./calibrate.ts"
import { baselineId, loadBaselines, type Baseline } from "./score.ts"

const MODEL = "0xmodel"

/** Plain normal scores, so these tests check the harness rather than the mock engine. */
function rowsOf(input: { seed: number; classes?: string[]; images?: string[]; weeks?: number; perWeek?: number; shift?: number; scale?: number }) {
  const rng = mulberry32(input.seed)
  const rows: ScoredRow[] = []
  for (const gpuClass of input.classes ?? ["gpu-a", "gpu-b"]) {
    for (const imageDigest of input.images ?? ["image-a", "image-b"]) {
      for (let week = 0; week < (input.weeks ?? 12); week++) {
        for (let i = 0; i < (input.perWeek ?? 120); i++) {
          rows.push({ hostWeek: `${gpuClass}/${imageDigest}/${week}`, gpuClass, imageDigest, temperature: 0.7, tokensOut: 100, ll: -2 + 0.5 * (normalFrom(rng) * (input.scale ?? 1) - (input.shift ?? 0)) })
        }
      }
    }
  }
  return rows
}

const swapRows = (kind: string, shift: number, seed: number): SwapRow[] => rowsOf({ seed, weeks: 1, perWeek: 200, shift }).map((row) => ({ ...row, kind }))

const run = (over: Partial<Parameters<typeof calibrateModel>[0]> = {}) =>
  calibrateModel({ modelDigest: MODEL, source: "hardware", honest: rowsOf({ seed: 1 }), swaps: [...swapRows("small", 3.2, 2), ...swapRows("int4", 3, 3)], seed: 5, now: 1_800_000_000, bootWeeks: 300, powerRuns: 400, ...over })

describe("fitting", () => {
  test("baselines are per the full bucket key", () => {
    const rows = [...rowsOf({ seed: 1, classes: ["gpu-a"], images: ["image-a"], weeks: 1, perWeek: 200 }), ...rowsOf({ seed: 2, classes: ["gpu-a"], images: ["image-b"], weeks: 1, perWeek: 200 }), ...rowsOf({ seed: 3, classes: ["gpu-b"], images: ["image-a"], weeks: 1, perWeek: 200 })]
    const fitted = fitBaselines(MODEL, [...rows, ...rows.map((row) => ({ ...row, temperature: 0 })), ...rows.map((row) => ({ ...row, tokensOut: 500 }))], "v1")
    expect(new Set(fitted.map(baselineId)).size).toBe(9)
    expect(fitted[0]!.mu).toBeCloseTo(-2, 0)
  })

  test("a thin bucket gets no baseline, so it cannot swing a score", () => {
    expect(fitBaselines(MODEL, rowsOf({ seed: 1, classes: ["gpu-a"], images: ["image-a"], weeks: 1, perWeek: 99 }), "v1")).toEqual([])
  })

  test("a bucket with no spread gets no baseline", () => {
    const rows = Array.from({ length: 200 }, () => ({ hostWeek: "w", gpuClass: "g", imageDigest: "i", temperature: 0, tokensOut: 8, ll: -1 }))
    expect(fitBaselines(MODEL, rows, "v1")).toEqual([])
  })

  test("A respects the bound for any week length, even on quiet data", () => {
    const rng = mulberry32(3)
    const pool = { gpuClass: "g", offsets: [0], residuals: Array.from({ length: 2_000 }, () => normalFrom(rng)) }
    expect(chooseLogA([pool], PUBLISHED_BASELINE, 0.01, 200, rng).logA).toBeGreaterThanOrEqual(Math.log(100))
  })

  test("heavy-tailed honest scores push A up", () => {
    const rng = mulberry32(4)
    const light = { gpuClass: "g", offsets: [0], residuals: Array.from({ length: 2_000 }, () => normalFrom(rng)) }
    const heavy = { gpuClass: "g", offsets: [0], residuals: Array.from({ length: 2_000 }, () => normalFrom(rng) * (rng() < 0.1 ? 3 : 1)) }
    expect(chooseLogA([heavy], PUBLISHED_BASELINE, 0.01, 400, rng).quantiles[0]!.quantile).toBeGreaterThan(chooseLogA([light], PUBLISHED_BASELINE, 0.01, 400, rng).quantiles[0]!.quantile)
  })
})

describe("the report", () => {
  test("the same rows and seed give the same report", () => {
    const { baselines: _a, ...first } = run()
    const { baselines: _b, ...second } = run()
    expect(first).toEqual(second)
  })

  test("a passing hardware run is ready", () => {
    const result = run({ honest: rowsOf({ seed: 1, weeks: 44, perWeek: 120 }), bootWeeks: 600 })
    expect(result.scored).toBeGreaterThanOrEqual(20_000)
    expect(result.gates).toEqual({ scored: true, gpuClasses: true, images: true, bootstrapWeeks: true, falseFlags: true, power: true, hardware: true })
    expect(result.ready).toBe(true)
    expect(result.delta).toBeGreaterThan(1)
  })

  test("fewer than 20,000 scores is not ready", () => {
    const result = run({ honest: rowsOf({ seed: 1, weeks: 4 }) })
    expect(result.gates.scored).toBe(false)
    expect(result.ready).toBe(false)
  })

  test("one GPU class is not ready", () => {
    expect(run({ honest: rowsOf({ seed: 1, classes: ["gpu-a"], weeks: 40 }) }).gates.gpuClasses).toBe(false)
  })

  test("one image is not ready", () => {
    expect(run({ honest: rowsOf({ seed: 1, images: ["image-a"], weeks: 40 }) }).gates.images).toBe(false)
  })

  test("a stand-in the test cannot see fails the power gate", () => {
    const result = run({ swaps: [...swapRows("small", 3.2, 2), ...swapRows("fp8", 0.3, 3)] })
    expect(result.gates.power).toBe(false)
    expect(result.power.fp8!["0.10"]!).toBeLessThan(0.95)
  })

  test("no stand-in runs at all fails the power gate", () => {
    expect(run({ swaps: [] }).gates.power).toBe(false)
  })
