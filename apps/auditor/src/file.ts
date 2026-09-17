import { AuditCourtAbi, MockUSDGAbi } from "@offpeak/abis"
import { TEST_ID, publishedBaseline, score } from "@offpeak/audit-tests"
import { CHALLENGE_BOND, evidenceRoot, scaleStatistic, testIdHash, type EvidenceBundle, type Hex } from "@offpeak/shared"
import { TransactionReceiptNotFoundError, decodeEventLog, encodeFunctionData, keccak256, parseTransaction, type Address } from "viem"
import { KIND_METERING, KIND_SWAP, KIND_THROUGHPUT, OUTCOME_BREACH, OUTCOME_SWAP, decideRuling } from "../../../services/rulings/src/decide.ts"
import { leavesProven } from "../../../services/rulings/src/review.ts"
import { log } from "../../../services/common/src/log.ts"
import { filingCalibrated } from "./calibrate.ts"
import { answerAccepted } from "./canaries.ts"
import type { AuditDeps } from "./deps.ts"
import { evidenceUri, storeBundle, type AuditBundle } from "./evidence.ts"

/** Below this the auditor raises the alarm, ten challenges short of being unable to file. */
export const LOW_BOND_MICRO = 1_000_000_000n

const SERVICE = "auditor"

export type SwapSignals = { sequential: boolean; canary: boolean; replication: boolean; reason: string | null }

function sameBaseline(bundle: EvidenceBundle) {
  const pinned = publishedBaseline(bundle.modelDigest)
  const given = bundle.baseline
  return given.epsilon === pinned.epsilon && given.delta === pinned.delta && given.logA === pinned.logA && given.minN === pinned.minN
}

/** Marks must match the attachment exactly: a flag with nothing behind it is a forged signal. */
function sameSet(marked: readonly { reqId: string }[], expected: ReadonlySet<string>) {
  return marked.length === expected.size && marked.every((row) => expected.has(row.reqId))
}

function canarySignal(bundle: AuditBundle) {
  const { canaries, canaryThreshold } = bundle.attachments
  const failed = new Set(canaries.filter((c) => c.deterministic && !answerAccepted(c.accepted, c.output)).map((c) => c.reqId))
  if (!sameSet(bundle.samples.filter((s) => s.canaryFail), failed)) return { ok: false, forged: true }
  return { ok: canaryThreshold > 0 && failed.size >= canaryThreshold, forged: false }
}

function replicationSignal(bundle: AuditBundle) {
  const { replication, firstRun } = bundle.attachments
  const marked = bundle.samples.filter((s) => s.refAgrees)
  if (!replication) return { ok: false, forged: marked.length > 0 }
  const host = bundle.host.toLowerCase()
  const independent = replication.refHost !== replication.primaryRef && replication.refHost !== host && replication.primaryRef !== host
  const firstIds = new Set<string>(bundle.samples.slice(0, firstRun).map((s) => s.reqId))
  const fresh = replication.reqIds.every((reqId) => !firstIds.has(reqId))
  const payers = new Map(bundle.samples.map((s) => [s.reqId as string, s.payer]))
  const flagged = score(replication.zs.map((z, i) => ({ z, payer: payers.get(replication.reqIds[i]!) })), publishedBaseline(bundle.modelDigest)).flagged
  const ok = independent && fresh && flagged && replication.zs.length === replication.reqIds.length
  if (!ok) return { ok: false, forged: marked.length > 0 }
  return { ok: sameSet(marked, new Set(replication.reqIds)), forged: !sameSet(marked, new Set(replication.reqIds)) }
}

/**
 * The two-signal rule, computed from the bundle alone. Every swap filing goes through here at the
 * last moment, so nothing a caller claims can stand in for what the evidence shows.
 */
export function swapSignals(bundle: AuditBundle): SwapSignals {
  const none = (reason: string): SwapSignals => ({ sequential: false, canary: false, replication: false, reason })
  if (bundle.testId !== TEST_ID) return none("unknown_test")
  if (!sameBaseline(bundle)) return none("baseline_not_pinned")
  const sequential = score(bundle.samples, bundle.baseline).flagged
  const canary = canarySignal(bundle)
  const replication = replicationSignal(bundle)
  if (canary.forged || replication.forged) return none("signal_not_supported_by_evidence")
  const reason = !sequential ? "test_not_flagged" : canary.ok || replication.ok ? null : "second_signal_missing"
  return { sequential, canary: canary.ok, replication: replication.ok, reason }
}

