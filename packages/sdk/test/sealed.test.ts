import { afterEach, describe, expect, test } from "bun:test"
import { sha256Hex } from "@offpeak/shared"
import { bytesToHex, hexToBytes, type Hex, type PublicClient } from "viem"
import { fakeMeasurement, fakeQuote, FAKE_TD } from "../../../apps/host-agent/test/support/fake-tsm.ts"
import { MODEL, TRUST_ROUTER, sealedRig, type RigOptions } from "../../../apps/router/test/support/sealed-rig.ts"
import { Offpeak, OffpeakError, type HostCheck, type Measurement, type OffpeakOptions, type SealedOptions } from "../src/index.ts"
import { ZERO_NONCE, attestationRefOf, bindingsHash, checkTranscript, reportDataFor, type AttestReply, type Transcript } from "../src/sealed/attest.ts"
import { FrameSplitter, encodeTrailer } from "../src/sealed/stream.ts"
import { concatBytes } from "../src/sealed/hpke.ts"
import { BASE } from "./support.ts"

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

const ask = (content: string) => ({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 64 })

type Hook = { transcript?: (t: Transcript) => void; attest?: (reply: AttestReply) => void; response?: (res: Response) => Promise<Response> }

/** `sealed: null` is a client with no sealed options at all. */
function client(booted: Rig, hook: Hook = {}, sealed: SealedOptions | null = TRUST_ROUTER, extra: Partial<OffpeakOptions> = {}) {
  const posts: Uint8Array[] = []
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("http://127.0.0.1")) return fetch(input, init)
    if (init?.body instanceof Uint8Array) posts.push(init.body)
    const res = await booted.app.fetch(new Request(input, init))
    if (url.includes("/v1/sealed/hosts")) {
      const body = (await res.json()) as { hosts: { transcript: Transcript }[] }
      for (const row of body.hosts) hook.transcript?.(row.transcript)
      return Response.json(body)
    }
    if (new Headers(init?.headers).has("x-offpeak-attest-nonce")) {
      if (!res.ok || !hook.attest) return res
      const reply = (await res.json()) as AttestReply
      hook.attest(reply)
      return Response.json(reply)
    }
    return hook.response && res.ok ? hook.response(res) : res
  }) as typeof fetch
  const op = new Offpeak({ baseURL: BASE, apiKey: booted.key.token, deployment: "local", router: booted.stack.router.address, fetch: send, sealed: sealed ?? undefined, ...extra })
  return { op, posts }
}

/** Frames of a finished response, ready to be damaged and sent on. */
async function framesOf(res: Response) {
  const bytes = new Uint8Array(await res.arrayBuffer())
  const splitter = new FrameSplitter()
  const frames = splitter.push(bytes)
  return { salt: splitter.responseSalt!, frames, headers: res.headers }
}

const refusedFor = async (booted: Rig, hook: Hook) => {
  const { op, posts } = client(booted, hook)
  const checks = await op.sealed.check(MODEL)
  expect(await op.sealed.hosts(MODEL)).toEqual([])
  await expect(op.sealed.chat(ask("must not leave"))).rejects.toMatchObject({ code: "sealed_no_host" })
  expect(posts).toEqual([])
  return (checks as HostCheck[])[0]!.reasons
}

/** The record and closing frame of a finished reply, rewritten as a lying router would. */
const editTrailer = (change: (trailer: any) => void) => ({
  response: async (res: Response) => {
    const { salt, frames, headers } = await framesOf(res)
    const trailer = JSON.parse(new TextDecoder().decode(frames.at(-1)!.body))
    change(trailer)
    return new Response(concatBytes(salt, ...frames.slice(0, -1).map((frame) => frame.raw), encodeTrailer(trailer)), { headers })
  },
})

const setVerdict = (over: Partial<Transcript["verdict"]>) => (t: Transcript) => void Object.assign(t.verdict, over)

/** A second quote from the same fake TD, for tests that need the quote itself to change. */
const requote = (bindings: Transcript["bindings"], nonce: Hex, td = FAKE_TD) => bytesToHex(fakeQuote(td, reportDataFor(bindings, nonce)))

