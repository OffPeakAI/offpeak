import { readFileSync } from "node:fs"
import type Redis from "ioredis"
import type { Db } from "@offpeak/common"
import type { Counters, Holds } from "../context.ts"
import type { HoldView } from "./prepaid.ts"
import { WINDOW_PENDING_TTL_S, pendingKey } from "./window.ts"

const script = readFileSync(new URL("./holds.lua", import.meta.url), "utf8")
const BOOT_MARK = "offpeak:holds:rebuilt"

const prefixOf = (wallet: string) => `offpeak:hold:{${wallet.toLowerCase()}}`

type HoldScript = { offpeakHold(prefix: string, ...args: string[]): Promise<string> }

export class RedisHolds implements Holds {
  private script: HoldScript

  constructor(redis: Redis) {
    redis.defineCommand("offpeakHold", { numberOfKeys: 1, lua: script })
    this.script = redis as unknown as HoldScript
  }

  async admit(wallet: string, amount: bigint, view: HoldView, holdId: string, now: number, ttl = 900, fromHold = "") {
    const reply = await this.script.offpeakHold(
      prefixOf(wallet),
      "admit",
      amount.toString(),
      String(view.hour),
      String(view.day),
      view.hourlyCap.toString(),
      view.dailyCap.toString(),
      view.balance.toString(),
      view.servable ? "1" : (view.reason ?? "paused"),
      holdId,
      String(now + ttl),
      String(now),
      String(view.lastSettledHour),
      fromHold,
    )
    return reply === "ok" ? ({ ok: true } as const) : ({ ok: false, error: String(reply) } as const)
  }

  async capture(wallet: string, holdId: string, actual: bigint, hour: number) {
    await this.script.offpeakHold(prefixOf(wallet), "capture", holdId, actual.toString(), String(hour))
  }

  async release(wallet: string, holdId: string) {
    await this.script.offpeakHold(prefixOf(wallet), "release", holdId)
  }

  async committed(wallet: string, lastSettledHour: bigint) {
    return BigInt(await this.script.offpeakHold(prefixOf(wallet), "committed", String(lastSettledHour)))
  }
}

export class RedisCounters implements Counters {
  constructor(private redis: Redis) {}

  async add(key: string, by: bigint, ttlSeconds: number) {
    const value = await this.redis.incrby(key, by.toString())
    if (value === Number(by)) await this.redis.expire(key, ttlSeconds)
    return BigInt(value)
  }

  async get(key: string) {
    return BigInt((await this.redis.get(key)) ?? "0")
  }
}

/** Redis can lose spend counters and Window draws; the usage records cannot. Checked on a timer, so a Redis restart heals itself. */
export async function rebuildSpend(db: Db, redis: Redis, sinceHour: number) {
  if (await redis.get(BOOT_MARK)) return 0
  const rows = await db.query<{ payer: string; hour: string; spent: string }>(
    `SELECT payer, hour, SUM(host_cost_micro + fee_micro) AS spent FROM shared.usage_records
     WHERE pay_mode = 0 AND status = 'final' AND hour >= $1 AND req_id NOT IN (SELECT req_id FROM serving.pending_captures)
     GROUP BY payer, hour`,
    [sinceHour],
  )
  for (const row of rows.rows) await redis.hset(`${prefixOf(row.payer)}:spend`, row.hour, row.spent)
  // A record's actual tokens replace the request's reservation, so finished draws are all a counter holds.
  const draws = await db.query<{ window_id: string; payer: string; hour: string; tokens: string }>(
    `SELECT window_id, payer, hour, SUM(tokens_in + tokens_out) AS tokens FROM shared.usage_records
     WHERE pay_mode = 4 AND status = 'final' AND hour >= $1 GROUP BY window_id, payer, hour`,
    [sinceHour],
  )
  for (const row of draws.rows) await redis.set(pendingKey(row.window_id, row.payer, Number(row.hour)), row.tokens, "EX", WINDOW_PENDING_TTL_S)
  await redis.set(BOOT_MARK, "1")
  return rows.rows.length
}
