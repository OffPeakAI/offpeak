#!/usr/bin/env bun
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem"
import { foundry } from "viem/chains"
import { mnemonicToAccount } from "viem/accounts"
import { ANVIL_MNEMONIC } from "../packages/shared/src/test-keys.ts"

const PORT = 18600
const rpcUrl = `http://127.0.0.1:${PORT}`
const upstream = process.env.OFFPEAK_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
const root = new URL("..", import.meta.url).pathname
const contractsDir = join(root, "contracts")
const configPath = "config/chains/rehearsal.private.json"
const deploymentPath = "../packages/abis/deployments/rehearsal.private.json"
const proposalDir = "../packages/abis/deployments/rehearsal.private."
const account = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).address
const DEPLOYER = account(0)

function foundryBin(name: string) {
  return Bun.which(name) ?? `${process.env.HOME}/.foundry/bin/${name}`
}

function sortedThree(from: number) {
  return [account(from), account(from + 1), account(from + 2)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
}

async function waitForFork(anvil: Bun.Subprocess, reader: ReturnType<typeof createPublicClient>) {
  for (let i = 0; i < 200; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited; is port ${PORT} in use?`)
    try {
      await reader.getChainId()
      return
    } catch {
      await Bun.sleep(150)
    }
  }
  throw new Error("the fork did not start")
}

/** The panel must be a real Safe on mainnet. A fork stands in with the same `getOwners` surface. */
async function deployStandInSafe(reader: ReturnType<typeof createPublicClient>) {
  const artifact = JSON.parse(readFileSync(join(contractsDir, "out/DeployHarness.sol/MockSafe.json"), "utf8"))
  const wallet = createWalletClient({ account: account(19), transport: http(rpcUrl), chain: foundry })
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [[account(18)]],
    chain: null,
  })
  return (await reader.waitForTransactionReceipt({ hash })).contractAddress as Address
}

function forge(script: string, broadcast: boolean) {
  const args = [foundryBin("forge"), "script", script, "--rpc-url", rpcUrl]
  if (broadcast) args.push("--broadcast", "--unlocked", "--sender", DEPLOYER, "--slow", "--skip-simulation")
  const run = Bun.spawnSync(args, {
    cwd: contractsDir,
    env: { ...process.env, OFFPEAK_CHAIN_CONFIG: configPath, OFFPEAK_DEPLOYMENT_OUT: deploymentPath, OFFPEAK_PROPOSAL_DIR: proposalDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(`${script} failed:\n${out.slice(-1500)}\n${run.stderr.toString().slice(-1500)}`)
  console.log(`ok ${script}`)
  return out
}

const reader = createPublicClient({ transport: http(rpcUrl), pollingInterval: 100 })

async function rpc(method: string, params: unknown[] = []) {
  await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

/** Runs a phase the way mainnet will: deploy, the multisig schedules, 48 hours pass, it executes, and the wiring is read back. */
async function rehearseProposal(phase: string, run: typeof forge, confirmation: string) {
  run(`script/Deploy${phase.toUpperCase()}.s.sol`, true)
  const proposal = JSON.parse(readFileSync(join(contractsDir, `${proposalDir}${phase}-proposal.json`), "utf8"))
  const multisig = createWalletClient({ account: account(8), transport: http(rpcUrl), chain: null })
  const call = async (data: Hex) => {
    const hash = await multisig.sendTransaction({ to: proposal.timelock, data })
    const receipt = await reader.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`${phase} proposal reverted`)
  }
  await call(proposal.schedule)
  await rpc("evm_increaseTime", [proposal.delaySeconds + 1])
  await rpc("evm_mine")
  await call(proposal.execute)
  const verified = run("script/VerifyWiring.s.sol", false)
  if (!verified.includes(confirmation)) throw new Error(`VerifyWiring did not reach ${phase}`)
  rmSync(join(contractsDir, `${proposalDir}${phase}-proposal.json`), { force: true })
}
const anvil = Bun.spawn(
  [foundryBin("anvil"), "--fork-url", upstream, "--port", String(PORT), "--accounts", "20", "--silent", "--auto-impersonate"],
  { stdout: "ignore", stderr: "ignore" },
)
const fullConfig = join(contractsDir, configPath)
const fullDeployment = join(contractsDir, deploymentPath)

try {
  await waitForFork(anvil, reader)
  const panel = await deployStandInSafe(reader)
  const config = JSON.parse(readFileSync(join(contractsDir, "config/chains/4663.json"), "utf8"))
  writeFileSync(
    fullConfig,
    JSON.stringify({
      ...config,
      settlers: sortedThree(1),
      rulers: sortedThree(4),
      panel,
      guardian: account(7),
      multisig: account(8),
      relay: account(9),
      capturer: account(10),
      keeper: account(11),
      channelPayee: account(12),
      routerSigner: account(13),
      treasury: account(14),
      opsWallet: account(15),
    }),
  )
  forge("script/Deploy.s.sol", true)
  forge("script/HandOffOwnership.s.sol", true)
  const verified = forge("script/VerifyWiring.s.sol", false)
  if (!verified.includes("wiring verified")) throw new Error("VerifyWiring did not confirm")

  await rehearseProposal("p2", forge, "payments verified")
  await rehearseProposal("p3", forge, "markets verified")

  const deployment = JSON.parse(readFileSync(fullDeployment, "utf8"))
  console.log(`vault    ${deployment.contracts.OffpeakVault}`)
  console.log(`timelock ${deployment.timelock}`)
  console.log(`usdg eip-2612 ${deployment.usdgHasEip2612}, eip-3009 ${deployment.usdgHasEip3009}`)
  const spent = 10_000n * 10n ** 18n - (await reader.getBalance({ address: DEPLOYER }))
  console.log(`deployer spent ${Number(spent) / 1e18} ETH on the fork`)
  console.log("rehearsal passed")
} finally {
  anvil.kill()
  rmSync(fullConfig, { force: true })
  rmSync(fullDeployment, { force: true })
}
process.exit(0)
