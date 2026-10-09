import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { PUBLISHED_BASELINE, mulberry32 } from "../../packages/audit-tests/src/index.ts"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { advanceFlagged, runSequential, scorePending, weekStartOf } from "../../apps/auditor/src/run.ts"
import { fileMetering, reconcileFilings } from "../../apps/auditor/src/file.ts"
import { proveSamples } from "../../apps/auditor/src/evidence.ts"
import { saveCalibration, calibrateModel, type ScoredRow } from "../../apps/auditor/src/calibrate.ts"
import type { AuditDeps } from "../../apps/auditor/src/deps.ts"
import { createHostApp } from "../../apps/host-agent/src/mock-engine.ts"
import { seedOf, serveTokens, tokensToText, scoreTokens, CLAIMED } from "../../apps/host-agent/src/mock-model.ts"
import { LiveChain } from "../../apps/router/src/chainview/live.ts"
import { closeHour } from "../../apps/router/src/metering/hourclose.ts"
import { AuditCourtAbi, HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi } from "../../packages/abis/src/index.ts"
import { gpuClassOf, hourEnd, hourIndex, weekIndex } from "../../packages/shared/src/index.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { Metrics, openDatabase, type Db } from "../../services/common/src/index.ts"
import { createApi } from "../../services/indexer/src/api.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { rulingTick, type RulingDeps } from "../../services/rulings/src/review.ts"
import { insertRow, signRow } from "../../services/settlement/src/test-rows.ts"
import type { UsageRow } from "../../services/settlement/src/verify.ts"
import { settlementTick, type WorkerDeps } from "../../services/settlement/src/worker.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

/** The real `AuditCourt` on local anvil, reached through the auditor's own jobs. */
const CHAIN_PORT = 32545
const INDEXER_PORT = 32546
const TOKEN = "local-test-token-0123456789abcdef"
const BOND = 2_000_000_000n
const CHALLENGE_BOND = 100_000_000n
const START = 1_799_906_400 // A Wednesday, so no run crosses a week.
const MODEL = keccak256(toBytes("model"))
const IMAGE = keccak256(toBytes("image"))
const GPU = gpuClassOf("h100-80g-sxm")
const REF_A = "0x00000000000000000000000000000000000000a1"
const REF_B = "0x00000000000000000000000000000000000000b2"
const RECORDS = 480

const hostAccount = roleAccount("host")
const host = hostAccount.address.toLowerCase() as Address
const buyer = roleAccount("buyer").address.toLowerCase() as Address
const auditorAccount = anvilAccount(19)
const settlerAccounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]
const rulerAccounts = [roleAccount("rulingA"), roleAccount("rulingB"), roleAccount("rulingC")]

let chain: LocalChain
let reader: PublicClient
let db: Db
let ingest: IngestDeps
let workers: WorkerDeps[]
let rulers: RulingDeps[]
let rows: UsageRow[]
let hour: number
let deps: AuditDeps
let server: ReturnType<typeof Bun.serve>
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
const nextChallenge = () => reader.readContract({ address: contract("AuditCourt"), abi: AuditCourtAbi, functionName: "nextChallengeId" })

async function settleHour() {
  for (let pass = 0; pass < 3; pass++) {
    await tick(ingest, ingestState)
    for (const worker of workers) await settlementTick(worker)
  }
  await tick(ingest, ingestState)
}

async function ruleAll() {
  await tick(ingest, ingestState)
  for (const ruler of rulers) await rulingTick(ruler)
  await tick(ingest, ingestState)
}

async function rulingReason(id: string) {
  const signed = await db.query<{ batch: { reason: string } }>("SELECT batch FROM chain.settlement_sigs WHERE kind = 'ruling' AND hour = $1 LIMIT 1", [id])
  return signed.rows[0]!.batch.reason
}

const referenceApps = new Map<string, ReturnType<typeof createHostApp>["app"]>()

function reference(label: string, noise: number) {
  referenceApps.set(
    label,
    createHostApp({
      operator: hostAccount as never,
      routerAddress: roleAccount("router").address,
      usageLedger: contract("UsageLedger"),
      modelDigest: MODEL,
      modelName: "ofm-8b",
      imageDigest: IMAGE,
      gpuClass: "h100-80g-sxm",
      swap: false,
      serving: { gpuNoise: noise, gpuSeed: seedOf(label) },
      sealed: false,
      auditorAddress: auditorAccount.address,
    }).app,
  )
}

