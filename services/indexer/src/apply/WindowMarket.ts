import type { Db } from "@offpeak/common"
import type { ChainEvent } from "./index.ts"

const ZERO = "0x0000000000000000000000000000000000000000"
const UNIT_TOKENS = 1_000_000n
const PERF_POSTED = 1
const PERF_DISPUTED = 2
const PERF_FINAL = 3

async function moveBalance(tx: Db, e: ChainEvent, id: unknown, value: unknown) {
  const from = String(e.args.from).toLowerCase()
  const to = String(e.args.to).toLowerCase()
  if (from !== ZERO) {
    await tx.query("UPDATE chain.window_holdings SET balance = balance - $1 WHERE window_id = $2 AND holder = $3", [value, id, from])
  }
  if (to !== ZERO) {
    await tx.query(
      `INSERT INTO chain.window_holdings (window_id, holder, balance) VALUES ($1,$2,$3)
       ON CONFLICT (window_id, holder) DO UPDATE SET balance = chain.window_holdings.balance + $3`,
      [id, to, value],
    )
  }
}

async function applyDrawn(tx: Db, e: ChainEvent) {
  const holder = String(e.args.holder).toLowerCase()
  const rows = await tx.query<{ drawn_partial: string }>("SELECT drawn_partial FROM chain.window_holdings WHERE window_id = $1 AND holder = $2", [
    e.args.id,
    holder,
  ])
  const drawn = BigInt(rows.rows[0]?.drawn_partial ?? 0) + BigInt(String(e.args.tokens))
  await tx.query("UPDATE chain.window_holdings SET drawn_partial = $1 WHERE window_id = $2 AND holder = $3", [
    (drawn % UNIT_TOKENS).toString(),
    e.args.id,
    holder,
  ])
}

export async function applyWindowMarket(tx: Db, e: ChainEvent) {
  const args = e.args
  switch (e.event) {
    case "WindowCreated":
      await tx.query(
        `INSERT INTO chain.windows (id, host, model_digest, t0, t1, min_tps, units) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [args.id, String(args.host).toLowerCase(), args.modelDigest, args.t0, args.t1, args.minTps, args.units],
      )
      return
    case "TransferSingle":
      await moveBalance(tx, e, args.id, args.value)
      return
    case "TransferBatch": {
      const ids = args.ids as unknown[]
      const values = args.values as unknown[]
      for (let i = 0; i < ids.length; i++) await moveBalance(tx, e, ids[i], values[i])
      return
    }
    case "Drawn":
      await applyDrawn(tx, e)
      return
    case "Claimed":
      await tx.query("UPDATE chain.window_holdings SET drawn_partial = 0 WHERE window_id = $1 AND holder = $2", [
        args.id,
        String(args.holder).toLowerCase(),
      ])
      return
    case "Listed":
      await tx.query(
        `INSERT INTO chain.listings (listing_id, window_id, seller, units, price_per_unit) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (listing_id) DO NOTHING`,
        [args.listingId, args.id, String(args.seller).toLowerCase(), args.units, args.pricePerUnit],
      )
      return
    case "ListingFilled":
      await tx.query("UPDATE chain.listings SET units = units - $1 WHERE listing_id = $2", [args.units, args.listingId])
      return
    case "Delisted":
      await tx.query("UPDATE chain.listings SET units = 0 WHERE listing_id = $1", [args.listingId])
      return
    case "PerformancePosted":
      await tx.query(
        `UPDATE chain.windows SET measured_seconds = $1, below_min_seconds = $2, failed = $3, perf_final_at = $4,
           perf_state = CASE WHEN perf_state = $5 THEN $6::smallint ELSE $7::smallint END
         WHERE id = $8`,
        [args.measuredSeconds, args.belowMinSeconds, args.failed, args.finalAt, PERF_DISPUTED, PERF_FINAL, PERF_POSTED, args.id],
      )
      return
    case "PerformanceDisputed":
      await tx.query("UPDATE chain.windows SET perf_state = $1 WHERE id = $2", [PERF_DISPUTED, args.id])
      return
  }
}
