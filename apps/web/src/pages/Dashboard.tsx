import { useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Hex } from "viem"
import { Gate, useAuthed, useSession } from "../components/session.tsx"
import { useTx } from "../components/tx.tsx"
import { Data, Empty, Failed, Field, Section, Segmented, Stat, Usdg, useNetwork, useNow } from "../components/ui.tsx"
import { ApiError, Refused, explain, trpcMutation } from "../lib/api.ts"
import { capsState, withdrawAllState } from "../lib/countdown.ts"
import { depositRoom } from "../lib/fees.ts"
import { formatBps, formatUsdg, formatUtc, parseUsdg } from "../lib/format.ts"
import type { Material } from "../lib/recount.ts"
import type { ApiKey, Dispute, PermitPlan, Summary, Tx } from "../lib/types.ts"
import { deployedBook, permitProblem, permitTypes, type Want } from "../lib/wallet-check.ts"
import { Channels } from "./Channels.tsx"
import { Usage } from "./Usage.tsx"

const INDEX = [
  ["funds", "Prepaid credit"],
  ["caps", "Caps"],
  ["usage", "Usage"],
  ["keys", "API keys"],
  ["audit", "Audit sampling"],
  ["disputes", "Disputes"],
  ["channels", "Channels"],
] as const

const REASONS: Record<string, string> = {
  withdraw_requested: "A withdraw-all is pending, so new requests are refused.",
  paused: "Usage is paused across Offpeak. Your balance stays withdrawable.",
  no_balance: "Deposit USDG to start.",
  no_caps: "Set an hourly cap to start. Requests are refused until you do.",
}

export function Dashboard() {
  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <p className="lede">Prepaid USDG stays yours to withdraw. The reserved part can take up to 2 hours.</p>
      </header>
      <Gate what="your balance">
        <Signed />
      </Gate>
    </>
  )
}