/** Baselines fitted on this model's honest engine, under the chain's own class and image. */
async function seedBaselines() {
  const rng = mulberry32(11)
  const honest: ScoredRow[] = []
  for (let week = 0; week < 8; week++) {
    for (let i = 0; i < 600; i++) {
      const prompt = Math.floor(rng() * 0xffffffff)
      const tokens = serveTokens({ gpuNoise: 0.04, gpuSeed: week }, prompt, i, 0.7, 128).tokens
      const logprobs = scoreTokens({ ...CLAIMED, gpuNoise: 0.02, gpuSeed: seedOf("ref-a") }, prompt, tokens)
      honest.push({ hostWeek: `w${week}`, gpuClass: GPU, imageDigest: IMAGE, temperature: 0.7, tokensOut: tokens.length, ll: logprobs.reduce((a, b) => a + b, 0) / logprobs.length })
    }
  }
  await saveCalibration(db, { ...calibrateModel({ modelDigest: MODEL, source: "simulation", honest, swaps: [], seed: 1, now: 1 }) })
}

/** Canaries through a host that swaps a quarter of its replies, as the auditor would have recorded them. */
async function seedCanaries() {
  for (const [i, row] of rows.entries()) {
    const messages = [{ role: "user", content: `canary prompt ${i}` }]
    const { tokens } = serveTokens({ swapRate: 0.25, swapModel: "small", gpuNoise: 0.04, gpuSeed: 1 }, seedOf(JSON.stringify(messages)), i + 1, 0.7, 128)
    await db.query(
      `INSERT INTO serving.canary_runs (id, host, expected, output, passed, req_id, model_digest, prompt_id, deterministic, body, tool_calls, wallet, tokens_out, ts)
       VALUES ($1,$2,'[]'::jsonb,$3,NULL,$4,$5,'open:1',false,$6::jsonb,'[]'::jsonb,$7,$8,$9)`,
      [crypto.randomUUID(), host, tokensToText(tokens), row.req_id, MODEL, JSON.stringify({ model: "ofm-8b", messages, temperature: 0.7, max_tokens: 128 }), buyer, tokens.length, row.ts],
    )
  }
}

beforeAll(async () => {
  chain = await startLocalChain(CHAIN_PORT, { timestamp: START })
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 50 }) as PublicClient
  db = await openDatabase("pglite://memory")
  await db.exec(readFileSync(new URL("../../db/serving/schema.sql", import.meta.url), "utf8"))

  await send(auditorAccount.address, contract("MockUSDG"), MockUSDGAbi, "mint", [auditorAccount.address, 1_000_000_000n])
  await send(buyer, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("OffpeakVault"), 100_000_000n])
  await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi, "deposit", [100_000_000n])
  await send(buyer, contract("OffpeakVault"), OffpeakVaultAbi, "setCaps", [50_000_000n, 0n])
  await send(host, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), BOND])
  await send(host, contract("HostRegistry"), HostRegistryAbi, "register", [
    { modelDigests: [MODEL], maxTps: [100], imageDigest: IMAGE, gpuClass: GPU, endpointHash: keccak256(toBytes("endpoint")), attestationRef: `0x${"00".repeat(32)}`, bondUsdg: BOND, bondOfpk: 0n },
  ])

  ingest = { db, reader, contracts: chain.contracts, confirmations: 1, publish: () => {} }
  const shared = { db, reader, contracts: chain.contracts, chainId: 4663 }
  const wallet = (account: never) => createWalletClient({ account, transport: http(chain.rpcUrl), chain: null }) as never
  workers = settlerAccounts.map((account) => ({ ...shared, writer: wallet(account as never), account: account as never, routerAddress: roleAccount("router").address, settlers: settlerAccounts.map((s) => s.address), metrics }))
  rulers = rulerAccounts.map((account) => ({ ...shared, writer: wallet(account as never), account: account as never, rulers: rulerAccounts.map((r) => r.address) }))

  const registeredAt = await chainTime()
  hour = hourIndex(registeredAt)
  await tick(ingest, ingestState)
  const signed = await Promise.all(Array.from({ length: RECORDS }, (_, i) => signRow({ i, hour, payer: buyer, ts: Math.min(registeredAt + 1 + Math.floor(i / 2), hourEnd(hour) - 1) }, contract("UsageLedger"))))
  rows = signed.sort((a, b) => a.ts - b.ts || (a.req_id < b.req_id ? -1 : 1))
  for (const row of rows) await insertRow(db, row)
  await mineAt(hourEnd(hour) + 600)
  await closeHour(db as never, hour, roleAccount("router") as never, contract("UsageLedger"))
  await settleHour()
  await mineAt(hourEnd(hour) + 3 * 3_600)

  server = Bun.serve({ port: INDEXER_PORT, fetch: createApi({ db, reader, contracts: chain.contracts, internalToken: TOKEN, metrics }).fetch })
  reference("ref-a", 0.02)
  reference("ref-b", 0.03)
  await db.query("INSERT INTO serving.audit_reference_hosts (host, model_digest, endpoint, gpu_class, image_digest, attested) VALUES ($1,$2,'http://ref-a',$3,$4,true)", [REF_A, MODEL, GPU, IMAGE])
  await seedBaselines()
  await seedCanaries()

  deps = {
    env: "local",
    db,
    chain: new LiveChain({ url: `http://127.0.0.1:${INDEXER_PORT}`, token: TOKEN, endpointOf: () => "" }),
    fetcher: (url, init) => Promise.resolve(referenceApps.get(new URL(url).hostname)!.request(new URL(url).pathname, init)),
    account: auditorAccount as never,
    reader,
    writer: createWalletClient({ account: auditorAccount, transport: http(chain.rpcUrl), chain: null }) as never,
    contracts: chain.contracts,
    metrics,
    kek: randomBytes(32),
    routerUrl: "http://router.local",
    indexerUrl: `http://127.0.0.1:${INDEXER_PORT}`,
    internalToken: TOKEN,
    accounts: [],
    corpus: null,
    models: [{ name: "ofm-8b", digest: MODEL }],
    enqueueCanary: async () => undefined,
    fileThroughput: false,
    rng: mulberry32(5),
    clock: () => hourEnd(hour) + 3 * 3_600,
  }
}, 240_000)

