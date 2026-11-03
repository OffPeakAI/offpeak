import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { Stack } from "../context.ts"
import { channelId, channelProof, voucherBody } from "../pay/schemas.ts"

const METHOD = "offpeak-channel"
const challengeSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  realm: z.string().max(256),
  method: z.literal(METHOD),
  intent: z.literal("session"),
  request: z.string().max(4096),
  expires: z.string().datetime(),
  digest: z.string().max(128),
  header: z.literal("Payment-Authorization"),
  opaque: z.string().max(4096),
})
const credentialSchema = z.strictObject({
  challenge: challengeSchema,
  payload: z.strictObject({ channelId, proof: channelProof, voucher: voucherBody.optional() }),
})
// Challenge data contains only JSON primitives; sort object keys recursively for JCS encoding.
function canonical(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]"
  if (x !== null && typeof x === "object")
    return (
      "{" +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((x as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    )
  return JSON.stringify(x)
}
const enc = (x: unknown) => Buffer.from(canonical(x)).toString("base64url")
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
const sha = (body: string) => `sha-256=:${createHash("sha256").update(body).digest("base64")}:`
function binding(c: Omit<z.infer<typeof challengeSchema>, "id">) {
  return [c.realm, c.method, c.intent, c.request, c.expires, c.digest, c.header, c.opaque].join("|")
}
function mac(secret: string, c: Omit<z.infer<typeof challengeSchema>, "id">) {
  return createHmac("sha256", secret).update(binding(c)).digest("base64url")
}
function context(req: Request, nonce: string) {
  return enc({
    charge: req.headers.get("x-offpeak-max-charge"),
    nonce,
    path: new URL(req.url).pathname,
    price: req.headers.get("x-offpeak-max-price"),
  })
}
const bad = (code: string, status = 402) =>
  Response.json({ error: { type: "payment", code, message: "MPP session credential refused" } }, { status })

/** MPP transport for OffPeak's own USDG channels. This is a custom method, not Tempo/EVM charge. */
export async function mppChat(stack: Stack, req: Request, next: (req: Request) => Promise<Response>): Promise<Response> {
  const raw = req.headers.get("payment-authorization")
  const wants = req.headers.get("accept-payment") === METHOD
  if (!raw && !wants) return next(req)
  if (!stack.mppSecret || !stack.flags.channels) return bad("mpp_unavailable", 503)
  if (req.headers.has("x-offpeak-window") || req.headers.has("x-offpeak-flex")) return bad("mpp_request_mode", 400)
  const body = await req.text()
  if (Buffer.byteLength(body) > 128 * 1024) return bad("body_too_large", 413)
  if (!req.headers.has("x-offpeak-max-charge")) return bad("max_charge_required", 400)
  if (!raw) {
    const c = {
      realm: new URL(req.url).host,
      method: METHOD as typeof METHOD,
      intent: "session" as const,
      request: enc({
        amount: "0",
        currency: stack.usdg,
        methodDetails: {
          billing: "metered-tokens",
          chainId: 4663,
          channelManager: stack.channelManager,
          maxChargeMicro: req.headers.get("x-offpeak-max-charge"),
        },
        recipient: stack.channelPayee,
      }),
      expires: new Date((stack.clock() + 120) * 1000).toISOString(),
      digest: sha(body),
      header: "Payment-Authorization" as const,
      opaque: context(req, randomBytes(18).toString("base64url")),
    }
    const challenge = { id: mac(stack.mppSecret, c), ...c }
    const header =
      "Payment " +
      Object.entries(challenge)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
    return Response.json(
      { error: { type: "payment", code: "payment_required", message: "Use an OffPeak USDG channel" }, challenge },
      { status: 402, headers: { "WWW-Authenticate": header, "Cache-Control": "no-store" } },
    )
  }
  if (raw.length > 32768 || !raw.startsWith("Payment ")) return bad("bad_mpp_credential")
  let parsed: z.infer<typeof credentialSchema>
  try {
    parsed = credentialSchema.parse(JSON.parse(Buffer.from(raw.slice(8), "base64url").toString()))
  } catch {
    return bad("bad_mpp_credential")
  }
  const c = parsed.challenge,
    expected = mac(stack.mppSecret, c)
  if (
    !timingSafeEqual(Buffer.from(c.id), Buffer.from(expected)) ||
    c.realm !== new URL(req.url).host ||
    c.digest !== sha(body) ||
    Date.parse(c.expires) <= stack.clock() * 1000 ||
    Date.parse(c.expires) > (stack.clock() + 120) * 1000
  )
    return bad("bad_mpp_challenge")
  let nonce: string
  try {
    nonce = JSON.parse(Buffer.from(c.opaque, "base64url").toString()).nonce
  } catch {
    return bad("bad_mpp_challenge")
  }
  if (typeof nonce !== "string" || c.opaque !== context(req, nonce)) return bad("mpp_request_changed")
  const used = await stack.db.query(
    `INSERT INTO serving.expansion_replays (id,expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
    [`mpp:${c.id}`, Math.ceil(Date.parse(c.expires) / 1000)],
  )
  if (!used.rows.length) return bad("mpp_replayed", 409)
  const headers = new Headers(req.headers)
  for (const key of [
    "authorization",
    "payment-authorization",
    "payment-signature",
    "x-payment",
    "x-offpeak-channel",
    "x-offpeak-voucher",
    "x-offpeak-channel-auth",
  ])
    headers.delete(key)
  headers.set("x-offpeak-channel", parsed.payload.channelId)
  headers.set("x-offpeak-channel-auth", Buffer.from(json(parsed.payload.proof)).toString("base64url"))
  if (parsed.payload.voucher) headers.set("x-offpeak-voucher", Buffer.from(json(parsed.payload.voucher)).toString("base64url"))
  const response = await next(new Request(req.url, { method: "POST", headers, body, signal: req.signal }))
  // The ordinary channel verifier, reservations and replay guard still run in the serving pipeline.
  return response
}
