import { beforeAll, describe, expect, test } from "bun:test"
import { mulberry32, scan, type LlrBaseline, type LlrSample } from "@offpeak/audit-tests"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { createHostApp } from "../../host-agent/src/mock-engine.ts"
import { signRouterBody } from "../../host-agent/src/proxy.ts"
import { calibrateModel, wilsonLower, wilsonUpper, type CalibrationResult } from "./calibrate.ts"
import { baselineId, lenBucket, scoreOnReference, standardise, tempBucket, type Baseline } from "./score.ts"
import { SIM_GPUS, SIM_IMAGES, simCalibrationRows, simWeekScores, type SimHost } from "./simulate.ts"

/**
 * Section 5's auditor simulation. Every figure here comes from the mock engine's synthetic model.
 * It shows the method works on synthetic data, not that a real swap is caught. Real thresholds need
 * real calibration on GPU hosts.
 */
const MODEL = keccak256(toBytes("sim-model"))
const SWAP_RUNS = 2_000
const HONEST_WEEKS = 5_000
const HONEST_WEEK_N = 300
const HONEST_FRAMED = 2_000
const HTTP_RUNS = 40

let result: CalibrationResult
let baselines: Map<string, Baseline>
let baseline: LlrBaseline

const hostFor = (i: number, over: Partial<SimHost>): SimHost => ({
  label: `sim-${i}`,
  gpu: SIM_GPUS[i % SIM_GPUS.length]!,
  image: SIM_IMAGES[i % SIM_IMAGES.length]!,
  seed: Math.imul(i + 1, 0x9e3779b1),
  ...over,
})

beforeAll(() => {
  const rows = simCalibrationRows({ seed: 20261102, responsesPerWeek: 300, weeksPerCell: 16, swapResponses: 400 })
  result = calibrateModel({ modelDigest: MODEL, source: "simulation", ...rows, seed: 41, now: 1_800_000_000, bootWeeks: 800, powerRuns: 1_000 })
  baselines = new Map(result.baselines.map((row) => [baselineId(row), row]))
  baseline = { epsilon: result.epsilon, delta: result.delta, logA: result.logA, minN: result.minN }
  console.log(JSON.stringify({ delta: result.delta, logA: result.logA, scored: result.scored, shifts: result.shifts, power: result.power, falseFlagRate: result.falseFlagRate }))
}, 120_000)

describe("calibration on synthetic data", () => {
  test("a simulated calibration can never count as ready", () => {
    expect(result.source).toBe("simulation")
    expect(result.gates.hardware).toBe(false)
    expect(result.ready).toBe(false)
  })

  test("it meets the data gates the plan asks for", () => {
    expect(result.gates.scored).toBe(true)
    expect(result.gates.gpuClasses).toBe(true)
    expect(result.gates.images).toBe(true)
    expect(result.gates.bootstrapWeeks).toBe(true)
    expect(result.gates.falseFlags).toBe(true)
  })

  test("A never drops below the bound that holds for any week length", () => {
    expect(result.logA).toBeGreaterThanOrEqual(Math.log(100))
  })

  test("every GPU class has its own baselines, because their scores differ", () => {
    const classes = new Set(result.baselines.map((row) => row.gpuClass))
    expect(classes.size).toBe(SIM_GPUS.length)
  })
})

function flagRate(runs: number, seed: number, host: (i: number) => SimHost, n: number) {
  const rng = mulberry32(seed)
  let flagged = 0
  for (let i = 0; i < runs; i++) if (scan(simWeekScores(host(i), n, MODEL, baselines, rng), baseline).flagged) flagged++
  return flagged
}

