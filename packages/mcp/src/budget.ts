import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { OffpeakError, type MaxPrice } from "@offpeak/sdk"
import { hostCostMicro, type Micro, type UsageRecord } from "@offpeak/shared"

const DAY_MS = 86_400_000
const PAY_MODE_UPTO = 1

export type SpendLimits = {
  callCapMicro: Micro
  dayCapMicro: Micro
  /** Used when a call sets none, and the most a call may set. */
  maxPrice: MaxPrice
  /** Keeps the day's total across restarts. Stdio clients start a server per session, so without it each session starts at zero. */
  file?: string
}

export const DEFAULT_LIMITS: SpendLimits = { callCapMicro: 1_000_000n, dayCapMicro: 10_000_000n, maxPrice: { inPerM: 1_000_000n, outPerM: 4_000_000n } }

const lower = (a: Micro, b: Micro) => (a < b ? a : b)

/** What one record cost. `upto` was counted when it was signed, at the amount it put at risk. */
export const billedBy = (record: UsageRecord) => (record.payMode === PAY_MODE_UPTO ? 0n : record.hostCostMicro + record.feeMicro)

/**
 * The operator's limits on what these tools may spend, whatever an agent asks for. Text an agent reads
 * can steer it, so nothing here takes a value from a tool call that could raise a limit.
 */
export class Budget {
  private day = 0
  private spent = 0n
  private held = 0n

  constructor(private limits: SpendLimits = DEFAULT_LIMITS) {
    if (!limits.file) return
    try {
      const saved = JSON.parse(readFileSync(limits.file, "utf8")) as { day: number; spent: string }
      this.day = saved.day
      this.spent = BigInt(saved.spent)
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw new Error("OFFPEAK_SPEND_FILE cannot be read")
    }
  }

  private today() {
    const day = Math.floor(Date.now() / DAY_MS)
    if (day === this.day) return
    this.day = day
    this.spent = 0n
  }

  private add(amount: Micro) {
    this.spent += amount
    if (!this.limits.file) return
    writeFileSync(`${this.limits.file}.tmp`, JSON.stringify({ day: this.day, spent: this.spent.toString() }), { mode: 0o600 })
    renameSync(`${this.limits.file}.tmp`, this.limits.file)
  }

  private overDay(amount: Micro) {
    return new OffpeakError("day_cap", `This server's limit of ${this.limits.dayCapMicro} µUSDG a day would be passed by ${amount} µUSDG more. ${this.spent} µUSDG is spent today.`)
  }

  /** A call's cap: its own where that is lower, the operator's otherwise. */
  maxPrice(asked?: MaxPrice): MaxPrice {
    const { inPerM, outPerM } = this.limits.maxPrice
    return asked ? { inPerM: lower(asked.inPerM, inPerM), outPerM: lower(asked.outPerM, outPerM) } : { inPerM, outPerM }
  }

  /** The most a request can cost under a cap, taking a byte of input as one token at most. */
  worstCase(input: string, outputTokens: number, cap: MaxPrice) {
    return hostCostMicro(Buffer.byteLength(input), outputTokens, cap.inPerM, cap.outPerM)
  }

  /** Holds the worst case while a call runs, then counts what it really cost. A call in flight counts, so calls side by side cannot pass the cap together. */
  async spend<T>(worst: Micro, run: () => Promise<T>, billed: (result: T) => Micro): Promise<T> {
    this.today()
    if (worst > this.limits.callCapMicro) throw new OffpeakError("call_cap", `This call could cost ${worst} µUSDG, above this server's limit of ${this.limits.callCapMicro} µUSDG a call`)
    if (this.spent + this.held + worst > this.limits.dayCapMicro) throw this.overDay(worst)
    this.held += worst
    try {
      const result = await run()
      this.held -= worst
      this.add(billed(result))
      return result
    } catch (err) {
      this.held -= worst
      // Offpeak's own errors come before any payment, except a record over its cap. Anything else may have been served.
      if (!(err instanceof OffpeakError) || err.code === "over_max_price") this.add(worst)
      throw err
    }
  }

  /** An `upto` puts its whole amount at risk the moment it is signed, so it counts in full before the signature. */
  authorized(amount: Micro) {
    this.today()
    if (this.spent + amount > this.limits.dayCapMicro) throw this.overDay(amount)
    this.add(amount)
  }
}
