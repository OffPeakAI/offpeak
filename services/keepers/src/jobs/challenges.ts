import { AuditCourtAbi, HostRegistryAbi } from "@offpeak/abis"
import { log } from "@offpeak/common"
import type { Address, Hex } from "viem"
import type { KeeperDeps } from "./types.ts"

const PANEL_TIMEOUT_S = 14 * 86_400
const CONFIRM_WINDOW_S = 7 * 86_400

async function send(deps: KeeperDeps, functionName: "finalize" | "claimRefund", args: readonly unknown[]) {
  const { request } = await deps.reader.simulateContract({
    address: deps.contracts.AuditCourt!,
    abi: AuditCourtAbi,
    functionName,
    args: args as never,
    account: deps.account,
  })
  await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
}

/** Decisions execute and stalled challenges time out without anyone stepping in. */
export async function runChallengeFinalize(deps: KeeperDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const now = Number(head.timestamp)
  const due = await deps.db.query<{ id: string }>(
    `SELECT id FROM chain.challenges
     WHERE state = 'decided'
        OR (state = 'filed' AND filed_at + $1 <= $2)
        OR (state = 'panel_review' AND review_ends_at + $3 <= $2)
     ORDER BY id`,
    [PANEL_TIMEOUT_S, now, CONFIRM_WINDOW_S],
  )
  const finalized: number[] = []
  for (const { id } of due.rows) {
    try {
      await send(deps, "finalize", [BigInt(id)])
      finalized.push(Number(id))
    } catch (err) {
      log("keepers", "finalize_skipped", { id, error: String(err).slice(0, 160) })
    }
  }
  return finalized
}

/** Buyers owed a refund get it without having to claim. */
export async function runRefundClaims(deps: KeeperDeps) {
  const owed = await deps.db.query<{ challenge_id: string; buyer: string; amount: string; proof: Hex[] }>(
    `SELECT t.challenge_id, t.buyer, t.amount, t.proof FROM chain.refund_trees t
     JOIN chain.challenges c ON c.id = t.challenge_id
     WHERE c.state = 'finalized' AND c.slash_bps = t.slash_bps AND NOT t.claimed
     ORDER BY t.challenge_id, t.buyer`,
  )
  const paid: string[] = []
  for (const row of owed.rows) {
    try {
      await send(deps, "claimRefund", [BigInt(row.challenge_id), row.buyer as Address, BigInt(row.amount), row.proof])
      paid.push(row.buyer)
    } catch (err) {
      log("keepers", "refund_claim_skipped", { buyer: row.buyer, error: String(err).slice(0, 160) })
    }
  }
  return paid
}

/** A fully slashed host's released credits go to the reserve. Anyone may do this, so the job only saves waiting. */
export async function runForfeitSweep(deps: KeeperDeps) {
  const hosts = await deps.db.query<{ host: string }>("SELECT DISTINCT host FROM chain.challenges WHERE state = 'finalized' AND slash_bps = 10000")
  const registry = { address: deps.contracts.HostRegistry!, abi: HostRegistryAbi }
  const swept: string[] = []
  for (const { host } of hosts.rows) {
    const view = await deps.reader.readContract({ ...registry, functionName: "hostView", args: [host as Address] })
    if (view.releasableCredits === 0n) continue
    const { request } = await deps.reader.simulateContract({
      ...registry,
      functionName: "sweepForfeitedCredits",
      args: [host as Address],
      account: deps.account,
    })
    await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
    swept.push(host)
  }
  return swept
}
