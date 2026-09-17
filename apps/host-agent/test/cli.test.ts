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

  test("a container on another image fails", async () => {
    await expect(checkImage(IMAGE, async (args) => (args[0] === "image" ? "sha256:pinned" : "sha256:other"))).rejects.toThrow("not running the pinned image")
    const { deps } = setup()
    await expect(run(["verify"], { ...deps, docker: async () => Promise.reject(new Error("docker inspect failed")) })).rejects.toThrow("docker inspect failed")
  })

  test("--no-image skips only the image", async () => {
    const { deps, lines } = setup()
    await run(["verify", "--no-image"], { ...deps, docker: async () => Promise.reject(new Error("no docker here")) })
    expect(lines.at(-1)).toBe("image not checked")
  })
})

describe("offpeak-host register", () => {
  const decodeRegister = (data: Hex) => decodeFunctionData({ abi: hostRegistryAbi, data }).args![0] as Record<string, unknown>

  test("prints the calls and sends nothing by default", async () => {
    const { deps, lines, sent, posts, digest } = setup()
    await run(["register"], deps)
    expect(sent).toHaveLength(0)
    expect(posts).toHaveLength(0)
    const [approve, register] = lines.slice(0, 2).map((line) => JSON.parse(line))
    expect(approve.to).toBe(USDG)
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([REGISTRY, HOST_MIN_BOND])
    expect(register.to).toBe(REGISTRY)
    const params = decodeRegister(register.data)
    expect(params.modelDigests).toEqual([digest])
    expect(params.maxTps).toEqual([400])
    expect(params.imageDigest).toBe(imageDigestFor({ image: IMAGE }))
    expect(params.gpuClass).toBe(gpuClassOf("h100-80g-sxm"))
    expect(params.endpointHash).toBe(keccak256(toBytes("https://host.example.net")))
    expect(params.bondUsdg).toBe(HOST_MIN_BOND)
    expect(params.bondOfpk).toBe(0n)
    expect(lines.at(-1)).toContain("nothing sent")
  })

  test("--send approves, registers, then tells the router the endpoint", async () => {
    const { deps, sent, posts } = setup()
    await run(["register", "--send", "--bond-usdg", "3000000000", "--bond-ofpk", "7"], deps)
    expect(sent.map((call) => call.to)).toEqual([USDG, OFPK, REGISTRY])
    expect(decodeRegister(sent[2]!.data).bondUsdg).toBe(3_000_000_000n)
    expect(decodeRegister(sent[2]!.data).bondOfpk).toBe(7n)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`${BASE_URL}/v1/hosts/register`)
    const { operator, endpoint, sig } = posts[0]!.body
    expect((await recoverPersonal(canonicalJson({ endpoint, operator }), sig)).toLowerCase()).toBe(host.address.toLowerCase())
  })

  test("the router's own calldata for this host matches", async () => {
    const { registerCalldata } = await import("../../router/src/hosts-api/register.ts")
    const { deps, lines, digest } = setup()
    await run(["register"], deps)
    const mine = JSON.parse(lines[1]!).data
    const theirs = registerCalldata(REGISTRY as Hex, { operator: host.address, models: [{ digest, maxTps: 400 }], imageDigest: imageDigestFor({ image: IMAGE }), gpuClass: gpuClassOf("h100-80g-sxm"), endpoint: "https://host.example.net" })
    expect(mine).toBe(theirs.data)
  })

  test("a bad amount is refused", async () => {
    const { deps } = setup()
    await expect(run(["register", "--bond-usdg", "1.5"], deps)).rejects.toThrow("whole number")
  })
})

describe("offpeak-host price-sheet set", () => {
  test("signs, posts, then keeps the sheet for the agent", async () => {
    const { root, deps, posts, lines, digest } = setup()
    await run(["price-sheet", "set", "--file", sheetFile(root)], deps)
    expect(posts[0]!.url).toBe(`${BASE_URL}/v1/hosts/price-sheet`)
    const { sheet, sig } = posts[0]!.body
    expect(sheet.modelDigest).toBe(digest)
    expect(sheet.host).toBe(host.address.toLowerCase())
    const parsed = sheetFromJson(sheet)
    const signer = await recoverTypedDataAddress({ ...sheetTypedData(parsed, REGISTRY), signature: sig } as never)
    expect(signer.toLowerCase()).toBe(host.address.toLowerCase())
    const hash = sheetHashOf(parsed, REGISTRY)
    expect(readdirSync(join(root, "data/sheets"))).toEqual([`${hash}.json`])
    expect(lines.at(-1)).toBe(`sheet ${hash} in force from ${NOW + 7200}`)
  })

  test.each([
    ["a floor above 60% of the lowest base", { floorIn: 120_001 }, "floor_above_0_6_min_base"],
    ["a sheet starting too soon", { validFrom: NOW + 3599 }, "valid_from_too_soon"],
    ["a zero base", { baseOut: [...Array(167).fill(800_000), 0] }, "base_not_positive"],
  ])("%s never leaves the machine", async (_name, over, error) => {
    const { root, deps, posts } = setup()
    await expect(run(["price-sheet", "set", "--file", sheetFile(root, over)], deps)).rejects.toThrow(error)
    expect(posts).toHaveLength(0)
  })

  test("the floor rule is exact at 60%", async () => {
    const { root, deps, posts } = setup()
    await run(["price-sheet", "set", "--file", sheetFile(root, { floorIn: 120_000 })], deps)
    expect(posts).toHaveLength(1)
  })

  test("a short week and an unknown model are refused", async () => {
    const { root, deps } = setup()
    await expect(run(["price-sheet", "set", "--file", sheetFile(root, { baseIn: [1, 2] })], deps)).rejects.toThrow()
    await expect(run(["price-sheet", "set", "--file", sheetFile(root, { model: "other" })], deps)).rejects.toThrow("no model other")
  })

  test("a sheet the router refuses is not kept", async () => {
    const { root, deps } = setup()
    const refusing = (async () => Response.json({ ok: false, error: "nonce_not_increasing" })) as never
    await expect(run(["price-sheet", "set", "--file", sheetFile(root)], { ...deps, fetcher: refusing })).rejects.toThrow("nonce_not_increasing")
    expect(existsSync(join(root, "data/sheets")) ? readdirSync(join(root, "data/sheets")) : []).toEqual([])
  })
})

describe("offpeak-host credits and exit", () => {
  test("credits shows what the registry holds", async () => {
    const { deps, lines } = setup()
    await run(["credits"], deps)
    expect(lines).toEqual(["releasable 1500 µUSDG", "pending 250 µUSDG"])
  })

  test("withdraw and exit print first and send only on request", async () => {
    const { deps, sent, lines } = setup()
    await run(["credits", "withdraw"], deps)
    await run(["exit"], deps)
    expect(sent).toHaveLength(0)
    expect(lines.some((line) => line.includes("7-day"))).toBe(true)
    await run(["credits", "withdraw", "--send"], deps)
    await run(["exit", "--send"], deps)
    await run(["exit", "--finalize", "--send"], deps)
    expect(sent.map((call) => decodeFunctionData({ abi: hostRegistryAbi, data: call.data }).functionName)).toEqual(["withdrawCredits", "exit", "finalizeExit"])
    expect(sent.every((call) => call.to === REGISTRY)).toBe(true)
  })
})

test("no command prints the usage", async () => {
  const lines: string[] = []
  await run([], { env: {}, print: (line) => lines.push(line) })
  expect(lines[0]).toContain("usage: offpeak-host")
})
