import { OfpkHooksAbi, WindowMarketAbi } from "@offpeak/abis"
import { bearerMatches, type Db, type Metrics } from "@offpeak/common"
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

const PUBLIC_RATE_PER_MINUTE = 120
const MINUTE_MS = 60_000

/** One window per minute per caller. Clearing each window keeps the map to a minute's worth of callers. */
function perMinuteLimit(limit: number) {
  const counts = new Map<string, number>()
  let windowStart = 0
  return (caller: string, now: number) => {
    if (now - windowStart >= MINUTE_MS) {
      counts.clear()
      windowStart = now
    }
    const used = (counts.get(caller) ?? 0) + 1
    counts.set(caller, used)
    return used <= limit
  }
}

/** Under `Bun.serve` the second fetch argument is the server, which knows the peer. */
function callerOf(c: Context) {
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined
  return server?.requestIP?.(c.req.raw)?.address ?? "unknown"
}

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
  const publicLimit = perMinuteLimit(PUBLIC_RATE_PER_MINUTE)

  app.use("/idx/*", async (c, next) => {
    if (!bearerMatches(c.req.header("authorization"), deps.internalToken)) return c.json({ error: "unauthorized" }, 401)
    await next()
  })

  app.use("/public/*", async (c, next) => {
    if (!publicLimit(callerOf(c), Date.now())) return c.json({ error: "rate_limited" }, 429, { "retry-after": "60" })
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

  app.get("/idx/v1/escrows/:reqId", async (c) => {
    const head = await readHead(deps)
    const rows = await db.query<EscrowRow>("SELECT * FROM chain.escrows WHERE req_id = $1", [c.req.param("reqId").toLowerCase()])
    return send(c, 200, { head, data: escrowView(rows.rows[0]) })
  })

  app.get("/idx/v1/windows", async (c) => {
    const head = await readHead(deps)
    const market = deps.contracts.WindowMarket
    if (!market) return send(c, 200, { head, data: [] })
    const rows = await db.query<{ id: string }>("SELECT id FROM chain.windows WHERE status IN (0, 1) ORDER BY id DESC LIMIT 200")
    const views = await Promise.all(
      rows.rows.map((row) => deps.reader.readContract({ address: market, abi: WindowMarketAbi, functionName: "windowView", args: [BigInt(row.id)] })),
    )
    return send(c, 200, { head, data: views.map((view) => ({ ...view, host: view.host.toLowerCase() })) })
  })

  app.get("/idx/v1/windows/:id", async (c) => {
    const head = await readHead(deps)
    const market = deps.contracts.WindowMarket
    if (!market) return send(c, 200, { head, data: null })
    const view = await deps.reader.readContract({ address: market, abi: WindowMarketAbi, functionName: "windowView", args: [BigInt(c.req.param("id"))] })
    return send(c, 200, { head, data: view.host === zeroAddress ? null : { ...view, host: view.host.toLowerCase() } })
  })

  app.get("/idx/v1/windows/:id/holders/:addr", async (c) => {
    const head = await readHead(deps)
    const market = deps.contracts.WindowMarket
    if (!market) return send(c, 200, { head, data: null })
    const view = await deps.reader.readContract({
      address: market,
      abi: WindowMarketAbi,
      functionName: "holderView",
      args: [BigInt(c.req.param("id")), c.req.param("addr") as Address],
    })
    return send(c, 200, { head, data: view })
  })

  app.get("/idx/v1/settlements/:hour", async (c) => {
    const head = await readHead(deps)
    const rows = await db.query<{ root: string; totals_hash: string; tx_hash: string; settled_at: string }>(
      "SELECT root, totals_hash, tx_hash, settled_at FROM chain.settlements WHERE hour = $1",
      [c.req.param("hour")],
    )
    const row = rows.rows[0]
    if (!row) return c.json({ error: "not_found" }, 404)
    return send(c, 200, { head, data: { root: row.root, totalsHash: row.totals_hash, txHash: row.tx_hash, settledAt: Number(row.settled_at) } })
  })

  app.get("/idx/v1/usage/:reqId/proof", async (c) => {
    const head = await readHead(deps)
    const proof = await proofFor(db, c.req.param("reqId"), leavesByHour)
    if (!proof) return c.json({ error: "not_found" }, 404)
    return send(c, 200, { head, data: proof })
  })

  app.get("/idx/v1/ofpk/:addr", async (c) => {
    const head = await readHead(deps)
    const account = c.req.param("addr") as Address
    if (!deps.contracts.OfpkHooks) return send(c, 200, { head, data: { tier: 0, feeDiscountBps: 0, earlyAccess: false } })
    const hooks = { address: deps.contracts.OfpkHooks, abi: OfpkHooksAbi }
    const [tier, feeDiscountBps, earlyAccess] = await Promise.all([
      deps.reader.readContract({ ...hooks, functionName: "tierOf", args: [account] }),
      deps.reader.readContract({ ...hooks, functionName: "feeDiscountBps", args: [account] }),
      deps.reader.readContract({ ...hooks, functionName: "earlyAccess", args: [account] }),
    ])
    return send(c, 200, { head, data: { tier, feeDiscountBps, earlyAccess } })
  })

  app.get("/idx/v1/challenges", async (c) => {
    const head = await readHead(deps)
    const host = c.req.query("host")?.toLowerCase()
    const rows = await db.query<Record<string, unknown>>(
      "SELECT id, host, kind, state, outcome, decision, slash_bps, filed_at, review_ends_at FROM chain.challenges WHERE ($1::text IS NULL OR host = $1) ORDER BY id",
      [host ?? null],
    )
    return send(c, 200, { head, data: rows.rows })
  })

  app.get("/public/v1/refunds/:challengeId/:buyer", async (c) => {
    const head = await readHead(deps)
    const rows = await db.query<{ amount: string; proof: Hex[]; claimed: boolean }>(
      `SELECT t.amount, t.proof, t.claimed FROM chain.refund_trees t JOIN chain.challenges c ON c.id = t.challenge_id
       WHERE t.challenge_id = $1 AND t.buyer = $2 AND c.slash_bps = t.slash_bps`,
      [c.req.param("challengeId"), c.req.param("buyer").toLowerCase()],
    )
    const row = rows.rows[0]
    if (!row) return c.json({ error: "not_found" }, 404)
    return send(c, 200, { head, data: row })
  })

  app.get("/public/v1/stats/hosts", async (c) => {
    const head = await readHead(deps)
    const rows = await db.query<{ address: string; bond_usdg: string; status: number; strikes: number; revenue: string | null }>(
      `SELECT h.address, h.bond_usdg, h.status, h.strikes,
         (SELECT COALESCE(SUM(amount), 0) FROM chain.host_credits c
          WHERE c.host = h.address AND c.kind = 'credit' AND c.state <> 'clawed' AND c.accrued_at > $1) AS revenue
       FROM chain.hosts h ORDER BY h.address`,
      [head.blockTs - 30 * 86_400],
    )
    return send(c, 200, {
      head,
      data: rows.rows.map((r) => ({ host: r.address, bond: r.bond_usdg, status: Number(r.status), strikes: Number(r.strikes), revenue30d: r.revenue ?? "0" })),
    })
  })

  app.get("/metrics", (c) => c.text(deps.metrics.render()))
  return app
}
