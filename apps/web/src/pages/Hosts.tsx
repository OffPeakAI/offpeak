import { useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Hex } from "viem"
import { Gate, useAuthed, useSession } from "../components/session.tsx"
import { Mutate, useTx } from "../components/tx.tsx"
import { Data, Empty, Field, Mono, Section, Stat, Usdg, useNow } from "../components/ui.tsx"
import { rest, trpcMutation } from "../lib/api.ts"
import { formatDuration, formatTokens, formatUsdg, formatUtc, parseUsdg } from "../lib/format.ts"
import { CHALLENGE_STATE, EVIDENCE_KIND, HOST_STATUS } from "../lib/labels.ts"
import { DEV_ONLY_GPU_CLASS, GPU_CLASSES, HOST_MIN_BOND } from "../lib/shared.ts"
import type { Challenge, HostMe, ModelRow, Payouts, Plan, Tx } from "../lib/types.ts"

const GUIDE = [
  ["Prepare the machine", "Run vLLM from the pinned image by digest, with the approved recipe for each model. The host agent runs beside it, and your operator key never leaves that machine."],
  ["Put TLS in front", "The agent speaks plain HTTP on loopback. Your endpoint must be https, served by a TLS proxy on the same machine that forwards to the agent. docs/runbooks/deploy-host.md lists what the proxy must do."],
  ["Verify it", "offpeak-host init writes host.yaml. offpeak-host verify hashes every model file, checks the GPU class and checks the image digest. It refuses to start on any mismatch."],
  ["Register and bond", "Use the helper below, or offpeak-host register. The bond is at least 2,000 USDG, or 20% of your trailing 30-day credits if that is higher. The bond is slashable."],
  ["Probation", "New hosts serve canary traffic only, for 72 hours. Then anyone can activate the host."],
  ["Post a price sheet", "offpeak-host price-sheet set --file sheet.json signs a price for each of the 168 hours of the week. Your floor can be at most 60% of your lowest base price. Changes apply from one hour ahead."],
  ["Serve and get paid", "Credits are clawable for 24 hours, then releasable here. Audits are statistical and run all the time; a challenge gives you 24 hours to respond."],
] as const

