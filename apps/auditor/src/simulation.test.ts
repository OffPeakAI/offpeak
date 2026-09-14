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