describe(`auditor simulation (${SWAP_RUNS} swap runs, ${HONEST_WEEKS} honest host-weeks)`, () => {
  test("--swap-rate 0.10 --swap-model small is flagged within 200 samples in at least 95% of runs", () => {
    const flagged = flagRate(SWAP_RUNS, 101, (i) => hostFor(i, { swapRate: 0.1, swapModel: "small" }), 200)
    console.log(`small at 10%: ${flagged}/${SWAP_RUNS} flagged, 95% lower bound ${wilsonLower(flagged, SWAP_RUNS).toFixed(4)}`)
    expect(wilsonLower(flagged, SWAP_RUNS)).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  test("--swap-rate 0.10 --swap-model int4 is flagged within 200 samples in at least 95% of runs", () => {
    const flagged = flagRate(SWAP_RUNS, 102, (i) => hostFor(i, { swapRate: 0.1, swapModel: "int4" }), 200)
    console.log(`int4 at 10%: ${flagged}/${SWAP_RUNS} flagged, 95% lower bound ${wilsonLower(flagged, SWAP_RUNS).toFixed(4)}`)
    expect(wilsonLower(flagged, SWAP_RUNS)).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  test("honest hosts with GPU-class noise are flagged in at most 1% of host-weeks", () => {
    const flagged = flagRate(HONEST_WEEKS, 103, (i) => hostFor(i, {}), HONEST_WEEK_N)
    console.log(`honest: ${flagged}/${HONEST_WEEKS} flagged, 95% upper bound ${wilsonUpper(flagged, HONEST_WEEKS).toFixed(5)}`)
    expect(wilsonUpper(flagged, HONEST_WEEKS)).toBeLessThanOrEqual(0.01)
  }, 300_000)

  test("each GPU class stays under 1% on its own", () => {
    for (const [i, gpu] of SIM_GPUS.entries()) {
      const flagged = flagRate(1_000, 200 + i, (run) => hostFor(run, { gpu }), HONEST_WEEK_N)
      expect(wilsonUpper(flagged, 1_000)).toBeLessThanOrEqual(0.01)
    }
  }, 300_000)

  test("an honest host sitting 0.25 sigma low, which no baseline models, still stays under 1%", () => {
    const flagged = flagRate(2_000, 105, (i) => hostFor(i, { zBias: -0.25 }), HONEST_WEEK_N)
    console.log(`honest with an unmodelled offset: ${flagged}/2000 flagged`)
    expect(wilsonUpper(flagged, 2_000)).toBeLessThanOrEqual(0.01)
  }, 300_000)

  test("a 10% swap seen only through buyers, 40 of them, is still flagged in at least 95% of runs", () => {
    const rng = mulberry32(106)
    let flagged = 0
    for (let i = 0; i < SWAP_RUNS; i++) {
      const week = simWeekScores(hostFor(i, { swapRate: 0.1, swapModel: "small" }), 200, MODEL, baselines, rng).map((row, at) => ({ ...row, payer: `buyer-${at % 40}` }))
      if (scan(week, baseline).flagged) flagged++
    }
    console.log(`small at 10%, 40 buyers: ${flagged}/${SWAP_RUNS} flagged, 95% lower bound ${wilsonLower(flagged, SWAP_RUNS).toFixed(4)}`)
    expect(wilsonLower(flagged, SWAP_RUNS)).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  test("one opted-in buyer forcing low likelihood cannot flag an honest host", () => {
    const rng = mulberry32(107)
    let flagged = 0
    for (let i = 0; i < HONEST_FRAMED; i++) {
      const week: LlrSample[] = simWeekScores(hostFor(i, {}), HONEST_WEEK_N, MODEL, baselines, rng)
      for (let at = 0; at < 6; at++) week[at] = { z: -8, payer: "one-buyer" }
      if (scan(week, baseline).flagged) flagged++
    }
    console.log(`framed by one buyer: ${flagged}/${HONEST_FRAMED} flagged`)
    expect(wilsonUpper(flagged, HONEST_FRAMED)).toBeLessThanOrEqual(0.01)
  }, 300_000)

  test("a near-lossless stand-in is not caught, which is a limit of the method", () => {
    const flagged = flagRate(500, 104, (i) => hostFor(i, { swapRate: 0.1, swapModel: "fp8" }), 200)
    console.log(`fp8 at 10%: ${flagged}/500 flagged; its shift of ${result.shifts.fp8?.toFixed(2)} sigma is below what 200 samples can see`)
    expect(flagged / 500).toBeLessThan(0.5)
    expect(result.gates.power).toBe(false)
  }, 120_000)
})

describe(`through the mock engine over HTTP (${HTTP_RUNS} runs each way, ${HTTP_RUNS * 200 * 2} requests)`, () => {
  const router = roleAccount("router")
  const auditor = roleAccount("settlerC")
  const modelDigest = keccak256(toBytes("ofm-8b")) as Hex
  const options = { operator: roleAccount("host") as never, routerAddress: router.address, usageLedger: `0x${"11".repeat(20)}`, modelDigest, modelName: "ofm-8b", imageDigest: keccak256(toBytes("image")) as Hex, sealed: false, swap: false }
  const referenceApp = createHostApp({ ...options, gpuClass: "h100-80g-sxm", serving: { gpuNoise: 0.02, gpuSeed: 0x5eed }, auditorAddress: auditor.address }).app
  const fetcher = (url: string, init: RequestInit) => Promise.resolve(referenceApp.request(new URL(url).pathname, init))
  const now = Math.floor(Date.now() / 1000)
  const TEMPERATURES = [0.2, 0.7, 1]
  const MAX_TOKENS = [64, 128, 256]

  async function runWeek(engine: ReturnType<typeof createHostApp>, run: number, gpu: string, image: string) {
    const rng = mulberry32(9_000 + run)
    const zs: { z: number }[] = []
    for (let i = 0; zs.length < 200; i++) {
      const temperature = TEMPERATURES[Math.floor(rng() * TEMPERATURES.length)]!
      const maxTokens = MAX_TOKENS[Math.floor(rng() * MAX_TOKENS.length)]!
      const messages = [{ role: "user", content: `prompt ${run}-${i}-${Math.floor(rng() * 1e9)}` }]
      const payload = JSON.stringify({ model: "ofm-8b", messages, max_tokens: maxTokens, temperature })
      const header = await signRouterBody(router as never, { reqId: keccak256(toBytes(`${run}:${i}`)), ts: now, payload })
      const res = await engine.app.request("/offpeak/v1/chat/completions", { method: "POST", headers: { "x-offpeak-req": header }, body: payload })
      const text = ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content
      const tokensOut = text.split(" ").length
      const ll = await scoreOnReference(fetcher, auditor as never, { endpoint: "http://ref.local", host: "0xref" }, { model: "ofm-8b", messages, output: text }, now)
      const found = baselines.get(baselineId({ modelDigest: MODEL, gpuClass: gpu, imageDigest: image, tempBucket: tempBucket(temperature), lenBucket: lenBucket(tokensOut) }))
      if (found) zs.push({ z: standardise(ll, found) })
    }
    return scan(zs, baseline).flagged
  }

  test("a swapping engine is flagged and an honest one is not, on the same scorer", async () => {
    const gpu = SIM_GPUS[0]!
    let swapped = 0
    let honest = 0
    for (let run = 0; run < HTTP_RUNS; run++) {
      const swapping = createHostApp({ ...options, gpuClass: gpu.name, serving: { swapRate: 0.1, swapModel: "small", gpuNoise: gpu.noise, gpuSeed: run } })
      const clean = createHostApp({ ...options, gpuClass: gpu.name, serving: { gpuNoise: gpu.noise, gpuSeed: run + 1_000 } })
      if (await runWeek(swapping, run, gpu.name, SIM_IMAGES[0]!)) swapped++
      if (await runWeek(clean, run + 500, gpu.name, SIM_IMAGES[0]!)) honest++
    }
    console.log(`over HTTP: swap flagged ${swapped}/${HTTP_RUNS}, honest flagged ${honest}/${HTTP_RUNS}`)
    expect(swapped).toBeGreaterThanOrEqual(Math.floor(HTTP_RUNS * 0.9))
    expect(honest).toBe(0)
  }, 600_000)
})
