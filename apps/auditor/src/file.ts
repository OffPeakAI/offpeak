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
