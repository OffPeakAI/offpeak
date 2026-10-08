import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ZERO_BYTES32, type Hex } from "@offpeak/shared"
import { bytesToHex, hexToBytes } from "viem"
import { reportDataFor, type AttestReply, type Transcript } from "../../../packages/sdk/src/sealed/attest.ts"
import { FRAME_WIRE_BYTES } from "../../../packages/sdk/src/sealed/hpke.ts"
import { FAKE_TD, fakeMeasurement, fakeQuote } from "../../host-agent/test/support/fake-tsm.ts"
import { FLAGS } from "../src/context.ts"
import { lengthOutlier } from "../src/openai/sealed.ts"
import { AttestBook, attestHost, readAttestConfig, sealedHostsView, sweepAttestations, verifiedHost, verifyTranscript } from "../src/routing/attest.ts"
import { MODEL, sealedRig, type RigOptions } from "./support/sealed-rig.ts"

type Rig = Awaited<ReturnType<typeof sealedRig>>

let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

async function rig(opts?: RigOptions) {
  const booted = await sealedRig(opts)
  stops.push(booted.stop)
  return booted
}

const OTHER_HASH = `0x${"ee".repeat(32)}` as Hex

const quietly = async <T>(work: () => Promise<T>) => {
  const spy = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    return await work()
  } finally {
    spy.mockRestore()
  }
}

const sweep = (booted: Rig) => quietly(() => sweepAttestations(booted.stack))

const rows = async (booted: Rig) => (await booted.stack.db.query<{ host: string; attestation_ref: string; tcb_status: string; transcript: Transcript }>("SELECT * FROM serving.sealed_attestations")).rows

const hostsOf = async (booted: Rig) => ((await (await booted.app.request(`/v1/sealed/hosts?model=${MODEL}`)).json()) as { enabled: boolean; note?: string; hosts: { host: string; transcript: Transcript }[] })

/** Why the router refuses this host right now. */
const reasonsFor = async (booted: Rig) => {
  const row = (await booted.stack.indexer.hostList())[0]!
  const result = await attestHost(booted.stack, booted.stack.attest!, row)
  return "reasons" in result ? result.reasons : []
}

/** Rewrites what the agent answers on `/offpeak/v1/attest?nonce=`. */
function tamperAttest(booted: Rig, change: (reply: AttestReply) => void) {
  const hosts = booted.stack.hosts
  booted.stack.hosts = {
    request: async (host, endpoint, path, init) => {
      const res = await hosts.request(host, endpoint, path, init)
      if (!path.startsWith("/offpeak/v1/attest?nonce=")) return res
      const reply = (await res.json()) as AttestReply
      change(reply)
      return Response.json(reply)
    },
  }
}

describe("a verified host", () => {
  test("passes with both quotes, the GPU, the allow-list and the registry, and is published with its evidence", async () => {
    const booted = await rig()
    expect(verifiedHost(booted.stack, booted.host)?.attestationRef).toBe(booted.sealed.attestationRef)
    const view = await hostsOf(booted)
    expect(view.enabled).toBe(true)
    expect(view.hosts.map((row) => row.host)).toEqual([booted.host])
    const { transcript } = view.hosts[0]!
    expect(transcript.quote).toMatch(/^0x/)
    expect(transcript.boot.quote).toBe(booted.sealed.bootQuote)
    expect(transcript.verdict).toEqual({ quoteVerified: true, tcbStatus: "UpToDate", bootTcbStatus: "UpToDate", allowListed: true, gpuResult: true })
    expect(transcript.registry.attestationRef).toBe(booted.sealed.attestationRef)
    expect(booted.dcap.seen).toContain(transcript.quote)
    expect(booted.dcap.seen).toContain(transcript.boot.quote)
  })

  test("is written to sealed_attestations", async () => {
    const booted = await rig()
    const [row] = await rows(booted)
    expect(row).toMatchObject({ host: booted.host, attestation_ref: booted.sealed.attestationRef, tcb_status: "UpToDate" })
    expect(row!.transcript.nonce).toMatch(/^0x/)
  })

  test("SWHardeningNeeded is accepted", async () => {
    const booted = await rig({ noSweep: true })
    booted.dcap.state.tcbStatus = "SWHardeningNeeded"
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)?.tcbStatus).toBe("SWHardeningNeeded")
  })

  test("a model query that cannot be right is a 400", async () => {
    const booted = await rig()
    expect((await booted.app.request(`/v1/sealed/hosts?model=${"m".repeat(200)}`)).status).toBe(400)
  })

  test("the list filters by model", async () => {
    const booted = await rig()
    expect(sealedHostsView(booted.stack, "ofm-embed").hosts.length).toBe(1)
    expect(sealedHostsView(booted.stack, "no-such-model").hosts).toEqual([])
    expect(sealedHostsView(booted.stack, undefined).hosts.length).toBe(1)
  })
})

