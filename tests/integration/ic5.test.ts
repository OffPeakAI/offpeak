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

afterAll(() => {
  apiServer?.stop(true)
  chain?.stop()
})

describe("IC5", () => {
  let good: { id: bigint; collateral: bigint }
  let t0 = 0
  let drawnTotal = 0n
  const hostPrice = 1_000_000n
  const buyerPrice = 1_040_000n

  test("a Window is bought, and resold with the right fee", async () => {
    t0 = hourEnd(hourIndex(await chainTime()) + 1)
    good = await createWindow(t0, 1)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "buy", [good.id, 2n, buyerPrice])
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "buy", [good.id, 2n, buyerPrice])

    const salePrice = 1_500_000n
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "list", [good.id, 1n, salePrice])
    const sellerBefore = await usdgOf(seller.address)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "buyListing", [1n, 1n, salePrice])
    const fee = windowResaleFeeMicro(salePrice, buyerPrice)
    expect((await usdgOf(seller.address)) - sellerBefore).toBe(salePrice - fee)
    expect(fee).toBe(15_000n + 46_000n)

    await tick(ingest, ingestState)
    const held = await idx<Record<string, string>>(`/idx/v1/windows/${good.id}/holders/${buyer}`)
    expect(held.balance).toBe("3")
    const rows = await db.query<{ balance: string }>("SELECT balance FROM chain.window_holdings WHERE window_id = $1 AND holder = $2", [good.id, buyer])
    expect(BigInt(rows.rows[0]!.balance)).toBe(3n)
  }, 60_000)

  test("draws across two hours settle on chain and pay the host", async () => {
    await mineAt(t0 + 5)
    await syncWindow(good.id, buyer)
    for (let i = 0; i < 3; i++) drawnTotal += await drawCall(good.id)
    await mineAt(t0 + 3605)
    for (let i = 0; i < 3; i++) drawnTotal += await drawCall(good.id)

    const registryBefore = await usdgOf(contract("HostRegistry"))
    await settleThrough(hourIndex(t0 + 3605))
    const held = await idx<Record<string, string>>(`/idx/v1/windows/${good.id}/holders/${buyer}`)
    expect(BigInt(held.drawnTokens!)).toBe(drawnTotal)
    expect(held.balance).toBe("3")
    const rejects = await db.query("SELECT 1 FROM chain.settlement_rejects")
    expect(rejects.rows).toHaveLength(0)
    const expected = (drawnTotal * hostPrice) / 1_000_000n
    expect(await usdgOf(contract("HostRegistry"))).toBeGreaterThanOrEqual(registryBefore + expected - 6n)
    expect(metrics.get("settlement_signer_disagreement_total")).toBe(0)
  }, 60_000)

  test("a Window that met its target refunds half of what went unused, and returns the collateral", async () => {
    await mineAt(t0 + 2 * 3600 + 3600)
    await perfRound()
    const rows = await db.query<{ perf_state: number; failed: boolean; measured_seconds: string }>("SELECT perf_state, failed, measured_seconds FROM chain.windows WHERE id = $1", [good.id])
    expect(rows.rows[0]).toMatchObject({ perf_state: 1, failed: false })
    expect(Number(rows.rows[0]!.measured_seconds)).toBeGreaterThan(0)

    await mineAt((await chainTime()) + DISPUTE_S)
    const unused = 3n * 1_000_000n - drawnTotal
    const before = await usdgOf(buyer)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "claimExpired", [good.id])
    const refund = (await usdgOf(buyer)) - before
    const hostHalf = (unused * hostPrice) / 1_000_000n / 2n
    const feeShare = (unused * 40_000n) / 1_000_000n
    expect(refund).toBeGreaterThanOrEqual(hostHalf + feeShare - 2n)
    expect(refund).toBeLessThanOrEqual(hostHalf + feeShare + 2n)

    const hostBefore = await usdgOf(host)
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "claimExpired", [good.id])
    expect((await usdgOf(host)) - hostBefore).toBe(good.collateral)
    expect(await usdgOf(contract("WindowMarket"))).toBe(0n)
  }, 60_000)

  test("a Window that missed its target refunds what was paid and shares all the collateral", async () => {
    const start = hourEnd(hourIndex(await chainTime()) + 1)
    const bad = await createWindow(start, 1_000_000_000, 10n)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "buy", [bad.id, 1n, buyerPrice])
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "buy", [bad.id, 1n, buyerPrice])

    await mineAt(start + 5)
    await syncWindow(bad.id, buyer)
    const drawn = await drawCall(bad.id)
    await settleThrough(hourIndex(start + 3605))

    await mineAt(Math.max(start + 2 * 3600 + 3600, (await chainTime()) + 1))
    await perfRound()
    const rows = await db.query<{ failed: boolean }>("SELECT failed FROM chain.windows WHERE id = $1", [bad.id])
    expect(rows.rows[0]!.failed).toBe(true)

    await mineAt((await chainTime()) + DISPUTE_S)
    const buyerBefore = await usdgOf(buyer)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "claimFailure", [bad.id])
    const owed = ((1_000_000n - drawn) * buyerPrice) / 1_000_000n + bad.collateral / 2n
    const paid = (await usdgOf(buyer)) - buyerBefore
    expect(paid).toBeGreaterThanOrEqual(owed - 2n)
    expect(paid).toBeLessThanOrEqual(owed + 2n)

    const sellerBefore = await usdgOf(seller.address)
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "claimFailure", [bad.id])
    expect((await usdgOf(seller.address)) - sellerBefore).toBe(buyerPrice + bad.collateral / 2n)
    expect(await usdgOf(contract("WindowMarket"))).toBe(0n)
  }, 120_000)

  test("fees reach the host reward bucket, and the weekly batch pays by bond and uptime", async () => {
    expect(await runFeeDistribute(keeper).then((r) => r.distributed)).toBeGreaterThan(0n)
    const splitter = { address: contract("FeeSplitter"), abi: FeeSplitterAbi }
    const bucket = await reader.readContract({ ...splitter, functionName: "hostRewardBucket" })
    expect(bucket).toBeGreaterThan(0n)

    const now = await chainTime()
    const week = weekOf(now)
    await mineAt(weekStart(week + 1) + 1801)
    await tick(ingest, ingestState)
    for (const worker of workers) await rewardTick(worker)
    expect(await reader.readContract({ ...splitter, functionName: "rewardWeekPaid", args: [BigInt(week)] })).toBe(true)
    expect(await reader.readContract({ ...splitter, functionName: "hostRewardBucket" })).toBe(0n)
    for (const worker of workers) expect(await rewardTick(worker)).toBeNull()
  }, 120_000)

  test("the burn stays off until the legal gate, and then runs only for the burn keeper", async () => {
    const splitter = { address: contract("FeeSplitter"), abi: FeeSplitterAbi }
    expect((await runBurn(keeper, 1n)).skipped).toBe("not_due")

    const owner = anvilAccount(0)
    await send(owner, contract("FeeSplitter"), FeeSplitterAbi, "setTokenHooksEnabled", [true])
    await send(owner, contract("FeeSplitter"), FeeSplitterAbi, "setSwapAdapter", [contract("MockSwapAdapter")])
    await send(owner, contract("WindowMarket"), WindowMarketAbi, "setEarlyAccessSeconds", [0n])

    const window = await createWindow(hourEnd(hourIndex(await chainTime()) + 1), 1, 2n)
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "buy", [window.id, 1n, buyerPrice])
    const listingId = (await market("nextListingId")) as unknown as bigint
    await send(seller, contract("WindowMarket"), WindowMarketAbi, "list", [window.id, 1n, 2_000_000n])
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "buyListing", [listingId, 1n, 2_000_000n])
    await runFeeDistribute(keeper)
    const bucket = await reader.readContract({ ...splitter, functionName: "burnBucket" })
    expect(bucket).toBeGreaterThan(0n)

    expect((await runBurn(keeper, 1n)).skipped).toBe("no_keeper_or_floor")
    await send(owner, contract("FeeSplitter"), FeeSplitterAbi, "setBurnKeeper", [keeper.account.address])
    expect((await runBurn(keeper, undefined)).skipped).toBe("no_keeper_or_floor")
    expect((await runBurn(keeper, 1n)).burned).toBe(bucket)
    expect(await reader.readContract({ ...splitter, functionName: "burnBucket" })).toBe(0n)
  }, 60_000)

  test("an event that cannot apply does not stop the indexer, and raises an alert", async () => {
    await tick(ingest, ingestState)
    await db.exec(`
      CREATE FUNCTION chain.refuse_listing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_listing BEFORE INSERT ON chain.listings FOR EACH ROW EXECUTE FUNCTION chain.refuse_listing();
    `)
    const window = await createWindow(hourEnd(hourIndex(await chainTime()) + 1), 1, 2n)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "buy", [window.id, 1n, buyerPrice])
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "list", [window.id, 1n, 1_000_000n])
    await tick(ingest, ingestState)
    await db.exec("DROP TRIGGER refuse_listing ON chain.listings; DROP FUNCTION chain.refuse_listing();")

    const head = await reader.getBlockNumber({ cacheTime: 0 })
    const cursor = await db.query<{ block: string }>("SELECT block FROM chain.cursor WHERE id = 'main'")
    expect(BigInt(cursor.rows[0]!.block)).toBe(head)
    const failed = await db.query<{ event: string; error: string }>("SELECT event, error FROM chain.events WHERE error IS NOT NULL")
    expect(failed.rows).toHaveLength(1)
    expect(failed.rows[0]!.event).toBe("Listed")
    expect(metrics.get("indexer_apply_errors_total")).toBe(1)
  }, 60_000)

  test("a host's dispute gets a final repost", async () => {
    const start = hourEnd(hourIndex(await chainTime()) + 1)
    const disputed = await createWindow(start, 1, 2n)
    await send(buyerAccount, contract("WindowMarket"), WindowMarketAbi, "buy", [disputed.id, 1n, buyerPrice])
    await mineAt(start + 2 * 3600 + 3600)
    await perfRound()
    await send(host, contract("WindowMarket"), WindowMarketAbi, "disputePerformance", [disputed.id])
    await perfRound()
    const rows = await db.query<{ perf_state: number }>("SELECT perf_state FROM chain.windows WHERE id = $1", [disputed.id])
    expect(rows.rows[0]!.perf_state).toBe(3)
  }, 60_000)
})
