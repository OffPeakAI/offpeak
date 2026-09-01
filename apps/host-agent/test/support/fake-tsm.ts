import { createHmac } from "node:crypto"
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bytesToHex, hexToBytes, type Hex } from "viem"

/**
 * A stand-in for `/sys/kernel/config/tsm/report`, for machines with no TDX. It is a plain folder
 * holding what the kernel would show, and a child process plays the kernel. The quote has the real
 * v4 layout, but its "signature" is an HMAC under a key in this file: it proves nothing about any
 * hardware, and only the fake verifier in this repo's test support accepts it.
 */

const FAKE_SIGNING_KEY = "offpeak-fake-tdx-signing-key"
const HEADER_BYTES = 48
const BODY_BYTES = 584
const SIGNATURE_BYTES = 32

export type FakeTd = { mrtd: Hex; rtmrs: [Hex, Hex, Hex, Hex]; debug?: boolean }

export const fakeMeasurement = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(48)}` as Hex

export const FAKE_TD: FakeTd = { mrtd: fakeMeasurement(0xa1), rtmrs: [fakeMeasurement(0xb1), fakeMeasurement(0xb2), fakeMeasurement(0xb3), fakeMeasurement(0xb4)] }

const sign = (signed: Uint8Array) => new Uint8Array(createHmac("sha256", FAKE_SIGNING_KEY).update(signed).digest())

export function fakeQuote(td: FakeTd, reportData: Uint8Array): Uint8Array {
  const quote = new Uint8Array(HEADER_BYTES + BODY_BYTES + SIGNATURE_BYTES)
  const view = new DataView(quote.buffer)
  view.setUint16(0, 4, true)
  view.setUint16(2, 2, true)
  view.setUint32(4, 0x81, true)
  quote[HEADER_BYTES + 120] = td.debug ? 0x01 : 0x00
  quote.set(hexToBytes(td.mrtd), HEADER_BYTES + 136)
  td.rtmrs.forEach((rtmr, index) => quote.set(hexToBytes(rtmr), HEADER_BYTES + 328 + index * 48))
  quote.set(reportData, HEADER_BYTES + 520)
  quote.set(sign(quote.subarray(0, HEADER_BYTES + BODY_BYTES)), HEADER_BYTES + BODY_BYTES)
  return quote
}

/** True only for a quote `fakeQuote` made, unchanged since. */
export function fakeQuoteValid(quote: Hex) {
  const bytes = hexToBytes(quote)
  if (bytes.length !== HEADER_BYTES + BODY_BYTES + SIGNATURE_BYTES) return false
  return bytesToHex(sign(bytes.subarray(0, HEADER_BYTES + BODY_BYTES))) === bytesToHex(bytes.subarray(HEADER_BYTES + BODY_BYTES))
}

export type FakeTsmOptions = { td?: FakeTd; provider?: string; racing?: boolean }

export function sealedTempDir(prefix: string) {
  const parent = join(tmpdir(), "sealed")
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

const mkfifo = (path: string) => {
  if (Bun.spawnSync(["mkfifo", path]).exitCode !== 0) throw new Error("mkfifo failed")
}

export function startFakeTsm(opts: FakeTsmOptions = {}) {
  const root = sealedTempDir("tsm-")
  const entry = join(root, "offpeak")
  mkdirSync(entry)
  writeFileSync(join(entry, "provider"), `${opts.provider ?? "tdx_guest"}\n`)
  writeFileSync(join(entry, "generation"), "1\n")
  writeFileSync(join(entry, "inblob"), "")
  mkfifo(join(entry, "outblob"))
  const child = Bun.spawn([process.execPath, new URL(import.meta.url).pathname, entry, JSON.stringify(opts.td ?? FAKE_TD), opts.racing ? "racing" : "calm"], { stdout: "ignore", stderr: "ignore" })
  return {
    root,
    stop() {
      child.kill(9)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * Plays the kernel: blocks until a reader opens `outblob`, then answers for the current `inblob`.
 * Each answer leaves on its own FIFO, swapped out before closing, so a reader that has not seen
 * end of file yet can never pick up the next answer as well.
 */
function playKernel(entry: string, td: FakeTd, racing: boolean) {
  const outblob = join(entry, "outblob")
  const spare = join(entry, ".outblob")
  let generation = 1
  for (;;) {
    const fd = openSync(outblob, "w")
    const inblob = readFileSync(join(entry, "inblob"))
    if (statSync(join(entry, "inblob")).size === 64) writeSync(fd, fakeQuote(td, new Uint8Array(inblob)))
    if (racing) writeFileSync(join(entry, "generation"), `${(generation += 1)}\n`)
    mkfifo(spare)
    renameSync(spare, outblob)
    closeSync(fd)
  }
}

if (import.meta.main) playKernel(process.argv[2]!, JSON.parse(process.argv[3]!) as FakeTd, process.argv[4] === "racing")