describe("op.sealed.hosts refuses a transcript that fails", () => {
  test("a good transcript passes, and the key comes from its bindings", async () => {
    const booted = await rig()
    const [host] = await client(booted).op.sealed.hosts(MODEL)
    expect(host?.hpkePublicKey).toBe(booted.sealed.identity.publicKey)
    expect(host?.attestationRef).toBe(booted.sealed.attestationRef)
  })

  test("the router's verifier said no", async () => {
    expect(await refusedFor(await rig(), { transcript: setVerdict({ quoteVerified: false }) })).toContain("quote_verifier")
  })

  test.each(["OutOfDate", "OutOfDateConfigurationNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded", "Revoked", "uptodate", ""])("TCB status %s", async (status) => {
    expect(await refusedFor(await rig(), { transcript: setVerdict({ tcbStatus: status }) })).toContain("tcb_status")
  })

  test("the boot quote's TCB status counts too", async () => {
    expect(await refusedFor(await rig(), { transcript: setVerdict({ bootTcbStatus: "Revoked" }) })).toContain("tcb_status")
  })

  test("measurements off the allow-list", async () => {
    expect(await refusedFor(await rig(), { transcript: setVerdict({ allowListed: false }) })).toContain("measurement")
  })

  test("a GPU result that is not true", async () => {
    expect(await refusedFor(await rig(), { transcript: setVerdict({ gpuResult: false }) })).toContain("gpu")
  })

  test("GPU evidence that is not what the bindings hashed", async () => {
    const reasons = await refusedFor(await rig(), { transcript: (t) => void (t.gpuEvidence.arch = "OTHER") })
    expect(reasons).toContain("gpu_evidence")
  })

  test.each([
    ["hpkePublicKey", `0x${"66".repeat(32)}`],
    ["modelDigest", `0x${"77".repeat(32)}`],
    ["imageDigest", `0x${"88".repeat(32)}`],
    ["operator", `0x${"99".repeat(20)}`],
    ["countsSigner", `0x${"99".repeat(20)}`],
    ["configHash", `0x${"bb".repeat(32)}`],
    ["gpuEvidenceHash", `0x${"aa".repeat(32)}`],
  ])("tampered bindings: %s", async (field, value) => {
    const reasons = await refusedFor(await rig(), { transcript: (t) => void Object.assign(t.bindings, { [field]: value }) })
    expect(reasons).toContain("bindings")
  })

  test("tampered boot bindings", async () => {
    const reasons = await refusedFor(await rig(), { transcript: (t) => void (t.boot.bindings.hpkePublicKey = `0x${"66".repeat(32)}`) })
    expect(reasons).toContain("bindings")
  })

  test("a swapped HPKE key that a dishonest quote does cover", async () => {
    const reasons = await refusedFor(await rig(), {
      transcript: (t) => {
        t.bindings.hpkePublicKey = `0x${"66".repeat(32)}`
        t.quote = requote(t.bindings, t.nonce)
      },
    })
    expect(reasons).toContain("identity")
  })

  test("a nonce other than the one the quote covers", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.nonce = `0x${"55".repeat(32)}`) })).toContain("bindings")
  })

  test("the zero nonce", async () => {
    const reasons = await refusedFor(await rig(), {
      transcript: (t) => {
        t.nonce = ZERO_NONCE
        t.quote = t.boot.quote
        t.bindings = t.boot.bindings
      },
    })
    expect(reasons).toContain("nonce")
  })

  test("a boot quote that does not hash to the registered ref", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.registry.attestationRef = `0x${"44".repeat(32)}`) })).toContain("attestation_ref")
  })

  test("an unset registry ref", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.registry.attestationRef = ZERO_NONCE) })).toContain("attestation_ref")
  })

  test("an image or model the registry does not hold", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.registry.imageDigest = `0x${"33".repeat(32)}`) })).toContain("identity")
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.registry.modelDigests = []) })).toContain("identity")
  })

  test("a TD started in debug mode, whose memory its host can read", async () => {
    const debug = { ...FAKE_TD, debug: true }
    const reasons = await refusedFor(await rig(), {
      transcript: (t) => {
        t.quote = requote(t.bindings, t.nonce, debug)
      },
    })
    expect(reasons).toContain("debug_td")
  })

  test.each([
    ["another quote version", 0, 5],
    ["another TEE type", 4, 0x00],
  ])("%s", async (_name, at, value) => {
    const reasons = await refusedFor(await rig(), {
      transcript: (t) => {
        const bytes = hexToBytes(t.quote)
        bytes[at] = value
        t.quote = bytesToHex(bytes)
      },
    })
    expect(reasons).toContain("quote_format")
  })

  test("a quote the parser cannot read", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.quote = "0x00") })).toContain("quote_format")
  })

  test("a transcript past its age", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.verifiedAt = 1_000) })).toContain("stale")
  })

  test("a transcript dated in the future", async () => {
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.verifiedAt = Math.floor(Date.now() / 1000) + 86_400) })).toContain("stale")
  })

  test("two quotes from different VMs", async () => {
    const other = { ...FAKE_TD, mrtd: fakeMeasurement(0xc1) }
    expect(await refusedFor(await rig(), { transcript: (t) => void (t.quote = requote(t.bindings, t.nonce, other)) })).toContain("measurement")
  })

  test("a list that lies about which host a transcript is for", async () => {
    const booted = await rig()
    const { op } = client(booted, { transcript: (t) => void (t.host = `0x${"99".repeat(20)}`) })
    expect((await op.sealed.check(MODEL)).length).toBe(1)
    expect(await op.sealed.hosts(MODEL)).toEqual([])
  })

  test("the client's own allow-list overrules the router's yes", async () => {
    const booted = await rig()
    const measurements: Measurement[] = [{ imageDigest: booted.imageDigest, configHash: booted.sealed.bootBindings.configHash, mrtd: fakeMeasurement(0x01), rtmrs: FAKE_TD.rtmrs }]
    const { op } = client(booted, {}, { ...TRUST_ROUTER, measurements })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("measurement")
  })

  test("the client's own pin overrules the router's name for a model", async () => {
    const booted = await rig()
    const { op } = client(booted, {}, { ...TRUST_ROUTER, modelDigests: { [MODEL]: `0x${"77".repeat(32)}` } })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("model_pin")
  })

  test("a host list that cannot be read stops the call", async () => {
    const booted = await rig()
    const { op } = client(booted, { transcript: (t) => void (t.v = 2 as never) })
    await expect(op.sealed.hosts(MODEL)).rejects.toMatchObject({ code: "sealed_bad_transcript" })
  })
})

