/** SSE framing for OpenAI chunks and the final offpeak.usage event. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

export function sseDone(): string {
  return "data: [DONE]\n\n"
}
