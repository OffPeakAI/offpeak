import type { PaymentClient } from "@offpeak/shared"

export class LiveFacilitator implements PaymentClient {
  constructor(private opts: { url: string; token: string }) {}

  private async post<T>(path: string, body: unknown, bearer = false): Promise<T> {
    const res = await fetch(`${this.opts.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${this.opts.token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`facilitator ${path}: ${res.status}`)
    return (await res.json()) as T
  }

  verify(body: Parameters<PaymentClient["verify"]>[0]) {
    return this.post<Awaited<ReturnType<PaymentClient["verify"]>>>("/x402/verify", body, true)
  }

  settle(body: Parameters<PaymentClient["settle"]>[0]) {
    return this.post<{ success: boolean; status: string; errorReason?: string }>("/x402/settle", body, true)
  }

  capture(reqId: string, actual: bigint) {
    return this.post<{ queued: boolean }>("/x402/capture", { reqId, actual: actual.toString() }, true)
  }
}
