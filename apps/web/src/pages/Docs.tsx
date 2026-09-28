import { Data, FlagWord, Section, useStatus } from "../components/ui.tsx"
import { FEATURES } from "../lib/labels.ts"

const LIMITS = [
  "Open-weight models only. Offpeak doesn't sell closed models. Open models trail frontier models on the hardest tasks.",
  "Prices move. The live price shown at request start is what you pay; caps protect you, and requests over your cap wait (night jobs) or fail with 429 (interactive).",
  "Discounts depend on host supply and idle time. With few hosts, discounts are smaller.",
  "Open hosts can read prompts, and so can Offpeak's router, unless you use the sealed tier with client-side encryption. The sealed tier is not switched on yet.",
  "Audit sampling stores request bodies for up to 72 h, only if you opt in (opt-in buyers get 1% off).",
  "Audits are statistical. They catch sustained model swaps, not every single response.",
  "Usage records are signed by Offpeak's router and the host. You can recount your own requests and dispute any request within 7 days. Recount from a record under Usage on the dashboard, with op.verifyUsage in the SDK, or with offpeak_usage in MCP.",
  "Sealed records cannot be recounted from your plaintext. Their counts come from the attested host.",
  "Your balance is prepaid credit for Offpeak, not a bank deposit and not e-money.",
  "Withdrawing the reserved part of a balance can take up to 2 hours.",
  "USDG can be frozen by its issuer; Permit2 is a shared dependency.",
  "During the beta, deposits are capped at 500 USDG per buyer until the external contract audit is complete.",
  "Holding $OFPK alone earns nothing.",
]

const ROUTES: { group: string; rows: [string, string, string][] }[] = [
  {
    group: "OpenAI-compatible",
    rows: [
      ["POST", "/v1/chat/completions", "Chat, with streaming, tools and JSON mode. n above 1 is refused. Streams end with event: offpeak.usage, then data: [DONE]."],
      ["POST", "/v1/embeddings", "Embeddings, billed on input tokens only."],
      ["POST", "/v1/files", "Upload a batch file."],
      ["POST", "/v1/batches", "Schedule a night job at a locked price. GET /v1/batches/:id reads it; POST /v1/batches/:id/cancel releases lines not yet run."],
      ["GET", "/v1/models", "Model ids are compatibility names, with digest, hosts and the live price."],
    ],
  },
  {
    group: "Offpeak",
    rows: [
      ["GET", "/v1/prices?model=", "Live buyer price, every host and the next 168 hours by absolute hour. A key prices the board at its own fee."],
      ["GET", "/v1/usage/:reqId", "A signed usage record, with its Merkle proof once the hour settles."],
      ["GET", "/v1/usage?since=", "Your own records, newest first, with an API key."],
      ["GET", "/v1/tokenizers/:digest", "A model's context length and pinned tokenizer files, for recounting. Check them against the model digest."],
      ["GET", "/v1/windows", "The Window board. POST /v1/windows/buy, cancel, list and claim give calldata for your wallet."],
      ["GET", "/v1/channels/:id", "Deposit, claimed, vouchered cumulative, owed, latest seq, status and expiry. POST /v1/channels/:id/voucher accepts a voucher."],
      ["POST", "/v1/disputes", "Dispute requests within 7 days of each record."],
      ["GET", "/v1/status", "Feature flags and service health."],
      ["GET", "/v1/audits/calibration", "Published audit thresholds and baselines."],
    ],
  },
  {
    group: "Hosts",
    rows: [
      ["POST", "/v1/hosts/register", "Signed by the operator. Gives HostRegistry.register calldata."],
      ["POST", "/v1/hosts/price-sheet", "A signed price sheet. Sheets that break the floor rule are refused."],
      ["POST", "/v1/hosts/audit-response", "Gives AuditCourt.respond calldata with the hash of your response."],
    ],
  },
]

