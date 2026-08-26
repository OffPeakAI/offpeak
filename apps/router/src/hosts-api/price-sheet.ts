import { HOST_STATUS } from "@offpeak/shared"
import { z } from "zod"
import type { Hex } from "viem"
import { sheetFromJson, sheetJsonSchema } from "../../../host-agent/src/sheets.ts"
import { validateSheet } from "../pricing/pricebook.ts"
import { saveSheet } from "../pricing/sheets.ts"
import type { Stack } from "../pipeline.ts"

const WEEK_S = 604_800

/** Amounts arrive as decimal strings, so they become bigints here, before any rule looks at them. */
const sheetBody = z.object({ sheet: sheetJsonSchema, sig: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((value) => value as Hex) })

/** The nonce and the weekly limit are per host, so one host's posts take turns. */
export async function acceptPriceSheet(stack: Stack, raw: unknown) {
  const body = sheetBody.safeParse(raw)
  if (!body.success) return { ok: false as const, error: "bad_sheet" as const }
  const sheet = sheetFromJson(body.data.sheet)
  const { sig } = body.data
  // Any key can sign a sheet for its own address, and every router reloads every sheet, so only hosts in the registry may add one.
  const host = await stack.indexer.host(sheet.host.toLowerCase())
  if (!host || host.status === HOST_STATUS.None || host.status === HOST_STATUS.Delisted) return { ok: false as const, error: "host_not_registered" as const }
  const now = stack.clock()
  const week = Math.floor(now / WEEK_S)
  const result = await stack.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sheet.host])
    const latest = await tx.query<{ nonce: string | null }>("SELECT max(nonce) AS nonce FROM serving.price_sheets WHERE host = $1 AND model_digest = $2", [sheet.host, sheet.modelDigest])
    const count = await tx.query<{ n: number }>("SELECT n FROM serving.sheet_counts WHERE host = $1 AND week = $2", [sheet.host, week])
    const previous = { nonce: BigInt(latest.rows[0]?.nonce ?? -1), sheetsThisWeek: count.rows[0]?.n ?? 0 }
    const checked = await validateSheet(sheet, sig, stack.registry as Hex, now, previous)
    if (!checked.ok) return checked
    await saveSheet(tx, { ...sheet, sig, sheetHash: checked.sheetHash })
    await tx.query("INSERT INTO serving.sheet_counts (host, week, n) VALUES ($1,$2,1) ON CONFLICT (host, week) DO UPDATE SET n = serving.sheet_counts.n + 1", [sheet.host, week])
    return checked
  })
  if (result.ok) stack.sheets.push({ ...sheet, sig, sheetHash: result.sheetHash })
  return result
}
