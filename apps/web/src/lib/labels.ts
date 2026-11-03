export const PAGES = ["chat", "prices", "index", "windows", "agents", "dashboard", "hosts", "docs"] as const
export type Page = (typeof PAGES)[number] | "terms"

export const PAGE_PATHS: Record<Page, string> = { chat: "/chat", index: "/index", agents: "/agents", prices: "/", dashboard: "/dashboard", windows: "/windows", hosts: "/hosts", docs: "/docs", terms: "/terms" }

export function pageFor(pathname: string): Page | null {
  const path = pathname.replace(/\/+$/, "") || "/"
  return (Object.keys(PAGE_PATHS) as Page[]).find((page) => PAGE_PATHS[page] === path) ?? null
}

export const HOST_STATUS = ["None", "Probation", "Active", "Frozen", "Exiting", "Delisted"] as const
export const CHANNEL_STATUS = ["None", "Open", "Closing", "Closed"] as const
export const EVIDENCE_KIND = ["Model swap", "Throughput", "Metering", "Canary"] as const
export const CHALLENGE_STATE = ["None", "Filed", "Panel review", "Decided", "Finalized"] as const

export type Flags = Record<"channels" | "upto" | "night_jobs" | "windows" | "sealed" | "token_hooks" | "beta_cap", boolean>

export const FEATURES: { flag: keyof Flags; name: string; about: string }[] = [
  { flag: "channels", name: "Channels", about: "Prepaid payment channels for agents." },
  { flag: "upto", name: "x402 upto", about: "Pay-per-call with a signed maximum." },
  { flag: "night_jobs", name: "Night jobs", about: "Batch work at a price locked when scheduled." },
  { flag: "windows", name: "Windows", about: "Tradable reservations of future capacity." },
  { flag: "sealed", name: "Sealed tier", about: "Client-side encryption to attested hosts." },
  { flag: "token_hooks", name: "Token hooks", about: "Stays off until counsel review. Holding $OFPK alone earns nothing." },
  { flag: "beta_cap", name: "Beta cap", about: "500 USDG per buyer until the external audit is complete." },
]

export function flagWord(on: boolean) {
  return on ? "On" : "Not switched on yet"
}

export type WindowPhase = "before" | "running" | "ended"

export function windowPhase(window: { t0: number; t1: number }, now: number): WindowPhase {
  if (now < window.t0) return "before"
  return now < window.t1 ? "running" : "ended"
}
