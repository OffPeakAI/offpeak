import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostRegistryAbi } from "@offpeak/abis"
import { HOST_MIN_BOND, HOST_STATUS, gpuClassOf } from "@offpeak/shared"
import { createPublicClient, http } from "viem"
import { startLocalChain, type LocalChain } from "../../../tests/integration/local-chain.ts"
import { readDeployment, hostChain } from "../src/chain.ts"
import { run } from "../src/cli.ts"
import { bootAgent, imageDigestFor } from "../src/main.ts"
import { freePort } from "./support/fake-vllm.ts"
import { IMAGE, SMI, host, hostFolder, router } from "./support/harness.ts"

const haveFoundry = Boolean(Bun.which("anvil")) || existsSync(`${process.env.HOME}/.foundry/bin/anvil`)

/** The operator's commands and the boot checks against the deployed contracts, not a stand-in. */
describe.skipIf(!haveFoundry)("against the deployed contracts", () => {
  let chain: LocalChain
  let folder: ReturnType<typeof hostFolder>
  let port: number

  beforeAll(async () => {
    chain = await startLocalChain(freePort())
    port = freePort()
    folder = hostFolder({ deployment: chain.contracts as never, topLines: ["listen:", "  host: 127.0.0.1", `  port: ${port}`] })
  }, 240_000)

  afterAll(() => {
    chain?.stop()
    if (folder) rmSync(folder.root, { recursive: true, force: true })
  })

  const deps = () => {
    const lines: string[] = []
    return { lines, deps: { env: { ...folder.env, OFFPEAK_RPC_URL: chain.rpcUrl }, print: (line: string) => lines.push(line) } }
  }

  test("register --send puts the host in probation with the bond pulled", async () => {
    const { deps: cli } = deps()
    await run(["register", "--send"], cli)
    const client = createPublicClient({ transport: http(chain.rpcUrl) })
    const view = await client.readContract({ address: chain.contracts.HostRegistry!, abi: hostRegistryAbi, functionName: "hostView", args: [host.address] })
    expect(view.status).toBe(HOST_STATUS.Probation)
    expect(view.bondUsdg).toBe(HOST_MIN_BOND)
    expect(view.imageDigest).toBe(imageDigestFor({ image: IMAGE }))
    expect(view.gpuClass).toBe(gpuClassOf("h100-80g-sxm"))
  }, 60_000)

  test("the agent boots on what the chain now says", async () => {
    const { app } = await bootAgent({ configPath: folder.configPath, env: { ...folder.env, OFFPEAK_RPC_URL: chain.rpcUrl }, gpu: async () => SMI })
    expect(((await (await app.request("/offpeak/v1/info")).json()) as { modelDigests: string[] }).modelDigests).toEqual([folder.digest])
  }, 60_000)

  /** The real process, with an `nvidia-smi` on its path that prints what this machine cannot. */
  const startAgent = (smiLine: string) => {
    const bin = mkdtempSync(join(tmpdir(), "offpeak-bin-"))
    writeFileSync(join(bin, "nvidia-smi"), `#!/bin/sh\necho "name, memory.total [MiB], uuid"\necho "${smiLine}"\n`)
    chmodSync(join(bin, "nvidia-smi"), 0o755)
    const process_ = Bun.spawn(["bun", "run", "apps/host-agent/src/main.ts"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: { ...process.env, ...folder.env, OFFPEAK_RPC_URL: chain.rpcUrl, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { process_, bin }
  }

  test("the agent process opens its port on a matching machine", async () => {
    const { process_, bin } = startAgent("NVIDIA H100 80GB HBM3, 81559 MiB, GPU-00000000-aaaa-bbbb-cccc-1234567890ab")
    try {
      let info: Response | null = null
      for (let i = 0; i < 200 && !info; i++) {
        info = await fetch(`http://127.0.0.1:${port}/offpeak/v1/info`).catch(() => null)
        if (!info) await Bun.sleep(25)
      }
      expect(info?.status).toBe(200)
      // No vLLM runs here, so the host says it is not ready rather than taking traffic.
      expect(((await (await fetch(`http://127.0.0.1:${port}/offpeak/v1/health`)).json()) as { ok: boolean }).ok).toBe(false)
    } finally {
      process_.kill()
      await process_.exited
      rmSync(bin, { recursive: true, force: true })
    }
  }, 30_000)

  test("the agent process refuses to start on the wrong card", async () => {
    const { process_, bin } = startAgent("NVIDIA L40S, 46068 MiB, GPU-00000000-aaaa-bbbb-cccc-1234567890ab")
    expect(await process_.exited).not.toBe(0)
    expect(await new Response(process_.stderr).text()).toContain("gpu class mismatch")
    expect(await fetch(`http://127.0.0.1:${port}/offpeak/v1/info`).catch(() => null)).toBeNull()
    rmSync(bin, { recursive: true, force: true })
  }, 30_000)

  test("the router in the config is UsageLedger.routerSigner", async () => {
    const reader = hostChain(chain.rpcUrl, readDeployment(folder.env.OFFPEAK_DEPLOYMENT_FILE))
    expect((await reader.routerSigner()).toLowerCase()).toBe(router.address.toLowerCase())
  })

  test("credits reads the registry, and withdraw lands with nothing to withdraw", async () => {
    const { deps: cli, lines } = deps()
    await run(["credits"], cli)
    expect(lines).toEqual(["releasable 0 µUSDG", "pending 0 µUSDG"])
    await run(["credits", "withdraw", "--send"], cli)
    expect(lines.at(-1)).toMatch(/^sent 0x/)
  }, 60_000)

  test("exit --send starts the unbonding", async () => {
    const { deps: cli } = deps()
    await run(["exit", "--send"], cli)
    const reader = hostChain(chain.rpcUrl, readDeployment(folder.env.OFFPEAK_DEPLOYMENT_FILE))
    expect((await reader.registration(host.address)).status).toBe(HOST_STATUS.Exiting)
  }, 60_000)
})
