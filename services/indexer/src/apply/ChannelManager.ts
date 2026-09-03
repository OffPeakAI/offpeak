import type { Db } from "@offpeak/common"
import { hourIndex } from "@offpeak/shared"
import type { ChainEvent } from "./index.ts"

const COOPERATIVE_SEQ = (2n ** 64n - 1n).toString()

async function recordClaim(tx: Db, e: ChainEvent, channelId: string, seq: unknown, cumulative: unknown) {
  await tx.query(
    `INSERT INTO chain.channel_claims (channel_id, seq, cumulative, tx_hash, hour) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel_id, seq) DO NOTHING`,
    [channelId, seq, cumulative, e.txHash, hourIndex(e.blockTs)],
  )
  await tx.query("UPDATE shared.channel_state SET claimed = $1 WHERE channel_id = $2", [cumulative, channelId])
}

export async function applyChannelManager(tx: Db, e: ChainEvent) {
  const args = e.args
  const channelId = String(args.channelId).toLowerCase()
  switch (e.event) {
    case "ChannelOpened":
      await tx.query(
        `INSERT INTO chain.channels (channel_id, payer, deposit, expiry, opened_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (channel_id) DO NOTHING`,
        [channelId, String(args.payer).toLowerCase(), args.deposit, args.expiry, e.blockTs],
      )
      return
    case "ChannelToppedUp":
      await tx.query("UPDATE chain.channels SET deposit = $1 WHERE channel_id = $2", [args.deposit, channelId])
      return
    case "ChannelClaimed":
      await tx.query("UPDATE chain.channels SET claimed = $1, last_seq = $2, last_claim_at = $3 WHERE channel_id = $4", [
        args.cumulative,
        args.seq,
        e.blockTs,
        channelId,
      ])
      await recordClaim(tx, e, channelId, args.seq, args.cumulative)
      return
    case "CloseRequested":
      await tx.query("UPDATE chain.channels SET status = 2, challenge_ends_at = $1 WHERE channel_id = $2", [args.challengeEndsAt, channelId])
      return
    case "ChannelClosed":
      await tx.query("UPDATE chain.channels SET status = 3, claimed = $1, last_claim_at = $2 WHERE channel_id = $3", [
        args.paidToPayee,
        e.blockTs,
        channelId,
      ])
      await recordClaim(tx, e, channelId, COOPERATIVE_SEQ, args.paidToPayee)
      return
  }
}