export type Refusal = { filed: false; reason: string }
export type Filed = { filed: true; challengeId: string; txHash: Hex; root: Hex; duplicate: boolean }

const refuse = (reason: string): Refusal => ({ filed: false, reason })

type FilingDeps = Pick<AuditDeps, "db" | "reader" | "writer" | "account" | "contracts" | "metrics" | "env">

export type EvidenceArgs = {
  host: Address
  kind: number
  modelDigest: Hex
  samplesRoot: Hex
  sampleCount: number
  testId: Hex
  statistic: bigint
  threshold: bigint
  uri: string
}

const usdg = (deps: Pick<AuditDeps, "contracts">) => (deps.contracts.MockUSDG ?? deps.contracts.USDG) as Address

export async function bondBalance(deps: Pick<AuditDeps, "reader" | "contracts" | "account">) {
  return deps.reader.readContract({ address: usdg(deps), abi: MockUSDGAbi, functionName: "balanceOf", args: [deps.account.address] })
}

/** Alerts once a check while challenge USDG runs low. Returns the balance. */
export async function checkBond(deps: Pick<AuditDeps, "reader" | "contracts" | "account" | "metrics">) {
  const balance = await bondBalance(deps)
  deps.metrics.set("auditor_bond_micro", Number(balance))
  deps.metrics.set("auditor_bond_low", balance < LOW_BOND_MICRO ? 1 : 0)
  if (balance < LOW_BOND_MICRO) log(SERVICE, "auditor_bond_low", { balance: balance.toString(), floor: LOW_BOND_MICRO.toString() })
  return balance
}

async function approveBond(deps: FilingDeps, court: Address) {
  const allowance = await deps.reader.readContract({ address: usdg(deps), abi: MockUSDGAbi, functionName: "allowance", args: [deps.account.address, court] })
  if (allowance >= CHALLENGE_BOND) return
  const hash = await deps.writer.writeContract({ address: usdg(deps), abi: MockUSDGAbi, functionName: "approve", args: [court, CHALLENGE_BOND], account: deps.account, chain: deps.writer.chain })
  await deps.reader.waitForTransactionReceipt({ hash })
}

function challengeIdOf(logs: readonly { data: Hex; topics: readonly Hex[] }[]) {
  for (const entry of logs) {
    try {
      const event = decodeEventLog({ abi: AuditCourtAbi, data: entry.data, topics: entry.topics as [Hex, ...Hex[]] })
      if (event.eventName === "ChallengeFiled") return (event.args as { challengeId: bigint }).challengeId.toString()
    } catch {
      continue
    }
  }
  return null
}

const jsonEvidence = (e: EvidenceArgs) => JSON.stringify({ ...e, statistic: e.statistic.toString(), threshold: e.threshold.toString() })

function fromJson(raw: Record<string, unknown>): EvidenceArgs {
  return { ...(raw as unknown as EvidenceArgs), statistic: BigInt(raw.statistic as string), threshold: BigInt(raw.threshold as string) }
}

/** A node that already holds this exact transaction, or has mined it, has what it needs. */
const ALREADY_THERE = /already known|already imported|nonce too low/i

async function broadcast(deps: FilingDeps, signed: Hex) {
  await deps.writer.sendRawTransaction({ serializedTransaction: signed }).catch((err: unknown) => {
    if (!ALREADY_THERE.test(String(err))) throw err
  })
}

/**
 * `AuditCourt.challenge` takes a new bond every call, so nothing here may send one twice. The hash and
 * the signed bytes are on disk before anything leaves: a crash after that can only resend these same
 * bytes, whose nonce lets the chain take them once.
 */
async function send(deps: FilingDeps, id: string, evidence: EvidenceArgs, root: Hex): Promise<Filed | Refusal> {
  const court = deps.contracts.AuditCourt as Address
  await approveBond(deps, court)
  await deps.reader.simulateContract({ address: court, abi: AuditCourtAbi, functionName: "challenge", args: [evidence], account: deps.account })
  const data = encodeFunctionData({ abi: AuditCourtAbi, functionName: "challenge", args: [evidence as never] })
  const prepared = await deps.writer.prepareTransactionRequest({ account: deps.account, chain: deps.writer.chain, to: court, data })
  const signed = await deps.writer.signTransaction(prepared as never)
  const hash = keccak256(signed)
  await deps.db.query("UPDATE serving.audit_filings SET status = 'sent', tx_hash = $2, signed_tx = $3 WHERE id = $1", [id, hash, signed])
  await broadcast(deps, signed)
  return confirm(deps, id, hash, root)
}

