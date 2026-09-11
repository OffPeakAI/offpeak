import { OffpeakVaultAbi, abis } from "@offpeak/abis"
import { log, type Db, type Metrics } from "@offpeak/common"
import { decodeEventLog, type Abi, type Address, type Log, type PublicClient } from "viem"
import { applyEvent, type ChainEvent } from "./apply/index.ts"

const CURSOR = "main"
const MAX_RANGE = 2_000n

/** Events that only tighten serving go out at one confirmation; everything else waits for `safe`. */
const TIGHTENING = new Set(["WithdrawAllRequested", "CapsChangeRequested", "Paused", "CloseRequested"])
const FROZEN_OR_DELISTED = new Set([3, 5])

export type IngestDeps = {
  db: Db
  reader: PublicClient
  contracts: Record<string, Address>
  confirmations: number
  publish: (msg: Record<string, unknown>) => Promise<void> | void
  metrics?: Metrics
}

export type IngestState = { fastLaned: Set<string> }

export function newIngestState(): IngestState {
  return { fastLaned: new Set() }
}

function jsonArgs(args: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? value.toString() : value)))
}

function decode(log: Log, names: Map<string, string>): Omit<ChainEvent, "blockTs"> | null {
  const contract = names.get(log.address.toLowerCase())
  const abi = contract ? abis[contract as keyof typeof abis] : undefined
  if (!contract || !abi) return null
  try {
    const decoded = decodeEventLog({ abi: abi as Abi, data: log.data, topics: log.topics })
    return {
      txHash: log.transactionHash!,
      logIndex: log.logIndex!,
      blockNumber: log.blockNumber!,
      contract,
      event: decoded.eventName!,
      args: jsonArgs(decoded.args),
    }
  } catch {
    return null
  }
}

function isTightening(e: Pick<ChainEvent, "event" | "args">) {
  return TIGHTENING.has(e.event) || (e.event === "HostStatusChanged" && FROZEN_OR_DELISTED.has(Number(e.args.status)))
}

async function seedVaultState(deps: IngestDeps, startBlock: bigint) {
  const lastSettledHour = await deps.reader.readContract({
    address: deps.contracts.OffpeakVault!,
    abi: OffpeakVaultAbi,
    functionName: "lastSettledHour",
    blockNumber: startBlock > 0n ? startBlock : undefined,
  })
  await deps.db.query("INSERT INTO chain.vault_state (id, initial_settled_hour, last_settled_hour) VALUES (1, $1, $1) ON CONFLICT DO NOTHING", [
    lastSettledHour.toString(),
  ])
}

async function readCursor(db: Db) {
  const rows = await db.query<{ block: string; block_hash: string }>("SELECT block, block_hash FROM chain.cursor WHERE id = $1", [CURSOR])
  const row = rows.rows[0]
  return row ? { block: BigInt(row.block), hash: row.block_hash } : null
}

async function blockTimes(reader: PublicClient, logs: Log[]) {
  const times = new Map<bigint, number>()
  for (const number of new Set(logs.map((l) => l.blockNumber!))) {
    times.set(number, Number((await reader.getBlock({ blockNumber: number })).timestamp))
  }
  return times
}

/** Moves unmatched collections onto their payment rows, which may be written after the claim lands. */
async function reconcileCollections(tx: Db) {
  await tx.query(
    `UPDATE shared.agent_payments p SET collected_tx = c.tx_hash, collected_hour = c.hour
     FROM chain.collections c
     WHERE p.collected_tx IS NULL AND p.kind <> 'channel' AND p.payment_id = c.payment_id`,
  )
  // One claim collects every earlier voucher, and a cooperative close has no voucher row of its own.
  await tx.query(
    `WITH running AS (
       SELECT payment_id, channel_id, SUM(amount_micro) OVER (PARTITION BY channel_id ORDER BY voucher_seq) AS total
       FROM shared.agent_payments WHERE kind = 'channel'
     ), covering AS (
       SELECT DISTINCT ON (r.payment_id) r.payment_id, k.tx_hash, k.hour
       FROM running r JOIN chain.channel_claims k ON k.channel_id = r.channel_id AND k.cumulative >= r.total
       ORDER BY r.payment_id, k.cumulative
     )
     UPDATE shared.agent_payments p SET collected_tx = covering.tx_hash, collected_hour = covering.hour
     FROM covering WHERE p.payment_id = covering.payment_id AND p.collected_tx IS NULL`,
  )
}

