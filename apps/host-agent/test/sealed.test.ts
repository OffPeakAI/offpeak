import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CHAIN_ID, HOST_STATUS, ZERO_BYTES32, buyerRefOf, domain, gpuClassOf, hostCostMicro, hourOfWeek, outputHashOf, recordToMessage, serializeRecord, sha256Hex, signTyped, usageTypes, type UsageRecord } from "@offpeak/shared"
import { bytesToHex, hexToBytes, keccak256, toBytes, type Hex } from "viem"
import { bindingsHash, countsSignedBy, parseQuote, reportDataFor, sealedConfigHash, sealedCountsSchema, ZERO_NONCE } from "../../../packages/sdk/src/sealed/attest.ts"
import { FRAME_DATA_BYTES, FRAME_WIRE_BYTES, SEALED_PATH, publicKeyFrom, sealRequest } from "../../../packages/sdk/src/sealed/hpke.ts"
import { FrameSplitter, openResponse, type OpenedResponse } from "../../../packages/sdk/src/sealed/stream.ts"
import { livePrice, loadFactorBps } from "../../router/src/pricing/live.ts"
import { MODEL, byteTokenizer, sealedRig, type RigOptions } from "../../router/test/support/sealed-rig.ts"
import { parseHostYaml } from "../src/config.ts"
import { bootAgent, imageDigestFor } from "../src/main.ts"
import { countInput, withinDepth } from "../src/meter.ts"
import { signRouterBody } from "../src/proxy.ts"
import { GPU_EVIDENCE_COMMAND, collectGpuEvidence, gpuEvidenceHash } from "../src/sealed/gpu-evidence.ts"
import { ReplayGuard, sealedReqPayload } from "../src/sealed/hpke.ts"
import { SEALED_CHAT_ROUTE, SEALED_COUNTS_ROUTE, SealedAgent } from "../src/sealed/serve.ts"
import { readTdxQuote } from "../src/sealed/tdx.ts"
import { fakeGpuCommand } from "./support/fake-gpu-tool.ts"
import { FAKE_TD, fakeQuoteValid, sealedTempDir, startFakeTsm } from "./support/fake-tsm.ts"
import { startFakeVllm } from "./support/fake-vllm.ts"
import { IMAGE, SMI, host, hostFolder, router as routerKey } from "./support/harness.ts"

let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

type Rig = Awaited<ReturnType<typeof sealedRig>>

async function rig(opts?: RigOptions) {
  const booted = await sealedRig(opts)
  stops.push(booted.stop)
  return booted
}

const tsm = (opts?: Parameters<typeof startFakeTsm>[0]) => {
  const fake = startFakeTsm(opts)
  stops.push(fake.stop)
  return fake
}

let reqs = 0
const newReq = () => keccak256(toBytes(`sealed-req-${Date.now()}-${reqs++}`))

const agentOf = (booted: Rig) => booted.hostApps.get(booted.host)!

const chat = (content: string, over: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: "user", content }], stream: true, max_tokens: 32, ...over })

async function sealedBody(booted: Rig, body: unknown, nowMs = booted.stack.clock() * 1000, key: Hex = booted.sealed.identity.publicKey) {
  return sealRequest(await publicKeyFrom(hexToBytes(key)), new TextEncoder().encode(JSON.stringify(body)), SEALED_PATH, nowMs)
}

type Send = { maxTokens?: number; model?: string; signedMaxTokens?: number; signedModel?: string; header?: string | null; reqId?: Hex; signer?: unknown; signedBytes?: Uint8Array }

