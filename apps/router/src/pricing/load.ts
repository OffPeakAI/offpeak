export type LoadSample = { t: number; servedTps: number }

/** Long enough that a steady rate reads as itself, however long ago it began. */
const LOAD_WINDOW_S = 300
const TAU_S = 60

/**
 * EWMA with a 60s time constant over per-second buckets, where a second with no bucket served nothing. `u = ewma / maxTps`.
 * Weights are scaled to sum to 1 over the window, so a host held at `maxTps` reads exactly 1.
 */
export function ewmaUtil(samples: LoadSample[], now: number, maxTps: number): number {
  if (maxTps <= 0) return 1
  const alpha = 1 - Math.exp(-1 / TAU_S)
  let value = 0
  for (const sample of samples) {
    const age = now - sample.t
    if (age >= 0 && age < LOAD_WINDOW_S) value += alpha * sample.servedTps * Math.exp(-age / TAU_S)
  }
  return value / (1 - Math.exp(-LOAD_WINDOW_S / TAU_S)) / maxTps
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
/** First tokens wait on prefill, so a longer prompt than this is scaled down to it. Otherwise a buyer's long prompts read as a slow host. */
const TTFT_PROMPT_TOKENS = 1024

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
    const second = Math.floor(t)
    const list = (this.buckets.get(k) ?? []).filter((s) => s.t > second - LOAD_WINDOW_S)
    const bucket = list.find((s) => s.t === second)
    if (bucket) bucket.servedTps += served
    else list.push({ t: second, servedTps: served })
    this.buckets.set(k, list)
  }

  noteTtft(host: string, ms: number, promptTokens = 0) {
    const list = recent(this.ttft.get(host), TTFT_WINDOW_MS)
    list.push({ at: Date.now(), ms: (ms * TTFT_PROMPT_TOKENS) / Math.max(promptTokens, TTFT_PROMPT_TOKENS) })
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
