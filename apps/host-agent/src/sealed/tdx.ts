import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const TSM_REPORT_ROOT = "/sys/kernel/config/tsm/report"

const ENTRY = "offpeak"
const PROVIDER = "tdx_guest"
const REPORT_DATA_BYTES = 64

const alreadyThere = (err: unknown) => (err as { code?: string }).code === "EEXIST"

/**
 * One TDX quote through configfs-tsm. The kernel asks the TDX module when `outblob` is read, and
 * `generation` moves if anything wrote `inblob` in between, so a quote that raced is thrown away.
 * Callers run one at a time, because the entry is shared.
 */
export async function readTdxQuote(root: string, reportData: Uint8Array): Promise<Uint8Array> {
  if (reportData.length !== REPORT_DATA_BYTES) throw new Error("report_data must be 64 bytes")
  const entry = join(root, ENTRY)
  await mkdir(entry).catch((err) => {
    if (!alreadyThere(err)) throw err
  })
  const provider = (await readFile(join(entry, "provider"), "utf8")).trim()
  if (provider !== PROVIDER) throw new Error(`quote provider is ${provider}, not ${PROVIDER}`)
  await writeFile(join(entry, "inblob"), reportData)
  const before = await readFile(join(entry, "generation"), "utf8")
  const quote = new Uint8Array(await readFile(join(entry, "outblob")))
  const after = await readFile(join(entry, "generation"), "utf8")
  if (before !== after) throw new Error("another writer raced this quote")
  if (quote.length === 0) throw new Error("the kernel returned an empty quote")
  return quote
}
