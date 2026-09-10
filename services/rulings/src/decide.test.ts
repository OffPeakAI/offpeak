import { describe, expect, test } from "bun:test"
import { PUBLISHED_BASELINE, TEST_ID, TEST_VERSION, mulberry32, score, simulateWeek } from "../../../packages/audit-tests/src/index.ts"
import { evidenceRoot, scaleStatistic, testIdHash, type EvidenceBundle, type EvidenceSample } from "../../../packages/shared/src/index.ts"
import type { Hex } from "viem"
import { KIND_CANARY, KIND_METERING, KIND_SWAP, KIND_THROUGHPUT, OUTCOME_BREACH, OUTCOME_DISMISS, OUTCOME_SWAP, decideRuling, type ChallengeFacts } from "./decide.ts"

const HOST = `0x${"aa".repeat(20)}` as Hex
const LEAF = `0x${"bb".repeat(32)}` as Hex

function flaggedZs() {
  for (let seed = 1; seed < 500; seed++) {
    const week = simulateWeek(mulberry32(seed), 200, 0.25, PUBLISHED_BASELINE.delta)
    if (score(week, PUBLISHED_BASELINE).flagged) return week.map((s) => s.z)
  }
  throw new Error("no flagged week")
}

function honestZs() {
  for (let seed = 1; seed < 500; seed++) {
    const week = simulateWeek(mulberry32(seed), 200, 0, PUBLISHED_BASELINE.delta)
    if (!score(week, PUBLISHED_BASELINE).flagged) return week.map((s) => s.z)
  }
  throw new Error("no honest week")
}

function bundleOf(zs: number[], edit: (sample: EvidenceSample, i: number) => Partial<EvidenceSample> = () => ({})): EvidenceBundle {
  return {
    v: 1,
    host: HOST,
    modelDigest: LEAF,
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    baseline: { ...PUBLISHED_BASELINE },
    samples: zs.map((z, i) => {
      const sample = { reqId: LEAF, hour: 1, leaf: LEAF, proof: [], z, canaryFail: false, refAgrees: false, meteringFlag: false }
      return { ...sample, ...edit(sample, i) }
    }),
  }
}

function factsFor(bundle: EvidenceBundle, kind = KIND_SWAP): ChallengeFacts {
  const result = score(bundle.samples, PUBLISHED_BASELINE)
  return {
    host: bundle.host,
    kind,
    samplesRoot: evidenceRoot(bundle),
    sampleCount: bundle.samples.length,
    testId: testIdHash(TEST_ID),
    statistic: scaleStatistic(result.statistic),
    threshold: scaleStatistic(result.threshold),
  }
}

