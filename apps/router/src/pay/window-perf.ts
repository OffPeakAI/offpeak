import { WINDOW_MAX_SHARE_BPS } from "@offpeak/shared"
import type { Stack } from "../context.ts"

const MINUTE_S = 60
/** Other routers flush a finished minute within a sweep, so it is written out one minute later. */
const SETTLE_MINUTES = 1

type Minute = { tokens: number; busyMs: number; demanded: boolean }
type Track = { streaming: number; open: number; since: number; minutes: Map<number, Minute> }

export type MinuteSample = { windowId: bigint; minute: number; tokens: number; busyMs: number; demanded: boolean }

/**
 * One holder request. Its time counts from its first token, since a short reply says nothing about throughput
 * before that. It becomes demand on a token or at `end`, which is for a host that was asked and failed. `drop` is
 * for everything else, which leaves nothing on record, so a holder cannot manufacture minutes of zero throughput.
 */
export type PerfFlow = { tokens(count: number): void; end(): void; drop(): void }

/**
 * Throughput per Window per minute, for failure claims. The rate is tokens over the time output was
 * flowing, so small requests read at their real speed, and a holder whose request got nothing reads zero.
 */
export class WindowPerf {
  private tracks = new Map<string, Track>()

  constructor(
    private clock: () => number,
    private nowMs: () => number = () => performance.now(),
  ) {}

  private minute(track: Track) {
    const key = Math.floor(this.clock() / MINUTE_S)
    const row = track.minutes.get(key) ?? { tokens: 0, busyMs: 0, demanded: false }
    track.minutes.set(key, row)
    return row
  }

  private accrue(track: Track) {
    const now = this.nowMs()
    if (track.streaming > 0) this.minute(track).busyMs += now - track.since
    track.since = now
  }

  begin(windowId: bigint): PerfFlow {
    const key = windowId.toString()
    const track = this.tracks.get(key) ?? { streaming: 0, open: 0, since: 0, minutes: new Map() }
    this.tracks.set(key, track)
    track.open += 1
    const started = this.nowMs()
    let flowing = false
    let ended = false
    /** True when this flow has just closed without a token, which its caller then judges. */
    const close = () => {
      if (ended) return false
      ended = true
      track.open -= 1
      if (!flowing) return true
      this.accrue(track)
      track.streaming -= 1
      return false
    }
    return {
      tokens: (count) => {
        if (!flowing) {
          flowing = true
          this.accrue(track)
          track.streaming += 1
        }
        this.accrue(track)
        const minute = this.minute(track)
        minute.demanded = true
        minute.tokens += count
      },
      end: () => {
        if (!close()) return
        // Nothing arrived, so the whole wait is time the host served nothing.
        const minute = this.minute(track)
        minute.demanded = true
        minute.busyMs += this.nowMs() - started
      },
      drop: () => {
        close()
      },
    }
  }

  /** The minute in progress, for putting demand on record before the minute ends. */
  sofar(windowId: bigint): MinuteSample | null {
    const track = this.tracks.get(windowId.toString())
    if (!track) return null
    this.accrue(track)
    const minute = Math.floor(this.clock() / MINUTE_S)
    const row = track.minutes.get(minute)
    return row ? { windowId, minute, tokens: row.tokens, busyMs: Math.round(row.busyMs), demanded: row.demanded } : null
  }

  /** Hands over finished minutes. A router writes each one once. */
  take(now: number): MinuteSample[] {
    const current = Math.floor(now / MINUTE_S)
    const out: MinuteSample[] = []
    for (const [key, track] of this.tracks) {
      this.accrue(track)
      for (const [minute, row] of track.minutes) {
        if (minute >= current) continue
        out.push({ windowId: BigInt(key), minute, tokens: row.tokens, busyMs: Math.round(row.busyMs), demanded: row.demanded })
        track.minutes.delete(minute)
      }
      if (track.minutes.size === 0 && track.open === 0) this.tracks.delete(key)
    }
    return out
  }
}

