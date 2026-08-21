import { createHash, timingSafeEqual } from "node:crypto"

export function oai(status: number, message: string, type: string, code: string, extra?: Record<string, unknown>) {
  return Response.json({ error: { message, type, code, ...extra } }, { status })
}

export function featureOff(name: string) {
  return oai(403, `${name} not switched on yet`, "invalid_request", "feature_off")
}

/** Compares a presented token with a secret in constant time. Hashing first keeps the secret's length out of it too. */
export function sameSecret(presented: string | undefined, secret: string) {
  if (presented === undefined) return false
  const digest = (text: string) => createHash("sha256").update(text).digest()
  return timingSafeEqual(digest(presented), digest(secret))
}
