import { METER_TOLERANCE_ABS, METER_TOLERANCE_BPS } from "./constants.ts"

export function countsWithinTolerance(routerCount: number, hostCount: number): boolean {
  const diff = Math.abs(routerCount - hostCount)
  const allowance = Math.max(METER_TOLERANCE_ABS, Math.floor((routerCount * METER_TOLERANCE_BPS) / 10_000))
  return diff <= allowance
}

export function bothCountsOk(routerIn: number, routerOut: number, hostIn: number, hostOut: number): boolean {
  return countsWithinTolerance(routerIn, hostIn) && countsWithinTolerance(routerOut, hostOut)
}
