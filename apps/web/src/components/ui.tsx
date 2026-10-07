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

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <p className="state-title">{title}</p>
      {children && <p className="note">{children}</p>}
    </div>
  )
}

/** One place for the loading, error and ready states of a query. */
export function Data<T>({ query, lines, children }: { query: UseQueryResult<T>; lines?: number; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>
  if (query.isError) return <Failed error={query.error} retry={() => void query.refetch()} />
  return <Loading lines={lines} />
}

export function NotOn({ name }: { name: string }) {
  return (
    <div className="state off">
      <p className="state-title">{name}: not switched on yet.</p>
      <p className="note">
        Live feature flags are on the <a href="/docs#status">status page</a>.
      </p>
    </div>
  )
}

/** Renders children only while `GET /v1/status` has the flag on. */
export function Flagged({ flag, name, children }: { flag: keyof Flags; name: string; children: ReactNode }) {
  const status = useStatus()
  if (status.isError) return <Failed error={status.error} retry={() => void status.refetch()} />
  if (!status.data) return <Loading />
  return status.data.features[flag] ? <>{children}</> : <NotOn name={name} />
}

export function FlagWord({ on }: { on: boolean }) {
  return <span className={on ? "pill ok" : "pill wait"}>{flagWord(on)}</span>
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="note">{hint}</span> : null}
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (next: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Section({ id, title, aside, children }: { id?: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {aside && <div className="section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

export function Stat({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <b>{children}</b>
      {note && <span className="note">{note}</span>}
    </div>
  )
}
