import { formatUsdg } from "./format.ts"
import { windowResaleFeeMicro } from "./shared.ts"

export const RESALE_RULE = "1% of the sale price + 10% of your markup"
export const CANCEL_RULE = "95% of the host price + the full fee"

export type ResaleInput = { units: bigint; pricePerUnit: bigint; costBasisPerUnit: bigint }

/** The same arithmetic as `WindowMarket.buyListing`: each part floors on its own. */
export function resalePreview({ units, pricePerUnit, costBasisPerUnit }: ResaleInput) {
  const sale = units * pricePerUnit
  const basis = units * costBasisPerUnit
  const fee = windowResaleFeeMicro(sale, basis)
  return { sale, markup: sale > basis ? sale - basis : 0n, fee, proceeds: sale - fee }
}

export function resaleFeeLine(input: ResaleInput) {
  return `1% of sale price + 10% of markup = ${formatUsdg(resalePreview(input).fee)} USDG`
}

/** What a holder spends. The contract charges at most this, since a Dutch price only falls. */
export function buyTotal(units: bigint, pricePerUnit: bigint) {
  return units * pricePerUnit
}

/** Room left under the beta cap. Null when no cap applies. */
export function depositRoom(balance: bigint, cap: bigint | null) {
  if (cap === null) return null
  return balance >= cap ? 0n : cap - balance
}
