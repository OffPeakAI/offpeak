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
