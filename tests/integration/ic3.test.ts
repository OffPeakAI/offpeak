import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { closeHour } from "../../apps/router/src/metering/hourclose.ts"
import { AuditCourtAbi, HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi } from "../../packages/abis/src/index.ts"
import { PUBLISHED_BASELINE, TEST_ID, TEST_VERSION, mulberry32, score, simulateWeek } from "../../packages/audit-tests/src/index.ts"
import { evidenceRoot, hourEnd, hourIndex, merkleProof, scaleStatistic, testIdHash, type EvidenceBundle } from "../../packages/shared/src/index.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { Metrics, openDatabase, type Db } from "../../services/common/src/index.ts"
import { createApi } from "../../services/indexer/src/api.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { runChallengeFinalize, runRefundClaims } from "../../services/keepers/src/jobs/challenges.ts"
import type { KeeperDeps } from "../../services/keepers/src/jobs/types.ts"
import { panelPacket } from "../../services/rulings/src/panel.ts"
import { rulingTick, type RulingDeps } from "../../services/rulings/src/review.ts"
import { insertRow, signRow } from "../../services/settlement/src/test-rows.ts"
import type { UsageRow } from "../../services/settlement/src/verify.ts"
import { settlementTick, type WorkerDeps } from "../../services/settlement/src/worker.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29552
const TOKEN = "local-test-token-0123456789abcdef"
const BOND = 2_000_000_000n
const CHALLENGE_BOND = 100_000_000n
const FROZEN = 3
const ACTIVE_OR_PROBATION = 1
const DELISTED = 5

const router = roleAccount("router")
const hostAccount = roleAccount("host")
const host = hostAccount.address.toLowerCase() as Address
const buyerA = roleAccount("buyer").address.toLowerCase() as Address
const buyerB = anvilAccount(18).address.toLowerCase() as Address
const auditor = anvilAccount(19).address.toLowerCase() as Address
const panelAccount = anvilAccount(15)
const keeperAccount = anvilAccount(13)
const settlerAccounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]
const rulerAccounts = [roleAccount("rulingA"), roleAccount("rulingB"), roleAccount("rulingC")]

let chain: LocalChain
let reader: PublicClient
let db: Db
let ingest: IngestDeps
let workers: WorkerDeps[]
let rulers: RulingDeps[]
let keeper: KeeperDeps
let rows: UsageRow[]
let hour: number
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
}

async function send(account: Address, address: Address, abi: unknown, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never)
  return reader.waitForTransactionReceipt({ hash })
}

const usdgOf = (who: Address) => reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [who] })
const hostView = () => reader.readContract({ address: contract("HostRegistry"), abi: HostRegistryAbi, functionName: "hostView", args: [host] })

async function challengeRow(id: number) {
  const found = await db.query<{ state: string; outcome: number | null; slash_bps: number | null }>("SELECT state, outcome, slash_bps FROM chain.challenges WHERE id = $1", [id])
  return found.rows[0]!
}

async function rulingReason(id: number) {
  const signed = await db.query<{ batch: { reason: string } }>("SELECT batch FROM chain.settlement_sigs WHERE kind = 'ruling' AND hour = $1 LIMIT 1", [id])
  return signed.rows[0]!.batch.reason
}

async function settleHour() {
  for (let pass = 0; pass < 3; pass++) {
    await tick(ingest, ingestState)
    for (const worker of workers) await settlementTick(worker)
  }
  await tick(ingest, ingestState)
}

/** Every ruling process runs its own pass, the way their independent loops would. */
async function ruleAll() {
  await tick(ingest, ingestState)
  for (const ruler of rulers) await rulingTick(ruler)
  await tick(ingest, ingestState)
}

function bundleFrom(zs: number[], secondSignal: boolean, target: Address = host): EvidenceBundle {
  const leaves = rows.map((row) => row.leaf as Hex)
  return {
    v: 1,
    host: target,
    modelDigest: keccak256(toBytes("model")),
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    baseline: { ...PUBLISHED_BASELINE },
    samples: zs.map((z, i) => ({
      reqId: rows[i]!.req_id as Hex,
      hour,
      leaf: rows[i]!.leaf as Hex,
      proof: merkleProof(leaves, i),
      z,
      canaryFail: false,
      refAgrees: secondSignal && i === 0,
      meteringFlag: false,
    })),
  }
}

