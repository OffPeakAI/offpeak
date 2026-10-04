import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem"
import { MockUSDGAbi, OffpeakVaultAbi } from "../../packages/abis/src/index.ts"
import { roleAccount } from "../../packages/shared/src/test-keys.ts"
import { openDatabase, type Db } from "../../services/common/src/index.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29549
const buyer = roleAccount("buyer").address.toLowerCase() as Address

let chain: LocalChain
let reader: PublicClient
let db: Db
let deps: IngestDeps
const published: Record<string, unknown>[] = []

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  return ((await res.json()) as { result: unknown }).result
}

async function vault(functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account: buyer, transport: http(chain.rpcUrl), chain: null })
  const hash: Hex = await wallet.writeContract({ address: chain.contracts.OffpeakVault!, abi: OffpeakVaultAbi, functionName, args } as never)
  await reader.waitForTransactionReceipt({ hash })
}

async function indexedBalance() {
  const rows = await db.query<{ balance: string }>("SELECT balance FROM chain.buyers WHERE address = $1", [buyer])
  return BigInt(rows.rows[0]?.balance ?? 0)
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 50 }) as PublicClient
  db = await openDatabase(process.env.OFFPEAK_TEST_DATABASE_URL ?? "pglite://memory")
  deps = { db, reader, contracts: chain.contracts, confirmations: 1, publish: (msg) => void published.push(msg) }
  const wallet = createWalletClient({ account: buyer, transport: http(chain.rpcUrl), chain: null })
  const hash = await wallet.writeContract({
    address: chain.contracts.MockUSDG!,
    abi: MockUSDGAbi,
    functionName: "approve",
    args: [chain.contracts.OffpeakVault!, 1_000_000_000n],
  })
  await reader.waitForTransactionReceipt({ hash })
}, 120_000)

afterAll(() => {
  chain.stop()
})

describe("live indexer", () => {
  test("tick is idempotent: a second pass over the same head changes nothing", async () => {
    const state = newIngestState()
    await vault("deposit", [10_000_000n])
    await tick(deps, state)
    expect(await indexedBalance()).toBe(10_000_000n)
    const count = published.length
    await tick(deps, state)
    expect(await indexedBalance()).toBe(10_000_000n)
    expect(published.length).toBe(count)
  })

  test("a reorg rewinds derived state and republishes from the fork", async () => {
    const state = newIngestState()
    await tick(deps, state)
    const snapshot = await rpc("evm_snapshot")
    await vault("deposit", [5_000_000n])
    await tick(deps, state)
    expect(await indexedBalance()).toBe(15_000_000n)

    await rpc("evm_revert", [snapshot])
    await rpc("evm_mine")
    await rpc("evm_mine")
    await vault("deposit", [1_000_000n])
    await tick(deps, state)
    expect(await indexedBalance()).toBe(11_000_000n)
    expect(published.some((m) => m.type === "Reorg")).toBe(true)
  }, 30_000)

  test("tightening events go out at the head, once, ahead of confirmations", async () => {
    const state = newIngestState()
    const slow = { ...deps, confirmations: 3 }
    await tick(slow, state)
    published.length = 0
    await vault("requestWithdrawAll")
    await tick(slow, state)

    const pushed = () => published.filter((m) => m.type === "WithdrawAllRequested").length
    expect(pushed()).toBe(1)
    const rows = await db.query<{ withdraw_requested_at: string }>("SELECT withdraw_requested_at FROM chain.buyers WHERE address = $1", [buyer])
    expect(Number(rows.rows[0]!.withdraw_requested_at)).toBe(0)

    await rpc("evm_mine")
    await rpc("evm_mine")
    await tick(slow, state)
    expect(pushed()).toBe(1)
    const applied = await db.query<{ withdraw_requested_at: string }>("SELECT withdraw_requested_at FROM chain.buyers WHERE address = $1", [buyer])
    expect(Number(applied.rows[0]!.withdraw_requested_at)).toBeGreaterThan(0)
  }, 30_000)
})
