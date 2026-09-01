import type { ChatMessage } from "@offpeak/shared"
import type { AgentTokenizer } from "../../src/meter.ts"

export type FakeReply = { text: string; toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[]; finish?: "stop" | "length" | "tool_calls" }

export type FakeVllmOptions = {
  name: string
  tokenizer: AgentTokenizer
  maxModelLen?: number
  reply?: (body: Record<string, any>) => FakeReply
  /** Sends the first chunk, then waits here before the rest. */
  hold?: Promise<void>
  /** Answers every inference call with this status. */
  failWith?: number
  waiting?: number
}

const CHUNK_CHARS = 5

/** Runs that must stay out of the usual range set `OFFPEAK_TEST_PORT_BASE`. */
export function freePort() {
  return Number(process.env.OFFPEAK_TEST_PORT_BASE ?? 31_000) + Math.floor(Math.random() * 1000)
}

/** Starts on a free port in the range this project's tests may use. Another process may hold any given one. */
export function serveOnFreePort(start: (port: number) => { stop: (now?: boolean) => unknown; port?: number }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = freePort()
    try {
      return { server: start(port), port }
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err
    }
  }
  throw new Error("no free port in range")
}

const encoder = new TextEncoder()

const event = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)

/** Answers on the routes the agent uses, in the shapes vLLM's OpenAI server sends. */
export function startFakeVllm(opts: FakeVllmOptions) {
  const requests: { path: string; body: Record<string, any> }[] = []
  const state = { cancelled: 0 }
  const reply: (body: Record<string, any>) => FakeReply = opts.reply ?? (() => ({ text: "Large language models are neural networks trained on text." }))

  const usage = (body: Record<string, any>, made: FakeReply) => {
    const prompt = opts.tokenizer.encode(opts.tokenizer.render({ messages: body.messages as ChatMessage[], tools: body.tools })).length
    const finish = made.finish ?? (made.toolCalls ? "tool_calls" : "stop")
    const completion = opts.tokenizer.countOutput(made.text, made.toolCalls, finish)
    return { prompt_tokens: prompt, total_tokens: prompt + completion, completion_tokens: completion, prompt_tokens_details: null }
  }

  const chat = (body: Record<string, any>) => {
    const made = reply(body)
    const finish = made.finish ?? (made.toolCalls ? "tool_calls" : "stop")
    const base = { id: "chatcmpl-1", created: 1_762_000_000, model: body.model }
    if (!body.stream) {
      const message = { role: "assistant", content: made.toolCalls ? null : made.text, tool_calls: made.toolCalls ?? [], reasoning: null }
      return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message, logprobs: null, finish_reason: finish, stop_reason: null }], usage: usage(body, made) })
    }
    const chunk = (delta: object, finishReason: string | null) => event({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason, stop_reason: null }] })
    const pieces: string[] = []
    for (let at = 0; at < made.text.length; at += CHUNK_CHARS) pieces.push(made.text.slice(at, at + CHUNK_CHARS))
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(chunk({ role: "assistant", content: "" }, null))
          if (pieces[0]) controller.enqueue(chunk({ content: pieces[0] }, null))
          await opts.hold
          for (const piece of pieces.slice(1)) controller.enqueue(chunk({ content: piece }, null))
          for (const [index, call] of (made.toolCalls ?? []).entries()) {
            controller.enqueue(chunk({ tool_calls: [{ index, id: call.id, type: call.type, function: { name: call.function.name, arguments: "" } }] }, null))
            controller.enqueue(chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }, null))
          }
          controller.enqueue(chunk({ content: "" }, finish))
          if (body.stream_options?.include_usage) controller.enqueue(event({ ...base, object: "chat.completion.chunk", choices: [], usage: usage(body, made) }))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch {
          /* The agent hung up. `cancel` below has counted it. */
        }
      },
      cancel() {
        state.cancelled += 1
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
  }

  const completions = (body: Record<string, any>) => {
    if (!Array.isArray(body.prompt) || body.prompt_logprobs === undefined || body.stream) return Response.json({ error: { message: "bad request", type: "BadRequestError", code: 400 } }, { status: 400 })
    // The first prompt token has no context, so vLLM gives it null. Each row holds the actual token and the top one.
    const rows = (body.prompt as number[]).map((id, index) => {
      if (index === 0) return null
      const logprob = -((id % 9) + 1) / 10
      return { [String(id)]: { logprob, rank: 3, decoded_token: `<${id}>` }, "0": { logprob: -0.001, rank: 1, decoded_token: "!" } }
    })
    return Response.json({
      id: "cmpl-1",
      object: "text_completion",
      created: 1_762_000_000,
      model: body.model,
      choices: [{ index: 0, text: "x", logprobs: null, finish_reason: "length", stop_reason: null, prompt_logprobs: rows }],
      usage: { prompt_tokens: rows.length, total_tokens: rows.length + 1, completion_tokens: 1 },
    })
  }

  const embeddings = (body: Record<string, any>) => {
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input]
    const tokens = opts.tokenizer.countInputs(inputs)
    return Response.json({
      id: "embd-1",
      object: "list",
      created: 1_762_000_000,
      model: body.model,
      data: inputs.map((text, index) => ({ index, object: "embedding", embedding: [text.length, 0.5, 0.25] })),
      usage: { prompt_tokens: tokens, total_tokens: tokens, completion_tokens: 0, prompt_tokens_details: null },
    })
  }

  const handle = async (req: Request) => {
    const path = new URL(req.url).pathname
    if (req.method === "GET" && path === "/v1/models") return Response.json({ object: "list", data: [{ id: opts.name, object: "model", owned_by: "vllm", root: "/models/fake", max_model_len: opts.maxModelLen ?? 8192 }] })
    if (req.method === "GET" && path === "/metrics") return new Response(`# HELP vllm:num_requests_waiting Waiting.\nvllm:num_requests_running{engine="0",model_name="${opts.name}"} 1.0\nvllm:num_requests_waiting{engine="0",model_name="${opts.name}"} ${opts.waiting ?? 0}.0\n`)
    const body = (await req.json()) as Record<string, any>
    requests.push({ path, body })
    if (opts.failWith) return Response.json({ error: { message: "engine failed", type: "InternalServerError", code: opts.failWith } }, { status: opts.failWith })
    if (path === "/v1/chat/completions") return chat(body)
    if (path === "/v1/completions") return completions(body)
    if (path === "/v1/embeddings") return embeddings(body)
    return new Response("not found", { status: 404 })
  }

  const { server, port } = serveOnFreePort((free) => Bun.serve({ port: free, hostname: "127.0.0.1", idleTimeout: 0, fetch: handle }))
  return { url: `http://127.0.0.1:${port}`, requests, state, stop: () => server.stop(true) }
}
