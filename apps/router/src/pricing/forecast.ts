import { loadFactorBps, livePrice } from "./live.ts"

export type HourUtil = { how: number; u: number }

/** EWMA over up to 4 weekly samples for one hour-of-week. Default 0.3. */
export function forecastUtil(history: number[]): number {
  if (history.length === 0) return 0.3
  const recent = history.slice(-4)
  const alpha = 0.5
  let value = recent[0] ?? 0.3
  for (const sample of recent.slice(1)) value = alpha * sample + (1 - alpha) * value
  return value
}

export function forecastPrice(
  sheet: { baseIn: bigint[]; baseOut: bigint[]; floorIn: bigint; floorOut: bigint },
  how: number,
  historyForHow: number[],
): { in: bigint; out: bigint; u: number } {
  const u = forecastUtil(historyForHow)
  const price = livePrice(sheet, how, loadFactorBps(u))
  return { ...price, u }
}
