import { WindowCreate } from "./WindowCreate.tsx"
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
        <WindowCreate />
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
      {phase === "running" && !row.failed && <a className="btn small" href={`/chat?window=${row.id}`}>Use in Chat ↗</a>}
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

function BuyListing({ listing }: { listing: Listing }) {
  const { stage } = useSession()
  const { go, busy } = usePlan()
  if (stage !== "ready") return null
  const buy = () => void go(`Buy listing ${listing.listingId}`, `Buy for ${formatUsdg(listing.units * listing.pricePerUnit)} USDG`, "windows.buyListingPlan", { listingId: listing.listingId.toString(), units: listing.units.toString(), maxPricePerUnit: listing.pricePerUnit.toString() })
  return (
    <button type="button" className="btn small" disabled={busy} onClick={buy}>
      Buy all
    </button>
  )
}

function Delist({ listing }: { listing: Listing }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const pull = () => void run(`Take down listing ${listing.listingId}`, async (wallet) => wallet.send("Take down the listing", await trpcMutation<Tx>("windows.delistTx", { listingId: listing.listingId.toString() }, token)))
  return (
    <button type="button" className="btn ghost small" disabled={busy} onClick={pull}>
      Take down
    </button>
  )
}

function Holdings({ windows, serverTime }: { windows: WindowRow[]; serverTime: number }) {
  const holdings = useAuthed<Holding[]>("windows.holdings", undefined, { refetchInterval: 30_000 })
  const now = useNow(serverTime)
  return (
    <Data query={holdings} lines={2}>
      {(rows) =>
        rows.length > 0 ? (
          <ul className="windows">
            {rows.map((row) => (
              <HoldingCard key={row.id} holding={row} window={windows.find((item) => item.id === row.id)} now={now} />
            ))}
          </ul>
        ) : (
          <Empty title="You hold no Windows.">Buy one from the board above.</Empty>
        )
      }
    </Data>
  )
}

function HoldingCard({ holding, window: row, now }: { holding: Holding; window: WindowRow | undefined; now: number }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const phase = row ? windowPhase(row, now) : "ended"
  const balance = BigInt(holding.balance)
  const claim = () =>
    void run(`Claim Window ${holding.id}`, async (wallet) => {
      const plan = await trpcMutation<{ kind: string; tx: Tx }>("windows.claimTx", { id: holding.id }, token)
      await wallet.send(plan.kind === "failure" ? "Claim the failure refund" : "Claim the expiry refund", plan.tx)
    })
  return (
    <li className="window">
      <header>
        <span className="window-id">Window {holding.id}</span>
        <span className="pill ok">{formatTokens(holding.balance)} held</span>
      </header>
      <dl className="facts wide">
        <dt>Your cost per unit</dt>
        <dd>
          <Usdg micro={holding.costBasis} />
        </dd>
        <dt>Tokens drawn</dt>
        <dd>{formatTokens(holding.drawnTokens)}</dd>
      </dl>
      {phase !== "ended" && balance > 0n && <Resell holding={holding} />}
      {phase === "before" && balance > 0n && <Cancel holding={holding} />}
      {phase === "ended" && (
        <div className="row">
          <button type="button" className="btn small" disabled={busy || balance === 0n} onClick={claim}>
            {row?.failed ? "Claim failure refund" : "Claim expiry refund"}
          </button>
          <p className="note">{row?.failed ? "A failed Window refunds undrawn tokens plus a share of the host's collateral." : "Unused tokens refund 50% of the host price plus the full fee, once the Window's hours settle."}</p>
        </div>
      )}
    </li>
  )
}

function Resell({ holding }: { holding: Holding }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const [units, setUnits] = useState("1")
  const [price, setPrice] = useState("")
  const count = parseCount(units)
  const parsed = parseUsdg(price)
  const balance = BigInt(holding.balance)
  const costBasisPerUnit = BigInt(holding.costBasis)
  const ready = count.ok && parsed.ok && parsed.micro > 0n && count.value <= balance
  const input = ready ? { units: count.value, pricePerUnit: parsed.micro, costBasisPerUnit } : null
  const preview = input ? resalePreview(input) : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!input) return
    void run(`List ${input.units} of Window ${holding.id}`, async (wallet) => {
      const plan = await trpcMutation<{ tx: Tx }>("windows.listTx", { id: holding.id, units: input.units.toString(), pricePerUnit: input.pricePerUnit.toString() }, token)
      await wallet.send("List for resale", plan.tx)
    })
  }
  return (
    <form className="panel" onSubmit={submit}>
      <div className="fields">
        <Field label="Units to list" error={count.ok && count.value > balance ? "That is more units than you hold." : units !== "" && !count.ok ? count.error : null}>
          <input inputMode="numeric" autoComplete="off" value={units} onChange={(event) => setUnits(event.target.value)} />
        </Field>
        <Field label="Price per unit" error={price !== "" && !parsed.ok ? parsed.error : null}>
          <span className="input-unit">
            <input inputMode="decimal" autoComplete="off" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00" />
            <span>USDG</span>
          </span>
        </Field>
      </div>
      {input && preview ? (
        <p className="fee-line">
          <strong>{resaleFeeLine(input)}</strong>
          <span className="note">You receive {formatUsdg(preview.proceeds)} USDG if all of it sells.</span>
        </p>
      ) : (
        <p className="note">Fee: {RESALE_RULE}.</p>
      )}
      <button type="submit" className="btn ghost small" disabled={busy || !input}>
        List for resale
      </button>
    </form>
  )
}

function Cancel({ holding }: { holding: Holding }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const [units, setUnits] = useState("1")
  const count = parseCount(units)
  const over = count.ok && count.value > BigInt(holding.balance)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!count.ok || over) return
    void run(`Cancel ${count.value} of Window ${holding.id}`, async (wallet) => {
      await wallet.send("Cancel for a refund", await trpcMutation<Tx>("windows.cancelTx", { id: holding.id, units: count.value.toString() }, token))
    })
  }
  return (
    <form className="row end" onSubmit={submit}>
      <Field label="Cancel units" hint={`Before the start you get back ${CANCEL_RULE}.`} error={over ? "That is more units than you hold." : null}>
        <input inputMode="numeric" autoComplete="off" value={units} onChange={(event) => setUnits(event.target.value)} />
      </Field>
      <button type="submit" className="btn ghost small" disabled={busy || !count.ok || over}>
        Cancel (95%)
      </button>
    </form>
  )
}