async function confirm(deps: FilingDeps, id: string, hash: Hex, root: Hex): Promise<Filed | Refusal> {
  const receipt = await deps.reader.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") {
    await deps.db.query("UPDATE serving.audit_filings SET status = 'failed', error = 'reverted' WHERE id = $1", [id])
    return refuse("reverted")
  }
  const challengeId = challengeIdOf(receipt.logs as never)
  await deps.db.query("UPDATE serving.audit_filings SET status = 'filed', challenge_id = $2 WHERE id = $1", [id, challengeId])
  deps.metrics.inc("auditor_challenges_filed")
  log(SERVICE, "challenge_filed", { id, challengeId, root, tx: hash })
  return { filed: true, challengeId: challengeId ?? "", txHash: hash, root, duplicate: false }
}

type Signals = { sequential: boolean; canary: boolean; replication: boolean }

/**
 * The only path to `AuditCourt.challenge`, and private to this file. The row goes in first, so its
 * checks and unique key run before any money moves. Kind 3 has no path: canary results are half of
 * a swap case, never a filing of their own.
 */
async function submit(deps: FilingDeps, input: { kind: typeof KIND_SWAP | typeof KIND_METERING | typeof KIND_THROUGHPUT; bundle: EvidenceBundle; week: number; statistic: number; threshold: number; testId: string; signals?: Signals }): Promise<Filed | Refusal> {
  const { kind, bundle, week } = input
  const signals = input.signals ?? { sequential: false, canary: false, replication: false }
  if (!(await leavesProven(deps as never, bundle))) return refuse("leaf_unproven")
  if ((await checkBond(deps)) < CHALLENGE_BOND) return refuse("bond_too_low")
  const root = evidenceRoot(bundle)
  const evidence: EvidenceArgs = {
    host: bundle.host as Address,
    kind,
    modelDigest: bundle.modelDigest,
    samplesRoot: root,
    sampleCount: bundle.samples.length,
    testId: testIdHash(input.testId),
    statistic: scaleStatistic(input.statistic),
    threshold: scaleStatistic(input.threshold),
    uri: evidenceUri(root),
  }
  const ruled = decideRuling(bundle, { host: bundle.host, kind, samplesRoot: root, sampleCount: bundle.samples.length, testId: evidence.testId, statistic: evidence.statistic, threshold: evidence.threshold }, true)
  const expected = kind === KIND_SWAP ? OUTCOME_SWAP : OUTCOME_BREACH
  // Throughput rulings are not built yet, so that path files only when an operator turns it on.
  if (kind !== KIND_THROUGHPUT && ruled.outcome !== expected) return refuse(`ruling_would_be_${ruled.reason}`)
  await storeBundle(deps.db, bundle)

  const id = `${bundle.host}:${bundle.modelDigest}:${week}:${kind}`
  const head = await deps.reader.getBlockNumber()
  const inserted = await deps.db.query(
    `INSERT INTO serving.audit_filings (id, host, model_digest, week, kind, samples_root, evidence, signal_sequential, signal_canary, signal_replication, status, from_block)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'prepared',$11) ON CONFLICT DO NOTHING RETURNING id`,
    [id, bundle.host.toLowerCase(), bundle.modelDigest, week, kind, root, jsonEvidence(evidence), signals.sequential, signals.canary, signals.replication, head.toString()],
  )
  if (inserted.rows.length === 0) return refuse("already_filed")
  try {
    return await send(deps, id, evidence, root)
  } catch (err) {
    log(SERVICE, "filing_interrupted", { id, error: String(err) })
    deps.metrics.inc("auditor_filing_errors")
    return refuse("interrupted")
  }
}

