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

  test("no TSM, or no GPU evidence, stops the boot", async () => {
    await expect(start("/nonexistent/tsm/report")).rejects.toThrow()
    await expect(start(tsm().root, ["/bin/sh", "-c", "exit 1"])).rejects.toThrow()
  })

  test("the private key is in no reply and no public field", async () => {
    const booted = await rig()
    const nonce = `0x${"cd".repeat(32)}`
    const reply = await (await agentOf(booted).request(`/offpeak/v1/attest?nonce=${nonce}`)).text()
    expect(reply.toLowerCase()).not.toContain("private")
    expect(JSON.stringify(booted.sealed)).not.toContain("privateKey")
    expect(Object.keys(booted.sealed.identity)).not.toContain("privateKey")
  })

  test("host.yaml names a sealed model it serves, and the agent boots through the real path", async () => {
    const base = { operator: host.address, endpoint: "https://host.example.net", gpuClass: "h100-80g-sxm", image: IMAGE, router: routerKey.address, models: [{ name: "m", path: "/m", manifest: "/m.json", maxTps: 1 }] }
    expect(() => parseHostYaml(JSON.stringify({ ...base, sealed: { model: "other" } }))).toThrow()
    expect(parseHostYaml(JSON.stringify({ ...base, sealed: { model: "m" } })).sealed?.tsmRoot).toBe("/sys/kernel/config/tsm/report")
    // An evidence command from host.yaml would run in the VM, so the key itself no longer parses.
    expect(() => parseHostYaml(JSON.stringify({ ...base, sealed: { model: "m", gpuEvidenceCommand: ["x"] } }))).toThrow()
    const fake = tsm()
    const folder = hostFolder({ topLines: ["sealed:", "  model: qwen2.5-0.5b-instruct", `  tsmRoot: ${fake.root}`] })
    stops.push(() => rmSync(folder.root, { recursive: true, force: true }))
    const chain = {
      chainId: async () => CHAIN_ID,
      routerSigner: async () => routerKey.address,
      registration: async () => ({ status: HOST_STATUS.Active, imageDigest: imageDigestFor({ image: IMAGE }), gpuClass: gpuClassOf("h100-80g-sxm"), models: [folder.digest], bondUsdg: 0n, bondOfpk: 0n, releasableCredits: 0n, pendingCredits: 0n }),
      bondTokens: async () => ({ usdg: ZERO_BYTES32 as Hex, ofpk: ZERO_BYTES32 as Hex }),
    }
    const booted = await bootAgent({ configPath: folder.configPath, env: folder.env, chain, gpu: async () => SMI, gpuTool: fakeGpuCommand() })
    expect(booted.sealed?.bootBindings.modelDigest).toBe(folder.digest)
    expect(booted.sealed?.boot.engine).toBe("http://127.0.0.1:8000")
    const info = (await (await booted.app.request("/offpeak/v1/info")).json()) as { sealed: boolean }
    expect(info.sealed).toBe(true)
    const status = (await (await booted.app.request("/offpeak/v1/attest")).json()) as { attestationRef: string }
    expect(status.attestationRef).toBe(booted.sealed!.attestationRef)
  })
})

