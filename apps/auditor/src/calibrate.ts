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

function falseFlags(pool: Pool, baseline: LlrBaseline, weeks: number, rng: () => number) {
  let flagged = 0
  for (let i = 0; i < weeks; i++) if (scan(bootWeek(pool, BOOT_WEEK_N, rng), baseline).flagged) flagged++
  return { falseFlagRate: flagged / weeks, falseFlagUpper: wilsonUpper(flagged, weeks) }
}

function powerAt(pools: readonly Pool[], swapped: readonly number[], baseline: LlrBaseline, mix: number, runs: number, rng: () => number) {
  let flagged = 0
  for (let run = 0; run < runs; run++) {
    const honest = bootWeek(pickFrom(pools, rng), baseline.minN, rng)
    const samples = honest.map((row) => (rng() < mix ? { z: pickFrom(swapped, rng) } : row))
    if (score(samples, baseline).flagged) flagged++
  }
  return flagged / runs
}

/** How often honest weeks that sit a little low, which no baseline can model, get flagged. */
function offsetFlagRate(pools: readonly Pool[], baseline: LlrBaseline, runs: number, rng: () => number) {
  let flagged = 0
  for (let run = 0; run < runs; run++) {
    const week = bootWeek(pickFrom(pools, rng), BOOT_WEEK_N, rng).map((row) => ({ z: row.z - UNMODELLED_OFFSET }))
    if (scan(week, baseline).flagged) flagged++
  }
  return flagged / runs
}

/**
 * The δ that clears the power gate for the most stand-ins, then has the most room over it, from those
 * an honest host with a small unmodelled offset stays clear of. Power comes second: a stand-in missed
 * here fails the gate where people can see it, and a host falsely flagged pays for it.
 */
function fitDelta(pools: readonly Pool[], swapped: Map<string, number[]>, alpha: number, runs: number, rng: () => number) {
  let best = { delta: PUBLISHED_BASELINE.delta, cleared: -1, weakest: -1 }
  for (const delta of DELTA_GRID) {
    const baseline = { ...PUBLISHED_BASELINE, delta, logA: Math.log(1 / alpha) }
    if (offsetFlagRate(pools, baseline, runs, rng) > alpha) continue
    const powers = [...swapped.values()].map((zs) => powerAt(pools, zs, baseline, POWER_MIX, runs, rng)).filter((p, _i, all) => p >= TARGET_POWER || all.every((other) => other < TARGET_POWER))
    const cleared = powers.filter((p) => p >= TARGET_POWER).length
    const weakest = Math.min(...powers)
    if (cleared > best.cleared || (cleared === best.cleared && weakest >= best.weakest)) best = { delta, cleared, weakest }
  }
  return best.delta
}

/** Half the host-weeks fit baselines, a quarter choose A, a quarter check it on data neither saw. */
function splitHostWeeks(rows: readonly ScoredRow[]) {
  const labels = [...new Set(rows.map((r) => `${r.gpuClass}|${r.hostWeek}`))].sort()
  const role = new Map(labels.map((label, i) => [label, i % 4 < 2 ? "fit" : i % 4 === 2 ? "tune" : "check"]))
  const part = (name: string) => rows.filter((r) => role.get(`${r.gpuClass}|${r.hostWeek}`) === name)
  return { fit: part("fit"), tune: part("tune"), check: part("check") }
}

