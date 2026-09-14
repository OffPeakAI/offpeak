import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { createHostApp } from "../../host-agent/src/mock-engine.ts"
import { openDb } from "../../router/src/store.ts"
import { MAX_CALIBRATED_TEMPERATURE, baselineId, fillMissingZ, lenBucket, llMean, loadBaselines, recordScore, referencesFor, scoreOnReference, standardise, tempBucket, temperatureOf, uncalibratedParam } from "./score.ts"

const auditor = roleAccount("settlerC")
const stranger = roleAccount("buyer")
const NOW = Math.floor(Date.now() / 1000)

function reference(auditorAddress?: string) {
  return createHostApp({
    operator: roleAccount("host") as never,
    routerAddress: roleAccount("router").address,
    usageLedger: `0x${"11".repeat(20)}`,
    modelDigest: keccak256(toBytes("model")),
    modelName: "ofm-8b",
    imageDigest: keccak256(toBytes("image")),
    gpuClass: "h100-80g-sxm",
    swap: false,
    serving: {},
    sealed: false,
    auditorAddress,
  }).app
}

const fetcherFor = (app: ReturnType<typeof reference>) => (url: string, init: RequestInit) => Promise.resolve(app.request(new URL(url).pathname, init))

describe("buckets", () => {
  test("temperature edges land in the doc's buckets", () => {
    expect([0, 0.0001, 0.5, 0.5001, 1, 1.0001].map(tempBucket)).toEqual(["0", "(0,0.5]", "(0,0.5]", "(0.5,1]", "(0.5,1]", ">1"])
  })

  test("length edges land in the doc's buckets", () => {
    expect([1, 64, 65, 256, 257, 1024, 1025].map(lenBucket)).toEqual(["<=64", "<=64", "<=256", "<=256", "<=1024", "<=1024", ">1024"])
  })

  test("a plain request is calibrated, whatever its stream, seed or limits", () => {
    const body = { model: "m", messages: [], stream: true, stream_options: { include_usage: true }, max_tokens: 64, temperature: 0.7, seed: 4, stop: ["x"], user: "u", logprobs: true, top_logprobs: 1, n: 1 }
    expect(uncalibratedParam(body)).toBeNull()
    expect(uncalibratedParam({ model: "m", messages: [], tools: [], tool_choice: "none", top_p: 1, presence_penalty: 0, frequency_penalty: 0, response_format: { type: "text" }, metadata: null })).toBeNull()
  })

  test("anything that reshapes the output is left out of scoring", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ presence_penalty: 2 }, "presence_penalty"],
      [{ frequency_penalty: -2 }, "frequency_penalty"],
      [{ top_p: 0.1 }, "top_p"],
      [{ tools: [{ type: "function" }] }, "tools"],
      [{ tool_choice: "required" }, "tool_choice"],
      [{ response_format: { type: "json_schema" } }, "response_format"],
      [{ temperature: 1.3 }, "temperature"],
      [{ logit_bias: { 50: 100 } }, "logit_bias"],
      [{ some_future_field: 1 }, "some_future_field"],
    ]
    for (const [body, name] of cases) expect(uncalibratedParam({ model: "m", messages: [], ...body })).toBe(name)
  })

  test("the calibration run stays inside what scoring accepts", () => {
    const source = readFileSync(new URL("./collect.ts", import.meta.url), "utf8")
    const temperatures = /const TEMPERATURES = \[([^\]]+)\]/.exec(source)![1]!.split(",").map(Number)
    expect(Math.max(...temperatures)).toBe(MAX_CALIBRATED_TEMPERATURE)
  })

  test("a request without temperature reads as 1", () => {
    expect(temperatureOf({})).toBe(1)
    expect(temperatureOf({ temperature: 0 })).toBe(0)
  })
})

describe("standardising", () => {
  test("a lower likelihood gives a negative z", () => {
    expect(standardise(-3, { mu: -2, sigma: 0.5 })).toBe(-2)
    expect(llMean([-1, -2, -3])).toBe(-2)
  })
})

describe("reference hosts", () => {
  const refs = [
    { host: "0xa", modelDigest: "0xm", endpoint: "", gpuClass: "0xg", imageDigest: "0xi", attested: false },
    { host: "0xb", modelDigest: "0xm", endpoint: "", gpuClass: "0xg", imageDigest: "0xi", attested: true },
    { host: "0xc", modelDigest: "0xm", endpoint: "", gpuClass: "0xother", imageDigest: "0xi", attested: true },
    { host: "0xd", modelDigest: "0xother", endpoint: "", gpuClass: "0xg", imageDigest: "0xi", attested: true },
  ]

  test("a host never scores itself, and attested references come first", () => {
    expect(referencesFor(refs, { host: "0xz", modelDigest: "0xm", gpuClass: "0xg" }).map((r) => r.host)).toEqual(["0xb", "0xa"])
    expect(referencesFor(refs, { host: "0xb", modelDigest: "0xm", gpuClass: "0xg" }).map((r) => r.host)).toEqual(["0xa"])
  })

  test("another GPU class or model cannot stand in", () => {
    expect(referencesFor(refs, { host: "0xz", modelDigest: "0xm", gpuClass: "0xnone" })).toEqual([])
  })