describe("GET /offpeak/v1/attest", () => {
  test("a fresh quote under the caller's nonce, with GPU evidence bound in, and the boot quote beside it", async () => {
    const booted = await rig()
    const nonce = `0x${"cd".repeat(32)}` as Hex
    const reply = (await (await agentOf(booted).request(`/offpeak/v1/attest?nonce=${nonce}`)).json()) as any
    expect(reply.nonce).toBe(nonce)
    expect(reply.hpkePublicKey).toBe(booted.sealed.identity.publicKey)
    expect(parseQuote(reply.quote).reportData).toBe(bytesToHex(reportDataFor(reply.bindings, nonce)))
    expect(reply.bindings.gpuEvidenceHash).toBe(gpuEvidenceHash(reply.gpuEvidence))
    expect(reply.bindings.hpkePublicKey).toBe(booted.sealed.identity.publicKey)
    expect(reply.boot.quote).toBe(booted.sealed.bootQuote)
    expect(reply.quote).not.toBe(reply.boot.quote)
  })

  test("a bad nonce, and the boot quote's zero nonce, are refused", async () => {
    const agent = agentOf(await rig())
    expect((await agent.request("/offpeak/v1/attest?nonce=abc")).status).toBe(400)
    expect((await agent.request(`/offpeak/v1/attest?nonce=${ZERO_NONCE}`)).status).toBe(400)
  })

  test("the queue is bounded", async () => {
    const booted = await rig()
    const nonce = `0x${"cd".repeat(32)}`
    const replies = await Promise.all(Array.from({ length: 8 }, () => agentOf(booted).request(`/offpeak/v1/attest?nonce=${nonce}`)))
    expect(replies.filter((res) => res.status === 429).length).toBeGreaterThan(0)
    expect(replies.filter((res) => res.status === 200).length).toBeGreaterThan(0)
  })
})

