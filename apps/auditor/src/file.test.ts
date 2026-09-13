import { beforeEach, describe, expect, test } from "bun:test"
import { PUBLISHED_BASELINE, TEST_ID, TEST_VERSION, mulberry32, scan, score, simulateWeek } from "@offpeak/audit-tests"
import { AuditCourtAbi } from "@offpeak/abis"
import { CHALLENGE_BOND, evidenceRoot, scaleStatistic, testIdHash, type Hex } from "@offpeak/shared"
import { TransactionReceiptNotFoundError, decodeFunctionData, keccak256, parseTransaction, toBytes } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { Metrics } from "../../../services/common/src/metrics.ts"
import { KIND_SWAP, OUTCOME_SWAP, decideRuling } from "../../../services/rulings/src/decide.ts"
import { openDb } from "../../router/src/store.ts"
import type { Db } from "../../../services/common/src/db.ts"
import { canaryThreshold } from "./canaries.ts"
import { buildSwapBundle, loadRunScores, type AuditBundle, type RunScores } from "./evidence.ts"
import { LOW_BOND_MICRO, checkBond, fileMetering, fileSwap, fileThroughput, reconcileFilings, swapSignals } from "./file.ts"

const HOST = `0x${"aa".repeat(20)}` as Hex
const MODEL = keccak256(toBytes("model"))
const REF_A = `0x${"0a".repeat(20)}`
const REF_B = `0x${"0b".repeat(20)}`
const LEAF = keccak256(toBytes("leaf"))

const idOf = (i: number) => keccak256(toBytes(`req-${i}`))

function flaggedWeek(seed = 1) {
  for (let s = seed; s < seed + 500; s++) {
    const week = simulateWeek(mulberry32(s), 400, 0.25, PUBLISHED_BASELINE.delta)
    const read = scan(week, PUBLISHED_BASELINE)
    if (read.flagged) return { zs: week.map((row) => row.z), n: read.n }
  }
  throw new Error("no flagged week")
}

function honestWeek() {
  return simulateWeek(mulberry32(3), 400, 0, PUBLISHED_BASELINE.delta).map((row) => row.z)
}

type BundleOpts = { zs: number[]; first: number; replication?: "fresh" | "none" | "unflagged" | "same-ref" | "reused" | "host-as-ref"; canaryFails?: number; threshold?: number }

/** A bundle as `buildSwapBundle` writes it, then edited by each test. */
function bundleOf(opts: BundleOpts): AuditBundle {
  const { zs, first } = opts
  const reqIds = zs.map((_z, i) => idOf(i))
  const fresh = reqIds.slice(first)
  const kind = opts.replication ?? "fresh"
  const replicaZs = kind === "unflagged" ? fresh.map(() => 1) : fresh.map((_r, i) => zs[first + i]!)
  const replicaRef = kind === "same-ref" ? REF_A : kind === "host-as-ref" ? HOST : REF_B
  const replication = kind === "none" ? null : { primaryRef: REF_A, refHost: replicaRef, reqIds: kind === "reused" ? reqIds.slice(0, fresh.length) : fresh, zs: replicaZs }
  const signalled = new Set(kind === "none" || kind === "unflagged" ? [] : kind === "reused" ? reqIds.slice(0, fresh.length) : fresh)
  const failedIds = new Set(reqIds.slice(0, opts.canaryFails ?? 0))
  return {
    v: 1,
    host: HOST,
    modelDigest: MODEL,
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    baseline: { ...PUBLISHED_BASELINE },
    samples: zs.map((z, i) => ({ reqId: reqIds[i]!, hour: 1, leaf: LEAF, proof: [], z, canaryFail: failedIds.has(reqIds[i]!), refAgrees: signalled.has(reqIds[i]!), meteringFlag: false })),
    attachments: {
      firstRun: first,
      scores: [],
      canaries: [...failedIds].map((reqId) => ({ reqId, promptId: "sum:1", deterministic: true, body: {}, output: "wrong", accepted: ["right"] })),
      buyerSamples: [],
      replication,
      canaryThreshold: opts.threshold ?? 0,
    },
  }
}

