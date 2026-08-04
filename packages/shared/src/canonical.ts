/**
 * Canonical JSON: RFC 8785 subset. Object keys sorted, no whitespace, UTF-8.
 * Numbers must be finite. bigint is rejected (money is never canonicalized as JSON numbers).
 */
export function canonicalJson(value: unknown): string {
  return encode(value)
}

function encode(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON")
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "bigint") throw new Error("bigint is not canonical JSON; use a decimal string")
  if (Array.isArray(value)) return `[${value.map((v) => encode(v)).join(",")}]`
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const key of keys) {
      const v = obj[key]
      if (v === undefined) continue
      parts.push(`${JSON.stringify(key)}:${encode(v)}`)
    }
    return `{${parts.join(",")}}`
  }
  throw new Error(`cannot canonicalize ${typeof value}`)
}
