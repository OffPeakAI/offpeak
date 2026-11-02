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

  test("a ruling process boots and runs a tick", async () => {
    const rulers = [roleAccount("rulingA"), roleAccount("rulingB"), roleAccount("rulingC")]
    const output = await bootsTo(
      "services/rulings/src/main.ts",
      {
        ...baseEnv(),
        OFFPEAK_RULING_INDEX: "1",
        OFFPEAK_RULING_KEY: publicKey(7),
        OFFPEAK_RULER_ADDRESSES: rulers.map((r) => r.address).join(","),
        OFFPEAK_AUDITOR_ADDRESS: `0x${"19".repeat(20)}`,
      },
      '"event":"tick"',
    )
    expect(output).toContain('"event":"tick"')
    expect(output).not.toContain("tick_failed")
  }, 30_000)

  test("settlement refuses to start while holding another role's key", async () => {
    const child = Bun.spawn(["bun", "run", "services/settlement/src/main.ts"], {
      cwd: root,
      env: {
        ...baseEnv(),
        OFFPEAK_SETTLER_INDEX: "1",
        OFFPEAK_SETTLER_KEY: publicKey(4),
        OFFPEAK_KEEPER_KEY: publicKey(5),
        OFFPEAK_SETTLER_ADDRESSES: [1, 2, 3].map(() => roleAccount("settlerA").address).join(","),
        OFFPEAK_ROUTER_ADDRESS: roleAccount("router").address,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    running.push(child)
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("must not hold OFFPEAK_KEEPER_KEY")
  }, 30_000)

  test("the keepers boot when Redis is up", async () => {
    const up = await Bun.connect({ hostname: "127.0.0.1", port: 6379, socket: { data() {} } }).then(
      (socket) => {
        socket.end()
        return true
      },
      () => false,
    )
    if (!up) return
    const output = await bootsTo(
      "services/keepers/src/main.ts",
      { ...baseEnv(), OFFPEAK_KEEPER_KEY: publicKey(13), OFFPEAK_REDIS_URL: "redis://127.0.0.1:6379" },
      '"event":"started"',
    )
    expect(output).toContain('"event":"started"')
  }, 30_000)

  const facilitatorEnv = () => ({
    ...baseEnv(),
    OFFPEAK_FACILITATOR_RELAY_KEY: publicKey(11),
    OFFPEAK_CAPTURER_KEY: publicKey(12),
    OFFPEAK_INTERNAL_TOKEN: "local-test-token-0123456789abcdef",
    OFFPEAK_FACILITATOR_PORT: "29792",
    OFFPEAK_REDIS_URL: "redis://127.0.0.1:6379",
  })

  test("the facilitator refuses one key for both roles", async () => {
    const child = Bun.spawn(["bun", "run", "services/facilitator/src/main.ts"], {
      cwd: root,
      env: { ...facilitatorEnv(), OFFPEAK_CAPTURER_KEY: publicKey(11) },
      stdout: "pipe",
      stderr: "pipe",
    })
    running.push(child)
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("share a key")
  }, 30_000)

  test("the facilitator boots and lists channels first", async () => {
    const up = await Bun.connect({ hostname: "127.0.0.1", port: 6379, socket: { data() {} } }).then(
      (socket) => {
        socket.end()
        return true
      },
      () => false,
    )
    if (!up) return
    const child = Bun.spawn(["bun", "run", "services/facilitator/src/main.ts"], { cwd: root, env: facilitatorEnv(), stdout: "pipe", stderr: "pipe" })
    running.push(child)
    let output = ""
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      if (output.includes('"event":"started"')) break
    }
    const supported = (await (await fetch("http://127.0.0.1:29792/x402/supported")).json()) as { kinds: { scheme: string }[] }
    expect(supported.kinds.map((k) => k.scheme)).toEqual(["channel", "upto", "exact"])
  }, 30_000)
})
