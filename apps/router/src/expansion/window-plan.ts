import { z } from "zod"
import { encodeFunctionData } from "viem"
import { windowMarketAbi } from "@offpeak/abis"
import { approvalFor, refuse, txFor } from "../trpc/init.ts"
import type { Stack } from "../context.ts"
const uint64 = z
  .string()
  .regex(/^\d{1,20}$/)
  .transform(BigInt)
  .refine((x) => x > 0n && x < 2n ** 64n)
export const createWindowInput = z.strictObject({
  modelDigest: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase() as `0x${string}`),
  t0: z.number().int().positive(),
  t1: z.number().int().positive(),
  minTps: z
    .number()
    .int()
    .min(1)
    .max(2 ** 32 - 1),
  units: uint64,
  startPricePerUnit: uint64,
  endPricePerUnit: uint64,
  auctionStart: z.number().int().nonnegative(),
  auctionEnd: z.number().int().positive(),
})
export async function createWindowPlan(stack: Stack, wallet: string, w: z.output<typeof createWindowInput>) {
  const now = stack.clock()
  if (
    w.t0 % 3600 ||
    w.t1 % 3600 ||
    w.t0 <= now ||
    w.t1 <= w.t0 ||
    w.t1 - w.t0 > 168 * 3600 ||
    w.t1 > now + 365 * 86400 ||
    w.auctionStart >= w.auctionEnd ||
    w.auctionEnd > w.t0 ||
    w.auctionEnd <= now ||
    w.endPricePerUnit > w.startPricePerUnit
  )
    throw refuse("invalid_window_terms")
  const host = (await stack.indexer.hostList()).find((h) => h.operator.toLowerCase() === wallet.toLowerCase())
  const serving = host?.models.find((m) => m.digest.toLowerCase() === w.modelDigest)
  if (!host?.routable || !serving) throw refuse("host_not_serving_model")
  if (w.minTps > serving.maxTps) throw refuse("speed_exceeds_capacity")
  const hours = BigInt((w.t1 - w.t0) / 3600),
    perHour = (w.units * 1000000n + hours - 1n) / hours
  if (perHour > (BigInt(serving.maxTps) * 3600n * 7n) / 10n) throw refuse("window_exceeds_capacity")
  const collateral = (w.units * w.startPricePerUnit * 2000n + 9999n) / 10000n
  const params = { ...w, t0: BigInt(w.t0), t1: BigInt(w.t1), auctionStart: BigInt(w.auctionStart), auctionEnd: BigInt(w.auctionEnd) }
  return {
    collateralMicro: collateral.toString(),
    approval: approvalFor(stack, stack.windowMarket, collateral),
    tx: txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName: "create", args: [params, collateral] })),
  }
}
