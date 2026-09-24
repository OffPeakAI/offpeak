const BASE = (import.meta.env?.VITE_OFFPEAK_API as string | undefined) ?? ""

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Reply<T> = { result?: { data: T }; error?: { message: string; data?: { code?: string; httpStatus?: number } } }

export function trpcUrl(path: string, input?: unknown) {
  return `${BASE}/trpc/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`
}

async function settle<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Reply<T>
  if (body.error) throw new ApiError(body.error.data?.code ?? "ERROR", body.error.data?.httpStatus ?? res.status, body.error.message)
  if (!res.ok || !body.result) throw new ApiError("ERROR", res.status, "Service unavailable")
  return body.result.data
}

const bearer = (session?: string | null): Record<string, string> => (session ? { authorization: `Bearer ${session}` } : {})

export async function trpcQuery<T>(path: string, input?: unknown, session?: string | null): Promise<T> {
  return settle<T>(await fetch(trpcUrl(path, input), { headers: bearer(session) }))
}

export async function trpcMutation<T>(path: string, input?: unknown, session?: string | null): Promise<T> {
  const res = await fetch(trpcUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(session) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  return settle<T>(res)
}

/** The plain routes answer in the OpenAI error shape. */
export async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  const body = (await res.json().catch(() => ({}))) as { error?: { message: string; code: string } }
  if (!res.ok) throw new ApiError(body.error?.code ?? "ERROR", res.status, body.error?.message ?? "Service unavailable")
  return body as T
}

const MESSAGES: Record<string, string> = {
  withdraw_pending: "A withdraw-all is pending. Deposits wait until it finishes or you cancel it.",
  beta_cap: "This goes over the 500 USDG beta cap per buyer.",
  exceeds_withdrawable: "That is more than you can withdraw now. The reserved part can take up to 2 hours.",
  contract_not_deployed: "The contract is not deployed on this network yet, so nothing can be sent.",
  not_switched_on: "This is not switched on yet.",
  not_found: "Nothing found for this wallet.",
  channel_not_open: "This channel is no longer open.",
  channel_not_closing: "This channel has not asked to close.",
  challenge_period: "The 2-hour challenge period is still running.",
  deposit_too_small: "A channel needs at least 1 USDG.",
  window_started: "This Window has started, so it can no longer be cancelled.",
  window_ended: "This Window has ended.",
  window_not_ended: "Claims open after the Window ends.",
  exceeds_holding: "That is more units than you hold.",
  nothing_to_claim: "You hold nothing in this Window.",
  unknown_request: "One of these requests does not belong to this wallet.",
  dispute_window: "Disputes close 7 days after the request.",
  bond_below_minimum: "The minimum bond is 2,000 USDG.",
  bad_signature: "The operator signature does not match this wallet.",
  bad_endpoint: "The endpoint must be an https URL with no query string.",
  not_in_probation: "This host is not in probation.",
  probation_running: "The 72-hour probation is still running.",
  nothing_releasable: "No credits are releasable yet.",
  response_window_closed: "The 24-hour response window has closed.",
  bad_login: "The signature did not match. Try signing in again.",
  close_unavailable: "The router cannot close this channel with you right now. Use Close without the router, which takes 2 hours.",
}

/** Turns a router code or wallet failure into a sentence for the person looking at it. */
/** Written for the reader, by a check on this page, so it reaches them as it stands. */
export class Refused extends Error {}

export function explain(error: unknown) {
  if (error instanceof Refused) return error.message
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session ended. Sign in again."
    return MESSAGES[error.message] ?? MESSAGES[error.code] ?? (error.status >= 500 ? "The service did not answer. Try again in a moment." : error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/user rejected|user denied|rejected the request/i.test(message)) return "You declined this in your wallet."
  if (/provider not found|no provider/i.test(message)) return "No browser wallet found. Install one, then try again."
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "The service did not answer. Check your connection."
  const reverted = /reverted[^:]*:\s*([^\n]+)/i.exec(message)
  if (reverted && !/custom error/i.test(reverted[1]!)) return `The chain refused this: ${reverted[1]}`
  return reverted ? "The chain would refuse this, so nothing was sent." : "That did not go through. Nothing was sent."
}
