import { randomBytes } from "node:crypto"
import { CHANNEL_MIN_LIFETIME_S, CHANNEL_STATUS, type ChannelChain, type Hex } from "@offpeak/shared"
import { channelManagerAbi } from "@offpeak/abis"
import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem"
import { z } from "zod"
import { channelView } from "../../offpeak/channels.ts"
import { approvalFor, authed, feature, missing, refuse, router, txFor } from "../init.ts"
import { bytes32, positiveMicro } from "../inputs.ts"
import type { Stack } from "../../pipeline.ts"

const MIN_DEPOSIT_MICRO = 1_000_000n
const MAX_LIFETIME_S = 365 * 86_400

const on = authed.use(feature("channels"))
const byId = z.strictObject({ id: bytes32 })

/** A channel is visible only to its payer. Anyone else gets the same answer as a channel that does not exist. */
async function own(stack: Stack, wallet: string, id: string): Promise<ChannelChain> {
  const chain = await stack.indexer.channel(id)
  if (!chain || chain.payer.toLowerCase() !== wallet) throw missing()
  return chain
}

async function present(stack: Stack, id: string, chain: ChannelChain) {
  const view = await channelView(stack, id)
  if (!view) throw missing()
  return { id, ...view, challengeEndsAt: chain.challengeEndsAt.toString(), closeRequested: chain.closeRequested }
}

export const channels = router({
  list: authed.query(async ({ ctx: { stack, wallet } }) => {
    const known = await stack.db.query<{ channel_id: string }>(
      `SELECT channel_id FROM shared.channel_state WHERE lower(payer) = $1
       UNION SELECT channel_id FROM serving.channels_local WHERE lower(payer) = $1`,
      [wallet],
    )
    const rows = await Promise.all(
      known.rows.map(async ({ channel_id: id }) => {
        const chain = await stack.indexer.channel(id)
        return chain && chain.payer.toLowerCase() === wallet ? present(stack, id, chain) : null
      }),
    )
    return rows.filter((row) => row !== null)
  }),
  get: authed.input(byId).query(async ({ ctx: { stack, wallet }, input }) => present(stack, input.id, await own(stack, wallet, input.id))),
  openPlan: on.input(z.strictObject({ deposit: positiveMicro, lifetimeSeconds: z.number().int().min(CHANNEL_MIN_LIFETIME_S).max(MAX_LIFETIME_S) })).mutation(({ ctx: { stack, wallet }, input }) => {
    if (input.deposit < MIN_DEPOSIT_MICRO) throw refuse("deposit_too_small")
    const salt = `0x${randomBytes(32).toString("hex")}` as Hex
    const expiry = BigInt(stack.clock() + input.lifetimeSeconds)
    const channelId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [wallet as Hex, salt]))
    return {
      channelId,
      approval: approvalFor(stack, stack.channelManager, input.deposit),
      tx: txFor(stack.channelManager, encodeFunctionData({ abi: channelManagerAbi, functionName: "open", args: [input.deposit, expiry, salt] })),
    }
  }),
  topUpPlan: on.input(z.strictObject({ id: bytes32, amount: positiveMicro })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const chain = await own(stack, wallet, input.id)
    if (chain.status !== CHANNEL_STATUS.Open) throw refuse("channel_not_open")
    return {
      approval: approvalFor(stack, stack.channelManager, input.amount),
      tx: txFor(stack.channelManager, encodeFunctionData({ abi: channelManagerAbi, functionName: "topUp", args: [input.id, input.amount] })),
    }
  }),
  requestCloseTx: on.input(byId).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const chain = await own(stack, wallet, input.id)
    if (chain.status !== CHANNEL_STATUS.Open) throw refuse("channel_not_open")
    return txFor(stack.channelManager, encodeFunctionData({ abi: channelManagerAbi, functionName: "requestClose", args: [input.id] }))
  }),
  finalizeCloseTx: on.input(byId).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const chain = await own(stack, wallet, input.id)
    if (chain.status !== CHANNEL_STATUS.Closing) throw refuse("channel_not_closing")
    if (BigInt(stack.clock()) < chain.challengeEndsAt) throw refuse("challenge_period")
    return txFor(stack.channelManager, encodeFunctionData({ abi: channelManagerAbi, functionName: "finalizeClose", args: [input.id] }))
  }),
})
