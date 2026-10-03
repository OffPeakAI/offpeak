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
  }))
  keeper = { db, reader, writer: wallet(keeperAccount as never), account: keeperAccount, contracts: chain.contracts, metrics }