afterAll(() => {
  server?.stop(true)
  chain?.stop()
})

describe("the auditor against the real AuditCourt", () => {
  test("responses are scored by a reference host, over the signed path", async () => {
    for (let pass = 0; pass < 4; pass++) await scorePending(deps)
    const scores = await db.query<{ n: string; low: string }>("SELECT count(*) AS n, count(*) FILTER (WHERE z < -1.5) AS low FROM serving.audit_scores WHERE z IS NOT NULL")
    expect(Number(scores.rows[0]!.n)).toBe(RECORDS)
    expect(Number(scores.rows[0]!.low)).toBeGreaterThan(RECORDS * 0.1)
  }, 120_000)

  test("the test flags the host, and a flag alone files nothing", async () => {
    const before = await usdgOf(auditorAccount.address)
    const nextId = await nextChallenge()
    const read = await runSequential(deps)
    expect(read).toMatchObject({ pairs: 1, flagged: 1 })
    const run = await db.query<{ stopped_at: number; boost_until: string; state: string; n: number }>("SELECT stopped_at, boost_until, state, n FROM serving.audit_runs")
    expect(run.rows[0]!.state).toBe("flagged")
    expect(run.rows[0]!.stopped_at).toBeGreaterThanOrEqual(PUBLISHED_BASELINE.minN)
    expect(Number(run.rows[0]!.boost_until)).toBeGreaterThan(deps.clock())

    expect(await advanceFlagged(deps)).toEqual([{ host, result: "second_signal_missing" }])
    expect(await nextChallenge()).toBe(nextId)
    expect(await usdgOf(auditorAccount.address)).toBe(before)
    expect((await db.query("SELECT 1 FROM serving.audit_filings")).rows).toHaveLength(0)
    expect(metrics.get("auditor_no_second_reference")).toBeGreaterThan(0)
  }, 120_000)

  test("with a second reference host the swap is filed, bonded and ruled on both signals", async () => {
    await db.query("INSERT INTO serving.audit_reference_hosts (host, model_digest, endpoint, gpu_class, image_digest, attested) VALUES ($1,$2,'http://ref-b',$3,$4,true)", [REF_B, MODEL, GPU, IMAGE])
    const before = await usdgOf(auditorAccount.address)
    const id = await nextChallenge()
    const outcomes = await advanceFlagged(deps)
    expect(outcomes).toEqual([{ host, result: "filed" }])
    expect(await nextChallenge()).toBe(id + 1n)
    expect(before - (await usdgOf(auditorAccount.address))).toBe(CHALLENGE_BOND)

    const filing = await db.query<{ status: string; kind: number; signal_sequential: boolean; signal_replication: boolean; signal_canary: boolean; challenge_id: string; samples_root: string }>("SELECT * FROM serving.audit_filings")
    expect(filing.rows[0]).toMatchObject({ status: "filed", kind: 0, signal_sequential: true, signal_replication: true, signal_canary: false, challenge_id: id.toString() })
    const run = await db.query<{ state: string; filed_challenge_id: string }>("SELECT state, filed_challenge_id FROM serving.audit_runs")
    expect(run.rows[0]).toEqual({ state: "filed", filed_challenge_id: id.toString() })

    await send(host, contract("AuditCourt"), AuditCourtAbi, "respond", [id, keccak256(toBytes("we served the right model"))])
    await ruleAll()
    expect(await rulingReason(id.toString())).toBe("both_signals")
    const state = await db.query<{ state: string }>("SELECT state FROM chain.challenges WHERE id = $1", [id.toString()])
    expect(state.rows[0]!.state).toBe("panel_review")
    const view = await reader.readContract({ address: contract("HostRegistry"), abi: HostRegistryAbi, functionName: "hostView", args: [host] })
    expect(view.bondUsdg).toBe(BOND)
  }, 120_000)

  test("the filed bundle's proofs verify against the posted root, and its root is the one on chain", async () => {
    const filing = await db.query<{ samples_root: Hex }>("SELECT samples_root FROM serving.audit_filings")
    const logs = await reader.getContractEvents({ address: contract("AuditCourt"), abi: AuditCourtAbi, eventName: "EvidenceFiled", fromBlock: 0n })
    expect((logs[0]!.args as { samplesRoot: Hex }).samplesRoot).toBe(filing.rows[0]!.samples_root)
    expect((logs[0]!.args as { uri: string }).uri).toBe(`offpeak://evidence/${filing.rows[0]!.samples_root}`)
  }, 30_000)

  test("a rerun cannot file the same case twice", async () => {
    const id = await nextChallenge()
    expect(await advanceFlagged(deps)).toEqual([])
    await db.query("UPDATE serving.audit_runs SET state = 'flagged'")
    expect(await advanceFlagged(deps)).toEqual([])
    expect(await nextChallenge()).toBe(id)
  }, 30_000)

  test("after a crash, a landed challenge is confirmed from the chain and not sent again", async () => {
    const id = await nextChallenge()
    await db.query("UPDATE serving.audit_filings SET status = 'prepared', tx_hash = NULL, challenge_id = NULL")
    await reconcileFilings(deps)
    const row = await db.query<{ status: string; challenge_id: string }>("SELECT status, challenge_id FROM serving.audit_filings")
    expect(row.rows[0]!.status).toBe("filed")
    expect(row.rows[0]!.challenge_id).toBe((id - 1n).toString())
    expect(await nextChallenge()).toBe(id)
  }, 30_000)

  test("a metering bundle reaches the court as kind 2 and rules as a breach", async () => {
    const week = weekIndex(rows[0]!.ts)
    const proved = await proveSamples(deps, rows.slice(0, 300).map((row) => row.req_id))
    expect(proved.size).toBe(300)
    const samples = [...proved.values()].map((row, i) => ({ ...row, z: 0, canaryFail: false, refAgrees: false, meteringFlag: i < 20 }))
    const bundle = { v: 1 as const, host: host as Hex, modelDigest: MODEL, testId: "metering-v1", testVersion: "1", baseline: { ...PUBLISHED_BASELINE }, samples, attachments: { records: rows.length } }
    const id = await nextChallenge()
    expect(await fileMetering(deps, bundle, week)).toMatchObject({ filed: true, challengeId: id.toString() })
    const row = await db.query<{ kind: number }>("SELECT kind FROM chain.challenges WHERE id = $1", [id.toString()])
    await tick(ingest, ingestState)
    expect(row.rows).toHaveLength(0)
    const filed = await db.query<{ kind: number }>("SELECT kind FROM chain.challenges WHERE id = $1", [id.toString()])
    expect(Number(filed.rows[0]!.kind)).toBe(2)
    await send(host, contract("AuditCourt"), AuditCourtAbi, "respond", [id, keccak256(toBytes("our counts were right"))])
    await ruleAll()
    expect(await rulingReason(id.toString())).toBe("metering_flags")
  }, 60_000)

  test("the week the run read is the one the rows sit in", () => {
    expect(weekStartOf(weekIndex(rows[0]!.ts))).toBeLessThanOrEqual(rows[0]!.ts)
  })
})
