export type LoadSample = { t: number; servedTps: number }

/** EWMA with a 60s time constant. `u = ewma / maxTps`. */
export function ewmaUtil(samples: LoadSample[], now: number, maxTps: number): number {
  if (maxTps <= 0) return 1
  const tau = 60
  let value = 0
  let last = now - 60
  const ordered = [...samples].filter((s) => s.t >= now - 120 && s.t <= now).sort((a, b) => a.t - b.t)
  for (const sample of ordered) {
    const dt = Math.max(0, sample.t - last)
    const alpha = 1 - Math.exp(-dt / tau)
    value = value + alpha * (sample.servedTps - value)
    last = sample.t
  }
  const tail = Math.max(0, now - last)
  if (tail > 0 && ordered.length > 0) {
    const alpha = 1 - Math.exp(-tail / tau)
    value = value + alpha * (0 - value)
  }
  return value / maxTps
}

export type LoadRow = {
  host: string
  modelDigest: string
  ts: number
  util: number
  ttftP95Ms: number
  inflight: number
  healthy: boolean
}

const ERROR_WINDOW_MS = 5 * 60_000
const TTFT_WINDOW_MS = 15 * 60_000

/** Old samples age out, so one bad minute cannot exclude a quiet host for good. */
function recent<T extends { at: number }>(list: T[] | undefined, windowMs: number): T[] {
  const cutoff = Date.now() - windowMs
  return (list ?? []).filter((row) => row.at >= cutoff)
}

export class LoadMeter {
  private buckets = new Map<string, LoadSample[]>()
  private ttft = new Map<string, { at: number; ms: number }[]>()
  private results = new Map<string, { at: number; ok: boolean }[]>()
  private running = new Map<string, number>()
  rows: LoadRow[] = []

  key(host: string, model: string) {
    return `${host}:${model}`
  }

  /** A request is on this host until `leave`. */
  enter(host: string, model: string) {
    const k = this.key(host, model)
    this.running.set(k, (this.running.get(k) ?? 0) + 1)
  }

  leave(host: string, model: string) {
    const k = this.key(host, model)
    this.running.set(k, Math.max((this.running.get(k) ?? 0) - 1, 0))
  }

  inflight(host: string, model: string) {
    return this.running.get(this.key(host, model)) ?? 0
  }

  note(host: string, model: string, kind: "prefill" | "output", tokens: number, t: number) {
    const served = kind === "output" ? tokens : tokens / 4
    const k = this.key(host, model)
    const list = this.buckets.get(k) ?? []
    list.push({ t, servedTps: served })
    this.buckets.set(k, list.filter((s) => s.t >= t - 180))
  }

  noteTtft(host: string, ms: number) {
    const list = recent(this.ttft.get(host), TTFT_WINDOW_MS)
    list.push({ at: Date.now(), ms })
    if (list.length > 200) list.shift()
    this.ttft.set(host, list)
  }

  noteResult(host: string, ok: boolean) {
    const list = recent(this.results.get(host), ERROR_WINDOW_MS)
    list.push({ at: Date.now(), ok })
    if (list.length > 100) list.shift()
    this.results.set(host, list)
  }

  errorRate(host: string): number {
    const list = recent(this.results.get(host), ERROR_WINDOW_MS)
    if (list.length === 0) return 0
    return list.filter((row) => !row.ok).length / list.length
  }

  util(host: string, model: string, maxTps: number, now: number): number {
    return ewmaUtil(this.buckets.get(this.key(host, model)) ?? [], now, maxTps)
  }

  ttftP95(host: string): number {
    const list = recent(this.ttft.get(host), TTFT_WINDOW_MS)
    if (list.length === 0) return 0
    const sorted = list.map((row) => row.ms).sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
  }

  flush(host: string, model: string, maxTps: number, now: number, inflight: number, healthy: boolean): LoadRow {
    const row: LoadRow = {
      host,
      modelDigest: model,
      ts: now,
      util: this.util(host, model, maxTps, now),
      ttftP95Ms: this.ttftP95(host),
      inflight,
      healthy,
    }
    this.rows.push(row)
    return row
  }
}
