import { FEE_BPS_AUDIT_OPT_IN, FEE_BPS_DEFAULT, FEE_BPS_MIN, TOKENS_PER_MILLION, WINDOW_RESALE_MARKUP_BPS, WINDOW_RESALE_SALE_BPS } from "./constants.ts"

/** µUSDG. Always an integer. */
export type Micro = bigint

/** µUSDG per 1,000,000 tokens. */
export type PricePerM = bigint

export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("ceilDiv requires a positive divisor")
  if (n <= 0n) return 0n
  return (n + d - 1n) / d
}

export function feeBpsFor(opts: { auditOptIn?: boolean; ofpkDiscountBps?: number }): number {
  const base = opts.auditOptIn ? FEE_BPS_AUDIT_OPT_IN : FEE_BPS_DEFAULT
  const discount = opts.ofpkDiscountBps ?? 0
  const raw = base - discount
  return raw < FEE_BPS_MIN ? FEE_BPS_MIN : raw
}

/**
 * Host cost in µUSDG. Minimum 1 when any token was served.
 * hostCost = ceil((tokensIn * priceIn + tokensOut * priceOut) / 1_000_000)
 */
export function hostCostMicro(
  tokensIn: number | bigint,
  tokensOut: number | bigint,
  priceIn: PricePerM,
  priceOut: PricePerM,
): Micro {
  const tin = BigInt(tokensIn)
  const tout = BigInt(tokensOut)
  if (tin < 0n || tout < 0n) throw new Error("token counts must be non-negative")
  if (tin === 0n && tout === 0n) return 0n
  const raw = ceilDiv(tin * priceIn + tout * priceOut, TOKENS_PER_MILLION)
  return raw < 1n ? 1n : raw
}

export function feeMicro(hostCost: Micro, feeBps: number | bigint): Micro {
  if (hostCost <= 0n) return 0n
  return ceilDiv(hostCost * BigInt(feeBps), 10_000n)
}

export function buyerPays(hostCost: Micro, fee: Micro): Micro {
  return hostCost + fee
}

/** Buyer unit price (µUSDG per 1M tokens), fee included, rounded up. */
export function buyerUnitPrice(hostPrice: PricePerM, feeBps: number | bigint): PricePerM {
  return ceilDiv(hostPrice * (10_000n + BigInt(feeBps)), 10_000n)
}

export function quoteCost(input: {
  tokensIn: number
  tokensOut: number
  priceIn: PricePerM
  priceOut: PricePerM
  feeBps: number
}): { hostCostMicro: Micro; feeMicro: Micro; totalMicro: Micro } {
  const host = hostCostMicro(input.tokensIn, input.tokensOut, input.priceIn, input.priceOut)
  const fee = feeMicro(host, input.feeBps)
  return { hostCostMicro: host, feeMicro: fee, totalMicro: host + fee }
}

/** 1% of the sale price + 10% of the markup over cost basis. Integer division. */
export function windowResaleFeeMicro(salePrice: Micro, costBasis: Micro): Micro {
  const salePart = (salePrice * BigInt(WINDOW_RESALE_SALE_BPS)) / 10_000n
  const markup = salePrice > costBasis ? salePrice - costBasis : 0n
  const markupPart = (markup * BigInt(WINDOW_RESALE_MARKUP_BPS)) / 10_000n
  return salePart + markupPart
}

export function formatResaleFee(salePrice: Micro, costBasis: Micro): string {
  const fee = windowResaleFeeMicro(salePrice, costBasis)
  return `1% of the sale price + 10% of your markup = ${fee.toString()} µUSDG`
}
