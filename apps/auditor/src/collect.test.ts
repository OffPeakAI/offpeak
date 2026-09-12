import { describe, expect, test } from "bun:test"
import { mulberry32 } from "@offpeak/audit-tests"
import { keccak256, toBytes } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { createHostApp } from "../../host-agent/src/mock-engine.ts"
import { seedOf, serveTokens, tokensToText } from "../../host-agent/src/mock-model.ts"
import { calibrateModel } from "./calibrate.ts"
import { collectRows, type CollectTarget } from "./collect.ts"
import { SAMPLE_CORPUS_PATH, readCorpus } from "./corpus.ts"

const auditor = roleAccount("settlerC")
const corpus = readCorpus(SAMPLE_CORPUS_PATH)

const reference = createHostApp({ operator: roleAccount("host") as never, routerAddress: roleAccount("router").address, usageLedger: `0x${"11".repeat(20)}`, modelDigest: keccak256(toBytes("m")), modelName: "ofm-8b", imageDigest: keccak256(toBytes("i")), gpuClass: "h100-80g-sxm", swap: false, serving: { gpuNoise: 0.02, gpuSeed: 5 }, sealed: false, auditorAddress: auditor.address }).app

/** An engine with vLLM's route and shape, in front of the synthetic model. */
function engine(serving: Parameters<typeof serveTokens>[0]) {
  let run = 0
  return async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const { tokens } = serveTokens(serving, seedOf(JSON.stringify(body.messages)), ++run, body.temperature, body.max_tokens)
    return Response.json({ choices: [{ message: { content: tokensToText(tokens) } }], usage: { completion_tokens: tokens.length } })
  }
}

const route = (engines: Record<string, ReturnType<typeof engine>>) => (url: string, init: RequestInit) => {
  const parsed = new URL(url)
  const handler = engines[parsed.hostname]
  return handler ? handler(parsed.pathname, init) : Promise.resolve(reference.request(parsed.pathname, init))
}

const spec = (over: Partial<CollectTarget>): CollectTarget => ({ label: "sxm-a", baseUrl: "http://honest", model: "ofm-8b", gpuClass: "h100-80g-sxm", imageDigest: "image-a", hostWeek: "w1", responses: 20, concurrency: 4, reference: { host: "0xref", endpoint: "http://ref" }, ...over })

describe("collecting calibration rows", () => {
  test("honest engines and stand-ins come back as rows calibrate.ts reads", async () => {
    const rows: { ll: number; kind?: string; tokensOut: number; temperature: number }[] = []
    const fetcher = route({ honest: engine({}), swapped: engine({ swapRate: 1, swapModel: "small" }) })
    const specs = [spec({}), spec({ label: "int4", baseUrl: "http://swapped", kind: "small" })]
    expect(await collectRows(fetcher, auditor as never, corpus, specs, mulberry32(2), (row) => rows.push(row as never))).toBe(40)
    expect(rows.filter((row) => row.kind === "small")).toHaveLength(20)
    expect(rows.every((row) => row.ll < 0 && row.tokensOut > 0 && row.temperature >= 0)).toBe(true)
  })

  test("the rows run through the harness end to end", async () => {
    const rows: never[] = []
    const fetcher = route({ honest: engine({ gpuNoise: 0.05, gpuSeed: 1 }), swapped: engine({ swapRate: 1, swapModel: "small" }) })
    const specs = [
      ...Array.from({ length: 8 }, (_v, week) => spec({ gpuClass: "a", hostWeek: `a${week}`, responses: 150 })),
      ...Array.from({ length: 8 }, (_v, week) => spec({ gpuClass: "b", imageDigest: "image-b", hostWeek: `b${week}`, responses: 150 })),
      spec({ gpuClass: "a", baseUrl: "http://swapped", kind: "small", responses: 200 }),
    ]
    await collectRows(fetcher, auditor as never, corpus, specs, mulberry32(3), (row) => rows.push(row as never))
    const honest = rows.filter((row: { kind?: string }) => !row.kind)
    const swaps = rows.filter((row: { kind?: string }) => row.kind)
    const result = calibrateModel({ modelDigest: "0xm", source: "simulation", honest, swaps, seed: 1, now: 1, bootWeeks: 100, powerRuns: 100 })
    expect(result.gates.gpuClasses).toBe(true)
    expect(result.gates.scored).toBe(false)
    expect(result.ready).toBe(false)
  }, 60_000)

  test("an engine error stops the run rather than leaving a gap", async () => {
    const fetcher = async () => new Response("no", { status: 500 })
    await expect(collectRows(fetcher, auditor as never, corpus, [spec({})], mulberry32(4), () => undefined)).rejects.toThrow("500")
  })
})