/** One event that cannot apply must not stop the chain's history, and settlement with it. */
async function applySafely(deps: IngestDeps, tx: Db, event: ChainEvent) {
  await tx.exec("SAVEPOINT apply_event")
  try {
    await applyEvent(tx, event)
    await tx.exec("RELEASE SAVEPOINT apply_event")
  } catch (err) {
    await tx.exec("ROLLBACK TO SAVEPOINT apply_event")
    const message = String(err).slice(0, 300)
    await tx.query("UPDATE chain.events SET processed = false, error = $1 WHERE tx_hash = $2 AND log_index = $3", [message, event.txHash, event.logIndex])
    log("indexer", "event_not_applied", { txHash: event.txHash, name: event.event, error: message })
    deps.metrics?.inc("indexer_apply_errors_total")
  }
}

async function applyRange(deps: IngestDeps, from: bigint, to: bigint) {
  const names = new Map(Object.entries(deps.contracts).map(([name, address]) => [address.toLowerCase(), name]))
  const logs = await deps.reader.getLogs({ address: Object.values(deps.contracts), fromBlock: from, toBlock: to })
  const times = await blockTimes(deps.reader, logs)
  const tip = await deps.reader.getBlock({ blockNumber: to })
  const events: ChainEvent[] = []
  await deps.db.transaction(async (tx) => {
    for (const log of logs) {
      const decoded = decode(log, names)
      if (!decoded) continue
      const event = { ...decoded, blockTs: times.get(log.blockNumber!)! }
      const inserted = await tx.query<{ tx_hash: string }>(
        `INSERT INTO chain.events (tx_hash, log_index, block_number, block_hash, block_ts, contract, event, args, processed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true) ON CONFLICT DO NOTHING RETURNING tx_hash`,
        [event.txHash, event.logIndex, event.blockNumber, log.blockHash, event.blockTs, event.contract, event.event, JSON.stringify(event.args)],
      )
      if (inserted.rows.length === 0) continue
      await applySafely(deps, tx, event)
      events.push(event)
    }
    await reconcileCollections(tx)
    await tx.query(
      `INSERT INTO chain.cursor (id, block, block_hash) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET block = $2, block_hash = $3`,
      [CURSOR, to, tip.hash],
    )
  })
  return events
}

async function publishEvents(deps: IngestDeps, state: IngestState, events: ChainEvent[]) {
  for (const e of events) {
    const key = `${e.txHash}:${e.logIndex}`
    if (state.fastLaned.delete(key)) continue
    await deps.publish({ type: e.event, ...e.args, block: Number(e.blockNumber), txHash: e.txHash })
  }
}

/** Tightening events reach the router from the head, ahead of confirmation. They are re-applied at `safe`. */
async function fastLane(deps: IngestDeps, state: IngestState, from: bigint, head: bigint) {
  if (from > head) return
  const names = new Map(Object.entries(deps.contracts).map(([name, address]) => [address.toLowerCase(), name]))
  const logs = await deps.reader.getLogs({ address: Object.values(deps.contracts), fromBlock: from, toBlock: head })
  for (const log of logs) {
    const decoded = decode(log, names)
    if (!decoded || !isTightening(decoded)) continue
    const key = `${decoded.txHash}:${decoded.logIndex}`
    if (state.fastLaned.has(key)) continue
    state.fastLaned.add(key)
    await deps.publish({ type: decoded.event, ...decoded.args, block: Number(decoded.blockNumber), txHash: decoded.txHash })
  }
}

