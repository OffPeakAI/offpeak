import { mkdir, open, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Hex } from "viem"
import type { UsageRecordJson } from "@offpeak/shared"

const RETENTION_DAYS = 30
const DAY_S = 86_400
const FILE = /^signed-(\d{4}-\d{2}-\d{2})\.jsonl$/
const NEWLINE = 0x0a

export type SignedEntry = {
  at: number
  record: UsageRecordJson
  routerSig: Hex
  hostSig: Hex
  leaf: Hex
  partial: boolean
  hostCounts: { tokensIn: number; tokensOut: number }
  engineUsage: { prompt_tokens?: number; completion_tokens?: number } | null
  /** The hash of what the host itself sent back. Prompts and outputs are never written here. */
  hostOutputHash: Hex | null
}

const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)

/** How a day's file is opened. A test passes its own to watch the order of writes and syncs. */
export type Opener = typeof open

/**
 * One file per UTC day, only ever appended to: the host's own evidence in a dispute. An entry is on
 * disk before `append` returns, because the signature it holds leaves the machine straight after.
 */
export class SignedLog {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly opener: Opener = open,
  ) {}

  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.dir)) if (FILE.test(name)) await this.endLine(join(this.dir, name))
  }

  /** A crash can leave half a line. It stays, as evidence of nothing, but on its own so the next entry reads whole. */
  private async endLine(path: string) {
    const { size } = await stat(path)
    if (size === 0) return
    const file = await this.opener(path, "r+")
    try {
      const last = Buffer.alloc(1)
      await file.read(last, 0, 1, size - 1)
      if (last[0] === NEWLINE) return
      await file.write("\n", size)
      await file.sync()
    } finally {
      await file.close()
    }
  }

  private async write(path: string, line: string) {
    const created = !(await stat(path).then(() => true, () => false))
    const file = await this.opener(path, "a", 0o600)
    try {
      await file.appendFile(line)
      await file.sync()
    } finally {
      await file.close()
    }
    if (!created) return
    // A new file is only as durable as the folder entry that names it.
    const folder = await this.opener(this.dir, "r")
    await folder.sync().finally(() => folder.close())
  }

  /** One at a time, so two signatures cannot interleave a torn write. */
  append(entry: SignedEntry) {
    const written = this.tail.then(() => this.write(join(this.dir, `signed-${dayOf(entry.at)}.jsonl`), `${JSON.stringify(entry)}\n`))
    this.tail = written.catch(() => undefined)
    return written
  }

  /** Removes whole days past the retention period, and nothing else in the folder. */
  async prune(now: number) {
    const oldest = dayOf(now - RETENTION_DAYS * DAY_S)
    for (const name of await readdir(this.dir)) {
      const day = FILE.exec(name)?.[1]
      if (day && day < oldest) await rm(join(this.dir, name))
    }
  }
}
