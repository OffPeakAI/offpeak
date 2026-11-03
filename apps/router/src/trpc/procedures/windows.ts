import { createWindowInput, createWindowPlan } from "../../expansion/window-plan.ts"
import { windowResaleFeeMicro } from "@offpeak/shared"
import { windowMarketAbi } from "@offpeak/abis"
import { encodeFunctionData } from "viem"
import { z } from "zod"
import { approvalFor, authed, feature, missing, publicProcedure, refuse, router, txFor } from "../init.ts"
import { positiveMicro, pricePerUnit, uint256, units } from "../inputs.ts"
import type { Stack } from "../../pipeline.ts"

const on = authed.use(feature("windows"))

async function known(stack: Stack, id: bigint) {
  const row = await stack.indexer.window(id.toString())
  if (!row) throw missing()
  return row
}

async function held(stack: Stack, wallet: string, id: bigint) {
  const row = await stack.indexer.holder(id.toString(), wallet)
  return row ?? { balance: 0n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 0n }
}

export const windows = router({
  createPlan: on.input(createWindowInput).mutation(({ctx:{stack,wallet},input})=>createWindowPlan(stack,wallet,input)),
  list: publicProcedure.query(async ({ ctx }) => (await ctx.stack.indexer.windowList()).map((row) => ({ id: row.id.toString(), host: row.host }))),
  /** The Dutch price here is as fresh as the indexer's read of `windowView`. */
  board: publicProcedure.query(async ({ ctx: { stack } }) => {
    const rows = await stack.indexer.windowList()
    return {
      serverTime: stack.clock(),
      windows: rows.map((row) => ({
        id: row.id.toString(),
        host: row.host,
        modelDigest: row.modelDigest,
        model: stack.models.find((model) => model.digest === row.modelDigest)?.name ?? null,
        t0: Number(row.t0),
        t1: Number(row.t1),
        minTps: Number(row.minTps),
        units: row.units.toString(),
        hostPricePerUnit: row.hostPricePerUnit.toString(),
        buyerPricePerUnit: row.buyerPricePerUnit.toString(),
        failed: row.failed,
      })),
    }
  }),
  holdings: authed.query(async ({ ctx: { stack, wallet } }) => {
    const rows = await stack.indexer.windowList()
    const views = await Promise.all(rows.map(async (row) => ({ id: row.id.toString(), view: await held(stack, wallet, BigInt(row.id)) })))
    return views
      .filter(({ view }) => view.balance > 0n || view.drawnTokens > 0n)
      .map(({ id, view }) => ({
        id,
        balance: view.balance.toString(),
        lockedPartial: view.lockedPartial.toString(),
        drawnTokens: view.drawnTokens.toString(),
        costBasis: view.costBasis.toString(),
      }))
  }),
  buyPlan: on.input(z.strictObject({ id: uint256, units, maxBuyerPricePerUnit: positiveMicro })).mutation(async ({ ctx: { stack }, input }) => {
    await known(stack, input.id)
    return {
      approval: approvalFor(stack, stack.windowMarket, input.units * input.maxBuyerPricePerUnit),
      tx: txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName: "buy", args: [input.id, input.units, input.maxBuyerPricePerUnit] })),
    }
  }),
  /** Gives back 95% of the host price plus the full fee, and only before the Window starts. */
  cancelTx: on.input(z.strictObject({ id: uint256, units })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const row = await known(stack, input.id)
    if (BigInt(stack.clock()) >= BigInt(row.t0)) throw refuse("window_started")
    const holding = await held(stack, wallet, input.id)
    if (input.units > holding.balance) throw refuse("exceeds_holding")
    return txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName: "cancel", args: [input.id, input.units] }))
  }),
  /** The fee comes from the seller's own cost basis on chain, never from a number the page sends. */
  listTx: on.input(z.strictObject({ id: uint256, units, pricePerUnit })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const row = await known(stack, input.id)
    if (BigInt(stack.clock()) >= BigInt(row.t1)) throw refuse("window_ended")
    const holding = await held(stack, wallet, input.id)
    if (input.units > holding.balance) throw refuse("exceeds_holding")
    return {
      feeMicro: windowResaleFeeMicro(input.units * input.pricePerUnit, input.units * holding.costBasis).toString(),
      tx: txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName: "list", args: [input.id, input.units, input.pricePerUnit] })),
    }
  }),
  delistTx: on.input(z.strictObject({ listingId: uint256 })).mutation(({ ctx: { stack }, input }) =>
    txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName: "delist", args: [input.listingId] })),
  ),
  buyListingPlan: on.input(z.strictObject({ listingId: uint256, units, maxPricePerUnit: pricePerUnit })).mutation(({ ctx: { stack }, input }) => ({
    approval: approvalFor(stack, stack.windowMarket, input.units * input.maxPricePerUnit),
    tx: txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName: "buyListing", args: [input.listingId, input.units, input.maxPricePerUnit] })),
  })),
  claimTx: on.input(z.strictObject({ id: uint256 })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const row = await known(stack, input.id)
    if (BigInt(stack.clock()) < BigInt(row.t1)) throw refuse("window_not_ended")
    const holding = await held(stack, wallet, input.id)
    if (holding.balance === 0n) throw refuse("nothing_to_claim")
    const functionName = row.failed ? "claimFailure" : "claimExpired"
    return { kind: row.failed ? ("failure" as const) : ("expired" as const), tx: txFor(stack.windowMarket, encodeFunctionData({ abi: windowMarketAbi, functionName, args: [input.id] })) }
  }),
})