describe("fails closed", () => {
  test("no verifier URLs: no host is verified, and nothing was asked of the host", async () => {
    const booted = await rig({ noVerifiers: true })
    expect(await reasonsFor(booted)).toEqual(["no_verifier"])
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    expect((await hostsOf(booted)).hosts).toEqual([])
    expect(await rows(booted)).toEqual([])
  })

  test("no book at all: no host is verified", async () => {
    const booted = await rig()
    booted.stack.attest = undefined
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    expect((await hostsOf(booted)).hosts).toEqual([])
  })

  test("a DCAP service that is down, or unreachable", async () => {
    const booted = await rig({ noSweep: true })
    booted.dcap.state.down = true
    expect(await reasonsFor(booted)).toContain("quote_verifier")
    booted.dcap.state.down = false
    booted.stack.attest = new AttestBook({ ...booted.stack.attest!.config, tdxVerifierUrl: "http://127.0.0.1:37999/nothing-here" })
    expect(await reasonsFor(booted)).toContain("quote_verifier")
  })

  test("a GPU service that is down, or unreachable", async () => {
    const booted = await rig({ noSweep: true })
    booted.gpu.state.down = true
    expect(await reasonsFor(booted)).toContain("gpu")
    booted.gpu.state.down = false
    booted.stack.attest = new AttestBook({ ...booted.stack.attest!.config, gpuAttestationUrl: "http://127.0.0.1:37999/nothing-here" })
    expect(await reasonsFor(booted)).toContain("gpu")
  })

  test("an empty allow-list means no host passes", async () => {
    const booted = await rig({ measurements: () => [], noSweep: true })
    expect(await reasonsFor(booted)).toContain("measurement")
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })

  test("an allow-list with the wrong MRTD, the wrong RTMR, or another image", async () => {
    const entry = (over: object) => (imageDigest: Hex, configHash: Hex) => [{ imageDigest, configHash, mrtd: FAKE_TD.mrtd, rtmrs: FAKE_TD.rtmrs, ...over }]
    expect(await reasonsFor(await rig({ measurements: entry({ mrtd: fakeMeasurement(0x01) }), noSweep: true }))).toContain("measurement")
    const rtmrs = [FAKE_TD.rtmrs[0], FAKE_TD.rtmrs[1], FAKE_TD.rtmrs[2], fakeMeasurement(0x02)]
    expect(await reasonsFor(await rig({ measurements: entry({ rtmrs }), noSweep: true }))).toContain("measurement")
    expect(await reasonsFor(await rig({ measurements: entry({ imageDigest: `0x${"dd".repeat(32)}` }), noSweep: true }))).toContain("measurement")
  })

  test("a host whose config is not the allow-listed one, however good its quotes", async () => {
    const booted = await rig({ measurements: (imageDigest) => [{ imageDigest, configHash: OTHER_HASH, mrtd: FAKE_TD.mrtd, rtmrs: FAKE_TD.rtmrs }], noSweep: true })
    expect(await reasonsFor(booted)).toEqual(["measurement"])
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })

  test("a config hash in the fresh quote that the boot quote does not hold", async () => {
    const booted = await rig({ measurements: (imageDigest, configHash) => [configHash, OTHER_HASH].map((hash) => ({ imageDigest, configHash: hash, mrtd: FAKE_TD.mrtd, rtmrs: FAKE_TD.rtmrs })), noSweep: true })
    tamperAttest(booted, (reply) => {
      reply.bindings.configHash = OTHER_HASH
      reply.quote = bytesToHex(fakeQuote(FAKE_TD, reportDataFor(reply.bindings, reply.nonce)))
    })
    expect(await reasonsFor(booted)).toEqual(["identity"])
  })

  test("a counts key in the fresh quote that the boot quote does not hold", async () => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => {
      reply.bindings.countsSigner = `0x${"99".repeat(20)}`
      reply.quote = bytesToHex(fakeQuote(FAKE_TD, reportDataFor(reply.bindings, reply.nonce)))
    })
    expect(await reasonsFor(booted)).toEqual(["identity"])
  })

  test.each(["OutOfDate", "OutOfDateConfigurationNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded", "Revoked", "UPTODATE"])("TCB status %s is refused", async (status) => {
    const booted = await rig({ noSweep: true })
    booted.dcap.state.tcbStatus = status
    expect(await reasonsFor(booted)).toContain("tcb_status")
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })

  test("a GPU that fails, or an answer for another nonce", async () => {
    const booted = await rig({ noSweep: true })
    booted.gpu.state.result = false
    expect(await reasonsFor(booted)).toContain("gpu")
    booted.gpu.state.result = true
    booted.gpu.state.nonceOverride = "00"
    expect(await reasonsFor(booted)).toContain("gpu")
  })

  test("a quote the verifier rejects", async () => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => {
      const bytes = hexToBytes(reply.quote)
      bytes[300]! ^= 1
      reply.quote = bytesToHex(bytes)
    })
    expect(await reasonsFor(booted)).toContain("quote_verifier")
  })

  test.each([
    ["hpkePublicKey", `0x${"66".repeat(32)}`],
    ["modelDigest", `0x${"77".repeat(32)}`],
    ["imageDigest", `0x${"88".repeat(32)}`],
    ["operator", `0x${"99".repeat(20)}`],
    ["countsSigner", `0x${"99".repeat(20)}`],
    ["configHash", `0x${"bb".repeat(32)}`],
    ["gpuEvidenceHash", `0x${"aa".repeat(32)}`],
  ])("tampered bindings are refused: %s", async (field, value) => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => {
      Object.assign(reply.bindings, { [field]: value })
      if (field === "hpkePublicKey") reply.hpkePublicKey = value as Hex
    })
    expect(await reasonsFor(booted)).toContain("bindings")
  })

  test("a host claiming an image or model the registry does not hold, under a quote that matches", async () => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => {
      reply.bindings.modelDigest = `0x${"77".repeat(32)}`
      reply.quote = bytesToHex(fakeQuote(FAKE_TD, reportDataFor(reply.bindings, reply.nonce)))
    })
    expect(await reasonsFor(booted)).toContain("identity")
  })

  test("another operator's quotes", async () => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => {
      for (const bindings of [reply.bindings, reply.boot.bindings]) bindings.operator = `0x${"99".repeat(20)}`
      reply.quote = bytesToHex(fakeQuote(FAKE_TD, reportDataFor(reply.bindings, reply.nonce)))
      reply.boot.quote = bytesToHex(fakeQuote(FAKE_TD, reportDataFor(reply.boot.bindings, `0x${"00".repeat(32)}`)))
    })
    expect(await reasonsFor(booted)).toContain("identity")
  })

  test("an old reply replayed for a new nonce", async () => {
    const booted = await rig({ noSweep: true })
    const nonce = `0x${"ee".repeat(32)}`
    const old = (await (await booted.hostApps.get(booted.host)!.request(`/offpeak/v1/attest?nonce=${nonce}`)).json()) as AttestReply
    tamperAttest(booted, (reply) => void Object.assign(reply, { ...old, nonce: reply.nonce }))
    expect(await reasonsFor(booted)).toContain("bindings")
  })

  test("a key beside the bindings that differs from the one inside them", async () => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => void (reply.hpkePublicKey = `0x${"66".repeat(32)}`))
    expect(await reasonsFor(booted)).toEqual(["identity"])
  })

  test("a reply for some other nonce", async () => {
    const booted = await rig({ noSweep: true })
    tamperAttest(booted, (reply) => void (reply.nonce = `0x${"ee".repeat(32)}`))
    expect(await reasonsFor(booted)).toEqual(["nonce"])
  })

  test("an attestationRef the registry does not hold", async () => {
    const booted = await rig({ noSweep: true })
    booted.hostRow.attestationRef = `0x${"44".repeat(32)}`
    expect(await reasonsFor(booted)).toContain("attestation_ref")
  })

  test("a TD in debug mode", async () => {
    expect(await reasonsFor(await rig({ td: { ...FAKE_TD, debug: true }, noSweep: true }))).toContain("debug_td")
  })

  test("a host that does not answer, or sends something else", async () => {
    const booted = await rig({ noSweep: true })
    const hosts = booted.stack.hosts
    booted.stack.hosts = { request: async () => new Response("no", { status: 500 }) }
    expect(await reasonsFor(booted)).toEqual(["no_attestation"])
    booted.stack.hosts = { request: async () => Response.json({ quote: "0x" }) }
    expect(await reasonsFor(booted)).toEqual(["no_attestation"])
    booted.stack.hosts = hosts
  })

  test("a host with no ref registered is never asked", async () => {
    const booted = await rig({ noSweep: true })
    booted.hostRow.attestationRef = ZERO_BYTES32 as Hex
    let asked = 0
    const hosts = booted.stack.hosts
    booted.stack.hosts = { request: (...args) => ((asked += 1), hosts.request(...args)) }
    await sweep(booted)
    expect(asked).toBe(0)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })
})

