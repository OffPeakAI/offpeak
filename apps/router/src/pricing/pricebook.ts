import { recoverTypedDataAddress, type Hex } from "viem"
import { FLOOR_MAX_RATIO_BPS, MAX_SHEETS_PER_HOST_PER_WEEK, SHEET_MIN_LEAD_S } from "@offpeak/shared"
import { domain, hashStruct, priceSheetTypes } from "@offpeak/shared"
import { domainSeparator, typedDataDigest } from "@offpeak/shared"
import type { Address } from "viem"

export type PriceSheet = {
  host: Hex
  modelDigest: Hex
  baseIn: bigint[]
  baseOut: bigint[]
  floorIn: bigint
  floorOut: bigint
  validFrom: number
  nonce: bigint
}

export type SheetError =
  | "bad_signature"
  | "base_not_positive"
  | "floor_above_0_6_min_base"
  | "valid_from_too_soon"
  | "nonce_not_increasing"
  | "weekly_sheet_limit"
  | "bad_length"

export function minBase(values: bigint[]): bigint {
  return values.reduce((m, v) => (v < m ? v : m))
}

export function floorWithinRule(floor: bigint, bases: bigint[]): boolean {
  return floor * 10_000n <= BigInt(FLOOR_MAX_RATIO_BPS) * minBase(bases)
}

export function sheetStructHash(sheet: PriceSheet): Hex {
  return hashStruct("PriceSheet", priceSheetTypes as never, {
    host: sheet.host,
    modelDigest: sheet.modelDigest,
    baseIn: sheet.baseIn,
    baseOut: sheet.baseOut,
    floorIn: sheet.floorIn,
    floorOut: sheet.floorOut,
    validFrom: BigInt(sheet.validFrom),
    nonce: sheet.nonce,
  })
}

export function sheetHashOf(sheet: PriceSheet, registry: Address): Hex {
  return typedDataDigest(sheetStructHash(sheet), domainSeparator("OffpeakPriceSheet", registry))
}

export async function validateSheet(
  sheet: PriceSheet,
  sig: Hex,
  registry: Address,
  now: number,
  previous?: { nonce: bigint; sheetsThisWeek: number },
): Promise<{ ok: true; sheetHash: Hex } | { ok: false; error: SheetError }> {
  if (sheet.baseIn.length !== 168 || sheet.baseOut.length !== 168) return { ok: false, error: "bad_length" }
  if (sheet.baseIn.some((v) => v <= 0n) || sheet.baseOut.some((v) => v <= 0n)) return { ok: false, error: "base_not_positive" }
  if (!floorWithinRule(sheet.floorIn, sheet.baseIn) || !floorWithinRule(sheet.floorOut, sheet.baseOut)) {
    return { ok: false, error: "floor_above_0_6_min_base" }
  }
  if (sheet.validFrom < now + SHEET_MIN_LEAD_S) return { ok: false, error: "valid_from_too_soon" }
  if (previous && sheet.nonce <= previous.nonce) return { ok: false, error: "nonce_not_increasing" }
  if (previous && previous.sheetsThisWeek >= MAX_SHEETS_PER_HOST_PER_WEEK) return { ok: false, error: "weekly_sheet_limit" }
  const hash = sheetHashOf(sheet, registry)
  try {
    const recovered = await recoverTypedDataAddress({
      domain: domain("OffpeakPriceSheet", registry),
      types: priceSheetTypes,
      primaryType: "PriceSheet",
      message: {
        host: sheet.host,
        modelDigest: sheet.modelDigest,
        baseIn: sheet.baseIn,
        baseOut: sheet.baseOut,
        floorIn: sheet.floorIn,
        floorOut: sheet.floorOut,
        validFrom: BigInt(sheet.validFrom),
        nonce: sheet.nonce,
      },
      signature: sig,
    })
    if (recovered.toLowerCase() !== sheet.host.toLowerCase()) return { ok: false, error: "bad_signature" }
  } catch {
    return { ok: false, error: "bad_signature" }
  }
  return { ok: true, sheetHash: hash }
}
