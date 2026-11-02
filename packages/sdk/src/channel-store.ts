import { readFileSync, renameSync, writeFileSync } from "node:fs"
import type { Micro } from "@offpeak/shared"
import type { Hex } from "viem"
import { z } from "zod"
import { OffpeakError, bytes32Schema, digitsSchema } from "./core.ts"

/** What outlives the process: the channel, how far this wallet has signed on it, and the records already paid for. */
export type SavedChannel = { id: Hex; seq: bigint; cumulative: Micro; counted: string[] }

export type ChannelStore = {
  load(): SavedChannel | null | Promise<SavedChannel | null>
  save(saved: SavedChannel): void | Promise<void>
}

const savedSchema = z.object({ id: bytes32Schema, seq: digitsSchema, cumulative: digitsSchema, counted: z.array(bytes32Schema) })

/** A JSON file only this user can read. One that cannot be read throws, because a start must never fund a channel on a guess. */
export function fileChannelStore(path: string): ChannelStore {
  return {
    load() {
      let text: string
      try {
        text = readFileSync(path, "utf8")
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return null
        throw new OffpeakError("bad_channel_state", "The channel state file cannot be read")
      }
      try {
        const saved = savedSchema.parse(JSON.parse(text))
        return { id: saved.id, seq: BigInt(saved.seq), cumulative: BigInt(saved.cumulative), counted: saved.counted }
      } catch {
        throw new OffpeakError("bad_channel_state", "The channel state file cannot be read")
      }
    },
    save({ id, seq, cumulative, counted }) {
      writeFileSync(`${path}.tmp`, JSON.stringify({ id, seq: seq.toString(), cumulative: cumulative.toString(), counted }), { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
    },
  }
}
