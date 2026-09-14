import { mulberry32, type LlrSample } from "@offpeak/audit-tests"
import { CLAIMED, scoreTokens, serveTokens, type MockLogits, type MockServing, type MockVariant } from "../../host-agent/src/mock-model.ts"
import { baselineId, lenBucket, llMean, standardise, tempBucket, type Baseline } from "./score.ts"
import type { ScoredRow, SwapRow } from "./calibrate.ts"

/**
 * Synthetic host-weeks for the auditor simulation in BUILD_B section 5. Everything here runs the
 * mock engine's model, so it shows the method working on synthetic data. It is not evidence that a
 * real swap would be caught, and no production path imports it.
 */
export type SimGpu = { name: string; noise: number }

export const SIM_GPUS: SimGpu[] = [
  { name: "h100-80g-sxm", noise: 0.04 },
  { name: "a100-80g", noise: 0.07 },
  { name: "l40s-48g", noise: 0.1 },
]
export const SIM_IMAGES = ["image-a", "image-b"]
export const SWAP_KINDS: MockVariant[] = ["int4", "fp8", "small", "finetune"]

const TEMPERATURES = [0, 0.2, 0.4, 0.7, 0.7, 1, 1, 1, 1.2]
const MAX_TOKENS = [32, 64, 128, 256, 256, 512, 512]
/** Busy batches add their own noise now and then, which fattens the tail of honest scores. */
const BURST_RATE = 0.03
const BURST_NOISE = 3

const REFERENCE: MockLogits = { ...CLAIMED, gpuNoise: 0.02, gpuSeed: 0x5eed }

export type SimHost = { label: string; gpu: SimGpu; image: string; swapRate?: number; swapModel?: MockVariant; seed: number; zBias?: number }

export function simResponse(host: SimHost, rng: () => number) {
  const prompt = Math.floor(rng() * 0xffffffff)
  const run = Math.floor(rng() * 0xffffffff)
  const temperature = TEMPERATURES[Math.floor(rng() * TEMPERATURES.length)]!
  const maxTokens = MAX_TOKENS[Math.floor(rng() * MAX_TOKENS.length)]!
  const burst = rng() < BURST_RATE ? BURST_NOISE : 1
  const serving: MockServing = {
    swapRate: host.swapRate ?? 0,
    swapModel: host.swapModel ?? "small",
    gpuNoise: host.gpu.noise * burst,
    gpuSeed: host.seed ^ prompt,
  }
  const { tokens, swapped } = serveTokens(serving, prompt, run, temperature, maxTokens)
  return { ll: llMean(scoreTokens(REFERENCE, prompt, tokens)), tokensOut: tokens.length, temperature, swapped }
}

const rowOf = (host: SimHost, hostWeek: string, response: ReturnType<typeof simResponse>): ScoredRow => ({
  hostWeek,
  gpuClass: host.gpu.name,
  imageDigest: host.image,
  temperature: response.temperature,
  tokensOut: response.tokensOut,
  ll: response.ll,
})

/** Honest studio hosts across GPU classes and images, then each stand-in served outright. */
export function simCalibrationRows(input: { seed: number; responsesPerWeek: number; weeksPerCell: number; swapResponses: number }) {
  const rng = mulberry32(input.seed)
  const honest: ScoredRow[] = []
  const swaps: SwapRow[] = []
  for (const gpu of SIM_GPUS) {
    for (const image of SIM_IMAGES) {
      for (let week = 0; week < input.weeksPerCell; week++) {
        const host: SimHost = { label: `${gpu.name}/${image}/${week}`, gpu, image, seed: Math.floor(rng() * 0xffffffff) }
        for (let i = 0; i < input.responsesPerWeek; i++) honest.push(rowOf(host, host.label, simResponse(host, rng)))
      }
      for (const kind of SWAP_KINDS) {
        const host: SimHost = { label: `${kind}`, gpu, image, swapRate: 1, swapModel: kind, seed: Math.floor(rng() * 0xffffffff) }
        for (let i = 0; i < input.swapResponses; i++) swaps.push({ ...rowOf(host, host.label, simResponse(host, rng)), kind })
      }
    }
  }
  return { honest, swaps }
}

/** A week of z scores, standardised the way the auditor does it, in arrival order. */
export function simWeekScores(host: SimHost, n: number, modelDigest: string, baselines: Map<string, Baseline>, rng: () => number) {
  const out: (LlrSample & { swapped: boolean })[] = []
  while (out.length < n) {
    const response = simResponse(host, rng)
    const key = { modelDigest, gpuClass: host.gpu.name, imageDigest: host.image, tempBucket: tempBucket(response.temperature), lenBucket: lenBucket(response.tokensOut) }
    const baseline = baselines.get(baselineId(key))
    if (baseline) out.push({ z: standardise(response.ll, baseline) + (host.zBias ?? 0), swapped: response.swapped })
  }
  return out
}
