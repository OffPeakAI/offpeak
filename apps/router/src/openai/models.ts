import { buyerUnitPrice, hourOfWeek } from "@offpeak/shared"
import { livePrice, loadFactorBps } from "../pricing/live.ts"
import type { Stack } from "../pipeline.ts"

export async function listModels(stack: Stack) {
  const hosts = await stack.indexer.hostList()
  return {
    object: "list" as const,
    data: stack.models.map((model) => {
      const prices = stack.sheets
        .filter((sheet) => sheet.modelDigest === model.digest)
        .map((sheet) => livePrice(sheet, hourOfWeek(stack.clock()), loadFactorBps(stack.load.util(sheet.host, sheet.modelDigest, 100, stack.clock()))))
        .sort((a, b) => (a.in < b.in ? -1 : 1))
      const price = prices[0]
      return {
        id: model.name,
        object: "model" as const,
        owned_by: "offpeak",
        offpeak: {
          digest: model.digest,
          context_length: model.contextLength,
          hosts: hosts.filter((host) => host.models.some((row) => row.digest === model.digest)).length,
          live_price_from: price ? { in: buyerUnitPrice(price.in, 400).toString(), out: buyerUnitPrice(price.out, 400).toString() } : null,
          sealed_available: stack.flags.sealed,
        },
      }
    }),
  }
}
