import { useEffect, useRef, useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Gate, useSession } from "../components/session.tsx"
import { Data, Field, Section, Usdg } from "../components/ui.tsx"
import { ApiError, rest } from "../lib/api.ts"
import { parseUsdg } from "../lib/format.ts"
import type { ModelRow } from "../lib/types.ts"

type Message = { role: "user" | "assistant"; content: string }
type Answer = {
  choices: { message: { content: string | null } }[]
  offpeak_usage: { record: { hostCostMicro: string; feeMicro: string; reqId: string }; [key: string]: unknown }
}
export function Chat() {
  const { token, wallet } = useSession(),
    [messages, setMessages] = useState<Message[]>([]),
    [prompt, setPrompt] = useState(() => new URLSearchParams(location.hash.slice(1)).get("prompt")?.slice(0, 8000) ?? ""),
    [model, setModel] = useState(""),
    [cap, setCap] = useState("0.01"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState<Answer["offpeak_usage"] | null>(null)
  const windowId = new URLSearchParams(location.search).get("window"),
    abort = useRef<AbortController | null>(null),
    generation = useRef(0)
  const models = useQuery({ queryKey: ["chat.models"], queryFn: () => rest<{ data: ModelRow[] }>("/v1/models") })
  useEffect(() => {
    generation.current++
    abort.current?.abort()
    setMessages([])
    setReceipt(null)
    setBusy(false)
    setError("")
    return () => {
      generation.current++
      abort.current?.abort()
    }
  }, [wallet])
  const parsed = parseUsdg(cap),
    chosen = model || models.data?.data.find((m) => m.offpeak.kind !== "embeddings")?.id || ""
  async function send(event: FormEvent) {
    event.preventDefault()
    if (busy || !token || !prompt.trim() || !chosen || !parsed.ok || parsed.micro <= 0n) return
    const turn = generation.current,
      history: Message[] = [...messages, { role: "user", content: prompt.trim() }]
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setError("")
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-offpeak-max-charge": parsed.micro.toString(),
      }
      if (windowId) headers["x-offpeak-window"] = windowId
      const reply = await rest<Answer>("/v1/chat/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: chosen, messages: history, max_tokens: 512, stream: false }),
        signal: controller.signal,
      })
      if (generation.current !== turn) return
      setMessages([...history, { role: "assistant", content: reply.choices[0]?.message.content ?? "" }])
      setReceipt(reply.offpeak_usage)
      setPrompt("")
    } catch (e) {
      if (generation.current === turn)
        setError(
          controller.signal.aborted
            ? "Request stopped. Check your usage records for any completed work."
            : e instanceof ApiError
              ? e.message
              : "The connection ended. Check usage before retrying.",
        )
    } finally {
      if (generation.current === turn) setBusy(false)
    }
  }
  function save() {
    if (!receipt) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `offpeak-${receipt.record.reqId}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <>
      <header className="page-head">
        <span className="eyebrow">OFFPEAK CHAT</span>
        <h1>Your next idea starts here.</h1>
        <p className="lede">Choose an open model. Set your maximum charge. Keep the signed usage record.</p>
      </header>
      <div className="chat-layout">
        <section className="chat-thread" aria-label="Conversation">
          <div role="log" aria-live="polite">
            {messages.length ? (
              messages.map((m, i) => (
                <article key={i} className={`chat-message ${m.role}`}>
                  <span className="eyebrow">{m.role === "user" ? "You" : "OffPeak"}</span>
                  <p>{m.content}</p>
                </article>
              ))
            ) : (
              <div className="chat-empty">
                <h2>What are you working on?</h2>
                <p>Summarize a document, structure an idea, or work through a question.</p>
                <div className="row">
                  {["Help me outline a product launch.", "Turn these notes into action items.", "Explain this code step by step."].map(
                    (s) => (
                      <button className="btn small" key={s} onClick={() => setPrompt(s)}>
                        {s}
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
          <form onSubmit={send} className="chat-compose">
            <label htmlFor="chat-prompt">Message</label>
            <textarea
              id="chat-prompt"
              value={prompt}
              maxLength={8000}
              rows={4}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask something…"
            />
            <Gate what="your chat">
              <div className="row">
                <button className="btn" disabled={busy || !prompt.trim() || !chosen || !parsed.ok || parsed.micro <= 0n}>
                  {busy ? "Working…" : `Send · max ${cap} USDG`}
                </button>
                {busy && (
                  <button className="btn secondary" type="button" onClick={() => abort.current?.abort()}>
                    Stop
                  </button>
                )}
              </div>
            </Gate>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </section>
        <aside className="chat-settings">
          <Section title="Your controls">
            <Data query={models}>
              {(data) => (
                <Field label="Model">
                  <select value={chosen} disabled={busy} onChange={(e) => setModel(e.target.value)}>
                    {data.data
                      .filter((m) => m.offpeak.kind !== "embeddings")
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </Data>
            <Field label="Maximum USDG per message" error={!parsed.ok ? parsed.error : null}>
              <input value={cap} disabled={busy} inputMode="decimal" onChange={(e) => setCap(e.target.value)} />
            </Field>
            <p className="note">
              Up to 512 output tokens. Paid from your existing vault balance. Each Send authorizes this message up to your cap.
            </p>
            <a href="/dashboard">Manage balance and usage ↗</a>
            {windowId && <p className="note">Using Window {windowId}. No automatic fallback to your balance.</p>}
          </Section>
          <Section title="Your receipt">
            {receipt ? (
              <>
                <p>
                  Charged <Usdg micro={BigInt(receipt.record.hostCostMicro) + BigInt(receipt.record.feeMicro)} />
                </p>
                <button className="btn small" onClick={save}>
                  Save signed record
                </button>
              </>
            ) : (
              <p className="note">Your latest completed message’s record appears here.</p>
            )}
          </Section>
          <p className="note">Open hosts and the router can read messages. Conversation history stays in this tab.</p>
          <button
            className="btn small secondary"
            disabled={busy}
            onClick={() => {
              setMessages([])
              setReceipt(null)
            }}
          >
            Clear conversation
          </button>
        </aside>
      </div>
    </>
  )
}