describe("the default", () => {
  test("a client with no verifier of its own refuses, rather than taking the router's word", async () => {
    const booted = await rig()
    const { op, posts } = client(booted, {}, null)
    await expect(op.sealed.hosts(MODEL)).rejects.toMatchObject({ code: "sealed_verifier_required" })
    await expect(op.sealed.chat(ask("must not leave"))).rejects.toMatchObject({ code: "sealed_verifier_required" })
    expect(posts).toEqual([])
  })

  test("a router that forges a transcript and swaps the key never sees the prompt", async () => {
    const booted = await rig()
    const swapped = `0x${"66".repeat(32)}` as Hex
    const forge = (t: Pick<Transcript, "bindings" | "boot" | "quote"> & { hpkePublicKey?: Hex }, nonce: Hex) => {
      t.bindings.hpkePublicKey = swapped
      t.boot.bindings.hpkePublicKey = swapped
      if (t.hpkePublicKey) t.hpkePublicKey = swapped
      const bad = hexToBytes(requote(t.bindings, nonce))
      bad[bad.length - 1]! ^= 1
      t.quote = bytesToHex(bad)
    }
    const hook = { transcript: (t: Transcript) => forge(t, t.nonce), attest: (reply: AttestReply) => forge(reply, reply.nonce) }
    const reader = { readContract: async ({ functionName }: { functionName: string }) => (functionName === "hostView" ? { attestationRef: booted.sealed.attestationRef, imageDigest: booted.imageDigest } : [booted.modelDigest]) } as unknown as PublicClient
    const own = { verifierUrl: booted.dcap.url, gpuVerifierUrl: booted.gpu.url, modelDigests: { [MODEL]: booted.modelDigest }, measurements: [{ imageDigest: booted.imageDigest, configHash: booted.sealed.bootBindings.configHash, mrtd: FAKE_TD.mrtd, rtmrs: FAKE_TD.rtmrs }] }
    const { op, posts } = client(booted, hook, own, { publicClient: reader })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("quote_verifier")
    await expect(op.sealed.chat(ask("must not leave"))).rejects.toMatchObject({ code: "sealed_no_host" })
    expect(posts).toEqual([])
  })
})