describe("decideRuling", () => {
  test("a flagged test with a replication is a swap", () => {
    const bundle = bundleOf(flaggedZs(), (_s, i) => ({ refAgrees: i === 0 }))
    expect(decideRuling(bundle, factsFor(bundle), true)).toEqual({ outcome: OUTCOME_SWAP, slashBps: 10_000, reason: "both_signals" })
  })

  test("a flagged test with enough canary failures is a swap", () => {
    const bundle = bundleOf(flaggedZs(), (_s, i) => ({ canaryFail: i < 10 }))
    expect(decideRuling(bundle, factsFor(bundle), true).outcome).toBe(OUTCOME_SWAP)
  })

  test("a ruling caps a payer as the auditor did, and gets the same statistic", () => {
    const zs = [...honestZs(), ...Array.from({ length: 40 }, () => -9)]
    const framed = bundleOf(zs, (_s, i) => ({ refAgrees: i === 0, payer: i >= 200 ? "one-buyer" : null }))
    expect(score(framed.samples, PUBLISHED_BASELINE).flagged).toBe(false)
    expect(decideRuling(framed, factsFor(framed), true).reason).toBe("test_not_flagged")
    const uncapped = bundleOf(zs, (_s, i) => ({ refAgrees: i === 0 }))
    expect(decideRuling(uncapped, factsFor(uncapped), true).outcome).toBe(OUTCOME_SWAP)
  })

  test("a bundle from an older test version is not ruled on", () => {
    const bundle = bundleOf(flaggedZs(), (_s, i) => ({ refAgrees: i === 0 }))
    const old = { ...bundle, testVersion: "1" }
    expect(decideRuling(old, factsFor(old), true)).toEqual({ outcome: OUTCOME_DISMISS, slashBps: 0, reason: "unknown_test" })
  })

  test("the test alone never makes a swap", () => {
    const bundle = bundleOf(flaggedZs(), (_s, i) => ({ canaryFail: i < 9 }))
    expect(decideRuling(bundle, factsFor(bundle), true)).toEqual({ outcome: OUTCOME_DISMISS, slashBps: 0, reason: "second_signal_missing" })
  })

  test("an honest host's data dismisses, even with a second signal", () => {
    const bundle = bundleOf(honestZs(), () => ({ refAgrees: true }))
    expect(decideRuling(bundle, factsFor(bundle), true).reason).toBe("test_not_flagged")
  })

  test("identical inputs give identical rulings", () => {
    const bundle = bundleOf(flaggedZs(), () => ({ refAgrees: true }))
    expect(decideRuling(bundle, factsFor(bundle), true)).toEqual(decideRuling(structuredClone(bundle), factsFor(bundle), true))
  })

  const flagged = () => bundleOf(flaggedZs(), () => ({ refAgrees: true }))
  const broken: [string, (b: EvidenceBundle, f: ChallengeFacts) => [EvidenceBundle | null, ChallengeFacts, boolean], string][] = [
    ["a missing bundle", (_b, f) => [null, f, true], "evidence_missing"],
    ["a bundle that does not match its root", (b, f) => [{ ...b, modelDigest: HOST }, f, true], "evidence_root_mismatch"],
    ["a bundle about another host", (b, f) => [b, { ...f, host: `0x${"cc".repeat(20)}` }, true], "evidence_wrong_host"],
    ["a sample count that does not match", (b, f) => [b, { ...f, sampleCount: 199 }, true], "evidence_count_mismatch"],
    ["a leaf not in a posted root", (b, f) => [b, f, false], "leaf_unproven"],
    ["a claimed statistic the data does not give", (b, f) => [b, { ...f, statistic: f.statistic + 1n }, true], "statistic_mismatch"],
    ["an unknown test", (b, f) => [b, { ...f, testId: LEAF }, true], "unknown_test"],
  ]
  for (const [name, build, reason] of broken) {
    test(`${name} dismisses`, () => {
      const bundle = flagged()
      const [b, f, proven] = build(bundle, factsFor(bundle))
      expect(decideRuling(b, f, proven)).toEqual({ outcome: OUTCOME_DISMISS, slashBps: 0, reason })
    })
  }

  test("a bundle with its own softer baseline dismisses", () => {
    const bundle = { ...flagged(), baseline: { ...PUBLISHED_BASELINE, logA: 0 } }
    expect(decideRuling(bundle, factsFor(bundle), true).reason).toBe("baseline_mismatch")
  })

  test("a bundle from a different test version dismisses", () => {
    const bundle = { ...flagged(), testVersion: "0" }
    expect(decideRuling(bundle, factsFor(bundle), true).reason).toBe("unknown_test")
  })

  test("canary failures on five percent of samples are a breach", () => {
    const failing = bundleOf(honestZs(), (_s, i) => ({ canaryFail: i < 10 }))
    expect(decideRuling(failing, factsFor(failing, KIND_CANARY), true)).toEqual({ outcome: OUTCOME_BREACH, slashBps: 2_000, reason: "canary_failures" })
    const passing = bundleOf(honestZs(), (_s, i) => ({ canaryFail: i < 9 }))
    expect(decideRuling(passing, factsFor(passing, KIND_CANARY), true).outcome).toBe(OUTCOME_DISMISS)
  })

  test("sustained metering flags are a breach", () => {
    const flaggedRows = bundleOf(honestZs(), (_s, i) => ({ meteringFlag: i < 10 }))
    expect(decideRuling(flaggedRows, factsFor(flaggedRows, KIND_METERING), true).reason).toBe("metering_flags")
  })

  test("throughput challenges wait for Windows", () => {
    const bundle = bundleOf(honestZs())
    expect(decideRuling(bundle, factsFor(bundle, KIND_THROUGHPUT), true).reason).toBe("throughput_needs_windows")
  })
})