describe("a client's own fresh quote", () => {
  const ask = (booted: Rig, headers: Record<string, string>) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/offpeak-hpke", ...headers } })
  const nonce = `0x${"ab".repeat(32)}`

  test("passes through the router under the client's nonce", async () => {
    const booted = await rig()
    const res = await ask(booted, { "x-offpeak-sealed-host": booted.host, "x-offpeak-attest-nonce": nonce })
    expect(res.status).toBe(200)
    const reply = (await res.json()) as AttestReply
    expect(reply.nonce).toBe(nonce as Hex)
    expect(reply.bindings.hpkePublicKey).toBe(booted.sealed.identity.publicKey)
  })

  test("only for a verified host, with both headers readable", async () => {
    const booted = await rig()
    expect((await ask(booted, { "x-offpeak-sealed-host": booted.host, "x-offpeak-attest-nonce": "abc" })).status).toBe(400)
    expect((await ask(booted, { "x-offpeak-attest-nonce": nonce })).status).toBe(400)
    expect((await ask(booted, { "x-offpeak-sealed-host": `0x${"12".repeat(20)}`, "x-offpeak-attest-nonce": nonce })).status).toBe(503)
  })

  test("stays at 501 while the switch is off", async () => {
    const booted = await rig()
    booted.stack.flags.sealed = false
    expect((await ask(booted, { "x-offpeak-sealed-host": booted.host, "x-offpeak-attest-nonce": nonce })).status).toBe(501)
  })
})

