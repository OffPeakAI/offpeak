import { TEST_ID, TEST_VERSION, publishedBaseline, score } from "@offpeak/audit-tests"
import { evidenceRoot, scaleStatistic, testIdHash, type EvidenceBundle, type EvidenceSample } from "@offpeak/shared"

export const KIND_SWAP = 0
export const KIND_THROUGHPUT = 1
export const KIND_METERING = 2
export const KIND_CANARY = 3

export const OUTCOME_DISMISS = 0
export const OUTCOME_BREACH = 1
export const OUTCOME_SWAP = 2

/** Canary failures or metering flags on at least this share of samples count as a signal. */
const SIGNAL_SHARE = 0.05

export type ChallengeFacts = {
  host: string
  kind: number
  samplesRoot: string
  sampleCount: number
  testId: string
  statistic: bigint
  threshold: bigint
}

export type RulingDecision = { outcome: number; slashBps: number; reason: string }

const dismiss = (reason: string): RulingDecision => ({ outcome: OUTCOME_DISMISS, slashBps: 0, reason })
const breach = (reason: string): RulingDecision => ({ outcome: OUTCOME_BREACH, slashBps: 2_000, reason })

const shareReached = (count: number, total: number) => count >= Math.ceil(total * SIGNAL_SHARE)

function sameBaseline(bundle: EvidenceBundle) {
  const expected = publishedBaseline(bundle.modelDigest)
  const given = bundle.baseline
  return given.epsilon === expected.epsilon && given.delta === expected.delta && given.logA === expected.logA && given.minN === expected.minN
}

function evidenceProblem(bundle: EvidenceBundle | null, facts: ChallengeFacts): string | null {
  if (!bundle) return "evidence_missing"
  if (evidenceRoot(bundle) !== facts.samplesRoot) return "evidence_root_mismatch"
  if (bundle.host.toLowerCase() !== facts.host.toLowerCase()) return "evidence_wrong_host"
  if (bundle.samples.length !== facts.sampleCount) return "evidence_count_mismatch"
  return null
}

function ruleSwap(samples: EvidenceSample[], flagged: boolean): RulingDecision {
  if (!flagged) return dismiss("test_not_flagged")
  const canaryFails = samples.filter((s) => s.canaryFail).length
  const replicated = samples.some((s) => s.refAgrees)
  if (!replicated && !shareReached(canaryFails, samples.length)) return dismiss("second_signal_missing")
  return { outcome: OUTCOME_SWAP, slashBps: 10_000, reason: "both_signals" }
}

/**
 * Deterministic: the bundle, its proofs and the pinned test decide everything. Anything the
 * evidence cannot prove dismisses, so doubt always falls on the challenger.
 */
export function decideRuling(bundle: EvidenceBundle | null, facts: ChallengeFacts, leavesProven: boolean): RulingDecision {
  const problem = evidenceProblem(bundle, facts)
  if (problem) return dismiss(problem)
  if (!leavesProven) return dismiss("leaf_unproven")
  const { samples } = bundle!
  if (facts.kind === KIND_THROUGHPUT) return dismiss("throughput_needs_windows")
  if (facts.kind === KIND_CANARY) {
    const fails = samples.filter((s) => s.canaryFail).length
    return shareReached(fails, samples.length) ? breach("canary_failures") : dismiss("canary_passed")
  }
  if (facts.kind === KIND_METERING) {
    const flags = samples.filter((s) => s.meteringFlag).length
    return shareReached(flags, samples.length) ? breach("metering_flags") : dismiss("metering_clean")
  }

  if (bundle!.testId !== TEST_ID || bundle!.testVersion !== TEST_VERSION) return dismiss("unknown_test")
  if (facts.testId !== testIdHash(TEST_ID)) return dismiss("unknown_test")
  if (!sameBaseline(bundle!)) return dismiss("baseline_mismatch")
  const result = score(samples, publishedBaseline(bundle!.modelDigest))
  if (scaleStatistic(result.statistic) !== facts.statistic || scaleStatistic(result.threshold) !== facts.threshold) {
    return dismiss("statistic_mismatch")
  }
  return ruleSwap(samples, result.flagged)
}
