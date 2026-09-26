const MICRO = 1_000_000n
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

function group(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function decimal(micro: bigint, minDecimals: number) {
  const negative = micro < 0n
  const value = negative ? -micro : micro
  const whole = value / MICRO
  const fraction = (value % MICRO).toString().padStart(6, "0").replace(/0+$/, "").padEnd(minDecimals, "0")
  return `${negative ? "-" : ""}${group(whole.toString())}${fraction ? `.${fraction}` : ""}`
}

/** Every digit of a µUSDG amount as a string. No float touches it. */
export function formatUsdg(micro: bigint | string) {
  return decimal(BigInt(micro), 2)
}

/** A `PricePerM` as dollars per 1M tokens, exact to the µUSDG. */
export function formatPrice(pricePerM: bigint | string) {
  return `$${decimal(BigInt(pricePerM), 3)}`
}

export function formatTokens(tokens: bigint | string | number) {
  return group(BigInt(tokens).toString())
}

/** Basis points as a percent, keeping only the digits that carry. */
export function formatBps(bps: number) {
  const whole = Math.trunc(bps / 100)
  const rest = Math.abs(bps % 100)
  if (rest === 0) return `${whole}%`
  return `${whole}.${rest.toString().padStart(2, "0").replace(/0$/, "")}%`
}

export type Parsed = { ok: true; micro: bigint } | { ok: false; error: string }

/** Reads what a person typed into µUSDG, or says why it cannot. Never rounds. */
export function parseUsdg(text: string): Parsed {
  const value = text.trim()
  if (value === "") return { ok: false, error: "Enter an amount." }
  if (!/^\d*\.?\d*$/.test(value) || value === ".") return { ok: false, error: "Use digits and one decimal point." }
  const [whole = "", fraction = ""] = value.split(".")
  if (fraction.length > 6) return { ok: false, error: "USDG has 6 decimals." }
  const micro = BigInt(whole || "0") * MICRO + BigInt(fraction.padEnd(6, "0") || "0")
  return { ok: true, micro }
}

export function parseCount(text: string): { ok: true; value: bigint } | { ok: false; error: string } {
  const value = text.trim()
  if (!/^[1-9]\d{0,18}$/.test(value)) return { ok: false, error: "Enter a whole number." }
  return { ok: true, value: BigInt(value) }
}

export function shortHex(value: string, lead = 6, tail = 4) {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`
}

function pad(value: number) {
  return value.toString().padStart(2, "0")
}

/** UTC only, so the same hour reads the same to everyone. */
export function formatUtc(unixSeconds: number) {
  const date = new Date(unixSeconds * 1000)
  const day = DAYS[(date.getUTCDay() + 6) % 7]
  return `${day} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

export function dayName(hourOfWeek: number) {
  return DAYS[Math.floor(hourOfWeek / 24) % 7]!
}

export function hourLabel(hourOfWeek: number) {
  return `${dayName(hourOfWeek)} ${pad(hourOfWeek % 24)}:00`
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const rest = total % 60
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(rest)}s`
  return `${minutes}m ${pad(rest)}s`
}
