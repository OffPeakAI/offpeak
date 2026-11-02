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

describe("IC2: settlement from real router traffic", () => {
  const served: { hour: number; reqId: Hex; leaf: Hex }[] = []
  let firstHour = 0
  let owed = 0n

  test("three consecutive hours settle from live traffic with three signers", async () => {
    firstHour = hourIndex(await chainTime())
    for (let hour = firstHour; hour < firstHour + 3; hour++) {
      await syncBuyer()
      await mineAt(Math.max(await chainTime() + 1, hourStart(hour) + 60))
      await syncBuyer()
      for (const prompt of [`hour ${hour} first`, `hour ${hour} second`]) {
        const usage = await serve(prompt)
        served.push({ hour, reqId: usage.record.reqId, leaf: usage.leaf })
        owed += costOf(usage)
      }
      await closeAndSettle(hour)
      const lastSettled = await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "lastSettledHour" })
      expect(Number(lastSettled)).toBe(hour)
    }
    expect(await vaultBalance()).toBe(DEPOSIT - owed)
  }, 120_000)

  test("all three signers computed the same batch and agreed", async () => {
    const rows = await db.query<{ signers: string; hashes: string }>(
      `SELECT count(DISTINCT signer) AS signers, count(DISTINCT batch_hash) AS hashes FROM chain.settlement_sigs
       WHERE kind = 'settle' AND hour = $1`,
      [firstHour],
    )
    expect(Number(rows.rows[0]!.hashes)).toBe(1)
    expect(Number(rows.rows[0]!.signers)).toBeGreaterThanOrEqual(2)
    expect(metrics.get("settlement_signer_disagreement_total")).toBe(0)
    expect(peakLag).toBeGreaterThanOrEqual(CLOSE_GRACE)
  })

  test("every record's proof from the indexer verifies on chain", async () => {
    for (const record of served) {
      const { status, body } = await idx<{ hour: number; leaf: Hex; proof: Hex[]; root: Hex }>(`/idx/v1/usage/${record.reqId}/proof`)
      expect(status).toBe(200)
      expect(body.data.leaf).toBe(record.leaf)
      const verified = await reader.readContract({
        address: contract("UsageLedger"),
        abi: UsageLedgerAbi,
        functionName: "verifyLeaf",
        args: [BigInt(record.hour), record.leaf, body.data.proof],
      })
      expect(verified).toBe(true)
    }
  })

  test("the shared tables record the settlement", async () => {
    const hours = await db.query<{ settle_tx: string | null }>("SELECT settle_tx FROM shared.usage_hours WHERE hour = $1", [firstHour])
    expect(hours.rows[0]!.settle_tx).toMatch(/^0x/)
    const open = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM shared.usage_records WHERE hour = $1 AND settled_hour_tx IS NULL",
      [firstHour],
    )
    expect(Number(open.rows[0]!.n)).toBe(0)
  })

  test("the indexer's views match the contracts exactly", async () => {
    const { body } = await idx<{ balance: string; hourlyCap: string; dailyCap: string; reserve: string; servable: boolean }>(`/idx/v1/buyers/${buyer}`)
    const onChain = await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "buyerState", args: [buyer] })
    expect(body.data.balance).toBe(onChain.balance.toString())
    expect(body.data.hourlyCap).toBe(onChain.hourlyCap.toString())
    expect(body.data.dailyCap).toBe(onChain.dailyCap.toString())
    expect(body.data.reserve).toBe(onChain.reserve.toString())
    expect(await crossCheckBuyers({ db, reader, vault: contract("OffpeakVault"), metrics })).toBe(0)

    const hostView = await idx<{ pendingCredits: string; releasableCredits: string; bondUsdg: string; status: number }>(`/idx/v1/hosts/${host}`)
    const hostOnChain = await reader.readContract({ address: contract("HostRegistry"), abi: HostRegistryAbi, functionName: "hostView", args: [host] })
    expect(hostView.body.data.pendingCredits).toBe(hostOnChain.pendingCredits.toString())
    expect(hostView.body.data.releasableCredits).toBe(hostOnChain.releasableCredits.toString())
    expect(hostView.body.data.bondUsdg).toBe(hostOnChain.bondUsdg.toString())
    expect(hostView.body.data.status).toBe(hostOnChain.status)
  })

  test("a forged record is excluded automatically and the hour still lands", async () => {
    const hour = firstHour + 3
    await mineAt(hourStart(hour) + 60)
    await syncBuyer()
    const honest = await serve("honest")
    owed += costOf(honest)

    const forged = keccak256(toBytes("forged"))
    await db.query(
      `INSERT INTO shared.usage_records (req_id, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out,
         prompt_hash, output_hash, price_in, price_out, host_cost_micro, fee_micro, fee_bps, pay_mode, pay_ref, sheet_hash,
         router_sig, host_sig, leaf)
       SELECT $1, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out, prompt_hash, output_hash,
         price_in, price_out, host_cost_micro * 50, fee_micro * 50, fee_bps, pay_mode, pay_ref, sheet_hash, router_sig, host_sig, leaf
       FROM shared.usage_records WHERE req_id = $2`,
      [forged, honest.record.reqId],
    )
    await closeAndSettle(hour)

    expect(Number(await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "lastSettledHour" }))).toBe(hour)
    expect(await vaultBalance()).toBe(DEPOSIT - owed)
    const rejected = await db.query<{ reason: string }>("SELECT reason FROM chain.settlement_rejects WHERE req_id = $1", [forged])
    expect(rejected.rows).toHaveLength(1)
    expect((await idx(`/idx/v1/usage/${forged}/proof`)).status).toBe(404)
    expect((await idx(`/idx/v1/usage/${honest.record.reqId}/proof`)).status).toBe(200)
  }, 60_000)

  test("withdraw-all inside an hour debits that hour up to the request time, then pays out", async () => {
    const hour = firstHour + 4
    await mineAt(hourStart(hour) + 120)
    await syncBuyer()
    const before = await serve("before exit")
    owed += costOf(before)

    await mineAt(hourStart(hour) + 300)
    await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi as never, "requestWithdrawAll")
    await tick(ingest, ingestState)
    expect(pushes.some((p) => p.type === "WithdrawAllRequested")).toBe(true)

    const refused = await ask("after exit")
    expect(refused.status).toBe(403)

    await closeAndSettle(hour)
    expect(await vaultBalance()).toBe(DEPOSIT - owed)

    const usdgBefore = await reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [buyer] })
    const keeperAccount = roleAccount("rulingA")
    const executed = await runWithdrawAll({
      db,
      reader,
      writer: createWalletClient({ account: keeperAccount, transport: http(chain.rpcUrl), chain: null }) as never,
      account: keeperAccount,
      contracts: chain.contracts,
      metrics,
    })
    expect(executed).toEqual([buyer])
    await tick(ingest, ingestState)
    const usdgAfter = await reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [buyer] })
    expect(usdgAfter - usdgBefore).toBe(DEPOSIT - owed)
    expect(await vaultBalance()).toBe(0n)
    expect((await idx<{ balance: string }>(`/idx/v1/buyers/${buyer}`)).body.data.balance).toBe("0")
  }, 60_000)

  test("an upheld dispute is paid from the reserve into the payer's vault balance", async () => {
    const billed = await db.query<{ req_id: string; cost: string }>(
      `SELECT r.req_id, r.host_cost_micro + r.fee_micro AS cost FROM shared.usage_records r JOIN chain.settlements s ON s.hour = r.hour
       WHERE r.payer = $1 AND r.status = 'final' AND r.req_id NOT IN (SELECT req_id FROM chain.settlement_rejects) LIMIT 1`,
      [buyer],
    )
    const amount = BigInt(billed.rows[0]!.cost)
    await send(host, contract("MockUSDG"), MockUSDGAbi as never, "approve", [contract("OffpeakVault"), amount])
    await send(host, contract("OffpeakVault"), OffpeakVaultAbi as never, "fundReserve", [amount])
    await db.query("INSERT INTO shared.refunds (id, payer, amount, reason, req_ids) VALUES ($1,$2,$3,$4,$5)", [
      "dispute:1",
      buyer,
      amount.toString(),
      "dispute_upheld",
      [billed.rows[0]!.req_id],
    ])
    await mineAt(hourStart(hourIndex(await chainTime()) + 1) + 60)
    await tick(ingest, ingestState)

    for (const worker of workers) await refundPass(worker)
    await tick(ingest, ingestState)
    expect(await vaultBalance()).toBe(amount)
    const row = await db.query<{ paid_hour: string | null }>("SELECT paid_hour FROM shared.refunds WHERE id = 'dispute:1'")
    expect(row.rows[0]!.paid_hour).not.toBeNull()

    for (const worker of workers) await refundPass(worker)
    expect(await vaultBalance()).toBe(amount)
  }, 60_000)

  test("the keeper activates a host once probation ends", async () => {
    const view = await reader.readContract({ address: contract("HostRegistry"), abi: HostRegistryAbi, functionName: "hostView", args: [host] })
    await mineAt(Number(view.probationEnds) + 1)
    await tick(ingest, ingestState)
    const keeperAccount = roleAccount("rulingB")
    const activated = await runHostActivate({
      db,
      reader,
      writer: createWalletClient({ account: keeperAccount, transport: http(chain.rpcUrl), chain: null }) as never,
      account: keeperAccount,
      contracts: chain.contracts,
      metrics,
    })
    expect(activated).toEqual([host])
    await tick(ingest, ingestState)
    expect((await idx<{ routable: boolean }>(`/idx/v1/hosts/${host}`)).body.data.routable).toBe(true)
  }, 60_000)
})
