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

  test("scoring needs the auditor's signature", async () => {
    const app = reference(auditor.address)
    const input = { model: "ofm-8b", messages: [{ role: "user", content: "hello" }], output: "w1 w2 w3 w4" }
    const ll = await scoreOnReference(fetcherFor(app), auditor as never, { endpoint: "http://ref.local", host: "0xref" }, input, NOW)
    expect(ll).toBeLessThan(0)
    await expect(scoreOnReference(fetcherFor(app), stranger as never, { endpoint: "http://ref.local", host: "0xref" }, input, NOW)).rejects.toThrow("401")
    await expect(scoreOnReference(fetcherFor(app), auditor as never, { endpoint: "http://ref.local", host: "0xref" }, input, NOW - 3_600)).rejects.toThrow("401")
  })

  test("a signature covers the body it was made for", async () => {
    const app = reference(auditor.address)
    const replay = (url: string, init: RequestInit) => app.request(new URL(url).pathname, { ...init, body: JSON.stringify({ model: "ofm-8b", messages: [], output: "w9" }) })
    await expect(scoreOnReference(replay as never, auditor as never, { endpoint: "http://ref.local", host: "0xref" }, { model: "ofm-8b", messages: [], output: "w1" }, NOW)).rejects.toThrow("401")
  })

  test("an unusable answer is an error, never a score", async () => {
    const bad = async () => Response.json({ logprobs: [] })
    await expect(scoreOnReference(bad, auditor as never, { endpoint: "http://ref.local", host: "0xref" }, { model: "ofm-8b", messages: [], output: "w1" }, NOW)).rejects.toThrow()
    const nan = async () => new Response('{"logprobs":[{"logprob":null}]}')
    await expect(scoreOnReference(nan, auditor as never, { endpoint: "http://ref.local", host: "0xref" }, { model: "ofm-8b", messages: [], output: "w1" }, NOW)).rejects.toThrow()
  })

  test("the likelihood is the mean over tokens the reference actually scored", async () => {
    const app = reference()
    const input = { model: "ofm-8b", messages: [{ role: "user", content: "hello" }], output: "w1 w2 w3" }
    const res = await app.request("/offpeak/v1/score", { method: "POST", body: JSON.stringify(input) })
    const reply = (await res.json()) as { ll_mean: number; logprobs: { logprob: number }[] }
    expect(reply.logprobs).toHaveLength(3)
    const ref = { endpoint: "http://ref.local", host: "0xref" }
    expect(await scoreOnReference(fetcherFor(app), auditor as never, ref, input, NOW)).toBeCloseTo(llMean(reply.logprobs.map((row) => row.logprob)), 12)
    const lying = async () => Response.json({ ...reply, ll_mean: -0.001 })
    expect(await scoreOnReference(lying, auditor as never, ref, input, NOW)).toBeCloseTo(reply.ll_mean, 12)
  })
})

describe("scores in the database", () => {
  const row = { reqId: "0x1", host: "0xh", modelDigest: "0xm", gpuClass: "0xg", imageDigest: "0xi", source: "sample" as const, temperature: 0.7, tokensOut: 100, ts: 5, ll: -3, refHost: "0xr" }
  const key = { modelDigest: "0xm", gpuClass: "0xg", imageDigest: "0xi", tempBucket: "(0.5,1]", lenBucket: "<=256" }

  test("a score waits for its baseline, then completes", async () => {
    const db = await openDb()
    expect(await recordScore(db, new Map(), row)).toBe(false)
    expect((await db.query<{ z: number | null }>("SELECT z FROM serving.audit_scores")).rows[0]!.z).toBeNull()
    await db.query("INSERT INTO serving.audit_baselines (model_digest, gpu_class, image_digest, temp_bucket, len_bucket, mu, sigma, n, version) VALUES ('0xm','0xg','0xi','(0.5,1]','<=256',-2,0.5,500,'v1')")
    expect(await fillMissingZ(db)).toBe(1)
    expect(Number((await db.query<{ z: number }>("SELECT z FROM serving.audit_scores")).rows[0]!.z)).toBe(-2)
  })

  test("the newest version of a baseline wins", async () => {
    const db = await openDb()
    for (const [version, mu] of [["v000000000001", -1], ["v000000000002", -2]] as const) {
      await db.query("INSERT INTO serving.audit_baselines (model_digest, gpu_class, image_digest, temp_bucket, len_bucket, mu, sigma, n, version) VALUES ('0xm','0xg','0xi','(0.5,1]','<=256',$1,0.5,500,$2)", [mu, version])
    }
    expect((await loadBaselines(db)).get(baselineId(key))?.mu).toBe(-2)
  })

  test("another GPU class's baseline is never applied", async () => {
    const db = await openDb()
    const other = new Map([[baselineId({ ...key, gpuClass: "0xother" }), { ...key, gpuClass: "0xother", mu: 0, sigma: 1, n: 500, version: "v1" }]])
    expect(await recordScore(db, other, row)).toBe(false)
  })
})

