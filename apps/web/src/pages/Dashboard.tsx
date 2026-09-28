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
