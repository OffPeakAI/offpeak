import { createHash, timingSafeEqual } from "node:crypto"

const digest = (value: string) => createHash("sha256").update(value).digest()

/** Hashing first gives both sides one length, so the compare takes the same time for any header. */
export function bearerMatches(header: string | undefined, token: string) {
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`))
}
