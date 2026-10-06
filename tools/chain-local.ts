#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getAddress, keccak256, type Hex } from "viem"

const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
/** keccak256 of Ethereum mainnet's Permit2 runtime code, the bytes in permit2.bin. */
const PERMIT2_MAINNET_CODEHASH = "0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131"
const CONTRACT_ORDER = [
  "MockUSDG",
  "MockOFPK",
  "MockSwapAdapter",
  "OffpeakVault",
  "HostRegistry",
  "UsageLedger",
  "X402Escrow",
  "ChannelManager",
  "WindowMarket",
  "AuditCourt",
  "OfpkHooks",
  "FeeSplitter",
  "Permit2",
] as const

const root = new URL("..", import.meta.url).pathname
const deploymentFile = join(root, "packages/abis/deployments/local.json")
const exitAfterDeploy = process.argv.includes("--exit")
const portFlag = process.argv.indexOf("--port")
const port = portFlag > -1 ? Number(process.argv[portFlag + 1]) : 8545
const timestampFlag = process.argv.indexOf("--timestamp")
const startTime = timestampFlag > -1 ? ["--timestamp", process.argv[timestampFlag + 1]!] : []
const rpcUrl = `http://127.0.0.1:${port}`

function foundryBin(name: string): string {
  return Bun.which(name) ?? `${process.env.HOME}/.foundry/bin/${name}`
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

async function waitForChain(anvil: Bun.Subprocess) {
  for (let i = 0; i < 100; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited early; is port ${port} already in use?`)
    try {
      await rpc("eth_chainId", [])
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error("anvil did not start")
}

async function etchPermit2() {
  const code = readFileSync(join(root, "contracts/test/fixtures/permit2.bin"), "utf8").trim() as Hex
  if (keccak256(code) !== PERMIT2_MAINNET_CODEHASH) throw new Error("permit2.bin does not match the pinned code hash")
  await rpc("anvil_setCode", [PERMIT2, code])
}

function deploy() {
  const script = Bun.spawnSync(
    [
      foundryBin("forge"),
      "script",
      "script/DeployLocal.s.sol:DeployLocal",
      "--rpc-url",
      rpcUrl,
      "--broadcast",
      "--unlocked",
      "--sender",
      DEPLOYER,
    ],
    { cwd: join(root, "contracts"), stdout: "pipe", stderr: "pipe" },
  )
  if (script.exitCode !== 0) {
    throw new Error(`forge script failed:\n${script.stdout.toString()}\n${script.stderr.toString()}`)
  }
}

function writeDeployment() {
  const written = JSON.parse(readFileSync(deploymentFile, "utf8"))
  const contracts = Object.fromEntries(CONTRACT_ORDER.map((name) => [name, getAddress(written.contracts[name])]))
  const deployment = {
    chainId: written.chainId,
    name: "local",
    deployed: true,
    note: "Written by bun run chain:local. X402Escrow, ChannelManager, WindowMarket, AuditCourt and OfpkHooks are stubs with final ABIs and events.",
    contracts,
    roles: written.roles,
  }
  writeFileSync(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`)
  return contracts
}

/** A chain left on the port would take the deploy at a later nonce and write wrong addresses into local.json. */
async function assertPortFree() {
  const answering = await rpc("eth_chainId", []).then(
    () => true,
    () => false,
  )
  if (answering) throw new Error(`something already answers on ${rpcUrl}; stop it before running chain:local`)
}

async function assertFreshDeployer() {
  const nonce = await rpc("eth_getTransactionCount", [DEPLOYER, "latest"])
  if (nonce !== "0x0") throw new Error(`deployer nonce is ${nonce}, expected a fresh chain`)
}

await assertPortFree()
const anvil = Bun.spawn(
  [foundryBin("anvil"), ...startTime, "--chain-id", "4663", "--host", "127.0.0.1", "--port", String(port), "--accounts", "20", "--silent"],
  { stdout: "ignore", stderr: "ignore" },
)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    anvil.kill()
    process.exit(0)
  })
}

try {
  await waitForChain(anvil)
  await assertFreshDeployer()
  await etchPermit2()
  deploy()
  const contracts = writeDeployment()
  for (const [name, address] of Object.entries(contracts)) console.log(`${name.padEnd(15)} ${address}`)
  console.log(`local chain ready on ${rpcUrl}, chain id 4663`)
} catch (err) {
  anvil.kill()
  throw err
}

if (exitAfterDeploy) anvil.kill()
else await anvil.exited
