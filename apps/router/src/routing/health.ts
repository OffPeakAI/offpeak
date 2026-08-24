export type Probe = { host: string; ok: boolean; at: number }

export function probeFresh(probe: Probe | undefined, now: number): boolean {
  if (!probe) return false
  return probe.ok && now - probe.at <= 30
}

export function errorRate(failures: number, total: number): number {
  if (total <= 0) return 0
  return failures / total
}
