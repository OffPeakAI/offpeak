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