describe("trustRouterVerification: false", () => {
  const reader = (booted: Rig, over: { attestationRef?: Hex } = {}) =>
    ({
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "hostView" ? { attestationRef: over.attestationRef ?? booted.sealed.attestationRef, imageDigest: booted.imageDigest } : [booted.modelDigest],
    }) as unknown as PublicClient

  const own = (booted: Rig, over: Partial<SealedOptions> = {}): SealedOptions => ({
    trustRouterVerification: false,
    verifierUrl: booted.dcap.url,
    gpuVerifierUrl: booted.gpu.url,
    measurements: [{ imageDigest: booted.imageDigest, configHash: booted.sealed.bootBindings.configHash, mrtd: FAKE_TD.mrtd, rtmrs: FAKE_TD.rtmrs }],
    modelDigests: { [MODEL]: booted.modelDigest },
    ...over,
  })

  test("needs the client's own verifier, GPU service and allow-list before it will start", async () => {
    const booted = await rig()
    expect(() => client(booted, {}, { trustRouterVerification: false })).toThrow(OffpeakError)
    expect(() => client(booted, {}, own(booted, { verifierUrl: undefined }))).toThrow(OffpeakError)
    expect(() => client(booted, {}, own(booted, { gpuVerifierUrl: undefined }))).toThrow(OffpeakError)
    expect(() => client(booted, {}, own(booted, { measurements: undefined }))).toThrow(OffpeakError)
    expect(() => client(booted, {}, own(booted, { modelDigests: undefined }))).toThrow(OffpeakError)
  })

  test("passes on the client's own services and the chain's record", async () => {
    const booted = await rig()
    const { op } = client(booted, {}, own(booted), { publicClient: reader(booted) })
    expect((await op.sealed.chat(ask("own verifier"))).text).toBe("Served in the sealed VM.")
  })

  test("ignores every claim the router makes", async () => {
    const booted = await rig()
    const hook = { transcript: setVerdict({ quoteVerified: false, tcbStatus: "Revoked", allowListed: false, gpuResult: false }) }
    const { op } = client(booted, hook, own(booted), { publicClient: reader(booted) })
    expect((await op.sealed.hosts(MODEL)).length).toBe(1)
  })

  test("takes a fresh quote under its own nonce, and its own clock dates it", async () => {
    const booted = await rig()
    const before = Math.floor(Date.now() / 1000)
    const listed: Transcript[] = []
    const asked: AttestReply[] = []
    const hook = { transcript: (t: Transcript) => void listed.push(t), attest: (reply: AttestReply) => void asked.push(reply) }
    const { op } = client(booted, hook, own(booted, { maxAgeSeconds: 60 }), { publicClient: reader(booted) })
    const [host] = await op.sealed.hosts(MODEL)
    expect(asked.length).toBe(1)
    expect(host!.transcript.nonce).toBe(asked[0]!.nonce)
    expect(host!.transcript.nonce).not.toBe(listed[0]!.nonce)
    expect(host!.transcript.quote).not.toBe(listed[0]!.quote)
    expect(host!.verifiedAt).toBeGreaterThanOrEqual(before)
    expect(host!.verifiedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })

  test("the router's date means nothing: an old transcript dated tomorrow does not get past maxAgeSeconds", async () => {
    const booted = await rig()
    const tomorrow = Math.floor(Date.now() / 1000) + 86_400
    const { op } = client(booted, { transcript: (t) => void (t.verifiedAt = tomorrow) }, own(booted, { maxAgeSeconds: 60 }), { publicClient: reader(booted) })
    const [host] = await op.sealed.hosts(MODEL)
    expect(host!.verifiedAt).toBeLessThan(tomorrow)
  })

  test("a quote the router saved from earlier cannot answer this client's nonce", async () => {
    const booted = await rig()
    const old = (await (await booted.hostApps.get(booted.host)!.request(`/offpeak/v1/attest?nonce=0x${"ee".repeat(32)}`)).json()) as AttestReply
    const replayed = { attest: (reply: AttestReply) => void Object.assign(reply, old) }
    expect((await client(booted, replayed, own(booted), { publicClient: reader(booted) }).op.sealed.check(MODEL))[0]!.reasons).toEqual(["no_attestation"])
    const relabelled = { attest: (reply: AttestReply) => void Object.assign(reply, { ...old, nonce: reply.nonce }) }
    expect((await client(booted, relabelled, own(booted), { publicClient: reader(booted) }).op.sealed.check(MODEL))[0]!.reasons).toContain("bindings")
  })

  test("a router that will not relay the quote refuses the host", async () => {
    const booted = await rig()
    const hosts = booted.stack.hosts
    booted.stack.hosts = { request: (host, endpoint, path, init) => (path.includes("attest?nonce") ? Promise.resolve(new Response("no", { status: 500 })) : hosts.request(host, endpoint, path, init)) }
    const { op, posts } = client(booted, {}, own(booted), { publicClient: reader(booted) })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toEqual(["no_attestation"])
    await expect(op.sealed.chat(ask("must not leave"))).rejects.toMatchObject({ code: "sealed_no_host" })
    expect(posts).toEqual([])
  })

  test("a host with another config cannot pass, however good its quotes", async () => {
    const booted = await rig()
    const measurements = own(booted).measurements!.map((row) => ({ ...row, configHash: `0x${"ee".repeat(32)}` as Hex }))
    const { op } = client(booted, {}, own(booted, { measurements }), { publicClient: reader(booted) })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("measurement")
  })

  test("a model name with no pin, or the wrong one, refuses the host", async () => {
    const booted = await rig()
    const none = client(booted, {}, own(booted, { modelDigests: {} }), { publicClient: reader(booted) })
    expect((await none.op.sealed.check(MODEL))[0]!.reasons).toContain("model_pin")
    const other = client(booted, {}, own(booted, { modelDigests: { [MODEL]: `0x${"77".repeat(32)}` } }), { publicClient: reader(booted) })
    expect((await other.op.sealed.check(MODEL))[0]!.reasons).toContain("model_pin")
  })

  test("the client's verifier decides: a bad TCB there refuses a host the router passed", async () => {
    const booted = await rig()
    booted.dcap.state.tcbStatus = "OutOfDate"
    const { op } = client(booted, {}, own(booted), { publicClient: reader(booted) })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("tcb_status")
  })

  test("a verifier that does not answer refuses the host", async () => {
    const booted = await rig()
    booted.dcap.state.down = true
    const { op } = client(booted, {}, own(booted), { publicClient: reader(booted) })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("quote_verifier")
  })

  test("a GPU service that says no refuses the host", async () => {
    const booted = await rig()
    booted.gpu.state.result = false
    const { op } = client(booted, {}, own(booted), { publicClient: reader(booted) })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("gpu")
  })

  test("the chain's ref decides, not the one the router printed", async () => {
    const booted = await rig()
    const { op } = client(booted, {}, own(booted), { publicClient: reader(booted, { attestationRef: `0x${"44".repeat(32)}` }) })
    expect((await op.sealed.check(MODEL))[0]!.reasons).toContain("attestation_ref")
  })