describe("the mock engine's swap mode", () => {
  const prompt = [{ role: "user", content: "the same prompt" }]

  test("--swap-rate and --swap-model parse, and bad values refuse", async () => {
    const { mockServingArgs } = await import("../../host-agent/src/mock-model.ts")
    expect(mockServingArgs(["--swap-rate", "0.1", "--swap-model", "small"])).toEqual({ swapRate: 0.1, swapModel: "small", gpuNoise: 0 })
    expect(mockServingArgs([])).toBeUndefined()
    expect(() => mockServingArgs(["--swap-rate", "2"])).toThrow()
    expect(() => mockServingArgs(["--swap-model", "huge"])).toThrow()
  })

  test("a stand-in's output scores lower than the claimed model's own", async () => {
    const { seedOf, serveTokens, tokensToText } = await import("../../host-agent/src/mock-model.ts")
    const app = reference()
    const score = async (swapModel: "small" | undefined, run: number) => {
      const { tokens } = serveTokens({ swapRate: swapModel ? 1 : 0, swapModel }, seedOf(JSON.stringify(prompt)), run, 1, 256)
      const res = await app.request("/offpeak/v1/score", { method: "POST", body: JSON.stringify({ messages: prompt, output: tokensToText(tokens) }) })
      return llMean(((await res.json()) as { logprobs: { logprob: number }[] }).logprobs.map((row) => row.logprob))
    }
    const honest: number[] = []
    const swapped: number[] = []
    for (let run = 1; run <= 40; run++) {
      honest.push(await score(undefined, run))
      swapped.push(await score("small", run))
    }
    expect(llMean(swapped)).toBeLessThan(llMean(honest))
  })

  test("the text carries no marker of which model served it", async () => {
    const { serveTokens, tokensToText } = await import("../../host-agent/src/mock-model.ts")
    const text = tokensToText(serveTokens({ swapRate: 1 }, 7, 9, 1, 64).tokens)
    expect(text).toMatch(/^w\d+( w\d+)*$/)
  })

  test("a swap decision is per request, at the configured rate", async () => {
    const { serveTokens } = await import("../../host-agent/src/mock-model.ts")
    let swapped = 0
    for (let run = 1; run <= 10_000; run++) if (serveTokens({ swapRate: 0.1 }, 1, run, 1, 1).swapped) swapped++
    expect(swapped).toBeGreaterThan(850)
    expect(swapped).toBeLessThan(1_150)
  })

  test("an engine in swap mode replies under real router traffic", async () => {
    const { signRouterBody } = await import("../../host-agent/src/proxy.ts")
    const router = roleAccount("router")
    const engine = createHostApp({ operator: roleAccount("host") as never, routerAddress: router.address, usageLedger: `0x${"11".repeat(20)}`, modelDigest: keccak256(toBytes("m")) as Hex, modelName: "ofm-8b", imageDigest: keccak256(toBytes("i")) as Hex, gpuClass: "h100-80g-sxm", swap: false, serving: { swapRate: 1, swapModel: "small" }, sealed: false })
    const payload = JSON.stringify({ model: "ofm-8b", messages: prompt, max_tokens: 16, temperature: 1 })
    const header = await signRouterBody(router as never, { reqId: keccak256(toBytes("r1")), ts: NOW, payload })
    const res = await engine.app.request("/offpeak/v1/chat/completions", { method: "POST", headers: { "x-offpeak-req": header }, body: payload })
    const json = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toMatch(/^w\d+/)
  })
})
