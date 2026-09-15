/**
 * Likelihood-ratio mixture sequential test, testId `llr-mix-v1`.
 * Pure and deterministic. Ruling services execute a pinned version of this package.
 *
 * Λ_n = Σ log((1−ε)·φ(z) + ε·φ(z+δ)) − log φ(z)
 * Flag when n ≥ minN and Λ_n ≥ log(A).
 *
 * Λ is a supermartingale on exactly standard normal z, so `A ≥ 1/α` keeps the chance of ever
 * crossing below α however long a week runs. Real scores are not exactly normal, which is why
 * calibration still has to choose `A` on honest data.
 */
export const TEST_ID = "llr-mix-v1"
export const TEST_VERSION = "2"

/**
 * One response may not outweigh a week: z is winsorised here, so every caller gets the same bound.
 * At δ = 2.5 this holds a term to about 3.35, under log(A), and leaves a 10% mix its power.
 */
export const Z_CLAMP = 3.5

/**
 * The most one payer's samples can add to Λ, whatever they sent. It sits below log(A), so no single
 * buyer can flag a host alone. It only ever lowers Λ, so the false-flag bound above still holds.
 */
export const PAYER_CAP = 3.5

/** Past this many samples a payer adds nothing the test can use, so planning counts no more of them. */
export const PAYER_SAMPLE_QUOTA = 10

/** Terms sum on this integer grid, so the statistic cannot depend on sample order or float carry. */
const TERM_SCALE = 1e9

/** `payer` groups one buyer's samples under the cap. Canaries are the auditor's own and carry none. */
export type LlrSample = { z: number; payer?: string | null }

export type LlrBaseline = {
  epsilon: number
  delta: number
  logA: number
  minN: number
}

export type LlrScore = {
  statistic: number
  threshold: number
  flagged: boolean
}

export type LlrScan = LlrScore & {
  /** Samples read: the crossing point when flagged, otherwise all of them. */
  n: number
  /** The largest Λ seen from minN on, which calibration needs to choose `A`. */
  peak: number
}

/** log φ(z) for the standard normal, unused directly; the ratio form is stable. */
export function standardNormalLogDensity(z: number): number {
  return -0.5 * z * z - 0.5 * Math.log(2 * Math.PI)
}

export function llrTerm(z: number, epsilon: number, delta: number): number {
  const clamped = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z))
  const ratio = Math.exp(-clamped * delta - 0.5 * delta * delta)
  const mixed = (1 - epsilon) + epsilon * ratio
  if (mixed <= 0) return Number.NEGATIVE_INFINITY
  return Math.log(mixed)
}

const scaledTerm = (z: number, baseline: LlrBaseline) => Math.round(llrTerm(z, baseline.epsilon, baseline.delta) * TERM_SCALE)

const SCALED_PAYER_CAP = Math.round(PAYER_CAP * TERM_SCALE)

/** Running Λ on the grid. Each payer's sum is capped as a whole, so sample order cannot matter. */
function tally(baseline: LlrBaseline) {
  const payers = new Map<string, number>()
  let total = 0
  return (sample: LlrSample) => {
    const term = scaledTerm(sample.z, baseline)
    if (!sample.payer) return (total += term)
    const before = payers.get(sample.payer) ?? 0
    const after = before + term
    payers.set(sample.payer, after)
    return (total += Math.min(SCALED_PAYER_CAP, after) - Math.min(SCALED_PAYER_CAP, before))
  }
}

/** The statistic over all samples. This is the function a ruling recomputes. */
export function score(samples: readonly LlrSample[], baseline: LlrBaseline): LlrScore {
  const add = tally(baseline)
  let total = 0
  for (const sample of samples) total = add(sample)
  const statistic = total / TERM_SCALE
  const flagged = samples.length >= baseline.minN && statistic >= baseline.logA
  return { statistic, threshold: baseline.logA, flagged }
}

/**
 * Walks samples in order and stops at the first crossing from minN on. `score` over the first `n`
 * samples gives the same statistic and flag, so a bundle cut at `n` rules the way the scan read it.
 */
export function scan(samples: readonly LlrSample[], baseline: LlrBaseline): LlrScan {
  const add = tally(baseline)
  let total = 0
  let peak = Number.NEGATIVE_INFINITY
  for (let i = 0; i < samples.length; i++) {
    total = add(samples[i]!)
    const n = i + 1
    if (n < baseline.minN) continue
    const statistic = total / TERM_SCALE
    peak = Math.max(peak, statistic)
    if (statistic >= baseline.logA) return { statistic, threshold: baseline.logA, flagged: true, n, peak }
  }
  return { statistic: total / TERM_SCALE, threshold: baseline.logA, flagged: false, n: samples.length, peak }
}

/**
 * Placeholder until calibration runs on real GPU hosts. δ = 2.5 and log(A) = 5 come from synthetic
 * data only: log(A) = 5 sits above log(1/α) for α = 1%, and at a true shift of 2.5 a 10% mix crosses
 * inside 200 samples in about 96% of simulated runs. Neither figure says anything about real swaps.
 */
export const PUBLISHED_BASELINE: LlrBaseline = {
  epsilon: 0.1,
  delta: 2.5,
  logA: 5,
  minN: 200,
}

/**
 * Per-model values from a calibration run, keyed by lowercase model digest. Rulings accept only
 * what is pinned here, so a new value ships as a change to this file, never through the database.
 */
export const PUBLISHED_BASELINES: Readonly<Record<string, LlrBaseline>> = {}

export function publishedBaseline(modelDigest: string): LlrBaseline {
  return PUBLISHED_BASELINES[modelDigest.toLowerCase()] ?? PUBLISHED_BASELINE
}
