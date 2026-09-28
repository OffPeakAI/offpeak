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
