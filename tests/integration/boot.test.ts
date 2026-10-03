import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { bytesToHex } from "viem"
import { ANVIL_MNEMONIC, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { mnemonicToAccount } from "viem/accounts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29550
const root = new URL("../../", import.meta.url).pathname

let chain: LocalChain
const running: Bun.Subprocess[] = []

function publicKey(index: number) {
  return bytesToHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey!)
}

function baseEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OFFPEAK_ENV: "local",
    OFFPEAK_CHAIN_ID: "4663",
    OFFPEAK_RPC_URL: chain.rpcUrl,
    OFFPEAK_CONFIRMATIONS: "1",
    OFFPEAK_DEPLOYMENT_FILE: `${root}packages/abis/deployments/local.json`,
    OFFPEAK_DATABASE_URL: "pglite://memory",
  }
}

/** Boots a service's real entry point and waits for the line that proves it got through startup. */
async function bootsTo(entry: string, env: Record<string, string | undefined>, expected: string) {
  const child = Bun.spawn(["bun", "run", entry], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  running.push(child)
  const decoder = new TextDecoder()
  let output = ""
  const deadline = Date.now() + 20_000
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk)
    if (output.includes(expected) || Date.now() > deadline) break
  }
  child.kill()
  return output
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
}, 120_000)

afterAll(() => {
  for (const child of running) child.kill()
  chain.stop()
})

describe("service entry points", () => {
  test("the indexer boots, serves and ingests", async () => {
    const output = await bootsTo(
      "services/indexer/src/main.ts",
      { ...baseEnv(), OFFPEAK_INTERNAL_TOKEN: "local-test-token-0123456789abcdef", OFFPEAK_INDEXER_PORT: "29791" },
      "listening",
    )
    expect(output).toContain("listening")
    expect(output).not.toContain("tick_failed")
  }, 30_000)

  test("a settlement signer boots and runs a tick", async () => {
    const settlers = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]
    const output = await bootsTo(
      "services/settlement/src/main.ts",
      {
        ...baseEnv(),
        OFFPEAK_SETTLER_INDEX: "1",
        OFFPEAK_SETTLER_KEY: publicKey(4),
        OFFPEAK_SETTLER_ADDRESSES: settlers.map((s) => s.address).join(","),
        OFFPEAK_ROUTER_ADDRESS: roleAccount("router").address,
      },
      '"event":"tick"',
    )
    expect(output).toContain('"event":"tick"')
    expect(output).not.toContain("tick_failed")
  }, 30_000)
