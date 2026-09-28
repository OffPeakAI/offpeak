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
