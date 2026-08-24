import type { Db } from "@offpeak/common"
import type { Hex } from "@offpeak/shared"
import type { StoredSheet } from "../context.ts"

export async function saveSheet(db: Db, sheet: StoredSheet) {
  await db.query(
    `INSERT INTO serving.price_sheets (sheet_hash, host, model_digest, valid_from, base_in, base_out, floor_in, floor_out, nonce, sig)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10) ON CONFLICT (sheet_hash) DO NOTHING`,
    [
      sheet.sheetHash,
      sheet.host.toLowerCase(),
      sheet.modelDigest,
      sheet.validFrom,
      JSON.stringify(sheet.baseIn.map(String)),
      JSON.stringify(sheet.baseOut.map(String)),
      sheet.floorIn.toString(),
      sheet.floorOut.toString(),
      sheet.nonce.toString(),
      sheet.sig,
    ],
  )
}

type SheetRow = {
  sheet_hash: Hex
  host: Hex
  model_digest: Hex
  valid_from: string
  base_in: string[]
  base_out: string[]
  floor_in: string
  floor_out: string
  nonce: string
  sig: Hex
}

export async function loadSheets(db: Db): Promise<StoredSheet[]> {
  const rows = await db.query<SheetRow>("SELECT * FROM serving.price_sheets")
  return rows.rows.map((row) => ({
    sheetHash: row.sheet_hash,
    host: row.host,
    modelDigest: row.model_digest,
    validFrom: Number(row.valid_from),
    baseIn: row.base_in.map(BigInt),
    baseOut: row.base_out.map(BigInt),
    floorIn: BigInt(row.floor_in),
    floorOut: BigInt(row.floor_out),
    nonce: BigInt(row.nonce),
    sig: row.sig,
  }))
}
