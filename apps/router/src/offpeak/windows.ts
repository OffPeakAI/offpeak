import { encodeFunctionData, type Hex } from "viem"
import { windowMarketAbi } from "@offpeak/abis"
import { CHAIN_ID, formatResaleFee, windowResaleFeeMicro } from "@offpeak/shared"
import type { Stack } from "../pipeline.ts"

export function windowCalldata(stack: Stack, action: "buy" | "cancel" | "list" | "claim", body: { id: string; units?: string; price?: string }) {
  const id = BigInt(body.id)
  const units = BigInt(body.units ?? "1")
  const price = BigInt(body.price ?? "0")
  const data =
    action === "buy"
      ? encodeFunctionData({ abi: windowMarketAbi, functionName: "buy", args: [id, units, price] })
      : action === "cancel"
        ? encodeFunctionData({ abi: windowMarketAbi, functionName: "cancel", args: [id, units] })
        : action === "list"
          ? encodeFunctionData({ abi: windowMarketAbi, functionName: "list", args: [id, units, price] })
          : encodeFunctionData({ abi: windowMarketAbi, functionName: "claimExpired", args: [id] })
  const fee = action === "list" ? formatResaleFee(price, windowResaleFeeMicro(price, price / 2n) > 0n ? price / 2n : 0n) : undefined
  return { to: stack.windowMarket as Hex, data, value: "0", chainId: CHAIN_ID, feePreview: fee }
}

export async function windowBoard(stack: Stack) {
  return (await stack.indexer.windowList()).map((row) => ({
    id: row.id.toString(),
    host: row.host,
    resaleFee: "1% of the sale price + 10% of your markup",
  }))
}
