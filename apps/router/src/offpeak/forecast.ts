import { buyerUnitPrice, hourIndex, hourOfWeek, type Hex } from "@offpeak/shared"
import type { HourSlot } from "../../../scheduler/src/plan.ts"
import { sheetFor } from "../openai/chat.ts"
import { forecastPrice } from "../pricing/forecast.ts"
import type { Stack } from "../context.ts"

const HISTORY_WEEKS = 4
const HOUR_S = 3600
const LOAD_RETENTION_S = 90 * 86_400

/** Hourly mean utilisation for each host and hour of week, oldest first. */
async function loadHistory(stack: Stack, model: Hex) {
  const rows = await stack.db.query<{ host: string; hour: string; u: number }>(
    `SELECT host, FLOOR(EXTRACT(EPOCH FROM ts) / 3600)::bigint AS hour, AVG(util) AS u FROM serving.host_load
     WHERE model_digest = $1 AND ts >= to_timestamp($2) GROUP BY host, hour ORDER BY hour`,
    [model, stack.clock() - HISTORY_WEEKS * 7 * 86_400],
  )
  const history = new Map<string, number[]>()
  for (const row of rows.rows) {
    const key = `${row.host}:${hourOfWeek(Number(row.hour) * HOUR_S)}`
    history.set(key, [...(history.get(key) ?? []), Number(row.u)])
  }
  return history
}

/** One hour per entry: the cheapest host's forecast price, and the idle tokens of every host for the model. */
export async function forecastSlots(stack: Stack, model: Hex, fromHour: number, count: number): Promise<HourSlot[]> {
  const history = await loadHistory(stack, model)
  const hosts = (await stack.indexer.hostList()).filter((host) => host.routable && host.models.some((row) => row.digest === model))
  const slots: HourSlot[] = []
  for (let hour = fromHour; hour < fromHour + count; hour++) {
    const how = hourOfWeek(hour * HOUR_S)
    let slot: HourSlot | null = null
    for (const host of hosts) {
      const sheet = sheetFor(stack, host.operator, model, hour * HOUR_S)
      const maxTps = host.models.find((row) => row.digest === model)!.maxTps
      if (!sheet) continue
      const price = forecastPrice(sheet, how, history.get(`${host.operator.toLowerCase()}:${how}`) ?? [])
      const idle = Math.floor(maxTps * Math.max(1 - price.u, 0) * HOUR_S)
      if (!slot) slot = { hour, forecastIn: price.in, forecastOut: price.out, idleTokens: idle }
      else {
        slot.idleTokens += idle
        if (price.in + price.out < slot.forecastIn + slot.forecastOut) {
          slot.forecastIn = price.in
          slot.forecastOut = price.out
        }
      }
    }
    if (slot) slots.push(slot)
  }
  return slots
}

/** The next hour forecast at or under the cap, or else the cheapest one coming. Buyer prices. */
export async function nextCheaper(stack: Stack, model: Hex, feeBps: number, cap: { inPerM: bigint; outPerM: bigint } | undefined, now: number) {
  const slots = (await forecastSlots(stack, model, hourIndex(now) + 1, 168)).map((slot) => ({ hour: slot.hour, in: buyerUnitPrice(slot.forecastIn, feeBps), out: buyerUnitPrice(slot.forecastOut, feeBps) }))
  const fits = cap ? slots.find((slot) => slot.in <= cap.inPerM && slot.out <= cap.outPerM) : undefined
  return fits ?? [...slots].sort((a, b) => (a.in + a.out < b.in + b.out ? -1 : a.in + a.out > b.in + b.out ? 1 : a.hour - b.hour))[0] ?? null
}

export async function trimLoad(stack: Stack) {
  await stack.db.query("DELETE FROM serving.host_load WHERE ts < to_timestamp($1)", [stack.clock() - LOAD_RETENTION_S])
}

/** Writes what the load meter sees, so forecasts have history. Each router keeps its own view of a host. */
export async function recordLoad(stack: Stack) {
  const now = stack.clock()
  for (const host of await stack.indexer.hostList()) {
    for (const model of host.models) {
      await stack.db.query("INSERT INTO serving.host_load (host, model_digest, ts, util, ttft_p95_ms, inflight, healthy) VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7) ON CONFLICT DO NOTHING", [
        host.operator.toLowerCase(),
        model.digest,
        now,
        stack.load.util(host.operator, model.digest, model.maxTps, now),
        stack.load.ttftP95(host.operator),
        stack.load.inflight(host.operator, model.digest),
        stack.probesOk.has(host.operator.toLowerCase()),
      ])
    }
  }
}