const swapBundle = () => {
  const { zs, n } = flaggedWeek()
  return bundleOf({ zs, first: n })
}

function factsFor(bundle: AuditBundle) {
  const result = score(bundle.samples, PUBLISHED_BASELINE)
  return { host: bundle.host, kind: KIND_SWAP, samplesRoot: evidenceRoot(bundle), sampleCount: bundle.samples.length, testId: testIdHash(TEST_ID), statistic: scaleStatistic(result.statistic), threshold: scaleStatistic(result.threshold) }
}

describe("the two-signal rule", () => {
  test("a flag with a fresh replication on a second reference passes, and a ruling agrees", () => {
    const bundle = swapBundle()
    expect(swapSignals(bundle)).toEqual({ sequential: true, canary: false, replication: true, reason: null })
    expect(decideRuling(bundle, factsFor(bundle), true).outcome).toBe(OUTCOME_SWAP)
  })

  test("a flag with canary failures past their threshold passes, and a ruling agrees", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 30, threshold: 10 })
    expect(swapSignals(bundle)).toEqual({ sequential: true, canary: true, replication: false, reason: null })
    expect(decideRuling(bundle, factsFor(bundle), true).outcome).toBe(OUTCOME_SWAP)
  })

  test("a flag alone does not pass", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "none" })).reason).toBe("second_signal_missing")
  })

  test("canary failures under their threshold do not pass", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "none", canaryFails: 9, threshold: 10 })).reason).toBe("second_signal_missing")
  })

  test("both second signals without a flag do not pass", () => {
    const zs = honestWeek()
    const bundle = bundleOf({ zs, first: 200, canaryFails: 30, threshold: 10 })
    bundle.attachments.replication!.zs = Array.from({ length: 200 }, () => -6)
    expect(swapSignals(bundle).reason).toBe("test_not_flagged")
  })

  test("a replication that did not flag is no signal", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "unflagged" })).reason).toBe("second_signal_missing")
  })

  test("the same reference host cannot replicate itself", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "same-ref" })).replication).toBe(false)
  })

  test("the audited host cannot be its own reference", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "host-as-ref" })).replication).toBe(false)
  })

  test("a replication must read responses the flag never saw", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "reused" })).replication).toBe(false)
  })

  test("a replication under the sample minimum is no signal", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs: zs.slice(0, n + 150), first: n })
    expect(swapSignals(bundle).replication).toBe(false)
  })

  test("a refAgrees mark with nothing behind it is refused as forged", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none" })
    bundle.samples[0]!.refAgrees = true
    expect(swapSignals(bundle).reason).toBe("signal_not_supported_by_evidence")
  })

  test("a canaryFail mark that does not match its canary is refused as forged", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 30, threshold: 10 })
    bundle.attachments.canaries[0]!.output = "right"
    expect(swapSignals(bundle).reason).toBe("signal_not_supported_by_evidence")
  })

  test("an open prompt's mismatch cannot count as a canary failure", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 30, threshold: 10 })
    for (const canary of bundle.attachments.canaries) canary.deterministic = false
    expect(swapSignals(bundle).reason).toBe("signal_not_supported_by_evidence")
  })

  test("a softer baseline than the pinned one is refused", () => {
    const bundle = swapBundle()
    bundle.baseline = { ...PUBLISHED_BASELINE, logA: 0 }
    expect(swapSignals(bundle).reason).toBe("baseline_not_pinned")
  })

  test("a threshold of zero never counts", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "none", threshold: 0 })).canary).toBe(false)
  })

  test("across 2,000 simulated swap weeks with no second signal, none passes", () => {
    const rng = mulberry32(77)
    let flagged = 0
    for (let run = 0; run < 2_000; run++) {
      const week = simulateWeek(rng, 400, 0.1, PUBLISHED_BASELINE.delta)
      const read = scan(week, PUBLISHED_BASELINE)
      if (read.flagged) flagged++
      expect(swapSignals(bundleOf({ zs: week.map((row) => row.z), first: read.n, replication: "none" })).reason).not.toBeNull()
    }
    expect(flagged).toBeGreaterThan(1_900)
  })
})
