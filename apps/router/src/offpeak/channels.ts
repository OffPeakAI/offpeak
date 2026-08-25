import { ChannelManagerAbi } from "@offpeak/abis"
import { CHAIN_ID, coopCloseTypes, domain, signTyped, type Hex } from "@offpeak/shared"
import { encodeFunctionData } from "viem"
import { freezeForClose, keepRouterSig, readChannel } from "../pay/channel-store.ts"
import { closeBody } from "../pay/schemas.ts"
import { verifyTyped } from "../pay/signatures.ts"
import type { Stack } from "../pipeline.ts"
import { oai } from "../http.ts"

export async function channelView(stack: Stack, id: string) {
  const chain = await stack.indexer.channel(id)
  if (!chain) return null
  const local = await readChannel(stack.db, id.toLowerCase())
  return {
    deposit: chain.deposit.toString(),
    claimed: chain.claimed.toString(),
    cumulative: local.cumulative.toString(),
    owed: (local.cumulative + local.unvouchered).toString(),
    latestSeq: (local.latestSeq > chain.lastSeq ? local.latestSeq : chain.lastSeq).toString(),
    status: chain.status,
    expiry: chain.expiry.toString(),
    closing: local.closeFinal !== null || local.frozenUntil > stack.clock(),
  }
}

/**
 * Countersigns `cooperativeClose` with the payee key once the payer's figure covers everything owed.
 * The contract pays that figure less what is already claimed, then refunds the rest of the deposit.
 */
export async function closeChannel(stack: Stack, id: Hex, raw: unknown) {
  const body = closeBody.safeParse(raw)
  if (!body.success) return oai(400, "Close needs finalCumulative, deadline and payerSig", "invalid_request", "bad_close")
  const { finalCumulative, deadline, payerSig } = body.data
  // The contract checks this signature against its payee, so another key's signature would only revert.
  const { payee } = stack
  if (!payee || payee.address.toLowerCase() !== stack.channelPayee.toLowerCase()) return oai(503, "Cooperative close is not available", "server_error", "close_unavailable")
  const channel = await stack.indexer.channel(id)
  if (!channel) return oai(404, "Not found", "invalid_request", "not_found")
  if (channel.status !== 1 && channel.status !== 2) return oai(409, "Channel is already closed", "invalid_request", "channel_closed")
  if (deadline <= BigInt(stack.clock())) return oai(400, "Deadline has passed", "invalid_request", "close_deadline")
  if (finalCumulative > channel.deposit) return oai(400, "Final amount is above the deposit", "invalid_request", "close_above_deposit")
  const typed = {
    domain: domain("OffpeakChannel", stack.channelManager),
    types: coopCloseTypes,
    primaryType: "CooperativeClose",
    message: { channelId: id, finalCumulative, deadline },
  } as const
  const signed = await verifyTyped(stack, channel.payer, typed, payerSig)
  if (signed === "unavailable") return oai(503, "Could not check the wallet's signature", "server_error", "verify_unavailable")
  if (signed === "bad") return oai(401, "Close is not signed by the payer", "auth", "bad_close_signature")
  const decision = await freezeForClose(stack.db, channel, id, { finalCumulative, deadline, payerSig }, stack.clock())
  if (!decision.ok) {
    const message = decision.error === "close_below_owed" ? "Final amount does not cover what is owed" : "A close was already signed at another amount"
    return oai(409, message, "invalid_request", decision.error, { owed: decision.owed.toString(), in_flight: decision.inFlight.toString(), required: decision.required.toString() })
  }
  const routerSig = await signTyped(payee, typed)
  await keepRouterSig(stack.db, id, routerSig)
  const data = encodeFunctionData({ abi: ChannelManagerAbi, functionName: "cooperativeClose", args: [id, { channelId: id, finalCumulative, deadline }, payerSig, routerSig] })
  return Response.json({ routerSig, to: stack.channelManager, data, value: "0", chainId: CHAIN_ID })
}
