import type { LlrSample } from "./sequential.ts"

/** Seeded generators for tests and calibration resampling. Nothing here decides an audit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function normalFrom(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export function simulateWeek(rng: () => number, n: number, swapRate: number, delta: number): LlrSample[] {
  const out: LlrSample[] = []
  for (let i = 0; i < n; i++) {
    const swapped = rng() < swapRate
    const z = normalFrom(rng) + (swapped ? -delta : 0)
    out.push({ z })
  }
  return out
}
