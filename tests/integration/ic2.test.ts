import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { closeHour } from "../../apps/router/src/metering/hourclose.ts"
import { bootStack } from "../../apps/router/test/support/stack.ts"
import { HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi, UsageLedgerAbi } from "../../packages/abis/src/index.ts"
import { hourEnd, hourIndex, hourStart } from "../../packages/shared/src/index.ts"
import { roleAccount } from "../../packages/shared/src/test-keys.ts"
import { Metrics, applySchemas, encodePush, type Db } from "../../services/common/src/index.ts"
import { createApi } from "../../services/indexer/src/api.ts"
import { crossCheckBuyers } from "../../services/indexer/src/crosscheck.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { runHostActivate } from "../../services/keepers/src/jobs/host-activate.ts"
import { runWithdrawAll } from "../../services/keepers/src/jobs/withdraw-all.ts"
import { refundPass, settlementTick, type WorkerDeps } from "../../services/settlement/src/worker.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29548
const API_PORT = PORT + 100
const FAC_PORT = PORT + 101
const TOKEN = "local-test-token-0123456789abcdef"
const DEPOSIT = 200_000_000n
const HOURLY_CAP = 50_000_000n
const CLOSE_GRACE = 600

const router = roleAccount("router")
const buyerAccount = roleAccount("buyer")
const hostAccount = roleAccount("host")
const buyer = buyerAccount.address.toLowerCase() as Address
const host = hostAccount.address.toLowerCase() as Address
const signerAccounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]

let chain: LocalChain
let booted: Awaited<ReturnType<typeof bootStack>>
let db: Db
let reader: PublicClient
let api: ReturnType<typeof createApi>
let apiServer: ReturnType<typeof Bun.serve>
let facServer: ReturnType<typeof Bun.serve>
let ingest: IngestDeps
const ingestState = newIngestState()
const metrics = new Metrics()
let workers: WorkerDeps[]
const pushes: Record<string, unknown>[] = []
let peakLag = 0

function contract(name: string) {
  return chain.contracts[name]!
}

async function rpc(method: string, params: unknown[] = []) {
  await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

/** Mines a block at `ts`, so the chain and the router's clock agree. */
async function mineAt(ts: number) {
  await rpc("evm_setNextBlockTimestamp", [ts])
  await rpc("evm_mine")
  booted.stack.setClock(ts)
}

async function chainTime() {
  return Number((await reader.getBlock({ blockTag: "latest" })).timestamp)
}

async function send(account: Address, address: Address, abi: never, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never)
  return reader.waitForTransactionReceipt({ hash })
}

async function idx<T>(path: string) {
  const res = await api.request(path, { headers: { authorization: `Bearer ${TOKEN}` } })
  return { status: res.status, body: (await res.json()) as { data: T } }
}

/** Drops the router's short caches, so a test reads the chain state it just made. */
async function syncBuyer() {
  booted.chain!.resync()
}

async function ask(content: string) {
  return booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 16 }),
  })
}

async function serve(content: string) {
  const res = await ask(content)
  expect(res.status).toBe(200)
  const json = (await res.json()) as { offpeak_usage: { record: { reqId: Hex; hostCostMicro: string; feeMicro: string }; leaf: Hex } }
  return json.offpeak_usage
}

const costOf = (usage: { record: { hostCostMicro: string; feeMicro: string } }) =>
  BigInt(usage.record.hostCostMicro) + BigInt(usage.record.feeMicro)

/** Runs every signer until the hour lands, the way their independent loops would. */
async function settle(hour: number) {
  for (let pass = 0; pass < 4; pass++) {
    await tick(ingest, ingestState)
    const onChain = await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "lastSettledHour" })
    if (Number(onChain) >= hour) return
    for (const worker of workers) {
      await settlementTick(worker)
      peakLag = Math.max(peakLag, metrics.get("settle_lag_seconds"))
    }
  }
  await tick(ingest, ingestState)
}

async function closeAndSettle(hour: number) {
  await mineAt(hourEnd(hour) + CLOSE_GRACE)
  await closeHour(booted.stack.db, hour, router as never, contract("UsageLedger"))
  await settle(hour)
}

async function vaultBalance() {
  const state = await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "buyerState", args: [buyer] })
  return state.balance
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl) }) as PublicClient
  booted = await bootStack({ live: { indexerUrl: `http://127.0.0.1:${API_PORT}`, facilitatorUrl: "http://127.0.0.1:1", token: TOKEN } })
  db = booted.stack.db
  await applySchemas(db, { shared: false })
  process.env.OFFPEAK_INTERNAL_TOKEN = TOKEN

  await send(buyer, contract("MockUSDG"), MockUSDGAbi as never, "approve", [contract("OffpeakVault"), DEPOSIT])
  await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi as never, "deposit", [DEPOSIT])
  await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi as never, "setCaps", [HOURLY_CAP, 0n])

  const bond = 2_000_000_000n
  await send(host, contract("MockUSDG"), MockUSDGAbi as never, "approve", [contract("HostRegistry"), bond])
  await send(host, contract("HostRegistry"), HostRegistryAbi as never, "register", [
    {
      modelDigests: [booted.modelDigest],
      maxTps: [100],
      imageDigest: booted.imageDigest,
      gpuClass: keccak256(toBytes("h100-80g-sxm")),
      endpointHash: keccak256(toBytes("http://host.local")),
      attestationRef: `0x${"00".repeat(32)}`,
      bondUsdg: bond,
      bondOfpk: 0n,
    },
  ])

  ingest = {
    db,
    reader,
    contracts: chain.contracts,
    confirmations: 1,
    publish: (msg) => {
      pushes.push(msg)
      booted.chain!.push(JSON.parse(encodePush(msg)))
    },
  }
  api = createApi({ db, reader, contracts: chain.contracts, internalToken: TOKEN, metrics })
  apiServer = Bun.serve({ port: API_PORT, fetch: api.fetch })
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
  booted.stack.setClock(await chainTime())
  await tick(ingest, ingestState)
}, 180_000)

afterAll(() => {
  apiServer?.stop(true)
  chain?.stop()
})