describe("re-verification", () => {
  test("24 hours on, the host is checked again with a new nonce", async () => {
    const booted = await rig()
    const first = verifiedHost(booted.stack, booted.host)!
    booted.stack.setClock(first.verifiedAt + 86_399)
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)!.transcript.nonce).toBe(first.transcript.nonce)
    booted.stack.setClock(first.verifiedAt + 86_400)
    await sweep(booted)
    const second = verifiedHost(booted.stack, booted.host)!
    expect(second.transcript.nonce).not.toBe(first.transcript.nonce)
    expect(second.verifiedAt).toBe(first.verifiedAt + 86_400)
    expect((await rows(booted))[0]!.transcript.nonce).toBe(second.transcript.nonce)
  })

  test("a host that fails at 24 hours is gone from routing, the list and the table", async () => {
    const booted = await rig()
    const first = verifiedHost(booted.stack, booted.host)!
    booted.stack.setClock(first.verifiedAt + 86_400)
    booted.dcap.state.tcbStatus = "Revoked"
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    expect((await hostsOf(booted)).hosts).toEqual([])
    expect(await rows(booted)).toEqual([])
  })

  test("a verifier outage at the 24-hour check drops the host rather than keeping it", async () => {
    const booted = await rig()
    booted.stack.setClock(verifiedHost(booted.stack, booted.host)!.verifiedAt + 86_400)
    booted.dcap.state.down = true
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })

  test("with sweeps stopped, a row expires by itself", async () => {
    const booted = await rig()
    booted.stack.setClock(verifiedHost(booted.stack, booted.host)!.verifiedAt + 90_001)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })

  test("a host restart is noticed on the next sweep, and it stays out until the new ref is registered", async () => {
    const booted = await rig()
    const next = await booted.restartHost()
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    expect(await rows(booted)).toEqual([])
    booted.hostRow.attestationRef = next.attestationRef
    booted.stack.attest!.retryAt.clear()
    await sweep(booted)
    const row = verifiedHost(booted.stack, booted.host)!
    expect(row.attestationRef).toBe(next.attestationRef)
    expect(row.transcript.bindings.hpkePublicKey).toBe(next.identity.publicKey)
  })

  test("a registry change drops the host", async () => {
    const booted = await rig()
    booted.hostRow.attestationRef = `0x${"44".repeat(32)}`
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
  })

  test("a host that fails waits before it is asked again", async () => {
    const booted = await rig({ noSweep: true })
    booted.dcap.state.down = true
    await sweep(booted)
    const asked = booted.dcap.seen.length
    booted.dcap.state.down = false
    await sweep(booted)
    expect(booted.dcap.seen.length).toBe(asked)
    booted.stack.setClock(booted.stack.clock() + 301)
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).not.toBeNull()
  })

  test("a router restart trusts nothing from the table until a fresh nonce passes", async () => {
    const booted = await rig()
    const before = verifiedHost(booted.stack, booted.host)!
    booted.stack.attest = new AttestBook(booted.stack.attest!.config)
    expect((await rows(booted)).length).toBe(1)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)!.transcript.nonce).not.toBe(before.transcript.nonce)
  })

  test("a stale row from before a restart goes as soon as the host fails its first check", async () => {
    const booted = await rig()
    booted.stack.attest = new AttestBook(booted.stack.attest!.config)
    booted.dcap.state.tcbStatus = "Revoked"
    await sweep(booted)
    expect(await rows(booted)).toEqual([])
  })

  test("a host that left the registry leaves the book and the table", async () => {
    const booted = await rig()
    booted.indexer.hosts.clear()
    await sweep(booted)
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    expect(await rows(booted)).toEqual([])
  })
})

