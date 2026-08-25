/** Keeps a draw counted until settlement has it, with room for a settlement that runs late. */
export const WINDOW_PENDING_TTL_S = 3 * 86_400

export const pendingKey = (id: bigint | string, wallet: string, hour: number) => `offpeak:window:${id}:${wallet.toLowerCase()}:${hour}`

export function windowTokensAvailable(balanceUnits: bigint, drawnTokens: bigint, pending: bigint): bigint {
  const total = balanceUnits * 1_000_000n
  const left = total - drawnTokens - pending
  return left > 0n ? left : 0n
}

export function admitWindow(input: {
  now: number
  t0: number
  t1: number
  available: bigint
  tokensInEst: number
  maxTokensOut: number
}): { ok: true } | { ok: false; error: "window_not_active" | "window_exhausted" } {
  if (input.now < input.t0 || input.now >= input.t1) return { ok: false, error: "window_not_active" }
  if (input.available < BigInt(input.tokensInEst + input.maxTokensOut)) return { ok: false, error: "window_exhausted" }
  return { ok: true }
}
