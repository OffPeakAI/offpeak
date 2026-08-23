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

const atFactor = (base: bigint, factorBps: number, floor: bigint) => {
  const scaled = ceilDiv(base * BigInt(factorBps), 10_000n)
  return scaled > floor ? scaled : floor
}

type Band = { low: bigint; high: bigint }

/** The prices the live formula can reach at this hour of the week, whatever load the router measured. */
export function liveBand(sheet: PriceSheet, ts: number): { in: Band; out: Band } {
  const how = hourOfWeek(ts)
  const band = (base: bigint, floor: bigint) => ({ low: atFactor(base, LOAD_FACTOR_MIN_BPS, floor), high: atFactor(base, LOAD_FACTOR_MAX_BPS, floor) })
  return { in: band(sheet.baseIn[how]!, sheet.floorIn), out: band(sheet.baseOut[how]!, sheet.floorOut) }
}

/** A night job's locked price averages forecast live prices over other hours, so only the week's limits apply. */
export function nightBand(sheet: PriceSheet): { in: Band; out: Band } {
  const band = (bases: bigint[], floor: bigint) => ({ low: floor, high: atFactor(largest(bases), LOAD_FACTOR_MAX_BPS, floor) })
  return { in: band(sheet.baseIn, sheet.floorIn), out: band(sheet.baseOut, sheet.floorOut) }
}

type Stored = { sheet: PriceSheet; sig: Hex; sheetHash: Hex }

/** The sheets this host signed. The agent prices records against these, never against what the router says. */
export class SheetBook {
  private byHash = new Map<string, Stored>()
  private loadedAt = 0

  constructor(
    private readonly dir: string,
    private readonly operator: string,
    private readonly registry: string,
  ) {}

  /** A file that fails its signature stops the load. Nothing else can have written to this folder honestly. */
  async load() {
    await mkdir(this.dir, { recursive: true })
    const next = new Map<string, Stored>()
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue
      const raw = storedSheetSchema.parse(JSON.parse(await readFile(join(this.dir, name), "utf8")))
      const sheet = sheetFromJson(raw.sheet)
      const sheetHash = sheetHashOf(sheet, this.registry)
      const signer = await recoverTyped(sheetTypedData(sheet, this.registry) as never, raw.sig as Hex)
      if (sheet.host !== this.operator || signer.toLowerCase() !== this.operator || sheetHash !== raw.sheetHash) throw new Error(`price sheet ${name} is not this host's`)
      next.set(sheetHash, { sheet, sig: raw.sig as Hex, sheetHash })
    }
    this.byHash = next
    this.loadedAt = performance.now()
  }

  async save(sheet: PriceSheet, sig: Hex) {
    await mkdir(this.dir, { recursive: true })
    const sheetHash = sheetHashOf(sheet, this.registry)
    const path = join(this.dir, `${sheetHash}.json`)
    await writeFile(`${path}.tmp`, JSON.stringify({ sheet: sheetToJson(sheet), sig, sheetHash }), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    return sheetHash
  }

  /** The `price-sheet` command writes from another process, so the book rereads the folder now and then. */
  private async fresh() {
    if (performance.now() - this.loadedAt > REFRESH_MS) await this.load()
  }

  /** The sheet this hash names, if it is the one in force for `modelDigest` at `ts`. */
  async inForce(sheetHash: string, modelDigest: string, ts: number): Promise<PriceSheet | null> {
    await this.fresh()
    if (!this.byHash.has(sheetHash)) await this.load()
    const named = this.byHash.get(sheetHash)?.sheet
    if (!named || named.modelDigest !== modelDigest || named.validFrom > ts) return null
    for (const { sheet } of this.byHash.values()) {
      if (sheet.modelDigest === modelDigest && sheet.validFrom <= ts && sheet.validFrom > named.validFrom) return null
    }
    return named
  }
}
