import { OfpkHooksAbi, WindowMarketAbi } from "@offpeak/abis"
import type { Db, Metrics } from "@offpeak/common"
import { merkleProof, merkleRoot } from "@offpeak/shared"
import { Hono, type Context } from "hono"
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem"
import { buyerView, channelView, emptyBuyerRow, escrowView, hostView, readVaultState, type BuyerRow, type ChannelRow, type EscrowRow } from "./views.ts"

export type ApiDeps = {
  db: Db
  reader: PublicClient
  contracts: Record<string, Address>
  internalToken: string
  metrics: Metrics
}

type Head = { block: number; blockTs: number; finalizedBlock: number }

function send(c: Context, status: number, body: unknown) {
  const json = JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
  return c.body(json, status as never, { "content-type": "application/json" })
}

async function readHead(deps: ApiDeps): Promise<Head> {
  const latest = await deps.reader.getBlock({ blockTag: "latest" })
  const cursor = await deps.db.query<{ block: string }>("SELECT block FROM chain.cursor WHERE id = 'main'")
  return {
    block: Number(latest.number),
    blockTs: Number(latest.timestamp),
    finalizedBlock: Number(cursor.rows[0]?.block ?? 0),
  }
}

/** Leaves rebuild from the rows settlement kept, then must match the root posted on chain. */
async function proofFor(db: Db, reqId: string, cache: Map<string, Hex[]>) {
  const records = await db.query<{ hour: string; leaf: string }>("SELECT hour, leaf FROM shared.usage_records WHERE req_id = $1", [reqId])
  const record = records.rows[0]
  if (!record) return null
  const hour = record.hour
  const excluded = await db.query("SELECT 1 FROM chain.settlement_rejects WHERE req_id = $1", [reqId])
  if (excluded.rows.length > 0) return null
  const settled = await db.query<{ root: string; tx_hash: string }>("SELECT root, tx_hash FROM chain.settlements WHERE hour = $1", [hour])
  const settlement = settled.rows[0]
  if (!settlement) return null

  let leaves = cache.get(hour)
  if (!leaves) {
    const rows = await db.query<{ leaf: string }>(
      `SELECT leaf FROM shared.usage_records
       WHERE hour = $1 AND status = 'final' AND req_id NOT IN (SELECT req_id FROM chain.settlement_rejects WHERE hour = $1)
       ORDER BY req_id ASC`,
      [hour],
    )
    leaves = rows.rows.map((r) => r.leaf as Hex)
    if (merkleRoot(leaves) !== settlement.root) return null
    cache.set(hour, leaves)
  }
  const index = leaves.indexOf(record.leaf as Hex)
  if (index < 0) return null
  return { hour: Number(hour), leaf: record.leaf, proof: merkleProof(leaves, index), root: settlement.root, txHash: settlement.tx_hash }
}

export function createApi(deps: ApiDeps) {
  const app = new Hono()
  const leavesByHour = new Map<string, Hex[]>()
  const { db } = deps

  app.use("/idx/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${deps.internalToken}`) return c.json({ error: "unauthorized" }, 401)
    await next()
  })

  app.get("/idx/v1/buyers/:addr", async (c) => {
    const head = await readHead(deps)
    const address = c.req.param("addr").toLowerCase()
    const rows = await db.query<BuyerRow>("SELECT * FROM chain.buyers WHERE address = $1", [address])
    const row = rows.rows[0] ?? (await emptyBuyerRow())
    return send(c, 200, { head, data: buyerView(row, await readVaultState(db), head.blockTs) })
  })

  app.get("/idx/v1/hosts", async (c) => {
    const head = await readHead(deps)
    const hosts = await db.query<{ address: string }>("SELECT address FROM chain.hosts ORDER BY address")
    return send(c, 200, { head, data: await Promise.all(hosts.rows.map((h) => hostView(db, h.address, head.blockTs))) })
  })

  app.get("/idx/v1/hosts/:addr", async (c) => {
    const head = await readHead(deps)
    const host = await hostView(db, c.req.param("addr").toLowerCase(), head.blockTs)
    if (!host) return c.json({ error: "not_found" }, 404)
    return send(c, 200, { head, data: host })
  })

  app.get("/idx/v1/channels/:id", async (c) => {
    const head = await readHead(deps)
    const rows = await db.query<ChannelRow>("SELECT * FROM chain.channels WHERE channel_id = $1", [c.req.param("id").toLowerCase()])
    return send(c, 200, { head, data: rows.rows[0] ? channelView(rows.rows[0]) : null })
  })