describe("sealed serving", () => {
  test("decrypts, forwards to vLLM on localhost and encrypts the stream back", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("hello inside"))
    const { res } = await send(booted, sealed.bytes)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/offpeak-hpke-stream")
    const { text } = await readReply(res, sealed)
    expect(text).toContain("data: ")
    expect(text).toContain("Serve")
    expect(booted.engine.requests[0]!.body.messages[0].content).toBe("hello inside")
    expect(booted.engine.requests[0]!.body.stream).toBe(true)
  })

  test("plaintext goes to the engine the VM attested, whatever the model table says", async () => {
    const logger = startFakeVllm({ name: MODEL, tokenizer: byteTokenizer })
    stops.push(logger.stop)
    const booted = await rig({ modelEngine: logger.url })
    const sealed = await sealedBody(booted, chat("attested engine only"))
    await readReply((await send(booted, sealed.bytes)).res, sealed)
    expect(booted.engine.requests.length).toBe(1)
    expect(logger.requests.length).toBe(0)
  })

  test("every frame has one size, so a short token and a long one look the same", async () => {
    const framesFor = async (text: string) => {
      const booted = await rig({ reply: () => ({ text }) })
      const sealed = await sealedBody(booted, chat("pad"))
      const bytes = new Uint8Array(await (await send(booted, sealed.bytes)).res.arrayBuffer())
      return new FrameSplitter().push(bytes).map((frame) => frame.raw.length)
    }
    const short = await framesFor("a b c d e f g h i j k l m n o p q r s t u v w x y z")
    const long = await framesFor("extraordinarily-long-tokens-with-no-spaces-at-all-anywhere")
    expect(new Set([...short, ...long])).toEqual(new Set([FRAME_WIRE_BYTES]))
  })

  test("padding comes back off, across frames, and a reply of no text still ends", async () => {
    const booted = await rig({ reply: () => ({ text: "z".repeat(FRAME_DATA_BYTES * 3) }) })
    const sealed = await sealedBody(booted, chat("long"))
    const { text } = await readReply((await send(booted, sealed.bytes)).res, sealed)
    expect(text.match(/"content":"z+"/g)!.join("").replaceAll(/[^z]/g, "").length).toBe(FRAME_DATA_BYTES * 3)
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
    const empty = await rig({ reply: () => ({ text: "" }) })
    const quiet = await sealedBody(empty, chat("nothing"))
    expect((await readReply((await send(empty, quiet.bytes)).res, quiet)).text).toContain("[DONE]")
  })

  test("the response on the wire holds no plaintext", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("x"))
    const { res } = await send(booted, sealed.bytes)
    expect(Buffer.from(await res.arrayBuffer()).includes("Served")).toBe(false)
  })

  test("a repeated enc is refused, even under a new router request", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("once"))
    expect((await send(booted, sealed.bytes)).res.status).toBe(200)
    const { res } = await send(booted, sealed.bytes)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("sealed_replayed_enc")
    expect(booted.engine.requests.length).toBe(1)
  })

  test("two copies racing each other serve once", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("race"))
    const replies = await Promise.all([send(booted, sealed.bytes), send(booted, sealed.bytes), send(booted, sealed.bytes)])
    expect(replies.map(({ res }) => res.status).sort()).toEqual([200, 409, 409])
  })

  test("garbage under someone's enc does not burn it", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("mine"))
    const garbled = sealed.bytes.slice()
    garbled[garbled.length - 1]! ^= 1
    expect(await errorCode((await send(booted, garbled)).res)).toBe("sealed_cannot_open")
    expect((await send(booted, sealed.bytes)).res.status).toBe(200)
  })

  test("the replay window is ±60 s", async () => {
    const booted = await rig()
    const now = booted.stack.clock() * 1000
    expect((await send(booted, (await sealedBody(booted, chat("late"), now - 60_000)).bytes)).res.status).toBe(200)
    expect((await send(booted, (await sealedBody(booted, chat("early"), now + 60_000)).bytes)).res.status).toBe(200)
    const late = (await send(booted, (await sealedBody(booted, chat("too late"), now - 60_001)).bytes)).res
    const early = (await send(booted, (await sealedBody(booted, chat("too early"), now + 60_001)).bytes)).res
    expect([late.status, early.status]).toEqual([400, 400])
    expect(await errorCode(late)).toBe("sealed_bad_time")
    expect(booted.engine.requests.length).toBe(2)
  })

  test("the replay book forgets only what the window already refuses, and fills closed", () => {
    const guard = new ReplayGuard()
    const FULL = 200_000
    expect(guard.take("a", 1_000n, 1_000)).toBe(true)
    expect(guard.take("a", 1_000n, 1_000)).toBe(false)
    for (let at = 1; at < FULL; at++) guard.take(`e${at}`, 1_000n, 1_000)
    expect(guard.take("one too many", 1_000n, 1_000)).toBe(false)
    expect(guard.has("a")).toBe(true)
    // Past the window these can never open again, so they may go.
    expect(guard.take("later", 500_000n, 500_000)).toBe(true)
    expect(guard.has("a")).toBe(false)
  })

  test("only the router can send", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("anyone"))
    expect((await send(booted, sealed.bytes, { header: null })).res.status).toBe(401)
    expect((await send(booted, sealed.bytes, { signer: host })).res.status).toBe(401)
    expect(booted.engine.requests.length).toBe(0)
  })

  test("the router's signature covers the ciphertext and both clear limits", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("limits"))
    expect((await send(booted, sealed.bytes, { maxTokens: 4096, signedMaxTokens: 8 })).res.status).toBe(401)
    expect((await send(booted, sealed.bytes, { model: "ofm-70b", signedModel: MODEL })).res.status).toBe(401)
    expect((await send(booted, sealed.bytes, { signedBytes: new Uint8Array(9) })).res.status).toBe(401)
  })

  test("the body cannot ask for more tokens than the clear header paid for", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("big ask", { max_tokens: 4096 }))
    const { res } = await send(booted, sealed.bytes, { maxTokens: 16 })
    await readReply(res, sealed)
    expect(booted.engine.requests[0]!.body.max_tokens).toBe(16)
  })

  test("max_completion_tokens is held to the same limit, and a body with none takes it", async () => {
    const booted = await rig()
    const first = await sealedBody(booted, chat("alias", { max_tokens: undefined, max_completion_tokens: 4096 }))
    await readReply((await send(booted, first.bytes, { maxTokens: 12 })).res, first)
    expect(booted.engine.requests[0]!.body.max_tokens).toBe(12)
    const second = await sealedBody(booted, chat("none", { max_tokens: undefined }))
    await readReply((await send(booted, second.bytes, { maxTokens: 7 })).res, second)
    expect(booted.engine.requests[1]!.body.max_tokens).toBe(7)
  })

  test("a smaller ask inside stands", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("small", { max_tokens: 5 }))
    await readReply((await send(booted, sealed.bytes, { maxTokens: 64 })).res, sealed)
    expect(booted.engine.requests[0]!.body.max_tokens).toBe(5)
  })

  test("the body must name the model the clear header priced", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("x", { model: "ofm-70b" }))
    const { res } = await send(booted, sealed.bytes)
    expect(await errorCode(res)).toBe("sealed_model_mismatch")
    expect(booted.engine.requests.length).toBe(0)
  })

  test("bad bodies are refused without reaching vLLM", async () => {
    const booted = await rig()
    const raw = await sealRequest(await publicKeyFrom(hexToBytes(booted.sealed.identity.publicKey)), new TextEncoder().encode("not json"), SEALED_PATH, booted.stack.clock() * 1000)
    expect(await errorCode((await send(booted, raw.bytes)).res)).toBe("bad_request")
    expect(await errorCode((await send(booted, (await sealedBody(booted, { model: MODEL })).bytes)).res)).toBe("bad_request")
    expect(await errorCode((await send(booted, (await sealedBody(booted, chat("x", { max_tokens: -1 }))).bytes)).res)).toBe("bad_max_tokens")
    expect((await send(booted, new Uint8Array(5))).res.status).toBe(400)
    expect(booted.engine.requests.length).toBe(0)
  })

  test("missing or impossible clear limits are refused", async () => {
    const booted = await rig()
    const sealed = await sealedBody(booted, chat("x"))
    expect((await send(booted, sealed.bytes, { maxTokens: 0 })).res.status).toBe(400)
    expect((await send(booted, sealed.bytes, { maxTokens: 5000 })).res.status).toBe(400)
  })

  test("a request for a key this boot does not hold cannot open", async () => {
    const booted = await rig()
    const other = await booted.restartHost()
    const sealed = await sealedBody(booted, chat("old key"), undefined, booted.sealed.identity.publicKey)
    expect(other.identity.publicKey).not.toBe(booted.sealed.identity.publicKey)
    expect(await errorCode((await send(booted, sealed.bytes)).res)).toBe("sealed_cannot_open")
  })

  const deep = (depth: number) => JSON.parse(`${"[".repeat(depth)}1${"]".repeat(depth)}`) as unknown

  test("tools nested past the limit are refused before the engine runs", async () => {
    const booted = await rig()
    const { res } = await send(booted, (await sealedBody(booted, chat("deep", { tools: [{ type: "function", deep: deep(12_000) }] }))).bytes)
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe("bad_request")
    expect(booted.engine.requests.length).toBe(0)
  })

  test("the depth check needs no stack, and real tool schemas pass it", () => {
    let nested: unknown = 1
    for (let depth = 0; depth < 1_000_000; depth += 1) nested = [nested]
    expect(withinDepth(nested)).toBe(false)
    expect(withinDepth(deep(62))).toBe(true)
    expect(withinDepth({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } })).toBe(true)
  })

  test("a body the tokenizer cannot count never reaches the engine, so no output goes unbilled", async () => {
    const tokenizer = {
      ...byteTokenizer,
      countChat: () => {
        throw new RangeError("too deep")
      },
    }
    const booted = await rig({ tokenizer })
    const { res } = await send(booted, (await sealedBody(booted, chat("cannot count"))).bytes)
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe("uncountable")
    expect(booted.engine.requests.length).toBe(0)
    expect(countInput(tokenizer, { messages: [] })).toBeNull()
  })

  test("a count the ciphertext could not hold is refused before the engine runs", async () => {
    const booted = await rig({ tokenizer: { ...byteTokenizer, countChat: () => 1_000_000 } })
    const { res } = await send(booted, (await sealedBody(booted, chat("too many"))).bytes)
    expect(await errorCode(res)).toBe("uncountable")
    expect(booted.engine.requests.length).toBe(0)
  })

  test("the input is counted once, up front", async () => {
    let calls = 0
    const booted = await rig({ tokenizer: { ...byteTokenizer, countChat: (body) => ((calls += 1), byteTokenizer.countChat(body)) } })
    const sealed = await sealedBody(booted, chat("once"))
    await readReply((await send(booted, sealed.bytes)).res, sealed)
    expect(calls).toBe(1)
  })

  test("vLLM's error text never leaves the VM", async () => {
    const booted = await rig({ failWith: 400 })
    const { res } = await send(booted, (await sealedBody(booted, chat("rejected prompt"))).bytes)
    expect(res.status).toBe(502)
    const body = await res.text()
    expect(body).not.toContain("engine failed")
    expect(body).toContain("engine_refused")
  })

  test("/offpeak/v1/info says sealed", async () => {
    const info = (await (await agentOf(await rig()).request("/offpeak/v1/info")).json()) as { sealed: boolean }
    expect(info.sealed).toBe(true)
  })
})

