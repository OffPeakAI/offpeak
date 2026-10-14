import { useMemo, useState, type FormEvent } from "react"
import { useQueries } from "@tanstack/react-query"
import type { Hex } from "viem"
import { useAuthed, useSession } from "../components/session.tsx"
import { Mutate, usePlan, useTx } from "../components/tx.tsx"
import { Data, Empty, Field, Flagged, Mono, Section, Usdg, useNetwork, useNow } from "../components/ui.tsx"
import { ApiError, Refused, rest, trpcMutation, trpcQuery } from "../lib/api.ts"
import { formatDuration, formatUsdg, formatUtc, parseUsdg } from "../lib/format.ts"
import { CHANNEL_STATUS } from "../lib/labels.ts"
import { rememberChannel, rememberedChannels } from "../lib/session.ts"
import { CHANNEL_MIN_LIFETIME_S, coopCloseTypes, domain } from "../lib/shared.ts"
import type { Channel, Plan, Tx } from "../lib/types.ts"
import { closeCallError, deployedBook, finalAmountProblem } from "../lib/wallet-check.ts"

const CLOSE_TTL_S = 900

// The contract refuses a final amount below what is already claimed.
const finalOwed = (row: Channel) => (BigInt(row.owed) > BigInt(row.claimed) ? BigInt(row.owed) : BigInt(row.claimed))

export function Channels() {
  return (
    <Section id="channels" title="Channels">
      <Flagged flag="channels" name="Channels">
        <ChannelList />
      </Flagged>
    </Section>
  )
}

function useChannels() {
  const { wallet, token } = useSession()
  const listed = useAuthed<Channel[]>("channels.list", undefined, { refetchInterval: 30_000 })
  const local = useMemo(() => (wallet ? rememberedChannels(wallet) : []), [wallet, listed.dataUpdatedAt])
  const missing = local.filter((id) => !listed.data?.some((row) => row.id === id))
  const extra = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["channels.get", id, token],
      queryFn: () => trpcQuery<Channel>("channels.get", { id }, token).catch((error) => (error instanceof ApiError && error.status === 404 ? null : Promise.reject(error))),
    })),
  })
  const rows = [...(listed.data ?? []), ...extra.flatMap((query) => (query.data ? [query.data] : []))]
  return { listed, rows }
}

function ChannelList() {
  const { listed, rows } = useChannels()
  const now = useNow()
  return (
    <>
      <p className="note">Agents pay per call from a channel with no on-chain transaction per request. Owed is the running total the router has served, claimed or not. Closing sends the rest of your deposit back to your wallet.</p>
      <Data query={listed} lines={2}>
        {() =>
          rows.length > 0 ? (
            <ul className="channels">
              {rows.map((row) => (
                <ChannelRow key={row.id} row={row} now={now} />
              ))}
            </ul>
          ) : (
            <Empty title="No channels yet.">Open one below, or let the SDK open one for your agent.</Empty>
          )
        }
      </Data>
      <OpenChannel />
    </>
  )
}

function ChannelRow({ row, now }: { row: Channel; now: number }) {
  const { go, busy } = usePlan()
  const [topUp, setTopUp] = useState("")
  const parsed = parseUsdg(topUp)
  const status = CHANNEL_STATUS[row.status] ?? "Unknown"
  const left = BigInt(row.deposit) - finalOwed(row)
  const endsAt = Number(row.challengeEndsAt)
  const closing = row.status === 2
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!parsed.ok || parsed.micro === 0n) return
    void go(`Top up ${formatUsdg(parsed.micro)} USDG`, "Top up the channel", "channels.topUpPlan", { id: row.id, amount: parsed.micro.toString() }, { spender: deployedBook.channelManager, amount: parsed.micro, call: { fn: "topUp", args: [row.id, parsed.micro] } }).then((ok) => ok && setTopUp(""))
  }
  return (
    <li className="channel">
      <header>
        <Mono value={row.id} />
        <span className={row.status === 1 ? "pill ok" : "pill wait"}>{status}</span>
      </header>
      <dl className="facts wide">
        <dt>Deposit</dt>
        <dd>
          <Usdg micro={row.deposit} />
        </dd>
        <dt>Owed</dt>
        <dd>
          <Usdg micro={row.owed} />
        </dd>
        <dt>Vouchered</dt>
        <dd>
          <Usdg micro={row.cumulative} />
        </dd>
        <dt>Claimed</dt>
        <dd>
          <Usdg micro={row.claimed} />
        </dd>
        <dt>Left</dt>
        <dd>
          <Usdg micro={left > 0n ? left : 0n} />
        </dd>
        <dt>Expires</dt>
        <dd>{formatUtc(Number(row.expiry))}</dd>
        {closing && (
          <>
            <dt>Challenge ends</dt>
            <dd>{endsAt > now ? `in ${formatDuration(endsAt - now)}` : "Over"}</dd>
          </>
        )}
      </dl>
      {row.status === 1 && (
        <div className="row end">
          <form className="row end grow" onSubmit={add}>
            <Field label="Top up">
              <span className="input-unit">
                <input inputMode="decimal" autoComplete="off" value={topUp} onChange={(event) => setTopUp(event.target.value)} placeholder="0.00" />
                <span>USDG</span>
              </span>
            </Field>
            <button type="submit" className="btn ghost small" disabled={busy || !parsed.ok || parsed.micro === 0n}>
              Top up
            </button>
          </form>
          <CooperativeClose row={row} />
          <Mutate path="channels.requestCloseTx" title="Ask to close (2-hour challenge)" label="Close without the router" input={{ id: row.id }} want={{ fn: "requestClose", args: [row.id] }} />
        </div>
      )}
      {closing && endsAt <= now && (
        <div className="row">
          <CooperativeClose row={row} />
          <Mutate path="channels.finalizeCloseTx" title="Finish closing" label="Finish closing" input={{ id: row.id }} kind="" want={{ fn: "finalizeClose", args: [row.id] }} />
        </div>
      )}
      {closing && endsAt > now && <p className="note">The keeper can land the latest voucher during this 2-hour challenge period. After it, anyone can finish the close.</p>}
    </li>
  )
}

