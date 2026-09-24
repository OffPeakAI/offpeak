import { useEffect, useState, type ReactNode } from "react"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getAddress } from "viem"
import { clockOffset } from "../lib/countdown.ts"
import { explain, rest, trpcQuery } from "../lib/api.ts"
import { formatPrice, formatUsdg, shortHex } from "../lib/format.ts"
import { flagWord, type Flags } from "../lib/labels.ts"
import type { Network, Status } from "../lib/types.ts"
import { pinNetwork } from "../lib/wallet-check.ts"

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => rest<Status>("/v1/status"), staleTime: 30_000 })
}

/** The router's view of the chain, with every address replaced by the one this build was shipped with. */
export function useNetwork() {
  return useQuery({ queryKey: ["account.network"], queryFn: async () => pinNetwork(await trpcQuery<Network>("account.network")), staleTime: 60_000 })
}

/** A ticking clock in server time, so countdowns ignore a wrong browser clock. */
export function useNow(serverTime?: number) {
  const [offset] = useState(() => (serverTime ? clockOffset(serverTime, Date.now()) : 0))
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000) + offset)
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000) + offset), 1000)
    return () => clearInterval(timer)
  }, [offset])
  return now
}

export function Usdg({ micro, unit = true }: { micro: bigint | string; unit?: boolean }) {
  return (
    <span className="money">
      {formatUsdg(micro)}
      {unit && <span className="unit"> USDG</span>}
    </span>
  )
}

export function Price({ value }: { value: bigint | string }) {
  return <span className="money">{formatPrice(value)}</span>
}

function checksummed(value: string) {
  try {
    return getAddress(value)
  } catch {
    return value
  }
}

export function Mono({ value, lead, tail, copy = true }: { value: string; lead?: number; tail?: number; copy?: boolean }) {
  const [done, setDone] = useState(false)
  const text = value.length === 42 ? checksummed(value) : value
  const write = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1200)
    } catch {
      setDone(false)
    }
  }
  return (
    <span className="mono" title={text}>
      {shortHex(text, lead, tail)}
      {copy && (
        <button type="button" className="copy" onClick={write} aria-label={`Copy ${text}`}>
          {done ? "copied" : "copy"}
        </button>
      )}
    </span>
  )
}

export function Loading({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="loading" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton" />
      ))}
    </div>
  )
}

export function Failed({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="state fail" role="alert">
      <p>{explain(error)}</p>
      {retry && (
        <button type="button" className="btn ghost" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}
