import { createHash } from "node:crypto"
/** Wrap the SDK's channel fetch. The SDK still signs requests, verifies records and issues vouchers. */
export function mppChannelFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      channel = req.headers.get("x-offpeak-channel")
    if (!channel || req.method !== "POST" || !new URL(req.url).pathname.endsWith("/v1/chat/completions")) return baseFetch(req)
    const body = await req.text(),
      headers = new Headers(req.headers)
    if (!headers.has("x-offpeak-max-charge")) throw Error("MPP requests require maxChargeMicro")
    const proof = headers.get("x-offpeak-channel-auth"),
      voucher = headers.get("x-offpeak-voucher")
    for (const key of ["authorization", "x-offpeak-channel", "x-offpeak-channel-auth", "x-offpeak-voucher", "payment-signature"])
      headers.delete(key)
    headers.set("accept-payment", "offpeak-channel")
    const first = await baseFetch(req.url, { method: "POST", headers, body, signal: req.signal, redirect: "error" })
    if (first.status !== 402) return first
    const data = await first
        .clone()
        .json()
        .catch(() => null),
      c = data?.challenge
    const expected = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`
    if (
      !c ||
      c.method !== "offpeak-channel" ||
      c.intent !== "session" ||
      c.realm !== new URL(req.url).host ||
      c.digest !== expected ||
      c.header !== "Payment-Authorization"
    )
      throw Error("Unexpected MPP challenge")
    const details = JSON.parse(Buffer.from(c.request, "base64url").toString())
    if (
      details.methodDetails?.chainId !== 4663 ||
      details.methodDetails?.maxChargeMicro !== headers.get("x-offpeak-max-charge") ||
      details.amount !== "0"
    )
      throw Error("MPP terms changed")
    if (!proof) throw Error("Missing channel proof")
    const payload = {
      channelId: channel,
      proof: JSON.parse(Buffer.from(proof, "base64url").toString()),
      ...(voucher ? { voucher: JSON.parse(Buffer.from(voucher, "base64url").toString()) } : {}),
    }
    headers.set("payment-authorization", "Payment " + Buffer.from(JSON.stringify({ challenge: c, payload })).toString("base64url"))
    return baseFetch(req.url, { method: "POST", headers, body, signal: req.signal, redirect: "error" })
  }) as typeof fetch
}