/** Steps 1 to 3 of the calibration plan. Pure: the same rows and seed give the same report. */
export function calibrateModel(input: CalibrationInput): CalibrationResult {
  const { modelDigest, source, honest, swaps, seed, now } = input
  const bootWeeks = Math.max(input.bootWeeks ?? 2_000, MIN_WEEKS_PER_CLASS)
  const powerRuns = input.powerRuns ?? 2_000
  const version = `v${String(now).padStart(12, "0")}`
  const rng = mulberry32(seed)
  const { fit, tune, check } = splitHostWeeks(honest)
  const baselines = fitBaselines(modelDigest, fit, version)
  const byId = new Map(baselines.map((b) => [baselineId(b), b]))
  const tunePools = poolsOf(tune, modelDigest, byId)
  const checkPools = poolsOf(check, modelDigest, byId)

  const swapped = new Map<string, number[]>()
  for (const row of swaps) {
    const z = zOf(row, modelDigest, byId)
    if (z === null) continue
    const list = swapped.get(row.kind) ?? []
    list.push(z)
    swapped.set(row.kind, list)
  }
  const delta = input.fixedDelta ?? (swapped.size > 0 ? fitDelta(tunePools, swapped, TARGET_FALSE_FLAG, Math.ceil(powerRuns / 4), rng) : PUBLISHED_BASELINE.delta)
  const chosen = chooseLogA(tunePools, { ...PUBLISHED_BASELINE, delta }, TARGET_FALSE_FLAG, bootWeeks, rng)
  const baseline = { ...PUBLISHED_BASELINE, delta, logA: chosen.logA }

  const classes = checkPools.map((pool) => ({
    gpuClass: pool.gpuClass,
    weeks: bootWeeks,
    quantile: chosen.quantiles.find((q) => q.gpuClass === pool.gpuClass)?.quantile ?? Number.NaN,
    ...falseFlags(pool, baseline, bootWeeks, rng),
  }))
  const falseFlagRate = Math.max(0, ...classes.map((c) => c.falseFlagRate))
  const falseFlagUpper = Math.max(0, ...classes.map((c) => c.falseFlagUpper))

  const power: CalibrationResult["power"] = {}
  const shifts: CalibrationResult["shifts"] = {}
  for (const [kind, zs] of swapped) {
    shifts[kind] = -zs.reduce((sum, value) => sum + value, 0) / zs.length
    power[kind] = Object.fromEntries(MIXES.map((mix) => [mix.toFixed(2), powerAt(checkPools, zs, baseline, mix, powerRuns, rng)]))
  }
  const weakest = Math.min(...Object.values(power).map((row) => row[POWER_MIX.toFixed(2)]!))

  const gpuClasses = [...new Set(honest.map((r) => r.gpuClass))].sort()
  const images = [...new Set(honest.map((r) => r.imageDigest))].sort()
  const gates = {
    scored: honest.length >= MIN_SCORED,
    gpuClasses: gpuClasses.length >= MIN_GPU_CLASSES,
    images: images.length >= MIN_IMAGES,
    bootstrapWeeks: bootWeeks >= MIN_WEEKS_PER_CLASS && classes.length === gpuClasses.length,
    falseFlags: classes.length > 0 && falseFlagUpper <= TARGET_FALSE_FLAG,
    power: swapped.size > 0 && weakest >= TARGET_POWER,
    hardware: source === "hardware",
  }
  return {
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    modelDigest,
    source,
    version,
    createdAt: now,
    ready: Object.values(gates).every(Boolean),
    ...baseline,
    scored: honest.length,
    hostWeeks: new Set(honest.map((r) => `${r.gpuClass}|${r.hostWeek}`)).size,
    gpuClasses,
    images,
    classes,
    falseFlagRate,
    falseFlagUpper,
    powerRuns,
    power,
    shifts,
    gates,
    baselines,
  }
}