/** What the auditor does: store the bundle, then file against its root. */
async function fileChallenge(bundle: EvidenceBundle) {
  const root = evidenceRoot(bundle)
  await db.query("INSERT INTO shared.evidence_bundles (samples_root, body) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING", [root, JSON.stringify(bundle)])
  const result = score(bundle.samples.map((s) => ({ z: s.z })), PUBLISHED_BASELINE)
  await send(auditor, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("AuditCourt"), CHALLENGE_BOND])
  await send(auditor, contract("AuditCourt"), AuditCourtAbi, "challenge", [
    {
      host: bundle.host,
      kind: 0,
      modelDigest: bundle.modelDigest,
      samplesRoot: root,
      sampleCount: bundle.samples.length,
      testId: testIdHash(TEST_ID),
      statistic: scaleStatistic(result.statistic),
      threshold: scaleStatistic(result.threshold),
      uri: `offpeak://evidence/${root}`,
    },
  ])
  await tick(ingest, ingestState)
  const latest = await db.query<{ id: string }>("SELECT max(id) AS id FROM chain.challenges")
  return Number(latest.rows[0]!.id)
}

function weekWhere(swapRate: number, wantFlagged: boolean) {
  for (let seed = 1; seed < 500; seed++) {
    const week = simulateWeek(mulberry32(seed), 200, swapRate, PUBLISHED_BASELINE.delta)
    if (score(week, PUBLISHED_BASELINE).flagged === wantFlagged) return week.map((s) => s.z)
  }
  throw new Error("no such week")
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 50 }) as PublicClient
  db = await openDatabase("pglite://memory")
  await db.exec("CREATE SCHEMA serving; CREATE TABLE serving.hour_locks (hour bigint PRIMARY KEY);")

  for (const [who, amount] of [[buyerB, 100_000_000n], [auditor, 1_000_000_000n]] as const) {
    await send(auditor, contract("MockUSDG"), MockUSDGAbi, "mint", [who, amount])
  }
  for (const buyer of [buyerA, buyerB]) {
    await send(buyer, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("OffpeakVault"), 100_000_000n])
    await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi, "deposit", [100_000_000n])
    await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi, "setCaps", [50_000_000n, 0n])
  }
  await send(host, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), BOND])
  await send(host, contract("HostRegistry"), HostRegistryAbi, "register", [
    {
      modelDigests: [keccak256(toBytes("model"))],
      maxTps: [100],
      imageDigest: keccak256(toBytes("image")),
      gpuClass: keccak256(toBytes("h100-80g-sxm")),
      endpointHash: keccak256(toBytes("endpoint")),
      attestationRef: `0x${"00".repeat(32)}`,
      bondUsdg: BOND,
      bondOfpk: 0n,
    },
  ])

  ingest = { db, reader, contracts: chain.contracts, confirmations: 1, publish: () => {} }
  const shared = { db, reader, contracts: chain.contracts, chainId: 4663 }
  const wallet = (account: never) => createWalletClient({ account, transport: http(chain.rpcUrl), chain: null }) as never
  workers = settlerAccounts.map((account) => ({
    ...shared,
    writer: wallet(account as never),
    account: account as never,
    routerAddress: router.address,
    settlers: settlerAccounts.map((s) => s.address),
    metrics,
  }))
  rulers = rulerAccounts.map((account) => ({
    ...shared,
    writer: wallet(account as never),
    account: account as never,
    rulers: rulerAccounts.map((r) => r.address),
    auditor,
  }))
  keeper = { db, reader, writer: wallet(keeperAccount as never), account: keeperAccount, contracts: chain.contracts, metrics }

  const registeredAt = await chainTime()
  hour = hourIndex(registeredAt)
  await tick(ingest, ingestState)
  const count = 210
  rows = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      signRow(
        { i, hour, payer: i % 4 === 0 ? buyerB : buyerA, ts: Math.min(registeredAt + 1 + i, hourEnd(hour) - 1) },
        contract("UsageLedger"),
      ),
    ),
  )
  rows.sort((a, b) => (a.req_id < b.req_id ? -1 : 1))
  for (const row of rows) await insertRow(db, row)
  await mineAt(hourEnd(hour) + 600)
  await closeHour(db as never, hour, router as never, contract("UsageLedger"))
  await settleHour()
}, 180_000)

afterAll(() => {
  chain?.stop()
})

