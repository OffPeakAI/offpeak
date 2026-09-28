export type Session = { token: string; wallet: string }

const KEY = "offpeak.session"

function load(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function store(next: Session | null) {
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {
    // Private windows may refuse storage. The session then lasts as long as the page.
  }
}

const listeners = new Set<() => void>()
let current = load()

export const sessionStore = {
  get: () => current,
  set(next: Session | null) {
    current = next
    store(next)
    for (const fn of listeners) fn()
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

const CHANNELS_KEY = "offpeak.channels"

/** Channel ids the router has not seen yet, since a new channel has no served request to list it by. */
export function rememberedChannels(wallet: string): string[] {
  try {
    return (JSON.parse(localStorage.getItem(`${CHANNELS_KEY}.${wallet}`) ?? "[]") as string[]).filter((id) => /^0x[0-9a-f]{64}$/.test(id))
  } catch {
    return []
  }
}

export function rememberChannel(wallet: string, id: string) {
  try {
    const next = [...new Set([...rememberedChannels(wallet), id.toLowerCase()])]
    localStorage.setItem(`${CHANNELS_KEY}.${wallet}`, JSON.stringify(next))
  } catch {
    // Only a convenience. The channel still exists on chain.
  }
}