/** A request as the router sends one, signed over the ciphertext and both clear limits. */
async function send(booted: Rig, bytes: Uint8Array, over: Send = {}) {
  const reqId = over.reqId ?? newReq()
  const maxTokens = over.maxTokens ?? 32
  const model = over.model ?? MODEL
  const payload = sealedReqPayload({ bodyHash: keccak256(over.signedBytes ?? bytes), maxTokens: over.signedMaxTokens ?? maxTokens, model: over.signedModel ?? model })
  const header = over.header === undefined ? await signRouterBody((over.signer ?? booted.stack.router) as never, { reqId, ts: booted.stack.clock(), payload }) : over.header
  const res = await agentOf(booted).request(SEALED_CHAT_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/offpeak-hpke", "x-offpeak-model": model, "x-offpeak-max-tokens": String(maxTokens), ...(header ? { "x-offpeak-req": header } : {}) },
    body: bytes,
  })
  return { res, reqId }
}

async function readReply(res: Response, sealed: { secret: Uint8Array; enc: Uint8Array }) {
  let text = ""
  let opened: OpenedResponse | null = null
  for await (const part of openResponse(res.body!, sealed.secret, sealed.enc, (result) => (opened = result))) text += new TextDecoder().decode(part)
  return { text, outputHash: (opened as OpenedResponse | null)!.outputHash }
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

async function counts(booted: Rig, reqId: Hex, signer: unknown = booted.stack.router) {
  const header = await signRouterBody(signer as never, { reqId, ts: booted.stack.clock(), payload: reqId })
  return agentOf(booted).request(`${SEALED_COUNTS_ROUTE}/${reqId}`, { headers: { "x-offpeak-req": header } })
}

describe("configfs-tsm", () => {
  test("a quote comes back with the report data the agent wrote", async () => {
    const reportData = new Uint8Array(64).fill(0x42)
    const quote = bytesToHex(await readTdxQuote(tsm().root, reportData))
    expect(parseQuote(quote).reportData).toBe(bytesToHex(reportData))
    expect(parseQuote(quote).mrtd).toBe(FAKE_TD.mrtd)
    expect(parseQuote(quote).rtmrs).toEqual(FAKE_TD.rtmrs)
    expect(fakeQuoteValid(quote)).toBe(true)
  })

  test("repeat reads answer for the newest report data", async () => {
    const { root } = tsm()
    for (const fill of [1, 2, 3, 4, 5]) {
      const reportData = new Uint8Array(64).fill(fill)
      expect(parseQuote(bytesToHex(await readTdxQuote(root, reportData))).reportData).toBe(bytesToHex(reportData))
    }
  })

  test("a machine with no TDX fails", async () => {
    const empty = sealedTempDir("no-tsm-")
    stops.push(() => rmSync(empty, { recursive: true, force: true }))
    await expect(readTdxQuote(join(empty, "missing"), new Uint8Array(64))).rejects.toThrow()
    await expect(readTdxQuote(empty, new Uint8Array(64))).rejects.toThrow()
  })

  test("another provider is refused", async () => {
    await expect(readTdxQuote(tsm({ provider: "sev_guest" }).root, new Uint8Array(64))).rejects.toThrow("quote provider")
  })

  test("a quote that raced another writer is thrown away", async () => {
    await expect(readTdxQuote(tsm({ racing: true }).root, new Uint8Array(64))).rejects.toThrow("raced")
  })

  test("report data must be 64 bytes", async () => {
    await expect(readTdxQuote(tsm().root, new Uint8Array(32))).rejects.toThrow("64 bytes")
  })
})

describe("GPU evidence", () => {
  test("the nonce reaches the tool and its JSON comes back", async () => {
    const evidence = await collectGpuEvidence(fakeGpuCommand(), `0x${"ab".repeat(32)}`)
    expect(evidence.arch).toBe("HOPPER")
    expect(evidence.evidence_list.length).toBe(1)
  })

  test("a tool that fails, or prints something else, stops the collection", async () => {
    await expect(collectGpuEvidence(["/bin/sh", "-c", "exit 3"], ZERO_NONCE)).rejects.toThrow("exited with 3")
    await expect(collectGpuEvidence(["/bin/sh", "-c", "echo not json"], ZERO_NONCE)).rejects.toThrow()
    await expect(collectGpuEvidence(["/bin/sh", "-c", "echo {}"], ZERO_NONCE)).rejects.toThrow()
  })

  test("the tool sees none of the agent's environment", async () => {
    process.env.OFFPEAK_SEALED_LEAK = "visible"
    try {
      const printed = ["/bin/sh", "-c", `echo '{"arch":"'"$OFFPEAK_SEALED_LEAK"'x","evidence_list":[{}]}'`]
      expect((await collectGpuEvidence(printed, ZERO_NONCE)).arch).toBe("x")
    } finally {
      delete process.env.OFFPEAK_SEALED_LEAK
    }
  })

  test("the command is fixed, by absolute path, and takes the nonce", () => {
    expect(GPU_EVIDENCE_COMMAND[0]!.startsWith("/")).toBe(true)
    expect(GPU_EVIDENCE_COMMAND).toContain("{nonce}")
  })
})

describe("boot", () => {
  const start = (tsmRoot: string, gpuTool = fakeGpuCommand(), engine = "http://127.0.0.1:8000") =>
    SealedAgent.start({ modelName: MODEL, modelDigest: `0x${"11".repeat(32)}`, imageDigest: `0x${"22".repeat(32)}`, operator: host.address, engine, tsmRoot, gpuTool })

  test("the bindings, boot quote and ref hold together", async () => {
    const agent = await start(tsm().root)
    const quote = parseQuote(agent.bootQuote)
    expect(quote.reportData).toBe(bytesToHex(reportDataFor(agent.bootBindings, ZERO_NONCE)))
    expect(quote.reportData.slice(0, 66)).toBe(bindingsHash(agent.bootBindings))
    expect(agent.attestationRef).toBe(sha256Hex(hexToBytes(agent.bootQuote)))
    expect(agent.bootBindings).toMatchObject({ v: 1, operator: host.address.toLowerCase(), hpkePublicKey: agent.identity.publicKey })
    expect(agent.bootBindings.gpuEvidenceHash).toBe(gpuEvidenceHash(await collectGpuEvidence(fakeGpuCommand(), ZERO_NONCE)))
  })

  test("each boot has its own keys and ref", async () => {
    const { root } = tsm()
    const [first, second] = [await start(root), await start(root)]
    expect(first.identity.publicKey).not.toBe(second.identity.publicKey)
    expect(first.bootBindings.countsSigner).not.toBe(second.bootBindings.countsSigner)
    expect(first.attestationRef).not.toBe(second.attestationRef)
  })

  test("the bindings hash everything that decides where plaintext goes", async () => {
    const { root } = tsm()
    const gpuTool = fakeGpuCommand()
    const honest = await start(root, gpuTool)
    expect(honest.bootBindings.configHash).toBe(sealedConfigHash({ modelName: MODEL, engine: "http://127.0.0.1:8000", tsmRoot: root, gpuTool }))
    const movedEngine = await start(root, gpuTool, "http://127.0.0.1:8001")
    expect(movedEngine.bootBindings.configHash).not.toBe(honest.bootBindings.configHash)
    const wrapped = await start(root, [...gpuTool, "--logged"])
    expect(wrapped.bootBindings.configHash).not.toBe(honest.bootBindings.configHash)
  })

  test("an engine that is not 127.0.0.1 stops the boot", async () => {
    const { root } = tsm()
    for (const engine of ["http://10.0.0.5:8000", "http://localhost:8000", "https://127.0.0.1:8000", "http://127.0.0.1.example.net:8000"]) {
      await expect(start(root, fakeGpuCommand(), engine)).rejects.toThrow("127.0.0.1")
    }
  })

  test("a proxy in the environment stops the boot, since fetch would send plaintext through it", async () => {
    const { root } = tsm()
    process.env.HTTP_PROXY = "http://127.0.0.1:43999"
    try {
      await expect(start(root)).rejects.toThrow("proxy")
    } finally {
      delete process.env.HTTP_PROXY
    }
  })
