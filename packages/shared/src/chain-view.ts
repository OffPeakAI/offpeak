import { keccak256, toBytes, type Hex } from "viem"
import { canonicalJson } from "./canonical.ts"
import type { BuyerView, ChannelView, HolderView, HostView, WindowView } from "./types.ts"

/** Messages on the Redis `offpeak:chain` channel. */
export type ChainPush = { type: string; block?: number; txHash?: string; [key: string]: unknown }

export type BuyerChain = BuyerView & {
  servable: boolean
  reason?: "withdraw_requested" | "paused" | "no_balance" | "no_caps"
  fetchedAt: number
}

export type HostChain = HostView & {
  models: { digest: Hex; maxTps: number; name?: string }[]
  routable: boolean
  routingBonusBps: number
  endpointHash: Hex
  endpoint: string
}

export type ChannelChain = ChannelView & { closeRequested: boolean }

export type EscrowChain = {
  status: "none" | "authorized" | "captured" | "expired"
  maxAmount: bigint
  captured: bigint
  txHash?: string | null
}

export type OfpkChain = { tier: number; feeDiscountBps: number; earlyAccess: boolean }

export type ProofChain = { hour: number; leaf: string; proof: string[]; root: string; txHash: string }

/** One row of `/idx/v1/challenges`. `state` follows AuditCourt: 1 Filed, 2 PanelReview, 3 Decided, 4 Finalized. */
export type ChallengeChain = { id: string; host: string; kind: number; state: number; slashBps: number; filedAt: number; reviewEndsAt: number }

/** What the router reads from the chain. The indexer API serves it live; tests use the mock. */
export type ChainReader = {
  buyer(addr: string, now: number): Promise<BuyerChain>
  hostList(): Promise<HostChain[]>
  host(addr: string): Promise<HostChain | null>
  channel(id: string): Promise<ChannelChain | null>
  escrow(reqId: string): Promise<EscrowChain | null>
  window(id: string): Promise<WindowView | null>
  windowList(): Promise<WindowView[]>
  holder(id: string, addr: string): Promise<HolderView | null>
  ofpkOf(addr: string): Promise<OfpkChain | null>
  proof(reqId: string): Promise<ProofChain | null>
  challengesOf?(host: string): Promise<ChallengeChain[]>
  subscribe(fn: (msg: ChainPush) => void): () => void
}

export type PaymentPayload = {
  x402Version?: number
  scheme: "upto" | "exact" | "channel"
  payload: {
    signature: Hex
    witness: Record<string, unknown>
    permitted: { token: Hex; amount: string }
    spender: Hex
    nonce: string
    deadline: string
    payer?: Hex
  }
}

export type PaymentRequirements = { payTo: string; asset: string; network?: string; maxAmountRequired?: string }

/** The facilitator as the router uses it. */
export type PaymentClient = {
  verify(body: { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }): Promise<{ isValid: boolean; invalidReason?: string; payer: string | null }>
  settle(body: { paymentPayload: PaymentPayload; mode: "authorize" | "exact" }): Promise<unknown> | unknown
  capture(reqId: string, actual: bigint): Promise<unknown> | unknown
}

/** What a channel's payer signs on every request, so a channel id alone spends nothing. */
export function channelAuthMessage(input: { channelId: string; ts: number; nonce: string; bodyHash: string }) {
  return canonicalJson({ bodyHash: input.bodyHash, channelId: input.channelId.toLowerCase(), nonce: input.nonce, ts: input.ts })
}

/** The `X-Offpeak-Channel-Auth` header for one request body. */
export async function channelAuthHeader(signer: { signMessage: (args: { message: string }) => Promise<Hex> }, input: { channelId: string; ts: number; body: string }) {
  const nonce = crypto.randomUUID()
  const message = channelAuthMessage({ channelId: input.channelId, ts: input.ts, nonce, bodyHash: keccak256(toBytes(input.body)) })
  return Buffer.from(JSON.stringify({ ts: input.ts, nonce, sig: await signer.signMessage({ message }) })).toString("base64url")
}
