import { useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { publicActions } from "viem"
import { useWalletClient } from "wagmi"
import { WindowMarketAbi } from "../../../../packages/abis/src/WindowMarket.ts"
import { Gate, useAuthed, useSession } from "../components/session.tsx"
import { usePlan, useTx } from "../components/tx.tsx"
import { Data, Empty, Field, Flagged, Mono, Section, Usdg, useNetwork, useNow } from "../components/ui.tsx"
import { trpcMutation, trpcQuery } from "../lib/api.ts"
import { CANCEL_RULE, RESALE_RULE, buyTotal, resaleFeeLine, resalePreview } from "../lib/fees.ts"
import { formatDuration, formatTokens, formatUsdg, formatUtc, parseCount, parseUsdg } from "../lib/format.ts"
import { windowPhase } from "../lib/labels.ts"
import type { Holding, Listing, Tx, WindowRow } from "../lib/types.ts"

type BoardData = { serverTime: number; windows: WindowRow[] }

const LISTINGS_SHOWN = 40n

export function Windows() {
  return (
    <>
      <header className="page-head">
        <h1>Windows</h1>
        <p className="lede">A Window is a reservation of future tokens on one host. One unit is 1M tokens. Buy at the live Dutch price, draw it down during the Window, or resell what you will not use.</p>
      </header>
      <Flagged flag="windows" name="Windows">
        <Board />
      </Flagged>
    </>
  )
}

function Board() {
  const board = useQuery({ queryKey: ["windows.board"], queryFn: () => trpcQuery<BoardData>("windows.board"), refetchInterval: 10_000 })
  return (
    <>
      <Section title="Board">
        <Data query={board} lines={4}>
          {(data) =>
            data.windows.length > 0 ? (
              <ul className="windows">
                {data.windows.map((row) => (
                  <WindowCard key={row.id} row={row} serverTime={data.serverTime} />
                ))}
              </ul>
            ) : (
              <Empty title="No Windows on sale.">Hosts post Windows ahead of the hours they cover. Check back, or watch the price page for cheap hours.</Empty>
            )
          }
        </Data>
      </Section>
      <Section title="Resale listings">
        <p className="note">Sellers pay {RESALE_RULE}. Listings are read straight from the chain through your wallet.</p>
        <Data query={board} lines={2}>
          {(data) => <Listings windows={data.windows} />}
        </Data>
      </Section>
      <Section title="Your Windows">
        <Gate what="your Windows">
          <Data query={board} lines={2}>
            {(data) => <Holdings windows={data.windows} serverTime={data.serverTime} />}
          </Data>
        </Gate>
      </Section>
    </>
  )
}

function WindowCard({ row, serverTime }: { row: WindowRow; serverTime: number }) {
  const now = useNow(serverTime)
  const phase = windowPhase(row, now)
  return (
    <li className="window">
      <header>
        <span className="window-id">Window {row.id}</span>
        <span className={phase === "ended" ? "pill wait" : "pill ok"}>{row.failed ? "Failed" : phase === "before" ? `Starts in ${formatDuration(row.t0 - now)}` : phase === "running" ? "Running" : "Ended"}</span>
      </header>
      {phase === "before" && (
        <div className="window-price">
          <strong>
            <Usdg micro={row.buyerPricePerUnit} />
          </strong>
          <span className="note">per unit now, fee included. The Dutch price falls until the auction ends.</span>
        </div>
      )}
      <dl className="facts wide">
        <dt>Model</dt>
        <dd>{row.model ?? "Unknown model"}</dd>
        <dt>Host</dt>
        <dd>
          <Mono value={row.host} />
        </dd>
        <dt>From</dt>
        <dd>{formatUtc(row.t0)}</dd>
        <dt>To</dt>
        <dd>{formatUtc(row.t1)}</dd>
        <dt>Minimum speed</dt>
        <dd>{formatTokens(row.minTps)} tokens/s</dd>
        <dt>Units</dt>
        <dd>{formatTokens(row.units)}</dd>
      </dl>
      {phase === "before" && <Buy row={row} />}
    </li>
  )
}

function Buy({ row }: { row: WindowRow }) {
  const { stage } = useSession()
  const { go, busy } = usePlan()
  const [text, setText] = useState("1")
  const parsed = parseCount(text)
  const price = BigInt(row.buyerPricePerUnit)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!parsed.ok) return
    const total = buyTotal(parsed.value, price)
    void go(`Buy ${parsed.value} of Window ${row.id}`, `Buy for up to ${formatUsdg(total)} USDG`, "windows.buyPlan", { id: row.id, units: parsed.value.toString(), maxBuyerPricePerUnit: price.toString() })
  }
  if (stage !== "ready") return <p className="note">Sign in on the dashboard or under Your Windows to buy.</p>
  return (
    <form className="row end" onSubmit={submit}>
      <Field label="Units" error={text !== "" && !parsed.ok ? parsed.error : null}>
        <input inputMode="numeric" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <button type="submit" className="btn small" disabled={busy || !parsed.ok}>
        Buy{parsed.ok ? ` for ${formatUsdg(buyTotal(parsed.value, price))} USDG` : ""}
      </button>
    </form>
  )
}

function useListings(windows: WindowRow[]) {
  const { data: client } = useWalletClient()
  const network = useNetwork()
  const market = network.data?.windowMarket
  const known = new Set(windows.map((row) => row.id))
  return useQuery({
    queryKey: ["listings", market, windows.length],
    enabled: Boolean(client && market),
    refetchInterval: 30_000,
    queryFn: async (): Promise<Listing[]> => {
      const reader = client!.extend(publicActions)
      const next = await reader.readContract({ address: market!, abi: WindowMarketAbi, functionName: "nextListingId" })
      const first = next > LISTINGS_SHOWN ? next - LISTINGS_SHOWN : 1n
      const ids = Array.from({ length: Number(next - first) }, (_, index) => first + BigInt(index))
      const rows = await Promise.all(ids.map((listingId) => reader.readContract({ address: market!, abi: WindowMarketAbi, functionName: "listings", args: [listingId] }).then(([id, seller, units, pricePerUnit]) => ({ listingId, id, seller, units, pricePerUnit }))))
      return rows.filter((row) => row.units > 0n && known.has(row.id.toString())).reverse()
    },
  })
}

function Listings({ windows }: { windows: WindowRow[] }) {
  const { address, wallet } = useSession()
  const listings = useListings(windows)
  if (!address) return <Empty title="Connect a wallet to read resale listings." />
  return (
    <Data query={listings} lines={2}>
      {(rows) =>
        rows.length > 0 ? (
          <table className="ledger">
            <thead>
              <tr>
                <th>Listing</th>
                <th>Window</th>
                <th>Seller</th>
                <th className="num">Units</th>
                <th className="num">Per unit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.listingId.toString()}>
                  <td data-label="Listing">{row.listingId.toString()}</td>
                  <td data-label="Window">{row.id.toString()}</td>
                  <td data-label="Seller">
                    <Mono value={row.seller} />
                  </td>
                  <td data-label="Units" className="num">
                    {row.units.toString()}
                  </td>
                  <td data-label="Per unit" className="num">
                    <Usdg micro={row.pricePerUnit} />
                  </td>
                  <td className="act">{row.seller.toLowerCase() === wallet ? <Delist listing={row} /> : <BuyListing listing={row} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing listed for resale right now." />
        )
      }
    </Data>
  )
}
