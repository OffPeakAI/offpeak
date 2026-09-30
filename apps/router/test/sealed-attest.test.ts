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
