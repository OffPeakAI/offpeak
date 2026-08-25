import { UPTO_MIN_MAX_MICRO, UPTO_PRECONFIRM_BUDGET_MICRO, UPTO_PRECONFIRM_TOKENS } from "@offpeak/shared"
import type { Hex } from "viem"

export type Accept = {
  scheme: "channel" | "upto" | "exact"
  network: "eip155:4663"
  asset: Hex
  maxAmountRequired?: string
  payTo?: Hex
  extra: Record<string, unknown>
}

export function paymentRequired(input: {
  asset: Hex
  channelManager: Hex
  payee: Hex
  vault: Hex
  permit2: Hex
  escrow: Hex
  maxAmount: bigint
  reqId: Hex
  validBefore: number
  resourceHash: Hex
  exact: boolean
  creditLimit: string
  channels?: boolean
  x402?: boolean
}): { accepts: Accept[]; offersUpto: boolean } {
  const { channels = true, x402 = true } = input
  const accepts: Accept[] = []
  if (channels) {
    accepts.push({
      scheme: "channel",
      network: "eip155:4663",
      asset: input.asset,
      extra: {
        channelManager: input.channelManager,
        payee: input.payee,
        minDeposit: "1000000",
        minExpirySeconds: 21600,
        creditLimit: input.creditLimit,
      },
    })
  }
  const offersUpto = x402 && input.maxAmount >= UPTO_MIN_MAX_MICRO
  if (offersUpto) {
    accepts.push({
      scheme: "upto",
      network: "eip155:4663",
      asset: input.asset,
      maxAmountRequired: input.maxAmount.toString(),
      payTo: input.vault,
      extra: {
        permit2: input.permit2,
        spender: input.escrow,
        reqId: input.reqId,
        validBefore: input.validBefore,
        witness: "UptoWitness",
      },
    })
  }
  if (x402 && input.exact) {
    accepts.push({
      scheme: "exact",
      network: "eip155:4663",
      asset: input.asset,
      maxAmountRequired: input.maxAmount.toString(),
      payTo: input.vault,
      extra: {
        permit2: input.permit2,
        spender: input.escrow,
        reqId: input.reqId,
        validBefore: input.validBefore,
        witness: "ExactWitness",
      },
    })
  }
  return { accepts, offersUpto }
}

export function preconfirmReached(tokensOut: number, costMicro: bigint): boolean {
  return tokensOut >= UPTO_PRECONFIRM_TOKENS || costMicro >= UPTO_PRECONFIRM_BUDGET_MICRO
}
