import { z } from "zod"
import { maxModelLen } from "./config.ts"

const PROBE_TIMEOUT_MS = 2_000
const PROBE_TTL_MS = 5_000

const modelsSchema = z.object({ data: z.array(z.looseObject({ id: z.string(), max_model_len: z.number().nullish() })) })

export function healthBody(inflight: number, queueDepth: number, ok = true) {
  return { inflight, queueDepth, ok }
}

/** Sums `vllm:num_requests_waiting` across engines. Advisory, like the rest of this endpoint. */
export function waitingRequests(metrics: string): number {
  let waiting = 0
  for (const line of metrics.split("\n")) {
    if (!line.startsWith("vllm:num_requests_waiting")) continue
    const value = Number(line.slice(line.lastIndexOf(" ") + 1))
    if (Number.isFinite(value)) waiting += value
  }
  return waiting
}

export type EngineState = { ready: boolean; queueDepth: number }

type WatchedEngine = { name: string; engine: string; vllmArgs: string[] }

/** Asks vLLM what it serves. It may still be loading weights, so this reports state and never stops the agent. */
export class EngineWatch {
  private last: { at: number; state: EngineState } | null = null

  constructor(private readonly models: WatchedEngine[]) {}

  private async probe(model: WatchedEngine): Promise<EngineState> {
    try {
      const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
      const res = await fetch(`${model.engine}/v1/models`, { signal })
      if (!res.ok) return { ready: false, queueDepth: 0 }
      const card = modelsSchema.parse(await res.json()).data.find((row) => row.id === model.name)
      const wanted = maxModelLen(model)
      if (!card || (wanted !== null && card.max_model_len !== wanted)) return { ready: false, queueDepth: 0 }
      const metrics = await fetch(`${model.engine}/metrics`, { signal }).catch(() => null)
      return { ready: true, queueDepth: metrics?.ok ? waitingRequests(await metrics.text()) : 0 }
    } catch {
      return { ready: false, queueDepth: 0 }
    }
  }

  async state(): Promise<EngineState> {
    const now = performance.now()
    if (this.last && now - this.last.at < PROBE_TTL_MS) return this.last.state
    const rows = await Promise.all(this.models.map((model) => this.probe(model)))
    const state = { ready: rows.every((row) => row.ready), queueDepth: rows.reduce((sum, row) => sum + row.queueDepth, 0) }
    this.last = { at: now, state }
    return state
  }
}
