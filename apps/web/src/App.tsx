import { Chat } from "./pages/Chat.tsx"
import { Index } from "./pages/Index.tsx"
import { Agents } from "./pages/Agents.tsx"
import { useEffect, useState, type MouseEvent } from "react"
import { WalletChip } from "./components/session.tsx"
import { useNow } from "./components/ui.tsx"
import { PAGES, PAGE_PATHS, pageFor, type Page } from "./lib/labels.ts"
import { hourOfWeek } from "./lib/shared.ts"
import { Dashboard } from "./pages/Dashboard.tsx"
import { Docs } from "./pages/Docs.tsx"
import { Hosts } from "./pages/Hosts.tsx"
import { Prices } from "./pages/Prices.tsx"
import { Terms } from "./pages/Terms.tsx"
import { Windows } from "./pages/Windows.tsx"

const TITLES: Record<Page, string> = { chat: "Chat", index: "Index", agents: "Agents", prices: "Prices", dashboard: "Dashboard", windows: "Windows", hosts: "Hosts", docs: "Docs", terms: "Terms" }

function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const sync = () => setPath(location.pathname)
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  // In-page links stay real anchors, so they work without any of this.
  const follow = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a")
    if (!link || link.origin !== location.origin || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    history.pushState(null, "", link.pathname + link.hash)
    setPath(link.pathname)
    if (link.hash) requestAnimationFrame(() => document.getElementById(link.hash.slice(1))?.scrollIntoView())
    else scrollTo(0, 0)
  }
  return { path, follow }
}

/** The week as one line across the top of every page, with this hour marked. */
function WeekRule() {
  const now = useNow()
  const how = hourOfWeek(now)
  return (
    <div className="week-rule" aria-hidden="true">
      <span style={{ left: `${((how + 0.5) / 168) * 100}%` }} />
    </div>
  )
}

export function App() {
  const { path, follow } = usePath()
  const page = pageFor(path)
  useEffect(() => {
    document.title = page ? `${TITLES[page]} · OFFPEAK` : "OFFPEAK"
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [page])
  return (
    <div className="shell" onClick={follow}>
      <WeekRule />
      <header className="nav">
        <a className="brand" href="/">
          OFFPEAK
        </a>
        <nav aria-label="Main">
          {PAGES.map((name) => (
            <a key={name} href={PAGE_PATHS[name]} aria-current={page === name ? "page" : undefined}>
              {TITLES[name]}
            </a>
          ))}
        </nav>
        <WalletChip />
      </header>
      <main>
        {page === "chat" && <Chat />}
        {page === "index" && <Index />}
        {page === "agents" && <Agents />}
        {page === "prices" && <Prices />}
        {page === "dashboard" && <Dashboard />}
        {page === "windows" && <Windows />}
        {page === "hosts" && <Hosts />}
        {page === "docs" && <Docs />}
        {page === "terms" && <Terms />}
        {page === null && (
          <header className="page-head">
            <h1>Nothing here.</h1>
            <p className="lede">
              Try the <a href="/">live prices</a>.
            </p>
          </header>
        )}
      </main>
      <footer>
        <p>Third-party names describe compatibility only; no affiliation.</p>
        <nav aria-label="Footer">
          <a href="/terms">Terms</a>
          <a href="/docs#limits">Honest limits</a>
          <a href="/docs#status">Status</a>
        </nav>
      </footer>
    </div>
  )
}
