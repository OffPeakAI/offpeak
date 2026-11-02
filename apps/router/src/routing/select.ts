export type HostCandidate = {
  host: string
  endpoint: string
  priceIn: bigint
  priceOut: bigint
  sheetHash: string
  bondUsdg: bigint
  routingBonusBps: number
  strikes: number
  auditedSamples: number
  util: number
  healthy: boolean
  ttftP95Ms: number
  errorRate: number
  status: "Active" | "Probation" | "Frozen" | "Exiting" | "Delisted" | "None"
  sealedOk: boolean
  modelDigest: string
  maxTps: number
}

export function routingWeight(bondUsdg: bigint, bonusBps: number): bigint {
  return (bondUsdg * BigInt(10_000 + bonusBps)) / 10_000n
}

/** Down or erroring, which only a host can be. Load and slow first tokens can be a buyer's doing. */
export const hostFailing = (h: HostCandidate) => !h.healthy || h.errorRate >= 0.05

export function selectHost(
  all: HostCandidate[],
  opts: { sealed: boolean; windowHost?: string; canary?: boolean; maxPriceIn?: bigint; maxPriceOut?: bigint; interactive?: boolean },
): HostCandidate[] {
  let rows = all.filter((h) => {
    if (opts.windowHost && h.host !== opts.windowHost) return false
    if (opts.sealed && !h.sealedOk) return false
    if (h.status === "Probation") return Boolean(opts.canary)
    if (h.status !== "Active") return false
    return true
  })
  rows = rows.filter((h) => {
    if (hostFailing(h)) return false
    if (h.util >= 0.95) return false
    if (opts.interactive !== false && h.ttftP95Ms >= 1500) return false
    return true
  })
  if (opts.maxPriceIn !== undefined) rows = rows.filter((h) => h.priceIn <= opts.maxPriceIn!)
  if (opts.maxPriceOut !== undefined) rows = rows.filter((h) => h.priceOut <= opts.maxPriceOut!)
  rows.sort((a, b) => {
    if (a.priceIn !== b.priceIn) return a.priceIn < b.priceIn ? -1 : 1
    if (a.priceOut !== b.priceOut) return a.priceOut < b.priceOut ? -1 : 1
    const best = a.priceIn
    const near = (h: HostCandidate) => {
      if (best === 0n) return true
      const delta = h.priceIn > best ? h.priceIn - best : best - h.priceIn
      return delta * 100n <= best
    }
    if (near(a) && near(b)) {
      const wa = routingWeight(a.bondUsdg, a.routingBonusBps)
      const wb = routingWeight(b.bondUsdg, b.routingBonusBps)
      if (wa !== wb) return wa > wb ? -1 : 1
      if (a.strikes !== b.strikes) return a.strikes - b.strikes
      if (a.auditedSamples !== b.auditedSamples) return b.auditedSamples - a.auditedSamples
    }
    return 0
  })
  return rows.slice(0, 3)
}
