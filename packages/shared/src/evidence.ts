import { keccak256, toBytes, type Hex } from "viem"
import { canonicalJson } from "./canonical.ts"

/** Statistics travel on chain as int256 scaled by this. */
export const STATISTIC_SCALE = 1_000_000

export type EvidenceSample = {
  reqId: Hex
  hour: number
  leaf: Hex
  proof: Hex[]
  z: number
  /** A pseudonym for the buyer behind a sample, so a ruling applies the same per-payer cap. Canaries have none. */
  payer?: string | null
  canaryFail: boolean
  /** A second, independent reference host replicated the likelihood result on this sample. */
  refAgrees: boolean
  meteringFlag: boolean
}

/** What a ruling process needs to recheck a challenge alone. `Evidence.samplesRoot` commits to it. */
export type EvidenceBundle = {
  v: 1
  host: Hex
  modelDigest: Hex
  testId: string
  testVersion: string
  baseline: { epsilon: number; delta: number; logA: number; minN: number }
  samples: EvidenceSample[]
}

export function evidenceRoot(bundle: EvidenceBundle): Hex {
  return keccak256(toBytes(canonicalJson(bundle)))
}

export function testIdHash(testId: string): Hex {
  return keccak256(toBytes(testId))
}

export function scaleStatistic(value: number): bigint {
  return BigInt(Math.round(value * STATISTIC_SCALE))
}
