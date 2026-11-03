import { useState, type FormEvent } from "react"
import { Gate } from "../components/session.tsx"
import { usePlan } from "../components/tx.tsx"
import { Field, Section, Usdg } from "../components/ui.tsx"
import { parseUsdg } from "../lib/format.ts"
export function WindowCreate() {
  const { go, busy } = usePlan(),
    [digest, setDigest] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [units, setUnits] = useState("1"),
    [speed, setSpeed] = useState("100"),
    [high, setHigh] = useState("1.00"),
    [low, setLow] = useState("0.50"),
    [error, setError] = useState("")
  const a = parseUsdg(high),
    b = parseUsdg(low),
    n = /^[1-9]\d{0,6}$/.test(units) ? BigInt(units) : 0n,
    collateral = a.ok ? (n * a.micro * 2000n + 9999n) / 10000n : 0n
  function submit(e: FormEvent) {
    e.preventDefault()
    setError("")
    const t0 = Date.parse(start + "Z") / 1000,
      t1 = Date.parse(end + "Z") / 1000
    if (
      !a.ok ||
      !b.ok ||
      !n ||
      !/^0x[0-9a-fA-F]{64}$/.test(digest) ||
      !Number.isSafeInteger(t0) ||
      !Number.isSafeInteger(t1) ||
      !Number.isSafeInteger(Number(speed))
    ) {
      setError("Check the model digest, UTC times, units and prices.")
      return
    }
    void go("Create a capacity Window", "Approve collateral and publish this auction", "windows.createPlan", {
      modelDigest: digest,
      t0,
      t1,
      minTps: Number(speed),
      units,
      startPricePerUnit: a.micro.toString(),
      endPricePerUnit: b.micro.toString(),
      auctionStart: Math.floor(Date.now() / 1000),
      auctionEnd: t0,
    })
  }
  return (
    <Section title="Offer your capacity">
      <Gate what="the Window creation form">
        <p className="note">
          For registered GPU hosts. Reserve up to 70% of capacity; collateral is 20% of units × starting price. Existing reservations are
          checked by the contract before a transaction is sent.
        </p>
        <form className="window-create" onSubmit={submit}>
          <Field label="Your served model digest">
            <input value={digest} onChange={(e) => setDigest(e.target.value)} placeholder="0x…" />
          </Field>
          <div className="row">
            <Field label="Starts (UTC, whole hour)">
              <input type="datetime-local" step="3600" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Ends (UTC, whole hour)">
              <input type="datetime-local" step="3600" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <Field label="Units (1M tokens each)">
              <input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Minimum tokens/second">
              <input value={speed} onChange={(e) => setSpeed(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          <div className="row">
            <Field label="Auction start price, USDG/unit">
              <input value={high} onChange={(e) => setHigh(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Auction end price, USDG/unit">
              <input value={low} onChange={(e) => setLow(e.target.value)} inputMode="decimal" />
            </Field>
          </div>
          <p>
            Collateral: <Usdg micro={collateral} />
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn" disabled={busy || !a.ok || !b.ok || n === 0n}>
            Review in wallet
          </button>
        </form>
      </Gate>
    </Section>
  )
}
