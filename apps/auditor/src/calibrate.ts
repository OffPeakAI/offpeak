import { createReadStream, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { PUBLISHED_BASELINE, PUBLISHED_BASELINES, TEST_ID, TEST_VERSION, mulberry32, publishedBaseline, scan, score, type LlrBaseline, type LlrSample } from "@offpeak/audit-tests"
import { weekIndex } from "@offpeak/shared"
import { z } from "zod"
import type { Db } from "../../../services/common/src/db.ts"
import { baselineId, lenBucket, loadBaselines, standardise, tempBucket, type Baseline } from "./score.ts"

/** The most a host-week may be falsely flagged, and the least a 10% mix may be missed by. */
export const TARGET_FALSE_FLAG = 0.01
export const TARGET_POWER = 0.95
export const MIN_SCORED = 20_000
export const MIN_GPU_CLASSES = 2
export const MIN_IMAGES = 2
export const MIN_WEEKS_PER_CLASS = 50
const MIN_BUCKET_N = 100
const MIXES = [0.05, 0.1, 0.25] as const
const POWER_MIX = 0.1
const DELTA_GRID = [1.5, 2, 2.5, 3, 3.5, 4, 5]
/** In σ. A host can sit this far from its baseline for reasons no bucket captures. */
const UNMODELLED_OFFSET = 0.25
/** Bootstrapped weeks read on past the 200-sample mark, as real weeks do. */
const BOOT_WEEK_N = 400
/** A weekly refit moving a bucket further than this, in σ, waits for a human. */
const MAX_WEEKLY_SHIFT = 0.5
/** So does one that widens or narrows σ by more than this factor. */
const MAX_WEEKLY_SIGMA_RATIO = 1.25

export type ScoredRow = { hostWeek: string; gpuClass: string; imageDigest: string; temperature: number; tokensOut: number; ll: number }
export type SwapRow = ScoredRow & { kind: string }

export type CalibrationSource = "hardware" | "live" | "simulation"

export type CalibrationInput = {
  modelDigest: string
  source: CalibrationSource
  honest: ScoredRow[]
  swaps: SwapRow[]
  seed: number
  now: number
  bootWeeks?: number
  powerRuns?: number
  /** Live recalibration has no swap runs, so δ stays as pinned. */
  fixedDelta?: number
}

export type ClassReport = { gpuClass: string; weeks: number; quantile: number; falseFlagRate: number; falseFlagUpper: number }

export type CalibrationResult = {
  testId: string
  testVersion: string
  modelDigest: string
  source: CalibrationSource
  version: string
  createdAt: number
  ready: boolean
  epsilon: number
  delta: number
  logA: number
  minN: number
  scored: number
  hostWeeks: number
  gpuClasses: string[]
  images: string[]
  classes: ClassReport[]
  falseFlagRate: number
  falseFlagUpper: number
  powerRuns: number
  power: Record<string, Record<string, number>>
  shifts: Record<string, number>
  gates: { scored: boolean; gpuClasses: boolean; images: boolean; bootstrapWeeks: boolean; falseFlags: boolean; power: boolean; hardware: boolean }
  baselines: Baseline[]
}

export function fitBaselines(modelDigest: string, rows: readonly ScoredRow[], version: string): Baseline[] {
  const groups = new Map<string, { key: Omit<Baseline, "mu" | "sigma" | "n" | "version">; sum: number; sumSq: number; n: number }>()
  for (const row of rows) {
    const key = { modelDigest, gpuClass: row.gpuClass, imageDigest: row.imageDigest, tempBucket: tempBucket(row.temperature), lenBucket: lenBucket(row.tokensOut) }
    const id = baselineId(key)
    const group = groups.get(id) ?? { key, sum: 0, sumSq: 0, n: 0 }
    group.sum += row.ll
    group.sumSq += row.ll * row.ll
    group.n += 1
    groups.set(id, group)
  }
  const out: Baseline[] = []
  for (const { key, sum, sumSq, n } of groups.values()) {
    if (n < MIN_BUCKET_N) continue
    const mu = sum / n
    const sigma = Math.sqrt(Math.max(0, (sumSq - n * mu * mu) / (n - 1)))
    if (sigma > 0) out.push({ ...key, mu, sigma, n, version })
  }
  return out
}

function zOf(row: ScoredRow, modelDigest: string, baselines: Map<string, Baseline>) {
  const key = { modelDigest, gpuClass: row.gpuClass, imageDigest: row.imageDigest, tempBucket: tempBucket(row.temperature), lenBucket: lenBucket(row.tokensOut) }
  const baseline = baselines.get(baselineId(key))
  return baseline ? standardise(row.ll, baseline) : null
}

/** One GPU class: how far each host-week sat from zero, and every score's distance from its week. */
type Pool = { gpuClass: string; offsets: number[]; residuals: number[] }

function poolsOf(rows: readonly ScoredRow[], modelDigest: string, baselines: Map<string, Baseline>): Pool[] {
  const classes = new Map<string, Map<string, number[]>>()
  for (const row of rows) {
    const z = zOf(row, modelDigest, baselines)
    if (z === null) continue
    const weeks = classes.get(row.gpuClass) ?? new Map<string, number[]>()
    const week = weeks.get(row.hostWeek) ?? []
    week.push(z)
    weeks.set(row.hostWeek, week)
    classes.set(row.gpuClass, weeks)
  }
  return [...classes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([gpuClass, weeks]) => {
    const offsets: number[] = []
    const residuals: number[] = []
    for (const week of weeks.values()) {
      const offset = week.reduce((sum, z) => sum + z, 0) / week.length
      offsets.push(offset)
      for (const z of week) residuals.push(z - offset)
    }
    return { gpuClass, offsets, residuals }
  })
}

const pickFrom = <T>(items: readonly T[], rng: () => number) => items[Math.floor(rng() * items.length)]!

/** A simulated week keeps one real host-week's offset and draws its spread from the whole class. */
function bootWeek(pool: Pool, n: number, rng: () => number): LlrSample[] {
  const offset = pickFrom(pool.offsets, rng)
  return Array.from({ length: n }, () => ({ z: offset + pickFrom(pool.residuals, rng) }))
}

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
}

/** Wilson upper bound at 95%, so a small run cannot pass a rate gate on luck. */
export function wilsonUpper(hits: number, runs: number, z = 1.96) {
  const p = hits / runs
  const denominator = 1 + (z * z) / runs
  return (p + (z * z) / (2 * runs) + z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))) / denominator
}

export function wilsonLower(hits: number, runs: number, z = 1.96) {
  const p = hits / runs
  const denominator = 1 + (z * z) / runs
  return (p + (z * z) / (2 * runs) - z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))) / denominator
}

/**
 * The smallest log(A) keeping bootstrapped honest weeks under α. It never drops below log(1/α),
 * the bound that holds for any week length when z is truly normal.
 */
export function chooseLogA(pools: readonly Pool[], baseline: LlrBaseline, alpha: number, weeks: number, rng: () => number) {
  const open = { ...baseline, logA: Number.POSITIVE_INFINITY }
  const quantiles = pools.map((pool) => {
    const peaks = Array.from({ length: weeks }, () => scan(bootWeek(pool, BOOT_WEEK_N, rng), open).peak)
    return { gpuClass: pool.gpuClass, quantile: quantile(peaks, 1 - alpha) }
  })
  return { logA: Math.max(Math.log(1 / alpha), ...quantiles.map((q) => q.quantile)), quantiles }
}
