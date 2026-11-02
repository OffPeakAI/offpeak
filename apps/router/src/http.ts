import { createHash, timingSafeEqual } from "node:crypto"

export function oai(status: number, message: string, type: string, code: string, extra?: Record<string, unknown>) {
  return Response.json({ error: { message, type, code, ...extra } }, { status })
}

export function featureOff(name: string) {
  return oai(403, `${name} not switched on yet`, "invalid_request", "feature_off")
}

/** The caller's address. Only the entries a trusted proxy appended mean anything, which are the rightmost `hops`. */
export function clientIp(req: Request, server: unknown, hops: number) {
  const forwarded = (req.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim())
  const entry = hops > 0 ? forwarded[forwarded.length - hops] : undefined
  if (entry) return entry.slice(0, 64)
  return (server as { requestIP?: (r: Request) => { address: string } | null } | undefined)?.requestIP?.(req)?.address ?? "unknown"
}

/** Compares a presented token with a secret in constant time. Hashing first keeps the secret's length out of it too. */
export function sameSecret(presented: string | undefined, secret: string) {
  if (presented === undefined) return false
  const digest = (text: string) => createHash("sha256").update(text).digest()
  return timingSafeEqual(digest(presented), digest(secret))
}
