import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type HDAccount, type Hex, type PublicClient } from "viem"
import { closeHour } from "../../apps/router/src/metering/hourclose.ts"
import { bootStack } from "../../apps/router/test/support/stack.ts"
import { FeeSplitterAbi, HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi, WindowMarketAbi } from "../../packages/abis/src/index.ts"
import { hourEnd, hourIndex, windowResaleFeeMicro } from "../../packages/shared/src/index.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { Metrics, applySchemas, encodePush, type Db } from "../../services/common/src/index.ts"
import { createApi } from "../../services/indexer/src/api.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { runBurn, runFeeDistribute } from "../../services/keepers/src/jobs/fee-distribute.ts"
import { runHostActivate } from "../../services/keepers/src/jobs/host-activate.ts"
import type { KeeperDeps } from "../../services/keepers/src/jobs/types.ts"
import { perfTick } from "../../services/settlement/src/perf.ts"
import { rewardTick, weekOf, weekStart } from "../../services/settlement/src/rewards.ts"
import { settlementTick, type WorkerDeps } from "../../services/settlement/src/worker.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29556
const API_PORT = PORT + 100
const FAC_PORT = PORT + 101
const TOKEN = "local-test-token-0123456789abcdef"
const CLOSE_GRACE = 600
const PROBATION_S = 72 * 3600
const DISPUTE_S = 24 * 3600

const router = roleAccount("router")
const hostAccount = roleAccount("host")
const host = hostAccount.address.toLowerCase() as Address
const buyerAccount = roleAccount("buyer")
const buyer = buyerAccount.address.toLowerCase() as Address
const seller = anvilAccount(19)
const signerAccounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]

let chain: LocalChain
let booted: Awaited<ReturnType<typeof bootStack>>
let db: Db
let reader: PublicClient
let api: ReturnType<typeof createApi>
let apiServer: ReturnType<typeof Bun.serve>
let facServer: ReturnType<typeof Bun.serve>
let ingest: IngestDeps
let workers: WorkerDeps[]
let keeper: KeeperDeps
const ingestState = newIngestState()
const metrics = new Metrics()

const contract = (name: string) => chain.contracts[name]!

async function rpc(method: string, params: unknown[] = []) {
  await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

async function chainTime() {
  return Number((await reader.getBlock({ blockTag: "latest" })).timestamp)
}

async function mineAt(ts: number) {
  await rpc("evm_setNextBlockTimestamp", [ts])
  await rpc("evm_mine")
  booted.stack.setClock(ts)
}

async function send(account: HDAccount | Address, address: Address, abi: unknown, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  // Fixed, because a Dutch price costs less gas in the auction's first second than an estimate can see.
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas: 5_000_000n } as never)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe("success")
  return receipt
}

const market = (functionName: string, args: unknown[] = []) =>
  reader.readContract({ address: contract("WindowMarket"), abi: WindowMarketAbi, functionName, args } as never) as Promise<never>
const usdgOf = (who: Address) => reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [who] })
const lastSettled = async () =>
  Number(await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "lastSettledHour" }))

async function idx<T>(path: string) {
  const res = await api.request(path, { headers: { authorization: `Bearer ${TOKEN}` } })
  return ((await res.json()) as { data: T }).data
}

async function settleThrough(hour: number) {
  for (let h = (await lastSettled()) + 1; h <= hour; h++) {
    const closeAt = hourEnd(h) + CLOSE_GRACE
    if ((await chainTime()) < closeAt) await mineAt(closeAt)
    await closeHour(booted.stack.db, h, router as never, contract("UsageLedger"))
    for (let pass = 0; pass < 4 && (await lastSettled()) < h; pass++) {
      await tick(ingest, ingestState)
      for (const worker of workers) await settlementTick(worker)
    }
    await tick(ingest, ingestState)
    expect(await lastSettled()).toBe(h)
  }
}

async function createWindow(t0: number, minTps: number, units = 10n, startPrice = 1_000_000n) {
  const now = await chainTime()
  const params = {
    modelDigest: booted.modelDigest,
    t0: BigInt(t0),
    t1: BigInt(t0 + 2 * 3600),
    minTps,
    units,
    startPricePerUnit: startPrice,
    endPricePerUnit: startPrice,
    auctionStart: BigInt(now),
    auctionEnd: BigInt(t0),
  }
  const before = (await market("nextId")) as unknown as bigint
  await send(host, contract("WindowMarket"), WindowMarketAbi, "create", [params, units * startPrice])
  return { id: before, collateral: units * startPrice }
}

/** Windows read straight from the chain, so there is nothing to refresh but the host and buyer caches. */
async function syncWindow(_id: bigint, _holder: Address) {
  booted.chain!.resync()
}

async function drawCall(id: bigint) {
  const res = await booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", "x-offpeak-window": id.toString() },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "draw" }], max_tokens: 16 }),
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { offpeak_usage: { record: { payMode: number; tokensIn: number; tokensOut: number } } }
  expect(json.offpeak_usage.record.payMode).toBe(4)
  return BigInt(json.offpeak_usage.record.tokensIn + json.offpeak_usage.record.tokensOut)
}

async function perfRound() {
  await tick(ingest, ingestState)
  for (const worker of workers) await perfTick(worker)
  await tick(ingest, ingestState)
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 20 }) as PublicClient
  booted = await bootStack({ live: { indexerUrl: `http://127.0.0.1:${API_PORT}`, facilitatorUrl: "http://127.0.0.1:1", token: TOKEN } })
  db = booted.stack.db
  await applySchemas(db, { shared: false })
  process.env.OFFPEAK_INTERNAL_TOKEN = TOKEN

  const bond = 2_000_000_000n
  await send(host, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), bond])
  await send(host, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("WindowMarket"), 10n ** 12n])
  await send(host, contract("HostRegistry"), HostRegistryAbi, "register", [
    {
      modelDigests: [booted.modelDigest],
      maxTps: [50_000],
      imageDigest: booted.imageDigest,
      gpuClass: keccak256(toBytes("h100-80g-sxm")),
      endpointHash: keccak256(toBytes("http://host.local")),
      attestationRef: `0x${"00".repeat(32)}`,
      bondUsdg: bond,
      bondOfpk: 0n,
    },
  ])
  for (const account of [buyer, seller.address]) {
    await send(seller, contract("MockUSDG"), MockUSDGAbi, "mint", [account, 1_000_000_000n])
  }
  await send(buyerAccount, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("WindowMarket"), 1_000_000_000n])
  await send(seller, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("WindowMarket"), 1_000_000_000n])

  ingest = {
    db,
    reader,
    contracts: chain.contracts,
    confirmations: 1,
    metrics,
    publish: (msg) => {
      booted.chain!.push(JSON.parse(encodePush(msg)))
    },
  }
  await tick(ingest, ingestState)
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
  const keeperAccount = anvilAccount(13)
  keeper = {
    db,
    reader,
    writer: createWalletClient({ account: keeperAccount, transport: http(chain.rpcUrl), chain: null }) as never,
    account: keeperAccount as never,
    contracts: chain.contracts,
    metrics,
  }
  await settleThrough(hourIndex(await chainTime()))
  await mineAt((await chainTime()) + PROBATION_S + 1)
  await tick(ingest, ingestState)
  await runHostActivate(keeper)
  await settleThrough(hourIndex(await chainTime()) - 1)
}, 240_000)
