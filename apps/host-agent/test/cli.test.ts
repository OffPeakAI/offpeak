import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostRegistryAbi } from "@offpeak/abis"
import { CHAIN_ID, HOST_MIN_BOND, HOST_STATUS, canonicalJson, gpuClassOf, manifestDigest, recoverPersonal, type Hex } from "@offpeak/shared"
import { decodeFunctionData, erc20Abi, keccak256, recoverTypedDataAddress, toBytes } from "viem"
import { checkImage, run, vllmCommand, type CliDeps } from "../src/cli.ts"
import { imageDigestFor } from "../src/main.ts"
import { sheetFromJson, sheetHashOf, sheetTypedData } from "../src/sheets.ts"
import { IMAGE, MODEL, NOW, REGISTRY, SMI, fixtureManifest, host, hostFolder, router } from "./support/harness.ts"

const USDG = `0x${"aa".repeat(20)}` as Hex
const OFPK = `0x${"bb".repeat(20)}` as Hex
const BASE_URL = "http://router.test"

const dirs: string[] = []

function setup() {
  const folder = hostFolder({ modelLines: ['    vllmArgs: ["--max-model-len=8192", "--dtype=auto"]'] })
  dirs.push(folder.root)
  const { root, modelDir, digest } = folder
  const lines: string[] = []
  const sent: { to: Hex; data: Hex }[] = []
  const posts: { url: string; body: any }[] = []
  const deps: CliDeps = {
    env: { ...folder.env, OFFPEAK_PUBLIC_BASE_URL: BASE_URL },
    print: (line) => lines.push(line),
    gpu: async () => SMI,
    clock: () => NOW,
    chain: {
      chainId: async () => CHAIN_ID,
      routerSigner: async () => router.address,
      registration: async () => ({ status: HOST_STATUS.Active, imageDigest: imageDigestFor({ image: IMAGE }), gpuClass: gpuClassOf("h100-80g-sxm"), models: [digest], bondUsdg: HOST_MIN_BOND, bondOfpk: 0n, releasableCredits: 1_500n, pendingCredits: 250n }),
      bondTokens: async () => ({ usdg: USDG, ofpk: OFPK }),
    },
    send: async (calls) => {
      sent.push(...calls)
      return calls.map((_, index) => `0x${String(index).padStart(64, "0")}` as Hex)
    },
    fetcher: (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ ok: true, sheetHash: `0x${"11".repeat(32)}` })
    }) as never,
    docker: async (args) => (args[0] === "image" ? "sha256:pinned" : "sha256:pinned"),
  }
  return { root, modelDir, lines, sent, posts, deps, digest }
}

const sheetFile = (root: string, over: Record<string, unknown> = {}) => {
  const path = join(root, "sheet.json")
  writeFileSync(path, JSON.stringify({ model: MODEL, baseIn: Array(168).fill(200_000), baseOut: Array(168).fill("800000"), floorIn: 100_000, floorOut: "400000", validFrom: NOW + 7200, nonce: 2, ...over }))
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("offpeak-host attestation", () => {
  const REF = `0x${"ab".repeat(32)}` as Hex

  test("registers the running agent's ref with what host.yaml serves, and sends only when asked", async () => {
    const { deps, lines, sent, digest } = setup()
    const asked: string[] = []
    const fetcher = (async (url: string) => {
      asked.push(url)
      return Response.json({ attestationRef: REF, hpkePublicKey: REF })
    }) as never
    await run(["attestation"], { ...deps, fetcher })
    expect(asked[0]).toContain("/offpeak/v1/attest")
    expect(sent).toEqual([])
    expect(lines).toContain(`attestationRef ${REF}`)
    await run(["attestation", "--send"], { ...deps, fetcher })
    const call = decodeFunctionData({ abi: hostRegistryAbi, data: sent[0]!.data })
    expect(call.functionName).toBe("updateServing")
    expect(call.args).toEqual([[digest], [400], imageDigestFor({ image: IMAGE }), gpuClassOf("h100-80g-sxm"), REF] as never)
  })

  test("an agent with no sealed section stops the command", async () => {
    const { deps } = setup()
    await expect(run(["attestation"], { ...deps, fetcher: (async () => new Response("no", { status: 404 })) as never })).rejects.toThrow("no attestationRef")
  })
})

describe("offpeak-host init", () => {
  test("makes the data folders and writes the vLLM arguments", async () => {
    const { root, deps, lines, digest } = setup()
    await run(["init"], deps)
    expect(existsSync(join(root, "data/sheets"))).toBe(true)
    expect(existsSync(join(root, "data/signed"))).toBe(true)
    const envFile = join(root, `data/vllm-${MODEL}.env`)
    expect(readFileSync(envFile, "utf8")).toBe(`VLLM_ARGS=--served-model-name=${MODEL} --enable-auto-tool-choice --tool-call-parser=hermes --max-model-len=8192 --dtype=auto\n`)
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
    expect(lines).toContain(`${MODEL} ${digest}`)
  })

  test("a model with no tool parser gets no tool flags", () => {
    const model = { name: "m", vllmArgs: [], recipeManifest: { ...fixtureManifest, toolCallParser: undefined } }
    expect(vllmCommand(model as never)).toEqual(["--served-model-name=m"])
  })

  test("writes a manifest for a new model without any key", async () => {
    const { root, modelDir, lines } = setup()
    const out = join(root, "new/manifest.json")
    await run(["init", "--manifest", "--model-dir", modelDir, "--name", "demo", "--kind", "chat", "--out", out], { env: {}, print: (line) => lines.push(line) })
    const written = JSON.parse(readFileSync(out, "utf8"))
    expect(written.name).toBe("demo")
    expect(written.tokenizer.map((file: { path: string }) => file.path)).toEqual(["tokenizer.json"])
    expect(lines[0]).toBe(`demo ${manifestDigest(written)}`)
  })
})

describe("offpeak-host verify", () => {
  test("checks the GPU, every model and the running image", async () => {
    const { deps, lines, digest } = setup()
    await run(["verify"], deps)
    expect(lines).toEqual(["gpu h100-80g-sxm ok", `${MODEL} ${digest} ok`, `image ${imageDigestFor({ image: IMAGE })} ok`])
  })

  test("a changed file fails", async () => {
    const { deps, modelDir } = setup()
    writeFileSync(join(modelDir, "model.safetensors"), "other weights")
    await expect(run(["verify"], deps)).rejects.toThrow("differs from its manifest hash")
  })

  test("the wrong card fails", async () => {
    const { deps } = setup()
    await expect(run(["verify"], { ...deps, gpu: async () => SMI.replace("H100 80GB HBM3", "L40S").replace("81559", "46068") })).rejects.toThrow("gpu class mismatch")
  })
