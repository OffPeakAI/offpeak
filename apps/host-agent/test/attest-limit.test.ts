import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { Hex } from "viem"
import { ServedBook } from "../src/meter.ts"
import { signRouterBody } from "../src/proxy.ts"
import { mountSealed, SealedAgent, type AttestBody } from "../src/sealed/serve.ts"
import { fakeGpuCommand } from "./support/fake-gpu-tool.ts"
import { startFakeTsm } from "./support/fake-tsm.ts"
import { host, router } from "./support/harness.ts"

const nonce = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}` as Hex
const PASS = async (_c: unknown, next: () => Promise<void>) => next()

let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

/** An agent whose quotes finish when a test says so, because the real ones take most of a minute. */
async function rig() {
  const fake = startFakeTsm()
  stops.push(fake.stop)
  const sealed = await SealedAgent.start({ modelName: "ofm-8b", modelDigest: `0x${"11".repeat(32)}`, imageDigest: `0x${"22".repeat(32)}`, operator: host.address, engine: "http://127.0.0.1:8000", tsmRoot: fake.root, gpuTool: fakeGpuCommand() })
  const started: Hex[] = []
  const waiting: (() => void)[] = []
  let hold = false
  ;(sealed as unknown as { fresh: (nonce: Hex) => Promise<AttestBody> }).fresh = async (asked) => {
    started.push(asked)
    if (hold) await new Promise<void>((resolve) => waiting.push(resolve))
    return { nonce: asked } as AttestBody
  }
  let now = 1_800_000_000
  const app = new Hono()
  mountSealed({ app, sealed, model: {} as never, limit: PASS as never, signed: PASS as never, routerAddress: router.address, served: new ServedBook(), clock: () => now, admit: (async () => new Response()) as never, inflight: () => undefined })
  const ask = (asked: Hex, peer: string | null, headers: Record<string, string> = {}) => app.fetch(new Request(`http://agent.test/offpeak/v1/attest?nonce=${asked}`, { headers }), { server: { requestIP: () => (peer ? { address: peer } : null) } })
  const signed = async (asked: Hex, signer = router) => ({ "x-offpeak-req": await signRouterBody(signer, { reqId: nonce(0xee), ts: now, payload: asked }) })
  return {
    ask,
    signed,
    started,
    pause: () => (hold = true),
    resume: () => {
      hold = false
      for (const go of waiting.splice(0)) go()
    },
    step: () => waiting.shift()?.(),
    later: (seconds: number) => (now += seconds),
  }
}

const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

describe("the unauthenticated attestation route", () => {
  test("one source runs out, and another is not touched", async () => {
    const { ask } = await rig()
    for (let i = 0; i < 6; i++) expect((await ask(nonce(1), "203.0.113.5")).status).toBe(200)
    const refused = await ask(nonce(1), "203.0.113.5")
    expect(refused.status).toBe(429)
    expect(await codeOf(refused)).toBe("attest_rate_limited")
    expect((await ask(nonce(1), "203.0.113.6")).status).toBe(200)
  })

  test("a source gets its quota back in the next window", async () => {
    const { ask, later } = await rig()
    for (let i = 0; i < 7; i++) await ask(nonce(1), "203.0.113.5")
    later(60)
    expect((await ask(nonce(1), "203.0.113.5")).status).toBe(200)
  })

  test("behind the local TLS proxy the source is the hop it added", async () => {
    const { ask } = await rig()
    for (let i = 0; i < 7; i++) await ask(nonce(1), "127.0.0.1", { "x-forwarded-for": `198.51.100.${i}, 203.0.113.5` })
    expect((await ask(nonce(1), "127.0.0.1", { "x-forwarded-for": "203.0.113.5" })).status).toBe(429)
    expect((await ask(nonce(1), "127.0.0.1", { "x-forwarded-for": "203.0.113.6" })).status).toBe(200)
  })

  test("a caller reaching the agent directly cannot name its own source", async () => {
    const { ask } = await rig()
    for (let i = 0; i < 6; i++) expect((await ask(nonce(1), "203.0.113.5", { "x-forwarded-for": `198.51.100.${i}` })).status).toBe(200)
    expect((await ask(nonce(1), "203.0.113.5", { "x-forwarded-for": "198.51.100.200" })).status).toBe(429)
  })

  test("the queue stays bounded across sources", async () => {
    const { ask, pause, resume } = await rig()
    pause()
    const running = Array.from({ length: 4 }, (_, i) => ask(nonce(1), `203.0.113.${i}`))
    await Bun.sleep(5)
    const refused = await ask(nonce(1), "203.0.113.9")
    expect(refused.status).toBe(429)
    expect(await codeOf(refused)).toBe("attest_busy")
    resume()
    for (const res of await Promise.all(running)) expect(res.status).toBe(200)
  })
})

describe("the router's sweep", () => {
  test("a full queue and a spent source cannot turn it away, and it runs next", async () => {
    const { ask, signed, started, pause, step, resume } = await rig()
    pause()
    const crowd = Array.from({ length: 4 }, (_, i) => ask(nonce(i + 1), `203.0.113.${i}`))
    await Bun.sleep(5)
    expect((await ask(nonce(9), "203.0.113.9")).status).toBe(429)
    const sweep = ask(nonce(0xaa), "203.0.113.0", await signed(nonce(0xaa)))
    await Bun.sleep(5)
    step()
    await Bun.sleep(5)
    expect(started.slice(0, 2)).toEqual([nonce(1), nonce(0xaa)])
    resume()
    expect((await sweep).status).toBe(200)
    await Promise.all(crowd)
  })

  test("it holds one place, not an open door", async () => {
    const { ask, signed, pause, resume } = await rig()
    pause()
    const first = ask(nonce(0xaa), "203.0.113.0", await signed(nonce(0xaa)))
    await Bun.sleep(5)
    expect((await ask(nonce(0xab), "203.0.113.0", await signed(nonce(0xab)))).status).toBe(429)
    resume()
    expect((await first).status).toBe(200)
  })

  test("a header from another key, or for another nonce, is an ordinary caller", async () => {
    const { ask, signed } = await rig()
    for (let i = 0; i < 6; i++) await ask(nonce(1), "203.0.113.5")
    expect((await ask(nonce(1), "203.0.113.5", await signed(nonce(1), host as never))).status).toBe(429)
    expect((await ask(nonce(1), "203.0.113.5", await signed(nonce(2)))).status).toBe(429)
    expect((await ask(nonce(1), "203.0.113.5", await signed(nonce(1)))).status).toBe(200)
  })
})
