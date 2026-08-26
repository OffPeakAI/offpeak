import type { Stack } from "../pipeline.ts"

export async function hostPayouts(stack: Stack, host: string) {
  const row = await stack.indexer.host(host)
  return {
    host,
    releasable: row?.releasableCredits.toString() ?? "0",
    pending: row?.pendingCredits.toString() ?? "0",
    strikes: row?.strikes ?? 0,
  }
}