/** Both parties sign the final amount, so the deposit comes back at once instead of after 2 hours. */
function CooperativeClose({ row }: { row: Channel }) {
  const { run, busy } = useTx()
  const network = useNetwork()
  const close = () =>
    void run("Close channel now", async (wallet) => {
      const channelManager = deployedBook.channelManager
      const finalCumulative = finalOwed(row).toString()
      const refused = finalAmountProblem(finalOwed(row), BigInt(row.deposit))
      if (refused) throw new Refused(refused)
      const deadline = (Math.floor(Date.now() / 1000) + CLOSE_TTL_S).toString()
      const payerSig = await wallet.sign("Sign the final amount", () =>
        wallet.client.signTypedData({
          domain: domain("OffpeakChannel", channelManager),
          types: coopCloseTypes,
          primaryType: "CooperativeClose",
          message: { channelId: row.id, finalCumulative: BigInt(finalCumulative), deadline: BigInt(deadline) },
        }),
      )
      const reply = await rest<Tx & { routerSig: Hex }>(`/v1/channels/${row.id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finalCumulative, deadline, payerSig }),
      }).catch((error) => {
        throw error instanceof ApiError && error.status === 404 ? new ApiError("close_unavailable", 404, "close_unavailable") : error
      })
      const wrong = closeCallError(reply, deployedBook, { id: row.id, finalCumulative: BigInt(finalCumulative), deadline: BigInt(deadline), payerSig })
      if (wrong) throw new Refused(wrong)
      await wallet.send("Close the channel", { to: reply.to, data: reply.data, value: "0", chainId: reply.chainId }, { fn: "cooperativeClose" })
    })
  return (
    <button type="button" className="btn small" disabled={busy || !network.data} onClick={close}>
      Close now
    </button>
  )
}

function OpenChannel() {
  const { token, wallet: me } = useSession()
  const { run, busy } = useTx()
  const [deposit, setDeposit] = useState("")
  const [hours, setHours] = useState("24")
  const parsed = parseUsdg(deposit)
  const hoursValue = /^\d{1,5}$/.test(hours) ? Number(hours) : 0
  const tooShort = hoursValue * 3_600 < CHANNEL_MIN_LIFETIME_S
  const tooSmall = parsed.ok && parsed.micro < 1_000_000n
  const open = (event: FormEvent) => {
    event.preventDefault()
    if (!parsed.ok || tooShort || tooSmall) return
    void run(`Open a ${formatUsdg(parsed.micro)} USDG channel`, async (wallet) => {
      const plan = await trpcMutation<Plan & { channelId: Hex }>("channels.openPlan", { deposit: parsed.micro.toString(), lifetimeSeconds: hoursValue * 3_600 }, token)
      await wallet.approve(plan.approval, { spender: deployedBook.channelManager, amount: parsed.micro })
      await wallet.send("Open the channel", plan.tx, { fn: "open", args: [parsed.micro] })
      if (me) rememberChannel(me, plan.channelId)
    }).then((ok) => ok && setDeposit(""))
  }
  return (
    <form className="panel" onSubmit={open}>
      <div className="fields">
        <Field label="Deposit" hint="At least 1 USDG." error={deposit !== "" && !parsed.ok ? parsed.error : tooSmall ? "A channel needs at least 1 USDG." : null}>
          <span className="input-unit">
            <input inputMode="decimal" autoComplete="off" value={deposit} onChange={(event) => setDeposit(event.target.value)} placeholder="0.00" />
            <span>USDG</span>
          </span>
        </Field>
        <Field label="Lifetime" hint="At least 6 hours. The router stops 2 hours before expiry." error={tooShort ? "At least 6 hours." : null}>
          <span className="input-unit">
            <input inputMode="numeric" autoComplete="off" value={hours} onChange={(event) => setHours(event.target.value)} />
            <span>hours</span>
          </span>
        </Field>
      </div>
      <button type="submit" className="btn ghost" disabled={busy || !parsed.ok || tooShort || tooSmall}>
        Open channel
      </button>
    </form>
  )
}
