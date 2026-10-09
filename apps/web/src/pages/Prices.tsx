import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ForecastChart } from "../components/chart.tsx"
import { Data, Empty, Failed, Loading, Mono, Price, Section, Segmented, Usdg, useStatus } from "../components/ui.tsx"
import { rest, trpcQuery } from "../lib/api.ts"
import { belowPercent, type Leg } from "../lib/forecast.ts"
import { formatBps } from "../lib/format.ts"
import { HOST_STATUS } from "../lib/labels.ts"
import type { Board, Leg as LegPrice, ModelRow } from "../lib/types.ts"

const LEGS = [
  { value: "out", label: "Output" },
  { value: "in", label: "Input" },
] as const

export function Prices() {
  const models = useQuery({ queryKey: ["models"], queryFn: () => rest<{ data: ModelRow[] }>("/v1/models"), staleTime: 60_000 })
  const [picked, setPicked] = useState<string | null>(null)
  const rows = models.data?.data ?? []
  const model = picked ?? rows[0]?.id ?? null
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Off-peak price,
            <br />
            <em>posted by the hour.</em>
          </h1>
          <p className="lede">Open-weight models from bonded GPU hosts. Hosts post a price for every hour of the week, and idle hours fall below it. The live price at the start of a request is the price you pay.</p>
          <p className="note">
            Discounts depend on host supply and idle time. With few hosts, discounts are smaller. Prices move. <a href="/docs#limits">Honest limits</a>
          </p>
        </div>
        {model ? <LiveTicket model={model} /> : <div className="ticket">{models.isError ? <Failed error={models.error} retry={() => void models.refetch()} /> : models.isLoading ? <Loading /> : <Empty title="No models listed yet." />}</div>}
      </section>
      {rows.length > 1 && (
        <nav className="models" aria-label="Models">
          {rows.map((row) => (
            <button key={row.id} type="button" aria-pressed={row.id === model} onClick={() => setPicked(row.id)}>
              {row.id}
            </button>
          ))}
        </nav>
      )}
      {model && <ModelDetail model={model} />}
    </>
  )
}

function Pair({ leg }: { leg: LegPrice }) {
  return (
    <span>
      <Price value={leg.in} /> / <Price value={leg.out} />
    </span>
  )
}

function useBoard(model: string) {
  return useQuery({ queryKey: ["hosts.board", model], queryFn: () => trpcQuery<Board>("hosts.board", { model }), refetchInterval: 15_000 })
}

function LiveTicket({ model }: { model: string }) {
  const board = useBoard(model)
  return (
    <aside className="ticket" aria-label={`Live buyer price for ${model}`}>
      <header>
        <span>Live buyer price</span>
        <span className="ticket-model">{model}</span>
      </header>
      <Data query={board} lines={4}>
        {(data) =>
          data.now ? (
            <>
              <div className="ticket-prices">
                <div>
                  <span className="note">Input</span>
                  <strong>
                    <Price value={data.now.in} />
                  </strong>
                </div>
                <div>
                  <span className="note">Output</span>
                  <strong>
                    <Price value={data.now.out} />
                  </strong>
                </div>
              </div>
              <p className="note">Per 1M tokens, {formatBps(data.feeBps)} fee included.</p>
              <dl className="ticket-host">
                <dt>Cheapest host</dt>
                <dd>
                  <Mono value={data.now.host} />
                </dd>
              </dl>
            </>
          ) : (
            <Empty title="No host is serving this model right now.">The forecast comes back when a host is active.</Empty>
          )
        }
      </Data>
    </aside>
  )
}

function ModelDetail({ model }: { model: string }) {
  const board = useBoard(model)
  const status = useStatus()
  const [leg, setLeg] = useState<Leg>("out")
  const sealedOn = status.data?.features.sealed ?? false
  return (
    <>
      <Section title="The next 168 hours" aside={<Segmented label="Price leg" value={leg} options={LEGS} onChange={setLeg} />}>
        <Data query={board} lines={6}>
          {(data) =>
            data.next168h.length > 0 ? (
              <>
                <ForecastChart slots={data.next168h} leg={leg} />
                {!data.forecastFromHistory && <p className="note">Not enough load history yet, so this forecast assumes 30% load. A forecast is not a quote: the live price at request start is what you pay.</p>}
              </>
            ) : (
              <Empty title="No forecast yet.">A forecast needs at least one active host with a price sheet.</Empty>
            )
          }
        </Data>
      </Section>
      <Section title="Hosts">
        <Data query={board}>
          {(data) =>
            data.hosts.length > 0 ? (
              <>
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Host</th>
                      <th className="num">Live in / out</th>
                      <th className="num">Base in / out</th>
                      <th className="num">Floor in / out</th>
                      <th className="num">30-day discount</th>
                      <th className="num">Bond</th>
                      <th>Status</th>
                      <th>Sealed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hosts.map((host) => (
                      <tr key={host.host}>
                        <td data-label="Host">
                          <span>
                            <Mono value={host.host} />
                            {host.host === data.now?.host && <span className="pill gold">cheapest</span>}
                          </span>
                        </td>
                        <td data-label="Live" className="num">
                          <span>
                            <Pair leg={host.live} />
                            <span className="note below">{belowPercent(BigInt(host.live.out), BigInt(host.base.out))}% below base</span>
                          </span>
                        </td>
                        <td data-label="Base" className="num">
                          <Pair leg={host.base} />
                        </td>
                        <td data-label="Floor" className="num">
                          <Pair leg={host.floor} />
                        </td>
                        <td data-label="30-day discount" className="num">
                          {host.effective_discount_30d_bps === null ? <span className="note">no data yet</span> : formatBps(host.effective_discount_30d_bps)}
                        </td>
                        <td data-label="Bond" className="num">
                          <Usdg micro={host.bond} />
                        </td>
                        <td data-label="Status">
                          <span className={host.routable ? "pill ok" : "pill wait"}>{HOST_STATUS[host.status] ?? "Unknown"}</span>
                        </td>
                        <td data-label="Sealed">{host.sealed ? <span className="pill ok">Attested</span> : <span className="note">{sealedOn ? "No" : "Not switched on yet"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="note">Buyer prices per 1M tokens at this hour, all with the {formatBps(data.feeBps)} fee so they compare directly. The 30-day discount is what buyers actually paid against base.</p>
              </>
            ) : (
              <Empty title="No hosts have posted a price sheet for this model yet.">
                Run a GPU? <a href="/hosts">Host with Offpeak</a>.
              </Empty>
            )
          }
        </Data>
      </Section>
    </>
  )
}
