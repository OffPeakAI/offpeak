const REDACT = /(https?:\/\/[^\s"]*?)(\/[A-Za-z0-9_-]{16,}|[?&](?:key|dkey|apikey)=[^\s"&]+)/g

/** JSON lines. Callers never pass request bodies or keys, and RPC URLs lose their credentials here. */
export function log(service: string, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), service, event, ...fields }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  )
  console.log(line.replace(REDACT, "$1/[redacted]"))
}

/** Event args hold bigints, which JSON cannot carry. They travel as decimal strings. */
export function encodePush(msg: Record<string, unknown>) {
  return JSON.stringify(msg, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
}
