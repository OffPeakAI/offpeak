import type { Stack } from "../context.ts"
import type { HostCandidate } from "./select.ts"

export type HostEvent = { choices?: { delta?: { content?: string | null; tool_calls?: ToolDelta[] }; finish_reason?: string | null }[] }
type ToolDelta = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }

export type Assembled = { text: string; toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[]; finish: string | null }

/** Well past the longest reply `MAX_OUTPUT_TOKENS` allows, framing included. */
const MAX_HOST_REPLY_BYTES = 8 * 1024 * 1024
/** OpenAI takes at most 128 tools. */
const MAX_TOOL_CALLS = 128

/** A host's whole reply as text. A reply past `limit` throws, with only that much read. */
export async function boundedText(res: Response, limit: number) {
  if (!res.body) return ""
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let text = ""
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      received += value.byteLength
      if (received > limit) throw new Error("host reply is too large")
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Host chunks as they arrive. Comment lines and `[DONE]` are not events. */
export async function* hostEvents(res: Response): AsyncGenerator<HostEvent> {
  if (!res.body) return
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ""
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      received += value.byteLength
      if (received > MAX_HOST_REPLY_BYTES) throw new Error("host reply is too large")
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (data === "[DONE]") return
          yield JSON.parse(data) as HostEvent
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function emptyAssembly(): Assembled {
  return { text: "", toolCalls: [], finish: null }
}

/** Calls arrive in order. The index comes from the host and indexes an array, so anything else is refused. */
function toolIndex(state: Assembled, delta: ToolDelta) {
  const index = delta.index ?? state.toolCalls.length
  if (!Number.isInteger(index) || index < 0 || index > state.toolCalls.length || index >= MAX_TOOL_CALLS) throw new Error("host sent a bad tool call index")
  return index
}

/** Folds one chunk in and yields back the text it added. Throws on a tool call that cannot be real. */
export function absorb(state: Assembled, event: HostEvent): string {
  const choice = event.choices?.[0]
  if (!choice) return ""
  if (choice.finish_reason) state.finish = choice.finish_reason
  for (const delta of choice.delta?.tool_calls ?? []) {
    const index = toolIndex(state, delta)
    const call = (state.toolCalls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
    if (delta.id) call.id = delta.id
    if (delta.type) call.type = delta.type
    if (delta.function?.name) call.function.name += delta.function.name
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments
  }
  const piece = choice.delta?.content ?? ""
  state.text += piece
  return piece
}

export type Opened = {
  ok: true
  host: string
  endpoint: string
  ttftMs: number
  first: HostEvent
  events: AsyncGenerator<HostEvent>
  abort: () => void
}

/**
 * Opens a stream on the best host, failing over once before any token has reached the client. Only a 5xx, a
 * timeout or a broken stream counts against a host: a 4xx answers this request, and a buyer can ask for those.
 */
export async function openHost(stack: Stack, ranked: HostCandidate[], payload: string, signedHeader: string): Promise<Opened | { ok: false; error: string }> {
  let last = "down"
  for (const host of ranked.slice(0, 2)) {
    const control = new AbortController()
    const started = performance.now()
    const timer = setTimeout(() => control.abort(), stack.ttftFailoverMs)
    try {
      const res = await stack.hosts.request(host.host, host.endpoint, "/offpeak/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-offpeak-req": signedHeader },
        body: payload,
        signal: control.signal,
      })
      if (res.status >= 400 && res.status < 500) {
        clearTimeout(timer)
        control.abort()
        last = "refused"
        continue
      }
      if (!res.ok) throw new Error(`host status ${res.status}`)
      const events = hostEvents(res)
      const first = await events.next()
      clearTimeout(timer)
      if (first.done) throw new Error("host sent an empty stream")
      const ttftMs = Math.round(performance.now() - started)
      stack.load.noteTtft(host.host, ttftMs)
      stack.load.noteResult(host.host, true)
      return { ok: true, host: host.host, endpoint: host.endpoint, ttftMs, first: first.value, events, abort: () => control.abort() }
    } catch (err) {
      clearTimeout(timer)
      control.abort()
      stack.load.noteResult(host.host, false)
      last = control.signal.aborted && String(err).includes("abort") ? "slow" : "error"
    }
  }
  return { ok: false, error: last }
}
