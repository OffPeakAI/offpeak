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
