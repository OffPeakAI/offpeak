import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type PublicClient } from "viem"
import { closeHour } from "../../apps/router/src/metering/hourclose.ts"
import { HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi } from "../../packages/abis/src/index.ts"
import { hourEnd, hourIndex } from "../../packages/shared/src/index.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { Metrics, openDatabase, type Db } from "../../services/common/src/index.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { insertRow, signRow } from "../../services/settlement/src/test-rows.ts"
import { settlementTick, type WorkerDeps } from "../../services/settlement/src/worker.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

/** The Settlement launch gate. Long, so it runs on request: OFFPEAK_LONG_TESTS=1 bun test this file. */
const HOURS = 72
const RECORDS_PER_HOUR = 12
const PORT = 29553

const router = roleAccount("router")
const host = roleAccount("host").address.toLowerCase() as Address
const buyers = [roleAccount("buyer"), anvilAccount(18), anvilAccount(19)].map((a) => a.address.toLowerCase() as Address)
const signerAccounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]

let chain: LocalChain
let reader: PublicClient
let db: Db
let ingest: IngestDeps
let workers: WorkerDeps[]
const metrics = new Metrics()
const ingestState = newIngestState()

const contract = (name: string) => chain.contracts[name]!

async function rpc(method: string, params: unknown[] = []) {
  await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

async function send(account: Address, address: Address, abi: unknown, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  await reader.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName, args } as never) })
}

const lastSettled = async () =>
  Number(await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "lastSettledHour" }))

describe.skipIf(!process.env.OFFPEAK_LONG_TESTS)("settlement gate", () => {
  beforeAll(async () => {
    chain = await startLocalChain(PORT)
    reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 50 }) as PublicClient
    db = await openDatabase("pglite://memory")
    await db.exec("CREATE SCHEMA serving; CREATE TABLE serving.hour_locks (hour bigint PRIMARY KEY);")
    for (const buyer of buyers) {
      await send(buyer, contract("MockUSDG"), MockUSDGAbi, "mint", [buyer, 400_000_000n])
      await send(buyer, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("OffpeakVault"), 400_000_000n])
      await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi, "deposit", [400_000_000n])
      await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi, "setCaps", [50_000_000n, 0n])
    }
    await send(host, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), 2_000_000_000n])
    await send(host, contract("HostRegistry"), HostRegistryAbi, "register", [
      {
        modelDigests: [keccak256(toBytes("model"))],
        maxTps: [100],
        imageDigest: keccak256(toBytes("image")),
        gpuClass: keccak256(toBytes("h100-80g-sxm")),
        endpointHash: keccak256(toBytes("endpoint")),
        attestationRef: `0x${"00".repeat(32)}`,
        bondUsdg: 2_000_000_000n,
        bondOfpk: 0n,
      },
    ])
    ingest = { db, reader, contracts: chain.contracts, confirmations: 1, publish: () => {} }
    workers = signerAccounts.map((account) => ({
      db,
      reader,
      writer: createWalletClient({ account, transport: http(chain.rpcUrl), chain: null }) as never,
      account: account as never,
      chainId: 4663,
      contracts: chain.contracts,
      routerAddress: router.address,
      settlers: signerAccounts.map((s) => s.address),
      metrics,
    }))
    await tick(ingest, ingestState)
  }, 180_000)

  afterAll(() => {
    chain.stop()
  })

  test("three signers agree on 72 consecutive hours", async () => {
    const start = Number((await reader.getBlock({ blockTag: "latest" })).timestamp)
    const firstHour = hourIndex(start)
    let expectedDebits = 0n
    for (let hour = firstHour; hour < firstHour + HOURS; hour++) {
      const ts = hour === firstHour ? start + 1 : hour * 3600 + 5
      for (let i = 0; i < RECORDS_PER_HOUR; i++) {
        const row = await signRow(
          { i, hour, payer: buyers[i % buyers.length]!, tokensIn: 500 + ((hour * 7 + i * 13) % 900), ts: Math.min(ts + i, hourEnd(hour) - 1) },
          contract("UsageLedger"),
        )
        await insertRow(db, row)
        expectedDebits += BigInt(row.host_cost_micro) + BigInt(row.fee_micro)
      }
      await rpc("evm_setNextBlockTimestamp", [hourEnd(hour) + 600])
      await rpc("evm_mine")
      await closeHour(db as never, hour, router as never, contract("UsageLedger"))

      await tick(ingest, ingestState)
      for (const worker of workers) await settlementTick(worker)
      await tick(ingest, ingestState)
      expect(await lastSettled()).toBe(hour)

      const hashes = await db.query<{ n: string; signers: string }>(
        "SELECT count(DISTINCT batch_hash) AS n, count(DISTINCT signer) AS signers FROM chain.settlement_sigs WHERE kind = 'settle' AND hour = $1",
        [hour],
      )
      expect(Number(hashes.rows[0]!.n)).toBe(1)
      expect(Number(hashes.rows[0]!.signers)).toBeGreaterThanOrEqual(2)
    }

    expect(metrics.get("settlement_signer_disagreement_total")).toBe(0)
    let remaining = 0n
    for (const buyer of buyers) {
      const state = await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "buyerState", args: [buyer] })
      remaining += state.balance
    }
    expect(remaining).toBe(1_200_000_000n - expectedDebits)
    const excluded = await db.query("SELECT 1 FROM chain.settlement_rejects")
    expect(excluded.rows).toHaveLength(0)
  }, 900_000)
})
