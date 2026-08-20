import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FLOOR_MAX_RATIO_BPS, LOAD_FACTOR_MAX_BPS, LOAD_FACTOR_MIN_BPS, SHEET_MIN_LEAD_S, ceilDiv, domain, hourOfWeek, priceSheetTypes, recoverTyped } from "@offpeak/shared"
import { hashTypedData, type Hex } from "viem"
import { z } from "zod"

const REFRESH_MS = 60_000

const units = z.string().regex(/^\d+$/).refine((value) => BigInt(value) < 2n ** 64n, "must fit uint64")
const week = z.array(units).length(168)

export const sheetJsonSchema = z.strictObject({
  host: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  modelDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  baseIn: week,
  baseOut: week,
  floorIn: units,
  floorOut: units,
  validFrom: z.int().nonnegative(),
  nonce: units,
})

const storedSheetSchema = z.strictObject({
  sheet: sheetJsonSchema,
  sig: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  sheetHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

export type SheetJson = z.infer<typeof sheetJsonSchema>

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

export function sheetFromJson(json: SheetJson): PriceSheet {
  return {
    host: json.host.toLowerCase() as Hex,
    modelDigest: json.modelDigest.toLowerCase() as Hex,
    baseIn: json.baseIn.map(BigInt),
    baseOut: json.baseOut.map(BigInt),
    floorIn: BigInt(json.floorIn),
    floorOut: BigInt(json.floorOut),
    validFrom: json.validFrom,
    nonce: BigInt(json.nonce),
  }
}

export function sheetToJson(sheet: PriceSheet): SheetJson {
  const text = (value: bigint) => value.toString()
  return { host: sheet.host, modelDigest: sheet.modelDigest, baseIn: sheet.baseIn.map(text), baseOut: sheet.baseOut.map(text), floorIn: text(sheet.floorIn), floorOut: text(sheet.floorOut), validFrom: sheet.validFrom, nonce: text(sheet.nonce) }
}

export function sheetTypedData(sheet: PriceSheet, registry: string) {
  return {
    domain: domain("OffpeakPriceSheet", registry),
    types: priceSheetTypes,
    primaryType: "PriceSheet" as const,
    message: { ...sheet, validFrom: BigInt(sheet.validFrom) },
  }
}

export function sheetHashOf(sheet: PriceSheet, registry: string): Hex {
  return hashTypedData(sheetTypedData(sheet, registry))
}

const smallest = (values: bigint[]) => values.reduce((low, value) => (value < low ? value : low))

const largest = (values: bigint[]) => values.reduce((high, value) => (value > high ? value : high))

const floorHolds = (floor: bigint, bases: bigint[]) => floor * 10_000n <= BigInt(FLOOR_MAX_RATIO_BPS) * smallest(bases)

/** The router's rules, so a sheet it would reject never leaves this machine. */
export function sheetProblem(sheet: PriceSheet, now: number): string | null {
  if (sheet.baseIn.some((value) => value <= 0n) || sheet.baseOut.some((value) => value <= 0n)) return "base_not_positive"
  if (!floorHolds(sheet.floorIn, sheet.baseIn) || !floorHolds(sheet.floorOut, sheet.baseOut)) return "floor_above_0_6_min_base"
  if (sheet.validFrom < now + SHEET_MIN_LEAD_S) return "valid_from_too_soon"
  return null
}
