import { ChannelManagerAbi } from "@offpeak/abis"
import { log } from "@offpeak/common"
import { CHANNEL_SETTLE_EVERY_MICRO, CHANNEL_SETTLE_EVERY_S } from "@offpeak/shared"
import type { Hex } from "viem"
import type { KeeperDeps } from "./types.ts"

const STATUS_OPEN = 1
const STATUS_CLOSING = 2
const LAND_ATTEMPTS = 6
/** Rides out a short RPC incident: the attempts span about 6 seconds, then the job's next pass tries again. */
const LAND_RETRY_MS = 200
/** A voucher still unlanded this close to the end pages a person. It is the host's money. */
const CLOSE_ALARM_S = 1800
const NO_RISK_MARGIN_S = 7200

type VoucherRow = { channel_id: string; latest_seq: string; cumulative: string; voucher_sig: string }

const manager = (deps: KeeperDeps) => ({ address: deps.contracts.ChannelManager!, abi: ChannelManagerAbi })

async function send(deps: KeeperDeps, functionName: "finalizeClose" | "requestClose", channelId: Hex) {
  const { request } = await deps.reader.simulateContract({ ...manager(deps), functionName, args: [channelId], account: deps.account })
  await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
}

/** A lost response can hide a voucher that landed, and its retry would then fail as stale. */
async function alreadyLanded(deps: KeeperDeps, channelId: Hex, seq: bigint) {
  const view = await deps.reader.readContract({ ...manager(deps), functionName: "channelView", args: [channelId] }).catch(() => null)
  return view !== null && view.lastSeq >= seq
}

async function landVoucher(deps: KeeperDeps, row: VoucherRow) {
  const channelId = row.channel_id as Hex
  const voucher = { channelId, seq: BigInt(row.latest_seq), cumulative: BigInt(row.cumulative) }
  for (let attempt = 1; attempt <= LAND_ATTEMPTS; attempt++) {
    try {
      const { request } = await deps.reader.simulateContract({
        ...manager(deps),
        functionName: "settleChannel",
        args: [channelId, voucher, row.voucher_sig as Hex],
        account: deps.account,
      })
      const receipt = await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
      if (receipt.status === "success") return true
    } catch (err) {
      log("keepers", "voucher_retry", { channelId, attempt, error: String(err).slice(0, 160) })
    }
    if (await alreadyLanded(deps, channelId, voucher.seq)) return true
    await Bun.sleep(LAND_RETRY_MS * 2 ** (attempt - 1))
  }
  return false
}

async function latestVoucher(deps: KeeperDeps, channelId: string) {
  const rows = await deps.db.query<VoucherRow>(
    "SELECT lower(channel_id) AS channel_id, latest_seq, cumulative, voucher_sig FROM shared.channel_state WHERE lower(channel_id) = $1",
    [channelId.toLowerCase()],
  )
  return rows.rows[0]
}

/** Moves each open channel's latest voucher on chain once enough is owed, or enough time has passed. */
export async function runChannelClaim(deps: KeeperDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const due = await deps.db.query<VoucherRow>(
    `SELECT c.channel_id, s.latest_seq, s.cumulative, s.voucher_sig
     FROM shared.channel_state s JOIN chain.channels c ON c.channel_id = lower(s.channel_id)
     WHERE c.status = $1 AND s.cumulative > c.claimed
       AND (s.cumulative - c.claimed >= $2 OR GREATEST(c.last_claim_at, c.opened_at) + $3 <= $4)`,
    [STATUS_OPEN, CHANNEL_SETTLE_EVERY_MICRO, CHANNEL_SETTLE_EVERY_S, Number(head.timestamp)],
  )
  const landed: string[] = []
  for (const row of due.rows) {
    if (await landVoucher(deps, row)) landed.push(row.channel_id)
  }
  return landed
}

/** Reads closing state from the chain, since a push can arrive ahead of the indexer's confirmations. */
async function watchClose(deps: KeeperDeps, channelId: Hex, now: number) {
  const view = await deps.reader.readContract({ ...manager(deps), functionName: "channelView", args: [channelId] })
  if (view.status !== STATUS_CLOSING) return NO_RISK_MARGIN_S
  const left = Number(view.challengeEndsAt) - now
  const voucher = await latestVoucher(deps, channelId)
  const unlanded = voucher !== undefined && BigInt(voucher.cumulative) > view.claimed
  if (left <= 0) {
    if (unlanded) log("keepers", "channel_voucher_lost", { channelId, cumulative: voucher.cumulative, claimed: view.claimed })
    await send(deps, "finalizeClose", channelId)
    return NO_RISK_MARGIN_S
  }
  if (!unlanded || (await landVoucher(deps, voucher))) return NO_RISK_MARGIN_S
  if (left < CLOSE_ALARM_S) log("keepers", "channel_close_alarm", { channelId, secondsLeft: left })
  return left
}

/** Runs on the `CloseRequested` push and on a clock. It lands the latest voucher, then finishes the close. */
/** The close race starts from this read, so one failed call must not cost a whole pass. */
async function readHead(deps: KeeperDeps) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.reader.getBlock({ blockTag: "latest" })
    } catch (err) {
      if (attempt === LAND_ATTEMPTS) throw err
      await Bun.sleep(LAND_RETRY_MS)
    }
  }
}

export async function runCloseWatch(deps: KeeperDeps, only?: Hex) {
  const head = await readHead(deps)
  const closing = await deps.db.query<{ channel_id: Hex }>("SELECT channel_id FROM chain.channels WHERE status = $1", [STATUS_CLOSING])
  const ids = only ? [only] : closing.rows.map((row) => row.channel_id)
  let margin = NO_RISK_MARGIN_S
  for (const id of ids) {
    try {
      margin = Math.min(margin, await watchClose(deps, id, Number(head.timestamp)))
    } catch (err) {
      log("keepers", "close_watch_failed", { channelId: id, error: String(err).slice(0, 200) })
    }
  }
  deps.metrics.set("channel_close_margin_seconds", margin)
  return ids
}

/** Closes channels past their expiry, landing the latest voucher first so the host is paid. */
export async function runChannelExpiry(deps: KeeperDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const expired = await deps.db.query<{ channel_id: Hex; claimed: string }>(
    "SELECT channel_id, claimed FROM chain.channels WHERE status = $1 AND expiry <= $2",
    [STATUS_OPEN, Number(head.timestamp)],
  )
  const closed: string[] = []
  for (const row of expired.rows) {
    try {
      const voucher = await latestVoucher(deps, row.channel_id)
      if (voucher && BigInt(voucher.cumulative) > BigInt(row.claimed)) await landVoucher(deps, voucher)
      await send(deps, "requestClose", row.channel_id)
      closed.push(row.channel_id)
    } catch (err) {
      log("keepers", "channel_expiry_skipped", { channelId: row.channel_id, error: String(err).slice(0, 160) })
    }
  }
  return closed
}