/** Files a swap only when the bundle itself shows both signals. */
export async function fileSwap(deps: FilingDeps, bundle: AuditBundle, week: number): Promise<Filed | Refusal> {
  if (deps.env !== "local" && !(await filingCalibrated(deps.db, bundle.modelDigest))) return refuse("not_calibrated")
  const signals = swapSignals(bundle)
  if (signals.reason) return refuse(signals.reason)
  const { statistic, threshold } = score(bundle.samples, bundle.baseline)
  return submit(deps, { kind: KIND_SWAP, bundle, week, statistic, threshold, testId: TEST_ID, signals })
}

/** Sustained disagreement: the share of flagged records, against the share a ruling needs. */
export async function fileMetering(deps: FilingDeps, bundle: EvidenceBundle, week: number): Promise<Filed | Refusal> {
  const flagged = bundle.samples.filter((s) => s.meteringFlag).length
  return submit(deps, { kind: KIND_METERING, bundle, week, statistic: flagged / bundle.samples.length, threshold: 0.05, testId: bundle.testId })
}

/** Only after a host disputes a performance post, with below-minimum seconds as the statistic. */
export async function fileThroughput(deps: FilingDeps, bundle: EvidenceBundle, week: number, measured: { belowSeconds: number; thresholdSeconds: number }): Promise<Filed | Refusal> {
  return submit(deps, { kind: KIND_THROUGHPUT, bundle, week, statistic: measured.belowSeconds, threshold: measured.thresholdSeconds, testId: bundle.testId })
}

type FilingRow = { id: string; samples_root: Hex; evidence: Record<string, unknown>; status: string; tx_hash: Hex | null; signed_tx: Hex | null; from_block: string }

const LOG_PAGE = 5_000n

async function findOnChain(deps: FilingDeps, row: FilingRow) {
  const head = await deps.reader.getBlockNumber()
  for (let from = BigInt(row.from_block); from <= head; from += LOG_PAGE) {
    const logs = await deps.reader.getContractEvents({ address: deps.contracts.AuditCourt as Address, abi: AuditCourtAbi, eventName: "EvidenceFiled", fromBlock: from, toBlock: from + LOG_PAGE - 1n > head ? head : from + LOG_PAGE - 1n })
    const hit = logs.find((entry) => (entry.args as { samplesRoot?: string }).samplesRoot === row.samples_root)
    if (hit) return hit.transactionHash
  }
  return null
}

async function receiptFor(deps: FilingDeps, hash: Hex) {
  try {
    return await deps.reader.getTransactionReceipt({ hash })
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return null
    throw err
  }
}

/** The bytes have not landed. If their nonce has gone to something else they never can, so only then is a new send safe. */
async function resume(deps: FilingDeps, row: FilingRow, hash: Hex, signed: Hex) {
  const taken = await deps.reader.getTransactionCount({ address: deps.account.address, blockTag: "latest" })
  if (taken > (parseTransaction(signed).nonce ?? 0)) {
    const landed = await findOnChain(deps, row)
    return landed ? confirm(deps, row.id, landed, row.samples_root) : send(deps, row.id, fromJson(row.evidence), row.samples_root)
  }
  await broadcast(deps, signed)
  return confirm(deps, row.id, hash, row.samples_root)
}

async function reconcile(deps: FilingDeps, row: FilingRow) {
  if (row.tx_hash) {
    if (await receiptFor(deps, row.tx_hash)) return confirm(deps, row.id, row.tx_hash, row.samples_root)
    return row.signed_tx ? resume(deps, row, row.tx_hash, row.signed_tx) : confirm(deps, row.id, row.tx_hash, row.samples_root)
  }
  const landed = await findOnChain(deps, row)
  return landed ? confirm(deps, row.id, landed, row.samples_root) : send(deps, row.id, fromJson(row.evidence), row.samples_root)
}

/** After a crash: confirm what went out, and send only what is proven not to have. One filing's trouble stays with that filing. */
export async function reconcileFilings(deps: FilingDeps) {
  const rows = await deps.db.query<FilingRow>("SELECT id, samples_root, evidence, status, tx_hash, signed_tx, from_block FROM serving.audit_filings WHERE status IN ('prepared', 'sent') ORDER BY created_at")
  for (const row of rows.rows) {
    try {
      await reconcile(deps, row)
    } catch (err) {
      log(SERVICE, "reconcile_failed", { id: row.id, error: String(err) })
      deps.metrics.inc("auditor_filing_errors")
    }
  }
  return rows.rows.length
}

