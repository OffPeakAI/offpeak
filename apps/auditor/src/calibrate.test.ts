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

  test("power is reported at 5, 10 and 25 percent", () => {
    expect(Object.keys(run().power.small!).sort()).toEqual(["0.05", "0.10", "0.25"])
  })

  test("a simulation never counts as ready, whatever it scores", () => {
    const result = run({ honest: rowsOf({ seed: 1, weeks: 44, perWeek: 120 }), source: "simulation", bootWeeks: 600 })
    expect(result.gates.hardware).toBe(false)
    expect(result.ready).toBe(false)
  })

  test("rate gates use an upper bound, so a small run cannot pass on luck", () => {
    expect(wilsonUpper(0, 50)).toBeGreaterThan(0.01)
    expect(wilsonUpper(0, 1_000)).toBeLessThan(0.01)
    expect(wilsonLower(190, 200)).toBeLessThan(0.95)
  })
})

describe("in the database", () => {
  test("a saved calibration publishes thresholds, baselines and the report", async () => {
    const booted = await bootStack()
    const empty = await (await booted.app.request("/v1/audits/calibration")).json()
    expect(empty).toMatchObject({ testId: "llr-mix-v1", status: "not_calibrated", thresholds: { default: PUBLISHED_BASELINE } })
    expect(empty.note).toContain("placeholders")
    await saveCalibration(booted.stack.db, run({ source: "simulation" }))
    const full = await (await booted.app.request("/v1/audits/calibration")).json()
    expect(full.status).toBe("not_calibrated")
    expect(full.reports).toHaveLength(1)
    expect(full.reports[0].modelDigest).toBe(MODEL)
    expect(full.baselines.length).toBeGreaterThan(0)
    expect(full.liveFalseFlags).toEqual({ flagsOnReferenceHosts: 0, flagsClearedByPanel: 0 })
  })

  test("a weekly live report does not undo a real calibration", async () => {
    const booted = await bootStack()
    await saveCalibration(booted.stack.db, run({ honest: rowsOf({ seed: 1, weeks: 44, perWeek: 120 }), bootWeeks: 600 }))
    expect((await (await booted.app.request("/v1/audits/calibration")).json()).status).toBe("calibrated")
    await saveCalibration(booted.stack.db, run({ source: "live", now: 1_800_000_500 }))
    expect((await (await booted.app.request("/v1/audits/calibration")).json()).status).toBe("calibrated")
  })

  test("the public report calls simulated figures what they are", async () => {
    const booted = await bootStack()
    const text = JSON.stringify(await (await booted.app.request("/v1/audits/calibration")).json())
    expect(text).toContain("synthetic data, not real swaps")
    expect(text).not.toMatch(/catches? (real|all|every) swaps?|guarantee/i)
  })

  test("a report only counts for filing when it matches the pin", async () => {
    const db = await openDb()
    await saveCalibration(db, run({ honest: rowsOf({ seed: 1, weeks: 44, perWeek: 120 }), bootWeeks: 600 }))
    expect((await latestCalibration(db, MODEL))?.ready).toBe(true)
    expect(await filingCalibrated(db, MODEL)).toBe(false)
  })

  test("weekly recalibration keeps δ, saves a proposal and leaves the pin alone", async () => {
    const db = await openDb()
    const now = 1_800_000_000
    const honest = rowsOf({ seed: 9, weeks: 14, perWeek: 120 })
    for (const [i, row] of honest.entries()) {
      await db.query("INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, ts, gpu_class, image_digest, temp_bucket, len_bucket) VALUES ($1,$2,$3,'b',$4,0,'0xr',$5,$6,$7,'(0.5,1]','<=256')", [`r${i}`, row.hostWeek, MODEL, row.ll, now - 1_000 - i, row.gpuClass, row.imageDigest])
    }
    await db.query("INSERT INTO serving.audit_reference_hosts (host, model_digest, endpoint, gpu_class, image_digest, attested) SELECT DISTINCT host, model_digest, '', 'g', 'i', true FROM serving.audit_scores")
    const done = await recalibrateLive(db, MODEL, now)
    expect(done).toMatchObject({ saved: expect.any(String) })
    const saved = await latestCalibration(db, MODEL)
    expect(saved?.source).toBe("live")
    expect(saved?.ready).toBe(false)
    expect(saved?.report.delta).toBe(PUBLISHED_BASELINE.delta)
  }, 60_000)

  test("too few live scores skips the refit", async () => {
    expect(await recalibrateLive(await openDb(), MODEL, 1_800_000_000)).toMatchObject({ skipped: "too_few_scores" })
  })

  test("only attested reference hosts feed the refit, so an unflagged cheater cannot", async () => {
    const db = await openDb()
    await db.query("INSERT INTO serving.audit_runs (host, model_digest, week, n, llr, threshold, flagged) VALUES ('0xbad',$1,1,200,9,5,true)", [MODEL])
    await db.query("INSERT INTO serving.audit_reference_hosts (host, model_digest, endpoint, gpu_class, image_digest, attested) VALUES ('0xattested',$1,'','g','i',true), ('0xunattested',$1,'','g','i',false)", [MODEL])
    for (const [i, host] of ["0xbad", "0xunflaggedcheater", "0xunattested", "0xattested"].entries()) {
      await db.query("INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, ts) VALUES ($1,$2,$3,'b',-1,0,'0xr',100)", [`r${i}`, host, MODEL])
    }
    const { liveHonestRows } = await import("./calibrate.ts")
    expect((await liveHonestRows(db, MODEL, 0)).map((row) => row.hostWeek.split(":")[0])).toEqual(["0xattested"])
  })

  test("a refit that moves a baseline far is held back, which stops slow poisoning", () => {
    const old: Baseline = { modelDigest: MODEL, gpuClass: "g", imageDigest: "i", tempBucket: "0", lenBucket: "<=64", mu: -2, sigma: 0.5, n: 500, version: "v1" }
    const previous = new Map([[baselineId(old), old]])
    expect(shiftedBuckets(previous, [{ ...old, mu: -2.2 }])).toEqual([])
    expect(shiftedBuckets(previous, [{ ...old, mu: -2.4 }])).toHaveLength(1)
  })

  test("a refit that widens or narrows sigma far is held back too, because a wide sigma hides a swap", () => {
    const old: Baseline = { modelDigest: MODEL, gpuClass: "g", imageDigest: "i", tempBucket: "0", lenBucket: "<=64", mu: -2, sigma: 0.5, n: 500, version: "v1" }
    const previous = new Map([[baselineId(old), old]])
    expect(shiftedBuckets(previous, [{ ...old, sigma: 0.6 }])).toEqual([])
    expect(shiftedBuckets(previous, [{ ...old, sigma: 0.45 }])).toEqual([])
    expect(shiftedBuckets(previous, [{ ...old, sigma: 0.7 }])).toHaveLength(1)
    expect(shiftedBuckets(previous, [{ ...old, sigma: 0.3 }])).toHaveLength(1)
  })

  test("the false-flag proxy counts flags on attested reference hosts and panel clears", async () => {
    const db = await openDb()
    await db.query("INSERT INTO serving.audit_reference_hosts (host, model_digest, endpoint, gpu_class, image_digest, attested) VALUES ('0xref',$1,'','g','i',true)", [MODEL])
    await db.query("INSERT INTO serving.audit_runs (host, model_digest, week, n, llr, threshold, flagged) VALUES ('0xref',$1,1,200,9,5,true)", [MODEL])
    await db.query(`INSERT INTO serving.audit_filings (id, host, model_digest, week, kind, samples_root, evidence, signal_sequential, signal_replication, status, outcome, from_block) VALUES ('x','0xh',$1,1,0,'0xr','{}'::jsonb,true,true,'filed','cleared',0)`, [MODEL])
    expect(await falseFlagProxy(db)).toEqual({ flagsOnReferenceHosts: 1, flagsClearedByPanel: 1 })
  })

  test("baselines load newest first", async () => {
    const db = await openDb()
    await saveCalibration(db, run({ now: 1_800_000_000 }))
    await saveCalibration(db, run({ now: 1_800_000_100 }))
    const loaded = [...(await loadBaselines(db, MODEL)).values()]
    expect(new Set(loaded.map((row) => row.version))).toEqual(new Set(["v001800000100"]))
  })

  test("rows from a real run load from JSON lines, and stand-ins are told apart", async () => {
    const path = join(tmpdir(), `rows-${process.pid}.jsonl`)
    writeFileSync(path, ['{"hostWeek":"w","gpuClass":"g","imageDigest":"i","temperature":0,"tokensOut":8,"ll":-1}', '{"hostWeek":"w","gpuClass":"g","imageDigest":"i","temperature":0,"tokensOut":8,"ll":-2,"kind":"int4"}'].join("\n"))
    const { honest, swaps } = await readScoredRows(path)
    expect(honest).toHaveLength(1)
    expect(swaps.map((row) => row.kind)).toEqual(["int4"])
    writeFileSync(path, '{"hostWeek":"w","ll":"not a number"}')
    await expect(readScoredRows(path)).rejects.toThrow()
  })
})
