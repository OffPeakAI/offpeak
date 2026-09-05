import { log } from "@offpeak/common"

const REFRESH_MS = 3_600_000

/** A failed refresh keeps the last good list, so an outage of the source never empties it. */
export class Denylist {
  private denied = new Set<string>()
  private timer: Timer | null = null

  constructor(private url?: string) {}

  has(address: string) {
    return this.denied.has(address.toLowerCase())
  }

  async refresh() {
    if (!this.url) return
    try {
      const response = await fetch(this.url)
      if (!response.ok) throw new Error(`status ${response.status}`)
      const entries: string[] = await response.json()
      this.denied = new Set(entries.map((entry) => entry.toLowerCase()))
    } catch (err) {
      log("facilitator", "denylist_refresh_failed", { error: String(err).slice(0, 160) })
    }
  }

  async start() {
    await this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}
