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
 * before that. It becomes demand on a token or at `end`. `drop` is for a request the host never had to serve,
 * which leaves nothing on record, so a holder cannot manufacture minutes of zero throughput.
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