async function refreshShares(stack: Stack, windows: Awaited<ReturnType<Stack["indexer"]["windowList"]>>) {
  const now = stack.clock()
  const hosts = await stack.indexer.hostList()
  const shares = new Map<string, number>()
  for (const window of windows) {
    if (now < Number(window.t0) || now >= Number(window.t1)) continue
    const host = hosts.find((row) => row.operator.toLowerCase() === window.host.toLowerCase())
    const maxTps = host?.models.find((row) => row.digest === window.modelDigest)?.maxTps
    if (!maxTps) continue
    const key = `${window.host.toLowerCase()}:${window.modelDigest}`
    shares.set(key, Math.min((shares.get(key) ?? 0) + Number(window.minTps) / maxTps, WINDOW_MAX_SHARE_BPS / 10_000))
  }
  stack.windowShares = shares
}

const rate = (tokens: number, busyMs: number) => (tokens * 1000) / Math.max(busyMs, 1)

/** The row settlement reads. A later figure replaces an earlier one, and a minute with demand stays one. */
const WRITE_SAMPLE = `INSERT INTO shared.window_perf (window_id, ts, tokens_per_s, demanded) VALUES ($1, to_timestamp($2), $3, $4)
  ON CONFLICT (window_id, ts) DO UPDATE SET
    tokens_per_s = CASE WHEN EXCLUDED.demanded THEN EXCLUDED.tokens_per_s ELSE shared.window_perf.tokens_per_s END,
    demanded = shared.window_perf.demanded OR EXCLUDED.demanded`

/** Puts a minute with demand on record as soon as a request ends, so a router that dies cannot hide it. The sweep has the last word. */
export async function noteWindowMinute(stack: Stack, windowId: bigint) {
  const row = stack.windowPerf.sofar(windowId)
  if (row) await stack.db.query(WRITE_SAMPLE, [row.windowId.toString(), row.minute * MINUTE_S, rate(row.tokens, row.busyMs), row.demanded])
}

/**
 * Routers merge a minute by adding tokens and taking the longest busy time, then one of them writes
 * the figure settlement reads. Every active Window gets a row, so a minute with no demand is on record too.
 */
export async function sweepWindows(stack: Stack) {
  const now = stack.clock()
  const current = Math.floor(now / MINUTE_S)
  const windows = await stack.indexer.windowList().catch(() => null)
  if (windows) await refreshShares(stack, windows).catch(() => undefined)
  for (const row of stack.windowPerf.take(now)) {
    await stack.db.query(
      `INSERT INTO serving.window_minutes (window_id, minute, tokens, busy_ms, demanded) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (window_id, minute) DO UPDATE SET
         tokens = serving.window_minutes.tokens + EXCLUDED.tokens,
         busy_ms = GREATEST(serving.window_minutes.busy_ms, EXCLUDED.busy_ms),
         demanded = serving.window_minutes.demanded OR EXCLUDED.demanded`,
      [row.windowId.toString(), row.minute, row.tokens, row.busyMs, row.demanded],
    )
  }
  const last = current - 1
  for (const window of windows ?? []) {
    if (last * MINUTE_S < Number(window.t0) || last * MINUTE_S >= Number(window.t1)) continue
    await stack.db.query("INSERT INTO serving.window_minutes (window_id, minute) VALUES ($1,$2) ON CONFLICT DO NOTHING", [window.id.toString(), last])
  }
  await stack.db.transaction(async (tx) => {
    const due = await tx.query<{ window_id: string; minute: string; tokens: string; busy_ms: string; demanded: boolean }>(
      `UPDATE serving.window_minutes SET written = true WHERE NOT written AND minute < $1 RETURNING window_id, minute, tokens, busy_ms, demanded`,
      [current - SETTLE_MINUTES],
    )
    for (const row of due.rows) await tx.query(WRITE_SAMPLE, [row.window_id, Number(row.minute) * MINUTE_S, rate(Number(row.tokens), Number(row.busy_ms)), row.demanded])
  })
}
