import { LOAD_FACTOR_MAX_BPS, LOAD_FACTOR_MIN_BPS } from "@offpeak/shared"
import { ceilDiv, type PricePerM } from "@offpeak/shared"

export function loadFactorBps(u: number): number {
  if (!Number.isFinite(u)) return LOAD_FACTOR_MIN_BPS
  const raw = Math.round(LOAD_FACTOR_MIN_BPS + 10_000 * u)
  if (raw < LOAD_FACTOR_MIN_BPS) return LOAD_FACTOR_MIN_BPS
  if (raw > LOAD_FACTOR_MAX_BPS) return LOAD_FACTOR_MAX_BPS
  return raw
}

export function liveLeg(base: PricePerM, floor: PricePerM, lfBps: number): PricePerM {
  const scaled = ceilDiv(base * BigInt(lfBps), 10_000n)
  return scaled > floor ? scaled : floor
}

export function livePrice(
  sheet: { baseIn: bigint[]; baseOut: bigint[]; floorIn: bigint; floorOut: bigint },
  how: number,
  lfBps: number,
): { in: PricePerM; out: PricePerM } {
  const baseIn = sheet.baseIn[how]
  const baseOut = sheet.baseOut[how]
  if (baseIn === undefined || baseOut === undefined) throw new Error("hour of week out of range")
  return {
    in: liveLeg(baseIn, sheet.floorIn, lfBps),
    out: liveLeg(baseOut, sheet.floorOut, lfBps),
  }
}
