export type SseEvent = { event: string | null; data: string; raw: string }

const BLOCK_END = /\r?\n\r?\n/

function parseBlock(raw: string): SseEvent | null {
  let event: string | null = null
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  return data.length > 0 || event ? { event, data: data.join("\n"), raw } : null
}

export class SseParser {
  private decoder = new TextDecoder()
  private buffer = ""

  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const blocks = this.buffer.split(BLOCK_END)
    this.buffer = blocks.pop() ?? ""
    return blocks.map(parseBlock).filter((event) => event !== null)
  }
}

/**
 * Passes a stream through and reports its events. `hide` drops matching events from what the
 * reader sees. `onEnd` runs once, with `true` when the reader walked away before the end.
 */
export function tapStream(body: ReadableStream<Uint8Array>, tap: { onEvent: (event: SseEvent) => void; onEnd: (abandoned: boolean) => Promise<void>; hide?: (event: SseEvent) => boolean }) {
  const reader = body.getReader()
  const parser = new SseParser()
  const encoder = new TextEncoder()
  let ended = false
  const end = async (abandoned: boolean) => {
    if (ended) return
    ended = true
    await tap.onEnd(abandoned)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A pull that enqueues nothing is never called again, so it reads until it has something to hand over.
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            await end(false)
            controller.close()
            return
          }
          const events = parser.push(value)
          for (const event of events) tap.onEvent(event)
          if (!tap.hide) {
            controller.enqueue(value)
            return
          }
          const kept = events.filter((event) => !tap.hide!(event))
          for (const event of kept) controller.enqueue(encoder.encode(`${event.raw}\n\n`))
          if (kept.length > 0) return
        }
      } catch (err) {
        await end(true)
        controller.error(err)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await end(true)
    },
  })
}