/** Undoes what the indexer wrote into shared tables. Replay and reconciliation write back whatever survives. */
async function clearDerivedWrites(tx: Db, forkBlock: bigint) {
  const undone = await tx.query<{ hour: string }>("SELECT hour FROM chain.settlements WHERE block > $1", [forkBlock])
  const hours = undone.rows.map((row) => row.hour)
  await tx.query("UPDATE shared.usage_hours SET settle_tx = NULL, settled_at = NULL WHERE hour = ANY($1)", [hours])
  await tx.query("UPDATE shared.usage_records SET settled_hour_tx = NULL WHERE hour = ANY($1)", [hours])
  await tx.query("DELETE FROM chain.settlement_rejects WHERE hour = ANY($1)", [hours])
  await tx.query("UPDATE shared.agent_payments SET drawn_hour = NULL WHERE drawn_hour = ANY($1)", [hours])
  await tx.query("UPDATE shared.agent_payments SET written_off_hour = NULL WHERE written_off_hour = ANY($1)", [hours])
  await tx.query("UPDATE shared.agent_payments SET collected_tx = NULL, collected_hour = NULL")
  await tx.query("UPDATE shared.channel_state SET claimed = 0")
  await tx.query("UPDATE shared.refunds SET paid_hour = NULL")
  await tx.exec("UPDATE chain.refund_trees SET claimed = false")
  await tx.exec("UPDATE chain.vault_state SET last_settled_hour = initial_settled_hour, usage_paused = false, settles_paused = false")
}

/** Drops events past the fork, rebuilds derived state by replay, and tells consumers. */
async function rewind(deps: IngestDeps, forkBlock: bigint) {
  const events = await deps.db.transaction(async (tx) => {
    await clearDerivedWrites(tx, forkBlock)
    await tx.query("DELETE FROM chain.events WHERE block_number > $1", [forkBlock])
    for (const table of ["buyers", "hosts", "host_models", "host_status_log", "host_credits", "settlements", "roots", "refunds_paid", "collections", "signer_sets", "challenges", "channels", "channel_claims", "escrows", "orphan_writeoffs", "swept_payments", "windows", "window_holdings", "listings"]) {
      await tx.exec(`DELETE FROM chain.${table}`)
    }
    const hash = await deps.reader.getBlock({ blockNumber: forkBlock })
    await tx.query("UPDATE chain.cursor SET block = $1, block_hash = $2 WHERE id = $3", [forkBlock, hash.hash, CURSOR])
    const kept = await tx.query<{
      tx_hash: string
      log_index: number
      block_number: string
      block_ts: string
      contract: string
      event: string
      args: Record<string, unknown>
    }>("SELECT * FROM chain.events ORDER BY block_number, log_index")
    return kept.rows
  })
  await deps.db.transaction(async (tx) => {
    for (const row of events) {
      await applyEvent(tx, {
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: BigInt(row.block_number),
        blockTs: Number(row.block_ts),
        contract: row.contract,
        event: row.event,
        args: row.args,
      })
    }
  })
  await deps.publish({ type: "Reorg", fromBlock: Number(forkBlock) })
}

/** Finds the last block whose hash the indexer can still vouch for. */
async function findForkBlock(deps: IngestDeps, cursor: bigint) {
  const seen = await deps.db.query<{ block_number: string; block_hash: string }>(
    "SELECT DISTINCT block_number, block_hash FROM chain.events WHERE block_number <= $1 ORDER BY block_number DESC",
    [cursor],
  )
  for (const row of seen.rows) {
    const block = await deps.reader.getBlock({ blockNumber: BigInt(row.block_number) }).catch(() => null)
    if (block?.hash === row.block_hash) return BigInt(row.block_number)
  }
  return 0n
}

/** One pass of the ingest loop. It returns the block it reached. */
export async function tick(deps: IngestDeps, state: IngestState): Promise<bigint> {
  const head = await deps.reader.getBlockNumber({ cacheTime: 0 })
  const safe = head - BigInt(deps.confirmations - 1)
  let cursor = await readCursor(deps.db)
  if (!cursor) {
    await seedVaultState(deps, 0n)
  } else {
    const onChain = await deps.reader.getBlock({ blockNumber: cursor.block }).catch(() => null)
    if (onChain?.hash !== cursor.hash) {
      await rewind(deps, await findForkBlock(deps, cursor.block))
      // Whatever survives the fork comes through again from the rewound cursor, so nothing is held back.
      state.fastLaned.clear()
      cursor = await readCursor(deps.db)
    }
  }

  let next = (cursor?.block ?? -1n) + 1n
  while (next <= safe) {
    const to = next + MAX_RANGE - 1n < safe ? next + MAX_RANGE - 1n : safe
    await publishEvents(deps, state, await applyRange(deps, next, to))
    next = to + 1n
  }
  await fastLane(deps, state, next, head)
  return next - 1n
}
