import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostRegistryAbi, usageLedgerAbi } from "@offpeak/abis"
import { CHAIN_ID, HOST_STATUS, gpuClassOf, manifestDigest, type Hex } from "@offpeak/shared"
import { decodeFunctionData, encodeFunctionResult } from "viem"
import { hostChain, readDeployment, type HostChain, type Registration } from "../src/chain.ts"
import { bootAgent, imageDigestFor } from "../src/main.ts"
import { freePort, serveOnFreePort } from "./support/fake-vllm.ts"
import { DIGEST, HOST_KEY, IMAGE, LEDGER, REGISTRY, SMI, fixtureManifest, host, hostFolder, router } from "./support/harness.ts"

const dirs: string[] = []

function setup() {
  const folder = hostFolder()
  dirs.push(folder.root)
  const registration: Registration = {
    status: HOST_STATUS.Probation,
    imageDigest: imageDigestFor({ image: IMAGE }),
    gpuClass: gpuClassOf("h100-80g-sxm"),
    models: [folder.digest],
    bondUsdg: 2_000_000_000n,
    bondOfpk: 0n,
    releasableCredits: 0n,
    pendingCredits: 0n,
  }
  return { ...folder, registration }
}

const chainWith = (registration: Registration, over: Partial<HostChain> = {}): HostChain => ({
  chainId: async () => CHAIN_ID,
  routerSigner: async () => router.address,
  registration: async () => registration,
  bondTokens: async () => ({ usdg: `0x${"aa".repeat(20)}`, ofpk: `0x${"bb".repeat(20)}` }),
  ...over,
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("booting on real checks", () => {
  test("a host that matches everything boots and answers", async () => {
    const { configPath, env, registration, digest } = setup()
    const { app } = await bootAgent({ configPath, env, chain: chainWith(registration), gpu: async () => SMI })
    const info = (await (await app.request("/offpeak/v1/info")).json()) as { modelDigests: string[]; imageDigest: string }
    expect(info.modelDigests).toEqual([digest])
    expect(info.imageDigest).toBe(imageDigestFor({ image: IMAGE }))
  })

  test("a registration for the fixture digest is the digest in the manifest", () => {
    expect(DIGEST).toBe(manifestDigest(fixtureManifest))
  })

  test("the wrong GPU refuses", async () => {
    const { configPath, env, registration } = setup()
    const gpu = async () => SMI.replace("H100 80GB HBM3", "H100 PCIe")
    await expect(bootAgent({ configPath, env, chain: chainWith(registration), gpu })).rejects.toThrow("gpu class mismatch")
  })

  test("a card the registration does not name refuses", async () => {
    const { configPath, env, registration } = setup()
    await expect(bootAgent({ configPath, env, chain: chainWith({ ...registration, gpuClass: gpuClassOf("h200-141g") }), gpu: async () => SMI })).rejects.toThrow("differs from the registration")
  })

  test("a router other than UsageLedger.routerSigner refuses", async () => {
    const { configPath, env, registration } = setup()
    const chain = chainWith(registration, { routerSigner: async () => host.address })
    await expect(bootAgent({ configPath, env, chain, gpu: async () => SMI })).rejects.toThrow("routerSigner")
  })

  test("an rpc on another chain refuses", async () => {
    const { configPath, env, registration } = setup()
    await expect(bootAgent({ configPath, env, chain: chainWith(registration, { chainId: async () => 1 }), gpu: async () => SMI })).rejects.toThrow("wrong chain")
  })

  test("an unregistered operator refuses", async () => {
    const { configPath, env, registration } = setup()
    await expect(bootAgent({ configPath, env, chain: chainWith({ ...registration, status: HOST_STATUS.None }), gpu: async () => SMI })).rejects.toThrow("not registered")
  })

  test("an image other than the registered one refuses", async () => {
    const { configPath, env, registration } = setup()
    await expect(bootAgent({ configPath, env, chain: chainWith({ ...registration, imageDigest: `0x${"cd".repeat(32)}` }), gpu: async () => SMI })).rejects.toThrow("image differs")
  })

  test("a model the chain does not list refuses", async () => {
    const { configPath, env, registration } = setup()
    await expect(bootAgent({ configPath, env, chain: chainWith({ ...registration, models: [`0x${"cd".repeat(32)}`] }), gpu: async () => SMI })).rejects.toThrow("model digest mismatch")
  })

  test("weights that differ from the manifest refuse", async () => {
    const { configPath, env, registration, modelDir } = setup()
    appendFileSync(join(modelDir, "model.safetensors"), "!")
    await expect(bootAgent({ configPath, env, chain: chainWith(registration), gpu: async () => SMI })).rejects.toThrow("differs from its manifest hash")
  })

  test("another role's key refuses before anything else runs", async () => {
    const { configPath, env, registration } = setup()
    await expect(bootAgent({ configPath, env: { ...env, OFFPEAK_ROUTER_SIGNER_KEY: `0x${"11".repeat(32)}` }, chain: chainWith(registration), gpu: async () => SMI })).rejects.toThrow("another role key")
  })

  test("a deployment file with no addresses refuses", () => {
    const { root } = setup()
    const path = join(root, "empty.json")
    writeFileSync(path, JSON.stringify({ contracts: { HostRegistry: `0x${"00".repeat(20)}`, UsageLedger: `0x${"00".repeat(20)}` } }))
    expect(() => readDeployment(path)).toThrow("no contract addresses")
  })
})

test("--mock-engine serves the fake model, and only locally", async () => {
  const root = new URL("../../../", import.meta.url).pathname
  const port = freePort()
  const start = (env: Record<string, string>) => Bun.spawn(["bun", "run", "apps/host-agent/src/main.ts", "--mock-engine", "--port", String(port)], { cwd: root, env: { ...process.env, OFFPEAK_HOST_OPERATOR_KEY: HOST_KEY, OFFPEAK_ROUTER_ADDRESS: router.address, ...env }, stdout: "ignore", stderr: "ignore" })
  const running = start({ OFFPEAK_ENV: "local" })
  try {
    let info: Response | null = null
    for (let i = 0; i < 200 && !info; i++) {
      info = await fetch(`http://127.0.0.1:${port}/offpeak/v1/info`).catch(() => null)
      if (!info) await Bun.sleep(25)
    }
    expect(((await info!.json()) as { gpuClass: string }).gpuClass).toBe("cpu-tdx-dev")
  } finally {
    running.kill()
    await running.exited
  }
  expect(await start({ OFFPEAK_ENV: "mainnet" }).exited).not.toBe(0)
}, 30_000)

describe("reading the chain over JSON-RPC", () => {
  test("routerSigner, hostView and modelsOf decode through the real ABIs", async () => {
    const model = `0x${"77".repeat(32)}` as Hex
    const view = {
      operator: host.address,
      status: 1,
      bondUsdg: 2_000_000_000n,
      bondOfpk: 5n,
      requiredBond: 2_000_000_000n,
      imageDigest: `0x${"12".repeat(32)}`,
      gpuClass: gpuClassOf("l40s-48g"),
      attestationRef: `0x${"00".repeat(32)}`,
      probationEnds: 9n,
      strikes: 0,
      openChallenges: 0,
      releasableCredits: 11n,
      pendingCredits: 22n,
    } as const
    const answer = (to: string, data: Hex): Hex => {
      if (to.toLowerCase() === LEDGER.toLowerCase()) return encodeFunctionResult({ abi: usageLedgerAbi, functionName: "routerSigner", result: router.address })
      const call = decodeFunctionData({ abi: hostRegistryAbi, data })
      if (call.functionName === "hostView") return encodeFunctionResult({ abi: hostRegistryAbi, functionName: "hostView", result: view })
      if (call.functionName === "modelsOf") return encodeFunctionResult({ abi: hostRegistryAbi, functionName: "modelsOf", result: [model] })
      throw new Error(`unexpected call ${call.functionName}`)
    }
    const { server, port } = serveOnFreePort((free) =>
      Bun.serve({
        port: free,
        hostname: "127.0.0.1",
        async fetch(req) {
          const rpc = (await req.json()) as { id: number; method: string; params: [{ to: string; data: Hex }] }
          if (rpc.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: "0x1237" })
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: answer(rpc.params[0].to, rpc.params[0].data) })
        },
      }),
    )
    const chain = hostChain(`http://127.0.0.1:${port}`, { HostRegistry: REGISTRY as Hex, UsageLedger: LEDGER as Hex })
    expect(await chain.chainId()).toBe(CHAIN_ID)
    expect((await chain.routerSigner()).toLowerCase()).toBe(router.address.toLowerCase())
    const registration = await chain.registration(host.address)
    expect(registration.models).toEqual([model])
    expect(registration.gpuClass).toBe(gpuClassOf("l40s-48g"))
    expect(registration.releasableCredits).toBe(11n)
    server.stop(true)
  })
})
