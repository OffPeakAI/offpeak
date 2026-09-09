import { log } from "@offpeak/common"
import type { Address } from "viem"
import type { KeeperDeps } from "./types.ts"

/** Used until there is a burn to measure. */
const LOW_BALANCE_WEI = 10_000_000_000_000_000n
const ALERT_DAYS = 3
const DAY_S = 86_400
/** New samples count for this much of the running rate, so one busy hour does not swing it. */
const SMOOTHING = 0.2

type Sample = { ts: number; balance: bigint; weiPerDay: number }

/** Measures each role's spend from its balance. A rise is a top-up, so it resets the baseline only. */
export class GasBurn {
  private samples = new Map<string, Sample>()

  observe(role: string, ts: number, balance: bigint): number {
    const last = this.samples.get(role)
    let weiPerDay = last?.weiPerDay ?? 0
    if (last && ts > last.ts && balance < last.balance) {
      const rate = (Number(last.balance - balance) / (ts - last.ts)) * DAY_S
      weiPerDay = weiPerDay === 0 ? rate : weiPerDay * (1 - SMOOTHING) + rate * SMOOTHING
    }
    this.samples.set(role, { ts, balance, weiPerDay })
    return weiPerDay
  }
}

export function daysLeft(balance: bigint, weiPerDay: number) {
  return weiPerDay > 0 ? Number(balance) / weiPerDay : Number.POSITIVE_INFINITY
}

export async function runGasWatch(deps: KeeperDeps, watched: Record<string, Address>, burn: GasBurn) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const low: string[] = []
  for (const [role, address] of Object.entries(watched)) {
    const balance = await deps.reader.getBalance({ address })
    const days = daysLeft(balance, burn.observe(role, Number(head.timestamp), balance))
    deps.metrics.set(`gas_balance_wei{role="${role}"}`, Number(balance))
    if (Number.isFinite(days)) deps.metrics.set(`${role}_balance_days`, days)
    if (days < ALERT_DAYS || balance < LOW_BALANCE_WEI) {
      low.push(role)
      log("keepers", "gas_low", { role, balance, days })
    }
  }
  return low
}
