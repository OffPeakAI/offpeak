import { buyerUnitPrice, quoteCost, type Micro, type PricePerM } from "@offpeak/shared"

export function parseUsdMicro(raw: string): Micro {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("bad price")
  const [whole, frac = ""] = trimmed.split(".")
  const micros = (frac + "000000").slice(0, 6)
  return BigInt(whole!) * 1_000_000n + BigInt(micros)
}

export function parseMaxPrice(header: string | undefined): { inPerM: PricePerM; outPerM: PricePerM } | undefined {
  if (!header) return undefined
  const parts = Object.fromEntries(
    header.split(",").map((piece) => {
      const [k, v] = piece.split("=")
      return [k?.trim(), v?.trim()]
    }),
  )
  if (!parts.in || !parts.out) throw new Error("bad max price")
  return { inPerM: parseUsdMicro(parts.in), outPerM: parseUsdMicro(parts.out) }
}

export function maxCost(input: {
  tokensIn: number
  maxTokensOut: number
  priceIn: PricePerM
  priceOut: PricePerM
  feeBps: number
}) {
  return quoteCost({
    tokensIn: input.tokensIn,
    tokensOut: input.maxTokensOut,
    priceIn: input.priceIn,
    priceOut: input.priceOut,
    feeBps: input.feeBps,
  })
}

export function priceAboveCap(
  priceIn: PricePerM,
  priceOut: PricePerM,
  feeBps: number,
  cap?: { inPerM: PricePerM; outPerM: PricePerM },
): boolean {
  if (!cap) return false
  return buyerUnitPrice(priceIn, feeBps) > cap.inPerM || buyerUnitPrice(priceOut, feeBps) > cap.outPerM
}