describe("the switch stays off", () => {
  test("the code and the claims fixture both say off", () => {
    expect(FLAGS.sealed).toBe(false)
    const fixture = JSON.parse(readFileSync(new URL("../../../tools/status-fixture.json", import.meta.url), "utf8")) as { features: { sealed: boolean } }
    expect(fixture.features.sealed).toBe(false)
  })

  test("/v1/status, /v1/models and the host list all agree while it is off", async () => {
    const booted = await rig()
    booted.stack.flags.sealed = FLAGS.sealed
    const status = (await (await booted.app.request("/v1/status")).json()) as { features: { sealed: boolean } }
    expect(status.features.sealed).toBe(false)
    const models = (await (await booted.app.request("/v1/models")).json()) as { data: { offpeak: { sealed_available: boolean } }[] }
    expect(models.data[0]!.offpeak.sealed_available).toBe(false)
    const view = await hostsOf(booted)
    expect(view.enabled).toBe(false)
    expect(view.note).toContain("not switched on yet")
  })

  test("the price board says sealed only with the switch on and the host verified", async () => {
    const booted = await rig()
    const sealedOn = async () => ((await (await booted.app.request(`/v1/prices?model=${MODEL}`)).json()) as { hosts: { sealed: boolean }[] }).hosts[0]!.sealed
    expect(await sealedOn()).toBe(true)
    booted.stack.flags.sealed = false
    expect(await sealedOn()).toBe(false)
  })
})

