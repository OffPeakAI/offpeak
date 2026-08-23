import { FEE_BPS_DEFAULT, buyerUnitPrice, hourIndex, hourOfWeek, type Hex } from "@offpeak/shared"
import { sheetFor } from "../openai/chat.ts"
import { forecastPrice } from "../pricing/forecast.ts"
import { livePrice, loadFactorBps } from "../pricing/live.ts"
import type { Stack } from "../pipeline.ts"

const ACTIVE = 2
const HISTORY_S = 28 * 86_400
const HISTORY_CACHE_MS = 300_000
const STATS_S = 30 * 86_400
const ATTESTATION_FRESH_S = 48 * 3_600
const HOURS = 168

type History = Map<string, number[]>

const historyCache = new WeakMap<Stack, Map<string, { at: number; rows: History }>>()

/** Hourly mean load by host and hour of week, oldest first. The forecast weighs the last four weeks. */
async function loadHistory(stack: Stack, digest: string, now: number): Promise<History> {
  const cache = historyCache.get(stack) ?? new Map<string, { at: number; rows: History }>()
  historyCache.set(stack, cache)
  const hit = cache.get(digest)
  if (hit && performance.now() - hit.at < HISTORY_CACHE_MS) return hit.rows
  const found = await stack.db.query<{ host: string; hour: string; util: number }>(
    `SELECT host, floor(extract(epoch FROM ts) / 3600)::bigint AS hour, avg(util) AS util
     FROM serving.host_load WHERE model_digest = $1 AND ts > to_timestamp($2)
     GROUP BY host, hour ORDER BY hour`,
    [digest, now - HISTORY_S],
  )
  const rows: History = new Map()
  for (const row of found.rows) {
    const key = `${row.host.toLowerCase()}:${hourOfWeek(Number(row.hour) * 3_600)}`
    rows.set(key, [...(rows.get(key) ?? []), Number(row.util)])
  }
  cache.set(digest, { at: performance.now(), rows })
  return rows
}

async function discounts(stack: Stack, now: number) {
  const found = await stack.db.query<{ host: string; billed: string; base: string }>(
    `SELECT host, sum(billed_host_micro) AS billed, sum(base_value_micro) AS base FROM serving.host_stats
     WHERE day >= to_timestamp($1)::date GROUP BY host`,
    [now - STATS_S],
  )
  const rows = new Map<string, number>()
  for (const row of found.rows) {
    const billed = BigInt(row.billed)
    const base = BigInt(row.base)
    if (base > 0n) rows.set(row.host.toLowerCase(), billed >= base ? 0 : Number(((base - billed) * 10_000n) / base))
  }
  return rows
}

async function sealedHosts(stack: Stack, now: number) {
  if (!stack.flags.sealed) return new Set<string>()
  const found = await stack.db.query<{ host: string }>("SELECT host FROM serving.sealed_attestations WHERE verified_at > to_timestamp($1)", [now - ATTESTATION_FRESH_S])
  return new Set(found.rows.map((row) => row.host.toLowerCase()))
}

const cheaper = (a: { in: bigint; out: bigint }, b: { in: bigint; out: bigint }) => a.in < b.in || (a.in === b.in && a.out < b.out)

/**
 * One model's prices. Every price is a buyer price at `feeBps`, so live, base and floor compare
 * like for like. `next168h` is keyed by absolute hour, starting with this one, and each row is the lowest forecast.
 */
export async function priceTable(stack: Stack, model: { name: string; digest: Hex }, feeBps = FEE_BPS_DEFAULT) {
  const now = stack.clock()
  const how = hourOfWeek(now)
  const buyer = (host: bigint) => buyerUnitPrice(host, feeBps).toString()
  const chain = await stack.indexer.hostList()
  const [history, discount, sealed] = await Promise.all([loadHistory(stack, model.digest, now), discounts(stack, now), sealedHosts(stack, now)])
  const hosts = chain.flatMap((host) => {
    const sheet = sheetFor(stack, host.operator, model.digest, now)
    if (!sheet) return []
    const key = host.operator.toLowerCase()
    const maxTps = host.models.find((row) => row.digest === model.digest)?.maxTps ?? 0
    const live = livePrice(sheet, how, loadFactorBps(stack.load.util(key, model.digest, maxTps, now)))
    return [
      {
        key,
        status: host.status,
        routable: host.routable && host.status === ACTIVE,
        strikes: host.strikes,
        bond: host.bondUsdg,
        live,
        base: { in: sheet.baseIn[how]!, out: sheet.baseOut[how]! },
        floor: { in: sheet.floorIn, out: sheet.floorOut },
      },
    ]
  })
  const eligible = hosts.filter((host) => host.routable)
  const best = eligible.reduce<(typeof eligible)[number] | null>((low, host) => (!low || cheaper(host.live, low.live) ? host : low), null)
  const startHour = hourIndex(now)
  const next168h = best
    ? Array.from({ length: HOURS }, (_, offset) => {
        const hour = startHour + offset
        const ts = hour * 3_600
        const slot = hourOfWeek(ts)
        const lowest = eligible.reduce<{ in: bigint; out: bigint } | null>((low, host) => {
          const sheet = sheetFor(stack, host.key, model.digest, ts) ?? sheetFor(stack, host.key, model.digest, now)
          if (!sheet) return low
          const price = forecastPrice(sheet, slot, history.get(`${host.key}:${slot}`) ?? [])
          return !low || cheaper(price, low) ? price : low
        }, null)
        return { hour, how: slot, forecast_in: buyer(lowest?.in ?? 0n), forecast_out: buyer(lowest?.out ?? 0n) }
      })
    : []
  return {
    model: model.name,
    digest: model.digest,
    feeBps,
    serverTime: now,
    now: best ? { in: buyer(best.live.in), out: buyer(best.live.out), host: best.key } : null,
    hosts: hosts.map((host) => ({
      host: host.key,
      status: host.status,
      routable: host.routable,
      strikes: host.strikes,
      bond: host.bond.toString(),
      live: { in: buyer(host.live.in), out: buyer(host.live.out) },
      base: { in: buyer(host.base.in), out: buyer(host.base.out) },
      floor: { in: buyer(host.floor.in), out: buyer(host.floor.out) },
      effective_discount_30d_bps: discount.get(host.key) ?? null,
      sealed: sealed.has(host.key),
    })),
    next168h,
    forecastFromHistory: history.size > 0,
  }
}

/** `GET /v1/prices`, the public shape of the table above. `now` is left out when no host can serve the model. */
export async function priceBoard(stack: Stack, model: { name: string; digest: Hex }, feeBps?: number) {
  const { model: name, digest, now, hosts, next168h } = await priceTable(stack, model, feeBps)
  return {
    model: name,
    digest,
    ...(now ? { now } : {}),
    hosts: hosts.map(({ host, live, base, floor, effective_discount_30d_bps, sealed }) => ({ host, live, base, floor, effective_discount_30d_bps, sealed })),
    next168h: next168h.map(({ hour, forecast_in, forecast_out }) => ({ hour, forecast_in, forecast_out })),
  }
}