describe("IC3: a swap host from flag to slash", () => {
  test("the usage the evidence rests on settled on chain", async () => {
    const lastSettled = await reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName: "lastSettledHour" })
    expect(Number(lastSettled)).toBe(hour)
    expect((await hostView()).pendingCredits).toBeGreaterThan(0n)
    const excluded = await db.query("SELECT 1 FROM chain.settlement_rejects")
    expect(excluded.rows).toHaveLength(0)
  })

  test("an honest host is not flagged across the calibration range", () => {
    let flagged = 0
    for (let seed = 1; seed <= 200; seed++) {
      if (score(simulateWeek(mulberry32(seed), 200, 0, PUBLISHED_BASELINE.delta), PUBLISHED_BASELINE).flagged) flagged++
    }
    expect(flagged / 200).toBeLessThanOrEqual(0.01)
  })

  test("a challenge the data does not support is dismissed and costs the challenger half", async () => {
    const auditorBefore = await usdgOf(auditor)
    const hostBefore = await usdgOf(host)
    const id = await fileChallenge(bundleFrom(weekWhere(0, false), true))
    await send(host, contract("AuditCourt"), AuditCourtAbi, "respond", [BigInt(id), keccak256(toBytes("we served the right model"))])
    await ruleAll()

    const row = await challengeRow(id)
    expect(row.state).toBe("finalized")
    expect(Number(row.outcome)).toBe(0)
    expect(await rulingReason(id)).toBe("test_not_flagged")
    expect((await usdgOf(host)) - hostBefore).toBe(CHALLENGE_BOND / 2n)
    expect(auditorBefore - (await usdgOf(auditor))).toBe(CHALLENGE_BOND / 2n)
    expect((await hostView()).bondUsdg).toBe(BOND)
  }, 60_000)

  test("another host's real records cannot frame a host", async () => {
    const framed = anvilAccount(17).address.toLowerCase() as Address
    await send(auditor, contract("MockUSDG"), MockUSDGAbi, "mint", [framed, BOND])
    await send(framed, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), BOND])
    await send(framed, contract("HostRegistry"), HostRegistryAbi, "register", [
      {
        modelDigests: [keccak256(toBytes("model"))],
        maxTps: [100],
        imageDigest: keccak256(toBytes("image")),
        gpuClass: keccak256(toBytes("h100-80g-sxm")),
        endpointHash: keccak256(toBytes("endpoint")),
        attestationRef: `0x${"00".repeat(32)}`,
        bondUsdg: BOND,
        bondOfpk: 0n,
      },
    ])
    const id = await fileChallenge(bundleFrom(weekWhere(0.25, true), true, framed))
    await send(framed, contract("AuditCourt"), AuditCourtAbi, "respond", [BigInt(id), keccak256(toBytes("not my records"))])
    await ruleAll()

    expect(await rulingReason(id)).toBe("leaf_unproven")
    const view = await reader.readContract({ address: contract("HostRegistry"), abi: HostRegistryAbi, functionName: "hostView", args: [framed] })
    expect(view.status).toBe(ACTIVE_OR_PROBATION)
    expect(view.bondUsdg).toBe(BOND)
  }, 60_000)

  test("if the panel never acts, the keeper dismisses and nothing is lost", async () => {
    const pending = (await hostView()).pendingCredits
    const id = await fileChallenge(bundleFrom(weekWhere(0.25, true), true))
    await send(host, contract("AuditCourt"), AuditCourtAbi, "respond", [BigInt(id), keccak256(toBytes("response"))])
    await ruleAll()
    expect(await rulingReason(id)).toBe("both_signals")
    expect((await hostView()).status).toBe(FROZEN)
    expect((await hostView()).pendingCredits).toBe(0n)

    const review = await db.query<{ review_ends_at: string }>("SELECT review_ends_at FROM chain.challenges WHERE id = $1", [id])
    await mineAt(Number(review.rows[0]!.review_ends_at) + 8 * 86_400)
    await tick(ingest, ingestState)
    expect(await runChallengeFinalize(keeper)).toEqual([id])
    await tick(ingest, ingestState)

    const view = await hostView()
    expect(view.status).toBe(ACTIVE_OR_PROBATION)
    expect(view.bondUsdg).toBe(BOND)
    expect(view.pendingCredits).toBe(pending)
    expect((await challengeRow(id)).state).toBe("finalized")
  }, 60_000)

  let swapId = 0

  test("a flagged host with a second signal is ruled a swap, frozen and not yet slashed", async () => {
    // A root counts once, so this run's evidence is its own.
    swapId = await fileChallenge({ ...bundleFrom(weekWhere(0.25, true), true), attachments: { run: "swap" } } as EvidenceBundle)
    await send(host, contract("AuditCourt"), AuditCourtAbi, "respond", [BigInt(swapId), keccak256(toBytes("response"))])
    await ruleAll()

    expect((await challengeRow(swapId)).state).toBe("panel_review")
    const view = await hostView()
    expect(view.status).toBe(FROZEN)
    expect(view.bondUsdg).toBe(BOND)
    const routable = await reader.readContract({ address: contract("HostRegistry"), abi: HostRegistryAbi, functionName: "routable", args: [host] })
    expect(routable).toBe(false)
  }, 60_000)

  test("the panel cannot confirm before the host's appeal window closes", async () => {
    const packet = await panelPacket({ db, reader, contracts: chain.contracts, chainId: 4663 }, swapId, "confirm")
    const panelSig = await panelAccount.signTypedData(packet.typedData as never)
    await expect(
      reader.simulateContract({
        address: contract("AuditCourt"),
        abi: AuditCourtAbi,
        functionName: "postPanelDecision",
        args: [packet.typedData.message as never, panelSig],
        account: keeperAccount,
      }),
    ).rejects.toThrow("ReviewNotOver")
  }, 30_000)

  test("the review packet tells the panel what it needs and holds no key", async () => {
    await send(host, contract("AuditCourt"), AuditCourtAbi, "appeal", [BigInt(swapId), keccak256(toBytes("appeal"))])
    await tick(ingest, ingestState)
    const packet = await panelPacket({ db, reader, contracts: chain.contracts, chainId: 4663 }, swapId, "confirm")
    expect(packet.evidence.samples).toBe(200)
    expect(packet.evidence.proofsVerify).toBe(true)
    expect(packet.evidence.rulingRecheck).toBe("both_signals")
    expect(packet.evidence.statistic).toBeGreaterThan(packet.evidence.threshold)
    expect(packet.appealHash).toBe(keccak256(toBytes("appeal")))
    expect(packet.typedData.message.finalSlashBps).toBe(10_000)
  }, 30_000)

  test("panel confirm slashes everything, delists, and refunds reach buyers by spend", async () => {
    const review = await db.query<{ review_ends_at: string }>("SELECT review_ends_at FROM chain.challenges WHERE id = $1", [swapId])
    await mineAt(Number(review.rows[0]!.review_ends_at))
    await tick(ingest, ingestState)

    const packet = await panelPacket({ db, reader, contracts: chain.contracts, chainId: 4663 }, swapId, "confirm")
    const panelSig = await panelAccount.signTypedData(packet.typedData as never)
    await send(keeperAccount.address, contract("AuditCourt"), AuditCourtAbi, "postPanelDecision", [packet.typedData.message, panelSig])
    await tick(ingest, ingestState)
    expect((await hostView()).bondUsdg).toBe(BOND)

    const auditorBefore = await usdgOf(auditor)
    const aBefore = await usdgOf(buyerA)
    const bBefore = await usdgOf(buyerB)
    expect(await runChallengeFinalize(keeper)).toEqual([swapId])
    await tick(ingest, ingestState)

    const view = await hostView()
    expect(view.bondUsdg).toBe(0n)
    expect(view.status).toBe(DELISTED)
    expect((await usdgOf(auditor)) - auditorBefore).toBe(CHALLENGE_BOND)
    expect((await challengeRow(swapId)).state).toBe("finalized")

    expect((await runRefundClaims(keeper)).sort()).toEqual([buyerA, buyerB].sort())
    await tick(ingest, ingestState)
    const toA = (await usdgOf(buyerA)) - aBefore
    const toB = (await usdgOf(buyerB)) - bBefore
    expect(toA).toBeGreaterThan(toB)
    expect(toA + toB).toBeLessThanOrEqual(BOND)
    expect(BOND - (toA + toB)).toBeLessThan(10n)
    expect(await runRefundClaims(keeper)).toEqual([])
  }, 60_000)

  test("the refund route serves what was paid", async () => {
    const api = createApi({ db, reader, contracts: chain.contracts, internalToken: TOKEN, metrics })
    const res = await api.request(`/public/v1/refunds/${swapId}/${buyerA}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { claimed: boolean } }
    expect(body.data.claimed).toBe(true)
    const listed = await api.request(`/idx/v1/challenges?host=${host}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(3)
  })
})
