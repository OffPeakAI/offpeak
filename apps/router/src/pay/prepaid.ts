export type HoldView = {
  servable: boolean
  reason?: "withdraw_pending" | "paused" | "no_balance" | "no_caps" | "insufficient_reserve"
  hourlyCap: bigint
  dailyCap: bigint
  balance: bigint
  hour: number
  day: number
  lastSettledHour: bigint
}

type HeldAmount = { wallet: string; amount: bigint; hour: number; day: number; expires: number }

export type HoldBooks = {
  /** wallet -> hour -> captured spend */
  spend: Map<string, Map<number, bigint>>
  holds: Map<string, HeldAmount>
}

export function emptyBooks(): HoldBooks {
  return { spend: new Map(), holds: new Map() }
}

export function effectiveCaps(hourly: bigint, daily: bigint, pendingHourly: bigint, pendingDaily: bigint, pendingActive: boolean) {
  if (!pendingActive) return { hourlyCap: hourly, dailyCap: daily }
  return {
    hourlyCap: pendingHourly < hourly ? pendingHourly : hourly,
    dailyCap: pendingDaily < daily ? pendingDaily : daily,
  }
}

/** Same admission rule as pay/holds.lua, using bigint. */
export function tryAdmit(books: HoldBooks, wallet: string, amount: bigint, view: HoldView, holdId: string, now: number, ttl: number, fromHold?: string):
  | { ok: true }
  | { ok: false; error: string } {
  if (!view.servable) return { ok: false, error: view.reason ?? "paused" }
  const parent = fromHold ? books.holds.get(fromHold) : undefined
  const carved = parent && parent.expires > now ? (parent.amount < amount ? parent.amount : amount) : 0n
  let hourOpen = 0n
  let dayOpen = 0n
  let totalOpen = 0n
  for (const [id, hold] of books.holds) {
    if (hold.wallet !== wallet) continue
    if (hold.expires <= now) {
      books.holds.delete(id)
      continue
    }
    totalOpen += hold.amount
    if (hold.hour === view.hour) hourOpen += hold.amount
    if (hold.day === view.day) dayOpen += hold.amount
  }
  if (parent) {
    totalOpen -= carved
    if (parent.hour === view.hour) hourOpen -= carved
    if (parent.day === view.day) dayOpen -= carved
  }
  let hourSpend = 0n
  let daySpend = 0n
  let unsettled = 0n
  for (const [hour, spent] of books.spend.get(wallet) ?? []) {
    if (hour === view.hour) hourSpend = spent
    if (Math.floor(hour / 24) === view.day) daySpend += spent
    if (BigInt(hour) > view.lastSettledHour) unsettled += spent
  }
  if (hourSpend + hourOpen + amount > view.hourlyCap) return { ok: false, error: "insufficient_reserve" }
  if (daySpend + dayOpen + amount > view.dailyCap) return { ok: false, error: "insufficient_reserve" }
  if (unsettled + totalOpen + amount > view.balance) return { ok: false, error: "insufficient_reserve" }
  if (parent && carved > 0n) {
    if (parent.amount === carved) books.holds.delete(fromHold!)
    else parent.amount -= carved
  }
  books.holds.set(holdId, { wallet, amount, hour: view.hour, day: view.day, expires: now + ttl })
  return { ok: true }
}

export function captureHold(books: HoldBooks, wallet: string, holdId: string, actual: bigint, hour: number) {
  const spend = books.spend.get(wallet) ?? new Map<number, bigint>()
  spend.set(hour, (spend.get(hour) ?? 0n) + actual)
  books.spend.set(wallet, spend)
  books.holds.delete(holdId)
}

export function releaseHold(books: HoldBooks, holdId: string) {
  books.holds.delete(holdId)
}

/** The in-process ledger, for tests and single-process local runs. */
export class HoldLedger {
  books = emptyBooks()

  async admit(wallet: string, amount: bigint, view: HoldView, holdId: string, now: number, ttl = 900, fromHold?: string) {
    return tryAdmit(this.books, wallet, amount, view, holdId, now, ttl, fromHold)
  }

  async capture(wallet: string, holdId: string, actual: bigint, hour: number) {
    captureHold(this.books, wallet, holdId, actual, hour)
  }

  async release(_wallet: string, holdId: string) {
    releaseHold(this.books, holdId)
  }

  async committed(wallet: string, lastSettledHour: bigint) {
    let total = 0n
    for (const hold of this.books.holds.values()) if (hold.wallet === wallet) total += hold.amount
    for (const [hour, spent] of this.books.spend.get(wallet) ?? []) if (BigInt(hour) > lastSettledHour) total += spent
    return total
  }
}

export class MemoryCounters {
  private values = new Map<string, bigint>()

  async add(key: string, by: bigint) {
    const next = (this.values.get(key) ?? 0n) + by
    this.values.set(key, next)
    return next
  }

  async get(key: string) {
    return this.values.get(key) ?? 0n
  }
}