describe("sealed counts and signing", () => {
  /** A record for what was served, as the router would build it from the VM's counts. */
  async function recordFor(booted: Rig, reqId: Hex, promptHash: Hex, outputHash: Hex, reported: { tokensIn: number; tokensOut: number }) {
    const { stack } = booted
    const sheet = stack.sheets[0]!
    const price = livePrice(sheet, hourOfWeek(stack.clock()), loadFactorBps(0))
    const record: UsageRecord = {
      reqId,
      buyerRef: buyerRefOf(booted.buyer, reqId),
      host: booted.host as Hex,
      modelDigest: booted.modelDigest,
      ...reported,
      promptHash,
      outputHash,
      priceIn: price.in,
      priceOut: price.out,
      hostCostMicro: hostCostMicro(reported.tokensIn, reported.tokensOut, price.in, price.out),
      feeMicro: 1n,
      payMode: 0,
      payRef: ZERO_BYTES32 as Hex,
      ts: stack.clock(),
      sheetHash: sheet.sheetHash,
    }
    return record
  }

  async function sign(booted: Rig, record: UsageRecord, partial?: boolean) {
    const routerSig = await signTyped(booted.stack.router, { domain: domain("OffpeakUsage", booted.stack.usageLedger), types: usageTypes, primaryType: "UsageRecord", message: recordToMessage(record) as never })
    const res = await agentOf(booted).request("/offpeak/v1/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record: serializeRecord(record), routerSig, partial }) })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }

  async function served(booted: Rig) {
    const sealed = await sealedBody(booted, chat("count me"))
    const promptHash = keccak256(sealed.bytes)
    const { res, reqId } = await send(booted, sealed.bytes)
    const { outputHash } = await readReply(res, sealed)
    return { reqId, promptHash, outputHash }
  }

  test("the VM's counts come back with hashes over ciphertext, not plaintext", async () => {
    const booted = await rig()
    const { reqId, promptHash, outputHash } = await served(booted)
    const res = await counts(booted, reqId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokensIn: number; tokensOut: number; promptHash: string; outputHash: string }
    expect(body.tokensIn).toBeGreaterThan(0)
    expect(body.tokensOut).toBeGreaterThan(0)
    expect(body).toMatchObject({ promptHash, outputHash })
  })

  test("the counts carry the VM's signature, under the key its bindings name", async () => {
    const booted = await rig()
    const { reqId } = await served(booted)
    const signed = sealedCountsSchema.parse(await (await counts(booted, reqId)).json())
    expect(signed.reqId).toBe(reqId)
    expect(await countsSignedBy(signed, booted.sealed.bootBindings.countsSigner)).toBe(true)
    expect(await countsSignedBy({ ...signed, tokensOut: signed.tokensOut + 1 }, booted.sealed.bootBindings.countsSigner)).toBe(false)
    expect(await countsSignedBy(signed, host.address)).toBe(false)
  })

  test("counts are for the router only, and only for a sealed request", async () => {
    const booted = await rig()
    const { reqId } = await served(booted)
    expect((await counts(booted, reqId, host)).status).toBe(401)
    expect((await agentOf(booted).request(`${SEALED_COUNTS_ROUTE}/${reqId}`)).status).toBe(401)
    expect((await counts(booted, newReq())).status).toBe(404)
  })

  test("a record with the right hashes is signed", async () => {
    const booted = await rig()
    const { reqId, promptHash, outputHash } = await served(booted)
    const reported = (await (await counts(booted, reqId)).json()) as { tokensIn: number; tokensOut: number }
    const { status, body } = await sign(booted, await recordFor(booted, reqId, promptHash, outputHash, { tokensIn: reported.tokensIn, tokensOut: reported.tokensOut }))
    expect(status).toBe(200)
    expect(body.hostSig).toMatch(/^0x/)
  })

  test("a record whose hashes are not over these ciphertext bytes is refused", async () => {
    const booted = await rig()
    const { reqId, promptHash, outputHash } = await served(booted)
    const reported = (await (await counts(booted, reqId)).json()) as { tokensIn: number; tokensOut: number }
    const shape = { tokensIn: reported.tokensIn, tokensOut: reported.tokensOut }
    const wrong = `0x${"12".repeat(32)}` as Hex
    expect((await sign(booted, await recordFor(booted, reqId, wrong, outputHash, shape))).body.reason).toBe("sealed_prompt_hash")
    expect((await sign(booted, await recordFor(booted, reqId, promptHash, wrong, shape))).body.reason).toBe("sealed_output_hash")
  })

  test("a cut stream may differ on output, since the router saw less, but never on the prompt", async () => {
    const booted = await rig()
    const { reqId, promptHash } = await served(booted)
    const reported = (await (await counts(booted, reqId)).json()) as { tokensIn: number; tokensOut: number }
    const wrong = `0x${"12".repeat(32)}` as Hex
    const shape = { tokensIn: reported.tokensIn, tokensOut: reported.tokensOut }
    expect((await sign(booted, await recordFor(booted, reqId, wrong, wrong, shape), true)).body.reason).toBe("sealed_prompt_hash")
    expect((await sign(booted, await recordFor(booted, reqId, promptHash, wrong, shape), true)).status).toBe(200)
  })

  test("counts outside tolerance are refused here as for any request", async () => {
    const booted = await rig()
    const { reqId, promptHash, outputHash } = await served(booted)
    expect((await sign(booted, await recordFor(booted, reqId, promptHash, outputHash, { tokensIn: 9_999, tokensOut: 9_999 }))).body.reason).toBe("counts")
  })

  test("the signed log keeps ciphertext hashes, and nothing derived from plaintext", async () => {
    const booted = await rig()
    const { reqId, promptHash, outputHash } = await served(booted)
    const reported = (await (await counts(booted, reqId)).json()) as { tokensIn: number; tokensOut: number }
    await sign(booted, await recordFor(booted, reqId, promptHash, outputHash, { tokensIn: reported.tokensIn, tokensOut: reported.tokensOut }))
    const folder = (booted.log as unknown as { dir: string }).dir
    const logged = readdirSync(folder).map((name) => readFileSync(join(folder, name), "utf8")).join("")
    expect((JSON.parse(logged.trim().split("\n").at(-1)!) as { hostOutputHash: string }).hostOutputHash).toBe(outputHash)
    expect(logged).not.toContain(outputHashOf("Served in the sealed VM.", []))
    expect(logged).not.toContain("count me")
    expect(logged).not.toContain("Served in the sealed VM.")
  })
})