const HEADERS: [string, string][] = [
  ["Authorization: Bearer op_live_…", "A prepaid key. Agents leave it out and pay by channel or x402."],
  ["X-Offpeak-Max-Price: in=0.15,out=0.60", "USD per 1M tokens, fee included. Above this, interactive requests fail with 429."],
  ["X-Offpeak-Flex: 2026-11-02T06:00:00Z", "Run later at a locked price, by this deadline."],
  ["X-Offpeak-Window: <id>", "Draw from a Window first."],
  ["X-Offpeak-Channel, X-Offpeak-Voucher", "Pay from a channel."],
  ["PAYMENT-SIGNATURE", "x402 payment."],
]

const ERRORS: [string, string][] = [
  ["402 insufficient_reserve", "Caps or reserve exhausted. Says how much is left."],
  ["402", "An unpaid agent request. The body lists payment options, channel first."],
  ["403 withdraw_pending", "A withdraw-all is pending."],
  ["429 price_above_cap", "The live price is over X-Offpeak-Max-Price. Says the next cheaper hour."],
  ["503 no_capacity", "No healthy host for this model right now."],
]

export function Docs() {
  const status = useStatus()
  return (
    <>
      <header className="page-head">
        <h1>Docs</h1>
        <p className="lede">Point any OpenAI client at Offpeak by changing the base URL. Every response carries a signed usage record you can check yourself.</p>
        <nav className="jump" aria-label="On this page">
          <a href="#quickstart">Quickstart</a>
          <a href="#api">API reference</a>
          <a href="#limits">Honest limits</a>
          <a href="#status">Status</a>
        </nav>
      </header>
      <Section id="quickstart" title="Quickstart">
        <pre className="code">{`curl $OFFPEAK_URL/v1/chat/completions \\
  -H "Authorization: Bearer op_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"ofm-8b","messages":[{"role":"user","content":"hello"}]}'`}</pre>
        <p className="note">Prepaid buyers make a key on the dashboard. Agents that have not paid get a 402 that lists channel first.</p>
      </Section>
      <Section id="api" title="API reference">
        {ROUTES.map((group) => (
          <div key={group.group} className="api-group">
            <h3>{group.group}</h3>
            <table className="ledger routes">
              <tbody>
                {group.rows.map(([method, path, about]) => (
                  <tr key={path}>
                    <td data-label="Route">
                      <code>
                        {method} {path}
                      </code>
                    </td>
                    <td data-label="What it does">{about}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <div className="api-group">
          <h3>Request headers</h3>
          <table className="ledger routes">
            <tbody>
              {HEADERS.map(([name, about]) => (
                <tr key={name}>
                  <td data-label="Header">
                    <code>{name}</code>
                  </td>
                  <td data-label="Meaning">{about}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="api-group">
          <h3>Errors</h3>
          <table className="ledger routes">
            <tbody>
              {ERRORS.map(([name, about]) => (
                <tr key={name}>
                  <td data-label="Error">
                    <code>{name}</code>
                  </td>
                  <td data-label="Meaning">{about}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section id="limits" title="Honest limits">
        <ol className="limits">
          {LIMITS.map((line, index) => (
            <li key={line}>
              {line}
              {index === LIMITS.length - 1 && status.data && !status.data.features.token_hooks && " Token hooks are not switched on yet."}
            </li>
          ))}
        </ol>
      </Section>
      <Section id="status" title="Status">
        <Data query={status} lines={7}>
          {(data) => (
            <>
              <table className="ledger routes">
                <tbody>
                  {FEATURES.map((row) => (
                    <tr key={row.flag}>
                      <td data-label="Feature">
                        <strong>{row.name}</strong>
                      </td>
                      <td data-label="What it is">{row.about}</td>
                      <td data-label="State">
                        <FlagWord on={data.features[row.flag]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">
                Router: {data.health.router}. Hosts passing health checks: {data.health.hosts}.
              </p>
            </>
          )}
        </Data>
      </Section>
    </>
  )
}
