import { keccak256, type Hex } from "viem"
import { z } from "zod"
import { OffpeakError } from "../core.ts"
import { FLAG_DATA, FLAG_LAST, FRAME_HEADER_BYTES, FRAME_MAX_BYTES, RESPONSE_SALT_BYTES, concatBytes, openFrame, responseKey, type ResponseKey } from "./hpke.ts"

/**
 * The router's own frame after the host's last one: `flag ‖ len ‖ JSON`, in the clear. It carries what
 * a stream's final SSE event carries for an open request, because the router cannot write into the
 * ciphertext. Nothing in it is secret, and the envelope inside is signed.
 */
export const FLAG_TRAILER = 0x02

export type Frame = { flag: number; body: Uint8Array; raw: Uint8Array }

export const trailerSchema = z.looseObject({
  usage: z.unknown().optional(),
  /** The VM's own signed counts, which the envelope's operator signature cannot stand in for. */
  counts: z.unknown().optional(),
  channelOwed: z.string().regex(/^\d+$/).optional(),
  error: z.looseObject({ message: z.string().optional(), code: z.string().optional() }).optional(),
})

export type Trailer = z.infer<typeof trailerSchema>

export function encodeTrailer(trailer: Trailer) {
  const body = new TextEncoder().encode(JSON.stringify(trailer))
  const header = new Uint8Array(FRAME_HEADER_BYTES)
  header[0] = FLAG_TRAILER
  new DataView(header.buffer).setUint32(1, body.length)
  return concatBytes(header, body)
}

export function decodeTrailer(body: Uint8Array): Trailer {
  try {
    return trailerSchema.parse(JSON.parse(new TextDecoder().decode(body)))
  } catch {
    throw new OffpeakError("sealed_bad_frame", "The closing frame cannot be read")
  }
}

/** Cuts response bytes into frames. It needs no key, so the router and the client share it. */
export class FrameSplitter {
  responseSalt: Uint8Array | null = null
  lastSeen = false
  private trailerSeen = false
  private buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): Frame[] {
    this.buffer = concatBytes(this.buffer, chunk)
    if (!this.responseSalt) {
      if (this.buffer.length < RESPONSE_SALT_BYTES) return []
      this.responseSalt = this.buffer.slice(0, RESPONSE_SALT_BYTES)
      this.buffer = this.buffer.slice(RESPONSE_SALT_BYTES)
    }
    const frames: Frame[] = []
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const flag = this.buffer[0]!
      const size = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(1)
      if (size > FRAME_MAX_BYTES) throw new OffpeakError("sealed_bad_frame", "A frame is too long")
      if (this.trailerSeen || (flag !== FLAG_TRAILER && this.lastSeen)) throw new OffpeakError("sealed_bad_frame", "Bytes followed the end of the stream")
      if (flag !== FLAG_DATA && flag !== FLAG_LAST && flag !== FLAG_TRAILER) throw new OffpeakError("sealed_bad_frame", "Unknown frame flag")
      const end = FRAME_HEADER_BYTES + size
      if (this.buffer.length < end) break
      frames.push({ flag, body: this.buffer.slice(FRAME_HEADER_BYTES, end), raw: this.buffer.slice(0, end) })
      this.buffer = this.buffer.slice(end)
      if (flag === FLAG_LAST) this.lastSeen = true
      if (flag === FLAG_TRAILER) this.trailerSeen = true
    }
    return frames
  }

  /** True when bytes of an unfinished frame or header are still waiting. */
  get incomplete() {
    return this.buffer.length > 0 || !this.responseSalt
  }
}

export type OpenedResponse = { outputHash: Hex; trailer: Trailer | null }

/** Decrypts a response as it arrives. A stream that ends without the host's last frame throws. */
export async function* openResponse(body: ReadableStream<Uint8Array>, secret: Uint8Array, enc: Uint8Array, done: (result: OpenedResponse) => void): AsyncGenerator<Uint8Array> {
  const splitter = new FrameSplitter()
  const cipher: Uint8Array[] = []
  const reader = body.getReader()
  let keys: ResponseKey | null = null
  let index = 0
  let trailer: Trailer | null = null
  try {
    while (true) {
      const { done: ended, value } = await reader.read()
      if (ended) break
      for (const frame of splitter.push(value)) {
        if (!keys) {
          cipher.push(splitter.responseSalt!)
          keys = await responseKey(secret, enc, splitter.responseSalt!)
        }
        if (frame.flag === FLAG_TRAILER) {
          trailer = decodeTrailer(frame.body)
          continue
        }
        cipher.push(frame.raw)
        const plaintext = await openFrame(keys, index, frame.flag, frame.body)
        index += 1
        if (plaintext.length > 0) yield plaintext
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (trailer?.error) throw new OffpeakError(trailer.error.code ?? "stream_error", trailer.error.message ?? "Stream failed")
  if (!splitter.lastSeen || splitter.incomplete) throw new OffpeakError("sealed_truncated", "The stream ended before the host's last frame")
  done({ outputHash: keccak256(concatBytes(...cipher)), trailer })
}

/** Passes a sealed stream through and reports the router's closing frame, leaving decryption to the reader. */
export function tapSealed(body: ReadableStream<Uint8Array>, onEnd: (trailer: Trailer | null) => Promise<void>) {
  const reader = body.getReader()
  const splitter = new FrameSplitter()
  let trailer: Trailer | null = null
  let ended = false
  const end = async () => {
    if (ended) return
    ended = true
    await onEnd(trailer)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          await end()
          controller.close()
          return
        }
        for (const frame of splitter.push(value)) if (frame.flag === FLAG_TRAILER) trailer = decodeTrailer(frame.body)
        controller.enqueue(value)
      } catch (err) {
        await end()
        controller.error(err)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await end()
    },
  })
}