export async function saveCalibration(db: Db, result: CalibrationResult) {
  const { baselines, ...report } = result
  await db.transaction(async (tx) => {
    for (const b of baselines) {
      await tx.query(
        `INSERT INTO serving.audit_baselines (model_digest, gpu_class, image_digest, temp_bucket, len_bucket, mu, sigma, n, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [b.modelDigest, b.gpuClass, b.imageDigest, b.tempBucket, b.lenBucket, b.mu, b.sigma, b.n, b.version],
      )
    }
    await tx.query("INSERT INTO serving.audit_calibrations (id, model_digest, source, ready, report) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING", [
      `${result.modelDigest}:${result.version}`,
      result.modelDigest,
      result.source,
      result.ready,
      JSON.stringify(report),
    ])
  })
}

type HonestScoreRow = { host: string; ts: string; gpu_class: string; image_digest: string; temp_bucket: string; len_bucket: string; ll_mean: number }

/** A bucket's own label stands in for the raw temperature and length, which live rows do not keep. */
const LABEL_TEMPERATURE: Record<string, number> = { "0": 0, "(0,0.5]": 0.5, "(0.5,1]": 1, ">1": 2 }
const LABEL_TOKENS: Record<string, number> = { "<=64": 64, "<=256": 256, "<=1024": 1024, ">1024": 2048 }

/**
 * Live rows from attested reference hosts only. A clean record proves nothing: a host cheating below
 * the flag has no flags, and its rows would pull the baseline towards the model it really serves.
 */
export async function liveHonestRows(db: Db, modelDigest: string, sinceTs: number): Promise<ScoredRow[]> {
  const rows = await db.query<HonestScoreRow>(
    `SELECT s.* FROM serving.audit_scores s
     WHERE s.model_digest = $1 AND s.ts >= $2
       AND EXISTS (SELECT 1 FROM serving.audit_reference_hosts h WHERE h.host = s.host AND h.model_digest = s.model_digest AND h.attested)`,
    [modelDigest, sinceTs],
  )
  return rows.rows.map((row) => ({
    hostWeek: `${row.host}:${weekIndex(Number(row.ts))}`,
    gpuClass: row.gpu_class,
    imageDigest: row.image_digest,
    temperature: LABEL_TEMPERATURE[row.temp_bucket] ?? 1,
    tokensOut: LABEL_TOKENS[row.len_bucket] ?? 256,
    ll: Number(row.ll_mean),
  }))
}

/**
 * Which buckets moved too far for a weekly refit to take effect without review. σ counts as much as
 * μ: a wider σ shrinks every z, which hides a swap as surely as a lower μ does.
 */
export function shiftedBuckets(previous: Map<string, Baseline>, next: readonly Baseline[]) {
  return next.filter((b) => {
    const old = previous.get(baselineId(b))
    if (!old) return false
    return Math.abs(b.mu - old.mu) > MAX_WEEKLY_SHIFT * old.sigma || b.sigma > old.sigma * MAX_WEEKLY_SIGMA_RATIO || b.sigma < old.sigma / MAX_WEEKLY_SIGMA_RATIO
  })
}

/**
 * Step 4: refit from live honest data. The new δ and A stay proposals until a change to
 * `PUBLISHED_BASELINES` ships them, because a ruling reads only what is pinned in the package.
 */
export async function recalibrateLive(db: Db, modelDigest: string, now: number, seed = now) {
  const honest = await liveHonestRows(db, modelDigest, now - 8 * 604_800)
  if (honest.length < MIN_SCORED / 4) return { skipped: "too_few_scores" as const, scored: honest.length }
  const result = calibrateModel({ modelDigest, source: "live", honest, swaps: [], seed, now, fixedDelta: publishedBaseline(modelDigest).delta })
  const moved = shiftedBuckets(await loadBaselines(db, modelDigest), result.baselines)
  if (moved.length > 0) return { skipped: "baseline_moved" as const, buckets: moved.map(baselineId) }
  await saveCalibration(db, result)
  return { saved: result.version, logA: result.logA }
}

/** Step 5: flags on attested reference hosts, and flags a panel later cleared. Both should stay near zero. */
export async function falseFlagProxy(db: Db) {
  const reference = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM serving.audit_runs r JOIN serving.audit_reference_hosts h ON h.host = r.host AND h.model_digest = r.model_digest
     WHERE r.flagged AND h.attested`,
  )
  const cleared = await db.query<{ n: string }>("SELECT count(*) AS n FROM serving.audit_filings WHERE kind = 0 AND outcome = 'cleared'")
  return { flagsOnReferenceHosts: Number(reference.rows[0]!.n), flagsClearedByPanel: Number(cleared.rows[0]!.n) }
}

export type CalibrationRow = { model_digest: string; source: CalibrationSource; ready: boolean; report: Omit<CalibrationResult, "baselines">; created_at: string }

export async function latestCalibration(db: Db, modelDigest: string) {
  const rows = await db.query<CalibrationRow>("SELECT * FROM serving.audit_calibrations WHERE model_digest = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [modelDigest])
  return rows.rows[0] ?? null
}

/** Pinned and real: a hardware report that passed its gates and matches what rulings will accept. */
export async function filingCalibrated(db: Db, modelDigest: string) {
  const rows = await db.query<CalibrationRow>("SELECT * FROM serving.audit_calibrations WHERE model_digest = $1 AND ready AND source = 'hardware' ORDER BY created_at DESC, id DESC LIMIT 1", [modelDigest])
  const report = rows.rows[0]?.report
  if (!report) return false
  const pinned = publishedBaseline(modelDigest)
  return pinned.delta === report.delta && pinned.logA === report.logA
}

const NOT_CALIBRATED = "Thresholds are placeholders until calibration runs on real GPU hosts. Simulated figures describe the method on synthetic data, not real swaps."

/** `GET /v1/audits/calibration`. */
export async function calibrationReport(db: Db) {
  const rows = await db.query<CalibrationRow>("SELECT DISTINCT ON (model_digest) * FROM serving.audit_calibrations ORDER BY model_digest, created_at DESC, id DESC")
  const reports = rows.rows.map((row) => row.report)
  const baselines = [...(await loadBaselines(db)).values()]
  const real = await db.query<{ model_digest: string }>("SELECT DISTINCT model_digest FROM serving.audit_calibrations WHERE ready AND source = 'hardware'")
  const covered = new Set(real.rows.map((row) => row.model_digest))
  const calibrated = rows.rows.length > 0 && rows.rows.every((row) => covered.has(row.model_digest))
  return {
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    status: calibrated ? "calibrated" : "not_calibrated",
    note: calibrated ? "Audits are statistical. They catch sustained model swaps, not every single response." : NOT_CALIBRATED,
    falseFlagTarget: TARGET_FALSE_FLAG,
    powerTarget: TARGET_POWER,
    thresholds: { default: PUBLISHED_BASELINE, byModel: PUBLISHED_BASELINES },
    baselines,
    reports,
    liveFalseFlags: await falseFlagProxy(db),
  }
}

const scoredRow = z.object({
  hostWeek: z.string().min(1),
  gpuClass: z.string().min(1),
  imageDigest: z.string().min(1),
  temperature: z.number().min(0),
  tokensOut: z.number().int().positive(),
  ll: z.number().finite(),
  kind: z.string().optional(),
})

/** Rows from a run on real hosts, one JSON object per line. A row with `kind` is a swap stand-in. */
export async function readScoredRows(path: string) {
  const honest: ScoredRow[] = []
  const swaps: SwapRow[] = []
  for await (const line of createInterface({ input: createReadStream(path) })) {
    if (!line.trim()) continue
    const { kind, ...row } = scoredRow.parse(JSON.parse(line))
    if (kind) swaps.push({ ...row, kind })
    else honest.push(row)
  }
  return { honest, swaps }
}

function arg(argv: readonly string[], name: string) {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

/**
 * `bun run apps/auditor/src/calibrate.ts --model 0x… --rows rows.jsonl --source hardware [--out report.json]`
 * Stores nothing unless OFFPEAK_DATABASE_URL is set. A passing report still has to be pinned in
 * `PUBLISHED_BASELINES` before a ruling accepts it.
 */
async function main(argv: readonly string[]) {
  const modelDigest = arg(argv, "--model")?.toLowerCase()
  const path = arg(argv, "--rows")
  const source = z.enum(["hardware", "simulation"]).parse(arg(argv, "--source") ?? "simulation")
  if (!modelDigest || !path) throw new Error("usage: calibrate --model <digest> --rows <file.jsonl> --source hardware|simulation [--out <file>]")
  const { honest, swaps } = await readScoredRows(path)
  const now = Math.floor(Date.now() / 1000)
  const result = calibrateModel({ modelDigest, source, honest, swaps, seed: now, now })
  const { baselines, ...report } = result
  const out = arg(argv, "--out")
  if (out) writeFileSync(out, JSON.stringify({ ...report, baselines }, null, 2))
  console.log(JSON.stringify(report))
  const url = process.env.OFFPEAK_DATABASE_URL
  if (url && !url.startsWith("pglite://")) {
    const { connectDatabase } = await import("../../../services/common/src/db.ts")
    await saveCalibration(connectDatabase(url), result)
  }
}

if (import.meta.main) await main(process.argv.slice(2))