export function Hosts() {
  return (
    <>
      <header className="page-head">
        <h1>Hosts</h1>
        <p className="lede">Post a bond, pin the image digest, and publish a price for every hour of the week. New hosts serve canaries only for 72 hours.</p>
      </header>
      <Section title="Onboarding guide">
        <ol className="guide">
          {GUIDE.map(([title, body]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{body}</span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Your host">
        <Gate what="your host">
          <HostPanel />
        </Gate>
      </Section>
    </>
  )
}

function HostPanel() {
  const me = useAuthed<HostMe>("hosts.me", undefined, { refetchInterval: 30_000 })
  return (
    <Data query={me} lines={4}>
      {(data) =>
        data.host ? (
          <>
            <Standing me={data} />
            <PayoutsPanel />
            <Challenges />
          </>
        ) : (
          <>
            <Empty title="This wallet has no host registered.">Fill in the helper to prepare the registration transaction.</Empty>
            <Register />
          </>
        )
      }
    </Data>
  )
}

function Standing({ me }: { me: HostMe }) {
  const now = useNow(me.serverTime)
  const host = me.host!
  const ends = Number(host.probationEnds)
  const probation = host.status === 1
  return (
    <>
      <div className="stats">
        <Stat label="Status" note={host.routable ? "Receiving traffic" : "Not routable"}>
          {HOST_STATUS[host.status] ?? "Unknown"}
        </Stat>
        <Stat label="Bond" note={`Required: ${formatUsdg(host.requiredBond)} USDG`}>
          <Usdg micro={host.bondUsdg} />
        </Stat>
        <Stat label="Strikes" note={`${host.openChallenges} open challenges`}>
          {host.strikes}
        </Stat>
      </div>
      {probation && (ends > now ? <p className="note">Probation ends in {formatDuration(ends - now)}. Canary traffic only until then.</p> : <Mutate path="hosts.activateTx" title="Activate host" label="Activate" kind="" />)}
    </>
  )
}

function PayoutsPanel() {
  const payouts = useAuthed<Payouts>("hosts.payouts", undefined, { refetchInterval: 30_000 })
  return (
    <Section title="Payouts">
      <Data query={payouts} lines={3}>
        {(data) => (
          <>
            <div className="stats two">
              <Stat label="Releasable">
                <Usdg micro={data.releasable} />
              </Stat>
              <Stat label="Pending" note="Clawable for 24 hours after the hour settles.">
                <Usdg micro={data.pending} />
              </Stat>
            </div>
            {BigInt(data.releasable) > 0n && <Mutate path="hosts.withdrawCreditsTx" title="Withdraw credits" label="Withdraw credits" kind="" />}
            {data.served.length > 0 ? (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Hour starting</th>
                    <th className="num">Tokens served</th>
                    <th className="num">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {data.served.map((row) => (
                    <tr key={row.hour}>
                      <td data-label="Hour starting">{formatUtc(row.hour * 3_600)}</td>
                      <td data-label="Tokens served" className="num">
                        {formatTokens(row.tokens)}
                      </td>
                      <td data-label="Records" className="num">
                        {row.records}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="Nothing served in the last 48 hours." />
            )}
          </>
        )}
      </Data>
    </Section>
  )
}

function Challenges() {
  const list = useAuthed<{ serverTime: number; challenges: Challenge[] }>("hosts.challenges", undefined, { refetchInterval: 30_000 })
  return (
    <Section title="Challenges and responses">
      <Data query={list} lines={2}>
        {(data) =>
          data.challenges.length > 0 ? (
            <ul className="channels">
              {data.challenges.map((row) => (
                <ChallengeRow key={row.id} row={row} serverTime={data.serverTime} />
              ))}
            </ul>
          ) : (
            <Empty title="No challenges against this host." />
          )
        }
      </Data>
    </Section>
  )
}

function ChallengeRow({ row, serverTime }: { row: Challenge; serverTime: number }) {
  const { token } = useSession()
  const { run, busy } = useTx()
  const now = useNow(serverTime)
  const [text, setText] = useState("")
  const open = row.state === 1 && now <= row.respondBy
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(`Respond to challenge ${row.id}`, async (wallet) => {
      const plan = await trpcMutation<{ tx: Tx; responseHash: Hex }>("hosts.respondTx", { challengeId: row.id, response: text.trim() }, token)
      await wallet.send("Commit your response", plan.tx)
    })
  }
  return (
    <li className="channel">
      <header>
        <strong>
          Challenge {row.id}: {EVIDENCE_KIND[row.kind] ?? "Unknown"}
        </strong>
        <span className="pill wait">{CHALLENGE_STATE[row.state] ?? "Unknown"}</span>
      </header>
      <p className="note">{open ? `Respond within ${formatDuration(row.respondBy - now)}.` : `Filed ${formatUtc(row.filedAt)}.`}</p>
      {open && (
        <form className="panel" onSubmit={submit}>
          <Field label="Your response" hint="Keep this document. Only its hash goes on chain.">
            <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
          <button type="submit" className="btn small" disabled={busy || text.trim() === ""}>
            Commit response
          </button>
        </form>
      )}
    </li>
  )
}

const DIGEST = /^0x[0-9a-fA-F]{64}$/

function Register() {
  const { token, wallet: operator } = useSession()
  const { run, busy } = useTx()
  const models = useQuery({ queryKey: ["models"], queryFn: () => rest<{ data: ModelRow[] }>("/v1/models"), staleTime: 60_000 })
  const [endpoint, setEndpoint] = useState("")
  const [digest, setDigest] = useState("")
  const [maxTps, setMaxTps] = useState("100")
  const [imageDigest, setImageDigest] = useState("")
  const [gpuClass, setGpuClass] = useState<string>("h100-80g-sxm")
  const [bond, setBond] = useState(formatUsdg(HOST_MIN_BOND).replaceAll(",", ""))
  const parsedBond = parseUsdg(bond)
  const tps = /^[1-9]\d{0,8}$/.test(maxTps) ? Number(maxTps) : 0
  const urlOk = /^https?:\/\/\S+$/.test(endpoint)
  const belowMin = parsedBond.ok && parsedBond.micro < HOST_MIN_BOND
  const ready = urlOk && DIGEST.test(digest) && DIGEST.test(imageDigest) && tps > 0 && parsedBond.ok && !belowMin
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || !parsedBond.ok || !operator) return
    const bondUsdg = parsedBond.micro.toString()
    void run("Register host", async (wallet) => {
      // Keys sort the same way as the router's canonical JSON.
      const message = JSON.stringify({ endpoint, operator })
      const sig = await wallet.sign("Sign the endpoint", () => wallet.client.signMessage({ message }))
      const plan = await trpcMutation<Plan>("hosts.registerPlan", { endpoint, models: [{ digest, maxTps: tps }], imageDigest, gpuClass, bondUsdg, sig }, token)
      await wallet.approve(plan.approval)
      await wallet.send("Register and post the bond", plan.tx)
    })
  }
  return (
    <form className="panel" onSubmit={submit}>
      <h3>Registration helper</h3>
      <p className="note">This prepares calldata for your wallet. Offpeak does not send the transaction for you.</p>
      <div className="fields">
        <Field label="Public endpoint" error={endpoint !== "" && !urlOk ? "Use a full https URL." : null}>
          <input value={endpoint} autoComplete="off" onChange={(event) => setEndpoint(event.target.value)} placeholder="https://gpu.example" />
        </Field>
        <Field label="GPU class">
          <select value={gpuClass} onChange={(event) => setGpuClass(event.target.value)}>
            {GPU_CLASSES.filter((name) => name !== DEV_ONLY_GPU_CLASS).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model digest" hint="From offpeak-host verify." error={digest !== "" && !DIGEST.test(digest) ? "0x and 64 hex characters." : null}>
          <input value={digest} list="model-digests" autoComplete="off" onChange={(event) => setDigest(event.target.value)} placeholder="0x…" />
          <datalist id="model-digests">
            {models.data?.data.map((row) => (
              <option key={row.id} value={row.offpeak.digest}>
                {row.id}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Max tokens per second" error={maxTps !== "" && tps === 0 ? "Enter a whole number." : null}>
          <input inputMode="numeric" value={maxTps} autoComplete="off" onChange={(event) => setMaxTps(event.target.value)} />
        </Field>
        <Field label="Image digest" error={imageDigest !== "" && !DIGEST.test(imageDigest) ? "0x and 64 hex characters." : null}>
          <input value={imageDigest} autoComplete="off" onChange={(event) => setImageDigest(event.target.value)} placeholder="0x…" />
        </Field>
        <Field label="Bond" error={belowMin ? "The minimum bond is 2,000 USDG." : !parsedBond.ok ? parsedBond.error : null} hint="Slashable. Paid in USDG.">
          <span className="input-unit">
            <input inputMode="decimal" value={bond} autoComplete="off" onChange={(event) => setBond(event.target.value)} />
            <span>USDG</span>
          </span>
        </Field>
      </div>
      <button type="submit" className="btn" disabled={busy || !ready}>
        Prepare and sign
      </button>
    </form>
  )
}
