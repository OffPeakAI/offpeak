import type { Db } from "@offpeak/common"
import type { ChainEvent } from "./index.ts"

export async function applyAuditCourt(tx: Db, e: ChainEvent) {
  const args = e.args
  const id = args.challengeId
  switch (e.event) {
    case "ChallengeFiled":
      await tx.query(
        `INSERT INTO chain.challenges (id, host, challenger, kind, evidence_hash, filed_at, filed_block, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'filed') ON CONFLICT (id) DO NOTHING`,
        [id, String(args.host).toLowerCase(), String(args.challenger).toLowerCase(), args.kind, args.evidenceHash, e.blockTs, e.blockNumber],
      )
      return
    case "EvidenceFiled":
      await tx.query(
        `UPDATE chain.challenges SET model_digest = $2, samples_root = $3, sample_count = $4, test_id = $5,
           statistic = $6, threshold = $7, uri = $8 WHERE id = $1`,
        [id, args.modelDigest, args.samplesRoot, args.sampleCount, args.testId, args.statistic, args.threshold, args.uri],
      )
      return
    case "HostResponded":
      await tx.query("UPDATE chain.challenges SET response_hash = $2 WHERE id = $1", [id, args.responseHash])
      return
    case "RulingPosted":
      await tx.query("UPDATE chain.challenges SET outcome = $2, slash_bps = $3 WHERE id = $1", [id, args.outcome, args.slashBps])
      return
    case "PanelReviewOpened":
      await tx.query("UPDATE chain.challenges SET state = 'panel_review', review_ends_at = $2 WHERE id = $1", [id, args.reviewEndsAt])
      return
    case "AppealFiled":
      await tx.query("UPDATE chain.challenges SET appeal_hash = $2 WHERE id = $1", [id, args.appealHash])
      return
    case "PanelDecided":
      await tx.query("UPDATE chain.challenges SET state = 'decided', decision = $2, slash_bps = $3 WHERE id = $1", [
        id,
        args.decision,
        args.finalSlashBps,
      ])
      return
    case "ChallengeFinalized":
      await tx.query("UPDATE chain.challenges SET state = 'finalized', slash_bps = $2, slashed_usdg = $3, finalized_at = $4 WHERE id = $1", [
        id,
        args.slashBps,
        args.slashedUsdg,
        e.blockTs,
      ])
      return
    case "RefundClaimed":
      await tx.query("UPDATE chain.refund_trees SET claimed = true WHERE challenge_id = $1 AND buyer = $2", [
        id,
        String(args.buyer).toLowerCase(),
      ])
      return
  }
}