describe("configuration", () => {
  const entry = { imageDigest: `0x${"11".repeat(32)}`, configHash: OTHER_HASH, mrtd: fakeMeasurement(1), rtmrs: [fakeMeasurement(2), fakeMeasurement(3), fakeMeasurement(4), fakeMeasurement(5)] }

  test("the allow-list is empty by default, and comes from the environment", () => {
    expect(readAttestConfig({})).toEqual({ tdxVerifierUrl: undefined, gpuAttestationUrl: undefined, measurements: [] })
    expect(readAttestConfig({ OFFPEAK_SEALED_MEASUREMENTS: JSON.stringify([entry]) }).measurements.length).toBe(1)
  })

  test("a list that cannot be read stops the boot", () => {
    expect(() => readAttestConfig({ OFFPEAK_SEALED_MEASUREMENTS: "not json" })).toThrow()
    expect(() => readAttestConfig({ OFFPEAK_SEALED_MEASUREMENTS: JSON.stringify([{ ...entry, mrtd: "0x12" }]) })).toThrow()
    expect(() => readAttestConfig({ OFFPEAK_SEALED_MEASUREMENTS: JSON.stringify([{ ...entry, rtmrs: entry.rtmrs.slice(1) }]) })).toThrow()
    expect(() => readAttestConfig({ OFFPEAK_SEALED_MEASUREMENTS: JSON.stringify([{ ...entry, configHash: undefined }]) })).toThrow()
  })

  test("production refuses a verifier reached in the clear", () => {
    expect(() => readAttestConfig({ OFFPEAK_TDX_VERIFIER_URL: "http://verifier.example" }, true)).toThrow("https")
    expect(() => readAttestConfig({ OFFPEAK_GPU_ATTESTATION_URL: "http://gpu.example" }, true)).toThrow("https")
    expect(readAttestConfig({ OFFPEAK_TDX_VERIFIER_URL: "https://verifier.example" }, true).tdxVerifierUrl).toBe("https://verifier.example")
  })

  test("the summary check holds every condition", () => {
    const good = { host: "0x1", tcbStatus: "UpToDate", gpuOk: true, measurementOk: true, reportDataOk: true }
    expect(verifyTranscript(good)).toBe(true)
    expect(verifyTranscript({ ...good, tcbStatus: "SWHardeningNeeded" })).toBe(true)
    expect(verifyTranscript({ ...good, tcbStatus: "Revoked" })).toBe(false)
    expect(verifyTranscript({ ...good, gpuOk: false })).toBe(false)
    expect(verifyTranscript({ ...good, measurementOk: false })).toBe(false)
    expect(verifyTranscript({ ...good, reportDataOk: false })).toBe(false)
  })

  test("padding does not read as an outlier: a short reply is mostly frames no token accounts for", () => {
    const range = { low: 1, high: 512 }
    expect(lengthOutlier(range, { bytes: 200, tokens: 30 }, { bytes: 16 + 6 * FRAME_WIRE_BYTES, tokens: 1 })).toBe(false)
    expect(lengthOutlier(range, { bytes: 200, tokens: 30 }, { bytes: 16 + 40 * FRAME_WIRE_BYTES, tokens: 1 })).toBe(true)
  })

  test("the length check flags both ways and skips an empty side", () => {
    const range = { low: 2, high: 100 }
    expect(lengthOutlier(range, { bytes: 500, tokens: 100 }, { bytes: 500, tokens: 100 })).toBe(false)
    expect(lengthOutlier(range, { bytes: 100, tokens: 100 }, { bytes: 500, tokens: 100 })).toBe(true)
    expect(lengthOutlier(range, { bytes: 500, tokens: 100 }, { bytes: 50_000, tokens: 100 })).toBe(true)
    expect(lengthOutlier(range, { bytes: 500, tokens: 100 }, { bytes: 100, tokens: 0 })).toBe(false)
  })
})
