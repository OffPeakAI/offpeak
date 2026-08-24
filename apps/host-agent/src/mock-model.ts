import { mulberry32, normalFrom } from "../../../packages/audit-tests/src/simulate.ts"

/**
 * A small synthetic language model for audit simulations. Each step has a real distribution over a
 * fixed vocabulary, seeded from the prompt and the tokens so far, so teacher-forced scoring measures
 * something instead of reading a marker in the text. A stand-in model has correlated logits, the way
 * a quantised or smaller sibling would. This shows the audit method on synthetic data only; it says
 * nothing about what real quantisation does to real scores.
 */
export type MockVariant = "full" | "fp8" | "int4" | "finetune" | "small"

/** Correlation of each variant's logits with the claimed model's. */
const CORRELATION: Record<MockVariant, number> = { full: 1, fp8: 0.97, int4: 0.7, finetune: 0.74, small: 0.68 }
const VARIANT_STREAM: Record<MockVariant, number> = { full: 0, fp8: 0x1f8, int4: 0x1b4, finetune: 0x1f7, small: 0x5a1 }

export const MOCK_VOCAB = 24
const WORDS = Array.from({ length: MOCK_VOCAB }, (_, i) => `w${i}`)
const WORD_INDEX = new Map(WORDS.map((word, i) => [word, i]))

const GAUSS_BITS = 16
const GAUSS_MASK = (1 << GAUSS_BITS) - 1
const GAUSS = (() => {
  const rng = mulberry32(0x0ff9ea4)
  return Float64Array.from({ length: 1 << GAUSS_BITS }, () => normalFrom(rng))
})()

function mix(a: number, b: number) {
  let h = Math.imul(a ^ b, 0x5bd1e995)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  return (h ^ (h >>> 13)) >>> 0
}

export function seedOf(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

export type MockLogits = {
  variant: MockVariant
  /** Spread of the hardware's own float noise, in units of one logit's standard deviation. */
  gpuNoise: number
  gpuSeed: number
}

export const CLAIMED: MockLogits = { variant: "full", gpuNoise: 0, gpuSeed: 0 }

/** How peaked a prompt's answers are. Scores differ between prompts, which is what σ measures. */
function promptScale(prompt: number) {
  return 1.2 + 1.6 * (mix(prompt, 0x7e57) / 0xffffffff)
}

function fillLogits(out: Float64Array, spec: MockLogits, prompt: number, prev: number, pos: number) {
  const context = mix(mix(prompt, prev + 1), pos + 1)
  const stream = VARIANT_STREAM[spec.variant]
  const rho = CORRELATION[spec.variant]
  const rest = Math.sqrt(1 - rho * rho)
  const scale = promptScale(prompt)
  const noiseContext = spec.gpuNoise > 0 ? mix(context, spec.gpuSeed | 1) : 0
  for (let token = 0; token < MOCK_VOCAB; token++) {
    let value = GAUSS[mix(context, token + 1) & GAUSS_MASK]!
    if (stream !== 0) value = rho * value + rest * GAUSS[mix(mix(context, stream), token + 1) & GAUSS_MASK]!
    if (spec.gpuNoise > 0) value += spec.gpuNoise * GAUSS[mix(noiseContext, token + 1) & GAUSS_MASK]!
    out[token] = scale * value
  }
}

function logNormaliser(logits: Float64Array, temperature: number) {
  let top = Number.NEGATIVE_INFINITY
  for (let i = 0; i < MOCK_VOCAB; i++) top = Math.max(top, logits[i]! / temperature)
  let sum = 0
  for (let i = 0; i < MOCK_VOCAB; i++) sum += Math.exp(logits[i]! / temperature - top)
  return top + Math.log(sum)
}

function pick(logits: Float64Array, temperature: number, draw: number) {
  if (temperature <= 0) {
    let best = 0
    for (let i = 1; i < MOCK_VOCAB; i++) if (logits[i]! > logits[best]!) best = i
    return best
  }
  const norm = logNormaliser(logits, temperature)
  let mass = 0
  for (let i = 0; i < MOCK_VOCAB; i++) {
    mass += Math.exp(logits[i]! / temperature - norm)
    if (draw < mass) return i
  }
  return MOCK_VOCAB - 1
}

/** How long a reply to this prompt runs before the token limit. */
function naturalLength(prompt: number) {
  return 12 + (mix(prompt, 0x1e46) % 340)
}

export function generateTokens(spec: MockLogits, prompt: number, run: number, temperature: number, maxTokens: number): number[] {
  const rng = mulberry32(mix(prompt, run))
  const length = Math.min(maxTokens, naturalLength(prompt))
  const logits = new Float64Array(MOCK_VOCAB)
  const tokens: number[] = []
  let prev = -1
  for (let pos = 0; pos < length; pos++) {
    fillLogits(logits, spec, prompt, prev, pos)
    prev = pick(logits, temperature, rng())
    tokens.push(prev)
  }
  return tokens
}

/** log p(token | prefix) for each token, teacher forced. */
export function scoreTokens(spec: MockLogits, prompt: number, tokens: readonly number[]): number[] {
  const logits = new Float64Array(MOCK_VOCAB)
  const out: number[] = []
  let prev = -1
  for (let pos = 0; pos < tokens.length; pos++) {
    fillLogits(logits, spec, prompt, prev, pos)
    const token = tokens[pos]!
    out.push(logits[token]! - logNormaliser(logits, 1))
    prev = token
  }
  return out
}

export function tokensToText(tokens: readonly number[]) {
  return tokens.map((token) => WORDS[token]).join(" ")
}

/** Any text can be scored: a word outside the vocabulary lands on a fixed token. */
export function textToTokens(text: string) {
  const parts = text.split(/\s+/).filter(Boolean)
  return parts.map((part) => WORD_INDEX.get(part) ?? seedOf(part) % MOCK_VOCAB)
}

export type MockServing = {
  /** Share of responses served by the stand-in. */
  swapRate?: number
  swapModel?: MockVariant
  gpuNoise?: number
  gpuSeed?: number
}

export function serveTokens(serving: MockServing, prompt: number, run: number, temperature: number, maxTokens: number) {
  const swapped = mix(run, 0x53a9) / 0xffffffff < (serving.swapRate ?? 0)
  const spec: MockLogits = {
    variant: swapped ? (serving.swapModel ?? "small") : "full",
    gpuNoise: serving.gpuNoise ?? 0,
    gpuSeed: serving.gpuSeed ?? 0,
  }
  return { tokens: generateTokens(spec, prompt, run, temperature, maxTokens), swapped }
}

/** `--swap-rate 0.1 --swap-model small --gpu-noise 0.05` for `--mock-engine`. */
export function mockServingArgs(argv: readonly string[]): MockServing | undefined {
  const value = (name: string) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const rate = value("--swap-rate")
  const model = value("--swap-model")
  const noise = value("--gpu-noise")
  if (rate === undefined && model === undefined && noise === undefined) return undefined
  const swapRate = Number(rate ?? 0)
  if (!(swapRate >= 0 && swapRate <= 1)) throw new Error("--swap-rate must be between 0 and 1")
  if (model !== undefined && !(model in CORRELATION)) throw new Error(`unknown --swap-model ${model}`)
  return { swapRate, swapModel: (model ?? "small") as MockVariant, gpuNoise: Number(noise ?? 0) }
}
