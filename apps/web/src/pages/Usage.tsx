import { useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { publicActions, type Hex } from "viem"
import { useWalletClient } from "wagmi"
import { UsageLedgerAbi } from "../../../../packages/abis/src/UsageLedger.ts"
import { useAuthed, useSession } from "../components/session.tsx"
import { Data, Empty, Failed, Field, Mono, Section, Usdg, useNetwork, useNow } from "../components/ui.tsx"
import { disputeOpen } from "../lib/countdown.ts"
import { formatTokens, formatUtc } from "../lib/format.ts"
import { readMaterial, recount, recountLines, type Material } from "../lib/recount.ts"
import type { Network } from "../lib/types.ts"
import { PAY_MODES, buyerTotal, checkLines, proofLine, proofState, verdict, verifyRecord, type Line, type ProofRow, type UsageRow } from "../lib/verify.ts"

type Page = { rows: UsageRow[]; more: boolean; serverTime: number }

type OnDispute = (reqId: string, material?: Material) => void

export function Usage({ onDispute }: { onDispute: OnDispute }) {
  const network = useNetwork()
  const [before, setBefore] = useState<{ ts: number; reqId: string } | undefined>(undefined)
  const [earlier, setEarlier] = useState<UsageRow[]>([])
  const page = useAuthed<Page>("usage.list", before ? { before } : {}, { refetchInterval: 30_000 })
  const more = () => {
    const rows = page.data?.rows ?? []
    const last = rows[rows.length - 1]
    if (!last) return
    setEarlier((held) => [...held, ...rows])
    setBefore({ ts: last.record.ts, reqId: last.record.reqId })
  }
  return (
    <Section id="usage" title="Usage">
      <p className="note">Every record is signed by Offpeak's router and the host. This page checks each one in your browser against the addresses published with this site. The page itself comes from Offpeak, so a check that does not rely on it needs the SDK and your own RPC.</p>
      <Data query={page} lines={4}>
        {(data) =>
          earlier.length + data.rows.length > 0 ? (
            <>
              <ul className="usage">
                {[...earlier, ...data.rows].map((row) => (
                  <Row key={row.record.reqId} row={row} network={network.data} serverTime={data.serverTime} onDispute={onDispute} />
                ))}
              </ul>
              {data.more && (
                <button type="button" className="btn ghost" onClick={more}>
                  Older records
                </button>
              )}
            </>
          ) : (
            <Empty title="No usage yet.">Make a key below and send your first request. Records appear here as they finish.</Empty>
          )
        }
      </Data>
    </Section>
  )
}

function Tick({ line }: { line: Line }) {
  return (
    <li className={line.tone}>
      <span className="tick" aria-hidden="true" />
      <span>
        <strong>{line.label}.</strong> {line.detail}
      </span>
    </li>
  )
}

/** The promise on the limits page: you can recount your own requests. Everything pasted here stays in this browser. */
function Recount({ row, onDispute }: { row: UsageRow; onDispute: OnDispute }) {
  const [pasted, setPasted] = useState({ body: "", output: "", toolCalls: "", finish: "" })
  const [lines, setLines] = useState<Line[] | null>(null)
  const [material, setMaterial] = useState<Material | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const edit = (field: keyof typeof pasted) => (event: { target: { value: string } }) => setPasted((held) => ({ ...held, [field]: event.target.value }))
  const run = async (event: FormEvent) => {
    event.preventDefault()
    setProblem(null)
    setLines(null)
    const read = readMaterial(pasted)
    if (typeof read === "string") return setProblem(read)
    setBusy(true)
    try {
      setLines(recountLines(await recount(row.record, read), row.record))
      setMaterial(read)
    } catch {
      setProblem("The tokenizer could not be loaded or does not match this record's model, so nothing was counted.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="recount">
      <summary>Recount this request</summary>
      <form className="fields" onSubmit={(event) => void run(event)}>
        <p className="note">Paste what you sent and what came back. This page recounts it with the model's own tokenizer, in your browser.</p>
        <Field label="Request body" hint="The JSON you sent.">
          <textarea rows={4} value={pasted.body} onChange={edit("body")} spellCheck={false} />
        </Field>
        <Field label="Output text">
          <textarea rows={4} value={pasted.output} onChange={edit("output")} spellCheck={false} />
        </Field>
        <Field label="Tool calls" hint="Optional. The tool_calls array as JSON.">
          <input value={pasted.toolCalls} onChange={edit("toolCalls")} spellCheck={false} />
        </Field>
        <Field label="Finish reason" hint="Optional. Sharpens the output count by one token.">
          <input value={pasted.finish} onChange={edit("finish")} spellCheck={false} />
        </Field>
        <button type="submit" className="btn ghost small" disabled={busy || pasted.body.trim() === ""}>
          {busy ? "Counting…" : "Recount"}
        </button>
      </form>
      {problem && <p className="note">{problem}</p>}
      {lines && (
        <ul className="ticks">
          {lines.map((line) => (
            <Tick key={line.label} line={line} />
          ))}
        </ul>
      )}
      {lines && material && (
        <button type="button" className="btn ghost small" onClick={() => onDispute(row.record.reqId, material)}>
          Dispute with this material
        </button>
      )}
    </details>
  )
}