function Signed() {
  const summary = useAuthed<Summary>("account.summary", undefined, { refetchInterval: 15_000 })
  const network = useNetwork()
  const [disputing, setDisputing] = useState("")
  const [evidence, setEvidence] = useState<Material | null>(null)
  const dispute = (reqId: string, material?: Material) => {
    setDisputing(reqId)
    setEvidence(material ?? null)
    document.getElementById("disputes")?.scrollIntoView()
  }
  return (
    <div className="book">
      <nav className="book-index" aria-label="Dashboard sections">
        {INDEX.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <div className="book-pages">
        {network.data && !network.data.deployed && (
          <p className="banner" role="status">
            The contracts are not deployed on this network yet. You can look around, but nothing can be sent.
          </p>
        )}
        {network.data?.deployed && network.data.mismatch && (
          <p className="banner" role="alert">
            The router lists different contract addresses from the ones published with this site ({network.data.mismatch}). This page uses the published ones and will not send anything else.
          </p>
        )}
        <Data query={summary} lines={5}>
          {(data) => (
            <>
              <Funds summary={data} />
              <CapsPanel summary={data} />
            </>
          )}
        </Data>
        <Usage onDispute={dispute} />
        <Keys />
        <Data query={summary} lines={2}>
          {(data) => <Audit summary={data} />}
        </Data>
        <Disputes reqId={disputing} setReqId={setDisputing} material={evidence} dropMaterial={() => setEvidence(null)} />
        <Channels />
      </div>
    </div>
  )
}

function Funds({ summary }: { summary: Summary }) {
  const balance = BigInt(summary.balance)
  const reserve = BigInt(summary.reserve)
  const reservedBps = balance > 0n ? Number((reserve * 10_000n) / balance) : 0
  const [panel, setPanel] = useState<"deposit" | "withdraw" | "all">("deposit")
  const pending = BigInt(summary.withdrawRequestedAt) !== 0n
  return (
    <Section id="funds" title="Prepaid credit">
      <p className="note">
        Your balance is prepaid credit for Offpeak. See the <a href="/terms">terms</a>.
      </p>
      <div className="stats">
        <Stat label="Balance">
          <Usdg micro={summary.balance} />
        </Stat>
        <Stat label="Reserve" note="Held for hours that have not settled.">
          <Usdg micro={summary.reserve} />
        </Stat>
        <Stat label="Withdrawable now">
          <Usdg micro={summary.withdrawable} />
        </Stat>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${reservedBps / 100}%` }} />
      </div>
      {!summary.servable && summary.reason && <p className="banner">{REASONS[summary.reason]}</p>}
      {pending ? (
        <WithdrawAll summary={summary} />
      ) : (
        <>
          <Segmented
            label="Funds action"
            value={panel}
            onChange={setPanel}
            options={[
              { value: "deposit", label: "Deposit" },
              { value: "withdraw", label: "Withdraw" },
              { value: "all", label: "Withdraw all" },
            ]}
          />
          {panel === "deposit" && <Deposit summary={summary} />}
          {panel === "withdraw" && <Withdraw summary={summary} />}
          {panel === "all" && <WithdrawAll summary={summary} />}
        </>
      )}
    </Section>
  )
}

function Deposit({ summary }: { summary: Summary }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const [text, setText] = useState("")
  const [mode, setMode] = useState<"approve" | "permit2">("approve")
  const parsed = parseUsdg(text)
  const room = depositRoom(BigInt(summary.balance), summary.betaCap ? BigInt(summary.betaCap) : null)
  const error = text === "" ? null : !parsed.ok ? parsed.error : parsed.micro === 0n ? "Enter more than zero." : room !== null && parsed.micro > room ? `The beta cap leaves room for ${formatUsdg(room)} USDG.` : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!parsed.ok || error) return
    const amount = parsed.micro.toString()
    void run(`Deposit ${formatUsdg(parsed.micro)} USDG`, async (wallet) => {
      const plan = await trpcMutation<PermitPlan>("account.depositPlan", { amount, mode }, token)
      await wallet.approve(plan.approval, { spender: mode === "approve" ? deployedBook.vault : deployedBook.permit2, amount: parsed.micro })
      if (plan.tx) return wallet.send("Deposit into the vault", plan.tx, { fn: "deposit", args: [parsed.micro] })
      const permit = plan.permit!
      const refused = permitProblem(permit, deployedBook, parsed.micro, Math.floor(Date.now() / 1000))
      if (refused) throw new Refused(refused)
      const message = { ...permit.message, permitted: { ...permit.message.permitted, amount: BigInt(permit.message.permitted.amount) }, nonce: BigInt(permit.message.nonce), deadline: BigInt(permit.message.deadline) }
      const sig = await wallet.sign("Sign the Permit2 transfer", () => wallet.client.signTypedData({ domain: permit.domain, types: permitTypes, primaryType: "PermitTransferFrom", message } as never))
      await wallet.send("Deposit into the vault", await trpcMutation<Tx>("account.depositPermit2Tx", { amount, nonce: permit.message.nonce, deadline: permit.message.deadline, sig }, token), { fn: "depositWithPermit2" })
    }).then((ok) => ok && setText(""))
  }
  return (
    <form className="panel" onSubmit={submit}>
      <Field label="Amount" error={error} hint={room !== null ? `During the beta, deposits are capped at 500 USDG per buyer until the external contract audit is complete. Room left: ${formatUsdg(room)} USDG.` : undefined}>
        <span className="input-unit">
          <input inputMode="decimal" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} placeholder="0.00" />
          <span>USDG</span>
        </span>
      </Field>
      <Segmented
        label="Approval method"
        value={mode}
        onChange={setMode}
        options={[
          { value: "approve", label: "Approve" },
          { value: "permit2", label: "Permit2" },
        ]}
      />
      <p className="note">{mode === "approve" ? "Two transactions: approve the vault for this amount, then deposit." : "Approve Permit2 once for this amount, sign a transfer, then deposit. Permit2 is a shared dependency."}</p>
      <button type="submit" className="btn" disabled={busy || !parsed.ok || Boolean(error)}>
        Deposit
      </button>
    </form>
  )
}

function Withdraw({ summary }: { summary: Summary }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const [text, setText] = useState("")
  const parsed = parseUsdg(text)
  const most = BigInt(summary.withdrawable)
  const error = text === "" ? null : !parsed.ok ? parsed.error : parsed.micro === 0n ? "Enter more than zero." : parsed.micro > most ? `You can withdraw ${formatUsdg(most)} USDG now.` : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!parsed.ok || error) return
    void run(`Withdraw ${formatUsdg(parsed.micro)} USDG`, async (wallet) => {
      await wallet.send("Withdraw from the vault", await trpcMutation<Tx>("account.withdrawTx", { amount: parsed.micro.toString() }, token), { fn: "withdraw", args: [parsed.micro] })
    }).then((ok) => ok && setText(""))
  }
  return (
    <form className="panel" onSubmit={submit}>
      <Field label="Amount" error={error} hint={`Up to ${formatUsdg(most)} USDG now.`}>
        <span className="input-unit">
          <input inputMode="decimal" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} placeholder="0.00" />
          <button type="button" className="copy" onClick={() => setText(formatUsdg(most).replaceAll(",", ""))}>
            max
          </button>
        </span>
      </Field>
      <button type="submit" className="btn" disabled={busy || !parsed.ok || Boolean(error)}>
        Withdraw
      </button>
    </form>
  )
}

function WithdrawAll({ summary }: { summary: Summary }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const now = useNow(summary.serverTime)
  const state = withdrawAllState({ requestedAt: summary.withdrawRequestedAt, dueAt: summary.withdrawDueAt, lastSettledHour: summary.lastSettledHour, now })
  const act = (title: string, label: string, path: string, want: Want) => run(title, async (wallet) => wallet.send(label, await trpcMutation<Tx>(path, undefined, token), want))
  if (state.phase === "none") {
    return (
      <div className="panel">
        <p className="note">Serving stops within a second of the request. The full balance, reserve included, can leave once the hour settles, and no later than 2 hours after the request.</p>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void act("Withdraw all", "Request withdraw-all", "account.requestWithdrawAllTx", { fn: "requestWithdrawAll" })}>
          Request withdraw-all
        </button>
      </div>
    )
  }
  return (
    <div className="panel countdown">
      {state.phase === "waiting" ? (
        <>
          <span className="stat-label">Guaranteed by {formatUtc(state.dueAt)}</span>
          <strong role="timer">{state.label}</strong>
          <div className="meter gold" aria-hidden="true">
            <span style={{ width: `${state.elapsedBps / 100}%` }} />
          </div>
          <p className="note">Requests are refused while this runs. It can finish sooner, once the hour of the request settles.</p>
        </>
      ) : (
        <>
          <strong>Ready</strong>
          <p className="note">{state.reason === "settled" ? "The hour of your request has settled." : "The 2-hour guarantee has passed."} Anyone can now send the balance to your wallet, and a keeper usually does.</p>
        </>
      )}
      <div className="row">
        {state.phase === "ready" && (
          <button type="button" className="btn" disabled={busy} onClick={() => void act("Finish withdraw-all", "Send the balance to your wallet", "account.executeWithdrawAllTx", { fn: "executeWithdrawAll", args: [summary.wallet] })}>
            Finish withdraw-all
          </button>
        )}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void act("Cancel withdraw-all", "Cancel the request", "account.cancelWithdrawAllTx", { fn: "cancelWithdrawAll" })}>
          Cancel and keep serving
        </button>
      </div>
    </div>
  )
}

function CapsPanel({ summary }: { summary: Summary }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const caps = capsState(summary)
  const [hourly, setHourly] = useState("")
  const [daily, setDaily] = useState("")
  const parsedHourly = parseUsdg(hourly)
  const parsedDaily = parseUsdg(daily || "0")
  const error = hourly === "" ? null : !parsedHourly.ok ? parsedHourly.error : null
  const dailyError = daily !== "" && !parsedDaily.ok ? parsedDaily.error : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!parsedHourly.ok || !parsedDaily.ok) return
    const input = { hourlyCap: parsedHourly.micro.toString(), dailyCap: parsedDaily.micro.toString() }
    void run("Set caps", async (wallet) => wallet.send("Set hourly and daily caps", await trpcMutation<Tx>("account.setCapsTx", input, token), { fn: "setCaps", args: [parsedHourly.micro, parsedDaily.micro] })).then((ok) => {
      if (!ok) return
      setHourly("")
      setDaily("")
    })
  }
  return (
    <Section id="caps" title="Caps">
      <div className="stats two">
        <Stat label="Hourly" note={caps.pendingHourly !== null ? `Falling to ${formatUsdg(caps.pendingHourly)} USDG` : undefined}>
          <Usdg micro={caps.hourly} />
        </Stat>
        <Stat label="Daily" note={caps.pendingDaily !== null ? `Falling to ${formatUsdg(caps.pendingDaily)} USDG` : undefined}>
          <Usdg micro={caps.daily} />
        </Stat>
      </div>
      <p className="note">Lower caps apply after the next settled hour. Offpeak serves you at the lower cap straight away; the reserve falls once that hour settles. Higher caps apply at once.</p>
      <form className="panel" onSubmit={submit}>
        <div className="fields">
          <Field label="New hourly cap" error={error}>
            <span className="input-unit">
              <input inputMode="decimal" autoComplete="off" value={hourly} onChange={(event) => setHourly(event.target.value)} placeholder="0.00" />
              <span>USDG</span>
            </span>
          </Field>
          <Field label="New daily cap" error={dailyError} hint="Blank means four times the hourly cap.">
            <span className="input-unit">
              <input inputMode="decimal" autoComplete="off" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="0.00" />
              <span>USDG</span>
            </span>
          </Field>
        </div>
        <button type="submit" className="btn ghost" disabled={busy || !parsedHourly.ok || !parsedDaily.ok}>
          Set caps
        </button>
      </form>
    </Section>
  )
}

function Keys() {
  const { token } = useSession()
  const keys = useAuthed<ApiKey[]>("keys.list")
  const client = useQueryClient()
  const [label, setLabel] = useState("")
  const [shown, setShown] = useState<{ token: string; label: string } | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const create = async (event: FormEvent) => {
    event.preventDefault()
    setFailure(null)
    try {
      setShown(await trpcMutation<{ token: string; label: string }>("keys.create", { label: label.trim() }, token))
      setLabel("")
      await client.invalidateQueries({ queryKey: ["keys.list"] })
    } catch (error) {
      setFailure(error)
    }
  }
  const revoke = async (key: ApiKey) => {
    if (!confirm(`Revoke "${key.label}"? Requests with it stop within seconds.`)) return
    setFailure(null)
    try {
      await trpcMutation("keys.revoke", { id: key.id }, token)
      await client.invalidateQueries({ queryKey: ["keys.list"] })
    } catch (error) {
      setFailure(error)
    }
  }
  return (
    <Section id="keys" title="API keys">
      {shown && (
        <div className="reveal" role="status">
          <p>
            <strong>{shown.label}</strong>: copy this now. It is stored only as a hash and will not be shown again.
          </p>
          <code>{shown.token}</code>
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(shown.token)}>
              Copy
            </button>
            <button type="button" className="btn ghost" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <Data query={keys} lines={2}>
        {(rows) =>
          rows.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Created</th>
                  <th className="num">Rate limit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => (
                  <tr key={key.id}>
                    <td data-label="Label">{key.label}</td>
                    <td data-label="Created">{formatUtc(key.createdAt)}</td>
                    <td data-label="Rate limit" className="num">
                      {key.rpm} rpm
                    </td>
                    <td className="act">
                      <button type="button" className="btn ghost small" onClick={() => void revoke(key)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No API keys yet.">A key lets your code spend from this balance, up to your caps.</Empty>
          )
        }
      </Data>
      <form className="row end" onSubmit={(event) => void create(event)}>
        <Field label="New key label">
          <input value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} placeholder="build box" />
        </Field>
        <button type="submit" className="btn ghost" disabled={label.trim() === ""}>
          Make a key
        </button>
      </form>
      {failure !== null && <Failed error={failure} />}
    </Section>
  )
}

function Audit({ summary }: { summary: Summary }) {
  const { token } = useSession()
  const client = useQueryClient()
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const flip = async (optIn: boolean) => {
    setBusy(true)
    setFailure(null)
    try {
      await trpcMutation("account.setAuditOptIn", { optIn }, token)
      await client.invalidateQueries({ queryKey: ["account.summary"] })
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section id="audit" title="Audit sampling">
      <label className="toggle">
        <input type="checkbox" checked={summary.auditOptIn} disabled={busy} onChange={(event) => void flip(event.target.checked)} />
        <span>
          <strong>Opt in for 1% off.</strong> Your fee is {formatBps(summary.feeBps)} of the host cost now.
        </span>
      </label>
      <p className="note">A random 2% of your requests keep the prompt and output, encrypted, so audits can test that hosts serve the model they claim. Audit sampling stores request bodies for up to 72 hours, only if you opt in. Requests already sampled stay until those 72 hours end.</p>
      {failure !== null && <Failed error={failure} />}
    </Section>
  )
}

function Disputes({ reqId, setReqId, material, dropMaterial }: { reqId: string; setReqId: (reqId: string) => void; material: Material | null; dropMaterial: () => void }) {
  const { token } = useSession()
  const disputes = useAuthed<Dispute[]>("disputes.list")
  const client = useQueryClient()
  const [reason, setReason] = useState("")
  const [failure, setFailure] = useState<string | null>(null)
  const valid = /^0x[0-9a-fA-F]{64}$/.test(reqId.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFailure(null)
    try {
      await trpcMutation("disputes.open", { reqIds: [reqId.trim() as Hex], reason: reason.trim(), ...(material ? { material } : {}) }, token)
      setReqId("")
      setReason("")
      dropMaterial()
      await client.invalidateQueries({ queryKey: ["disputes.list"] })
    } catch (error) {
      setFailure(error instanceof ApiError ? explain(error) : "That did not go through.")
    }
  }
  return (
    <Section id="disputes" title="Disputes">
      <p className="note">Dispute any request within 7 days. Automatic checks recount tokens and verify signatures and the price against the sheet. Upheld disputes are refunded to your vault balance. You get a reply within 72 hours.</p>
      <Data query={disputes} lines={2}>
        {(rows) =>
          rows.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Dispute</th>
                  <th>Requests</th>
                  <th>Reason</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Dispute">{row.id}</td>
                    <td data-label="Requests">{row.reqIds.length}</td>
                    <td data-label="Reason">{row.reason}</td>
                    <td data-label="Status">
                      <span className="pill wait">{row.outcome ?? "In review"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No disputes." />
          )
        }
      </Data>
      <form className="panel" onSubmit={(event) => void submit(event)}>
        <div className="fields">
          <Field label="Request id" hint="Open a record under Usage and choose Dispute, or paste its id." error={reqId !== "" && !valid ? "A request id is 0x and 64 hex characters." : null}>
            <input value={reqId} autoComplete="off" onChange={(event) => setReqId(event.target.value)} placeholder="0x…" />
          </Field>
          <Field label="What looks wrong">
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Token count looks high" />
          </Field>
        </div>
        {material && (
          <p className="note">
            Your request body and output go with this dispute, so the router can recount it.{" "}
            <button type="button" className="btn ghost small" onClick={dropMaterial}>
              Leave them out
            </button>
          </p>
        )}
        <button type="submit" className="btn ghost" disabled={!valid || reason.trim() === ""}>
          Open dispute
        </button>
        {failure && <p className="field-error">{failure}</p>}
      </form>
    </Section>
  )
}

