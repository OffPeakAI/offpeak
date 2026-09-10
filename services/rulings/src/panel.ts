import { TEST_ID, TEST_VERSION, publishedBaseline } from "@offpeak/audit-tests"
import { type Db } from "@offpeak/common"
import { domain, panelTypes } from "@offpeak/shared"
import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { factsOf, loadBundle, leavesProven, refundTreeFor, type ChallengeRow } from "./review.ts"
import { decideRuling } from "./decide.ts"
import { storeRefundTree } from "./refund-tree.ts"

export type PanelChoice = "confirm" | "downgrade" | "dismiss"

const CHOICES: Record<PanelChoice, { decision: number; finalSlashBps: number }> = {
  confirm: { decision: 0, finalSlashBps: 10_000 },
  downgrade: { decision: 1, finalSlashBps: 2_000 },
  dismiss: { decision: 2, finalSlashBps: 0 },
}

type PanelDeps = { db: Db; reader: PublicClient; contracts: Record<string, Address>; chainId: number }

/**
 * The review packet for human panel members and the typed data for their multisig to sign in its
 * own wallet. This code never holds a panel key.
 */
export async function panelPacket(deps: PanelDeps, challengeId: number, choice: PanelChoice) {
  const rows = await deps.db.query<ChallengeRow & { review_ends_at: string | null; appeal_hash: string | null }>(
    "SELECT * FROM chain.challenges WHERE id = $1",
    [challengeId],
  )
  const row = rows.rows[0]
  if (!row) throw new Error(`no challenge ${challengeId}`)
  const bundle = await loadBundle(deps.db, row.samples_root)
  if (!bundle) throw new Error(`no evidence bundle for challenge ${challengeId}`)

  const chosen = CHOICES[choice]
  let refundRoot = `0x${"00".repeat(32)}` as Hex
  if (chosen.finalSlashBps > 0) {
    const tree = await refundTreeFor(deps, row, bundle, chosen.finalSlashBps)
    await storeRefundTree(deps.db, challengeId, chosen.finalSlashBps, tree)
    refundRoot = tree.root
  }

  const samples = bundle.samples
  return {
    challengeId,
    host: row.host,
    reviewEndsAt: row.review_ends_at === null ? null : Number(row.review_ends_at),
    evidence: {
      samples: samples.length,
      statistic: Number(BigInt(row.statistic)) / 1e6,
      threshold: Number(BigInt(row.threshold)) / 1e6,
      canaryFailures: samples.filter((s) => s.canaryFail).length,
      replicatedByReference: samples.filter((s) => s.refAgrees).length,
      proofsVerify: await leavesProven(deps, bundle),
      rulingRecheck: decideRuling(bundle, factsOf(row), true).reason,
    },
    hostResponseHash: row.response_hash,
    appealHash: row.appeal_hash,
    calibration: { testId: TEST_ID, testVersion: TEST_VERSION, baseline: publishedBaseline(bundle.modelDigest), targetFalseFlagRate: 0.01 },
    typedData: {
      domain: domain("OffpeakAudit", deps.contracts.AuditCourt!, deps.chainId),
      types: panelTypes,
      primaryType: "PanelDecision" as const,
      message: {
        challengeId: BigInt(challengeId),
        decision: chosen.decision,
        finalSlashBps: chosen.finalSlashBps,
        refundRoot,
        reasonHash: keccak256(toBytes(choice)),
      },
    },
  }
}
