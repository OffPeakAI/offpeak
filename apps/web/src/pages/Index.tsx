import { useQuery } from "@tanstack/react-query"
import { Data, Section, Usdg } from "../components/ui.tsx"
import { rest } from "../lib/api.ts"
type Point = {
  modelDigest: string
  hour: number
  status: string
  reason: string | null
  records: number
  buyers: number
  hosts: number
  blendedMicroPerMillion: string | null
}
type Feed = {
  payload: { status: string; start: number; end: number; points: Point[]; limitations: string[] }
  signer: string
  hash: string
  signature: string
}
export function Index() {
  const feed = useQuery({ queryKey: ["market.index"], queryFn: () => rest<Feed>("/v1/index"), refetchInterval: 60000 })
  return (
    <>
      <header className="page-head">
        <span className="eyebrow">OFFPEAK INDEX</span>
        <h1>The price of useful compute.</h1>
        <p className="lede">Hourly prices from settled inference receipts. Separated by exact model revision, with buyer fees included.</p>
      </header>
      <Data query={feed}>
        {(f) => (
          <>
            <Section title="Last 24 completed hours">
              {f.payload.status !== "published" && (
                <div className="gate">
                  <h2>{f.payload.status === "volume_limit" ? "Publication paused" : "Waiting for a broader market"}</h2>
                  <p>
                    Each price needs at least 10 settled requests, 5 buyer wallets, and 3 hosts. No host may account for more than half the
                    tokens. Missing data is never shown as a zero price.
                  </p>
                </div>
              )}
              <div className="index-table">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Hour (UTC)</th>
                      <th>Model digest</th>
                      <th>USDG / 1M tokens</th>
                      <th>Receipts</th>
                      <th>Buyers / hosts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.payload.points.map((p) => (
                      <tr key={`${p.modelDigest}:${p.hour}`}>
                        <td>{new Date(p.hour * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
                        <td title={p.modelDigest}>{p.modelDigest.slice(0, 12)}…</td>
                        <td>
                          {p.blendedMicroPerMillion === null ? (
                            <span title={p.reason ?? ""}>Insufficient data</span>
                          ) : (
                            <Usdg micro={p.blendedMicroPerMillion} />
                          )}
                        </td>
                        <td>{p.records}</td>
                        <td>
                          {p.buyers} / {p.hosts}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section title="Check the publication">
              <p className="note">Signed by {f.signer}. Verify against a router signer you trust.</p>
              <pre>{f.hash}</pre>
              <a href="/v1/index" target="_blank" rel="noreferrer">
                Open signed JSON ↗
              </a>
              <ul className="note">
                {f.payload.limitations.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </Data>
    </>
  )
}
