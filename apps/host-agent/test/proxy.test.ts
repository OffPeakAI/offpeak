import { afterEach, describe, expect, test } from "bun:test"
import { MODEL, agentHarness, auditor, buyer, newReqId, router, tokenizer } from "./support/harness.ts"
import { serveOnFreePort } from "./support/fake-vllm.ts"
import { IDLE_TIMEOUT_S, serveAgent } from "../src/proxy.ts"

const CHAT = "/offpeak/v1/chat/completions"

let stops: (() => void)[] = []
const harness = async (opts: Parameters<typeof agentHarness>[0] = {}) => {
  const row = await agentHarness(opts)
  stops.push(row.stop)
  return row
}

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

describe("who the agent listens to", () => {
  test("a request the router signed reaches vLLM", async () => {
    const { serve, engine } = await harness()
    const { res, text } = await serve()
    expect(res.status).toBe(200)
    expect(text).toContain("data: [DONE]")
    expect(engine.requests).toHaveLength(1)
  })

  test("no header, a broken header, and a stranger's signature stop at the door", async () => {
    const { post, chatBody, engine } = await harness()
    expect((await post(CHAT, chatBody(), { header: null })).res.status).toBe(401)
    expect((await post(CHAT, chatBody(), { header: "not-a-header" })).res.status).toBe(401)
    expect((await post(CHAT, chatBody(), { signer: buyer })).res.status).toBe(401)
    expect(engine.requests).toHaveLength(0)
  })

  test("a signature over other bytes is refused", async () => {
    const { post, chatBody, engine } = await harness()
    const signed = JSON.stringify(chatBody())
    const tampered = JSON.stringify(chatBody({ max_tokens: 4096 }))
    const { res } = await post(CHAT, null, { signedBody: signed, rawBody: tampered })
    expect(res.status).toBe(401)
    expect(engine.requests).toHaveLength(0)
  })

  test("an old request is refused, and a request from slightly ahead is not", async () => {
    const { post, chatBody, clock } = await harness()
    expect((await post(CHAT, chatBody(), { ts: clock.now - 121 })).res.status).toBe(401)
    expect((await post(CHAT, chatBody(), { ts: clock.now + 121 })).res.status).toBe(401)
    expect((await post(CHAT, chatBody(), { ts: clock.now + 60 })).res.status).toBe(200)
  })

  test("the same request cannot be sent twice", async () => {
    const { post, chatBody, engine } = await harness()
    const reqId = newReqId()
    const body = chatBody()
    expect((await post(CHAT, body, { reqId })).res.status).toBe(200)
    const again = await post(CHAT, body, { reqId })
    expect(again.res.status).toBe(401)
    expect(((await again.res.json()) as { error: { code: string } }).error.code).toBe("replayed_req")
    expect(engine.requests).toHaveLength(1)
  })
})

describe("what reaches vLLM", () => {
  test("fields that change how a prompt is rendered or reported stay behind", async () => {
    const { serve, engine } = await harness()
    await serve({ chat_template: "{{ 'x' }}", add_generation_prompt: false, continue_final_message: true, prompt_logprobs: 1, echo: true, add_special_tokens: true, chat_template_kwargs: { a: 1 }, temperature: 0.5 })
    const forwarded = engine.requests[0]!.body
    expect(Object.keys(forwarded).sort()).toEqual(["max_tokens", "messages", "model", "stream", "stream_options", "temperature"])
    expect(forwarded.temperature).toBe(0.5)
  })

  test("a stream always asks for usage", async () => {
    const { serve, engine } = await harness()
    await serve({ stream_options: undefined })
    expect(engine.requests[0]!.body.stream_options).toEqual({ include_usage: true })
  })

  test("stream options stay out of a plain request", async () => {
    const { serve, engine } = await harness()
    await serve({ stream: false })
    expect(engine.requests[0]!.body.stream_options).toBeUndefined()
  })

  test("more than one choice and non-text content are refused", async () => {
    const { post, chatBody, engine } = await harness()
    expect((await post(CHAT, chatBody({ n: 2 }))).res.status).toBe(400)
    expect((await post(CHAT, chatBody({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }))).res.status).toBe(400)
    expect(engine.requests).toHaveLength(0)
  })

  test("a model this host does not serve is a 404", async () => {
    const { post, chatBody } = await harness()
    expect((await post(CHAT, chatBody({ model: "other" }))).res.status).toBe(404)
  })

  test("nothing is forwarded once a model file has failed its check", async () => {
    const { post, chatBody, engine } = await harness({ integrityFailed: "file differs" })
    expect((await post(CHAT, chatBody())).res.status).toBe(503)
    expect(engine.requests).toHaveLength(0)
  })

  test("an engine error goes back as it came and leaves nothing to sign", async () => {
    const { post, chatBody, record, sign, engine } = await harness({ failWith: 503 })
    const { res, reqId } = await post(CHAT, chatBody())
    expect(res.status).toBe(503)
    expect(engine.requests).toHaveLength(1)
    expect((await sign(record(reqId))).status).toBe(404)
  })

  test("a dead engine is a 503", async () => {
    const { post, chatBody, engine } = await harness()
    engine.stop()
    expect((await post(CHAT, chatBody())).res.status).toBe(503)
  })
})

describe("before a body is read", () => {
  /** A body that says whether anyone pulled on it. */
  function watched() {
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true
        controller.enqueue(new TextEncoder().encode("x".repeat(1_024)))
        controller.close()
      },
    }, { highWaterMark: 0 })
    return { body, pulled: () => pulled }
  }

  const send = (app: Awaited<ReturnType<typeof harness>>["app"], path: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit)

  test.each([CHAT, "/offpeak/v1/embeddings", "/offpeak/v1/score"])("%s reads nothing from a caller with no signature", async (path) => {
    const { app } = await harness()
    const stream = watched()
    const res = await send(app, path, {}, stream.body)
    expect(res.status).toBe(401)
    expect(stream.pulled()).toBe(false)
  })

  test("a stranger's signature, or a stale one, reads nothing either", async () => {
    const { app, clock } = await harness()
    const { signRouterBody } = await import("../src/proxy.ts")
    const stranger = await signRouterBody(buyer as never, { reqId: newReqId(), ts: clock.now, payload: "{}" })
    const stale = await signRouterBody(router as never, { reqId: newReqId(), ts: clock.now - 1_000, payload: "{}" })
    for (const header of [stranger, stale, "not-a-header"]) {
      const stream = watched()
      expect((await send(app, CHAT, { "x-offpeak-req": header }, stream.body)).status).toBe(401)
      expect(stream.pulled()).toBe(false)
    }
  })

  test("a valid header still gets its body read", async () => {
    const { app, clock } = await harness()
    const { signRouterBody } = await import("../src/proxy.ts")
    const stream = watched()
    const header = await signRouterBody(router as never, { reqId: newReqId(), ts: clock.now, payload: "{}" })
    expect((await send(app, CHAT, { "x-offpeak-req": header }, stream.body)).status).toBe(401)
    expect(stream.pulled()).toBe(true)
  })

  test("a host that is no reference still answers not found on the score route", async () => {
    const { app } = await harness({ auditor: null })
    const stream = watched()
    expect((await send(app, "/offpeak/v1/score", {}, stream.body)).status).toBe(404)
    expect(stream.pulled()).toBe(false)
  })
})

describe("idle sockets", () => {
  const listenIdle = (app: Awaited<ReturnType<typeof harness>>["app"], seconds: number) => {
    const { server, port } = serveOnFreePort((free) => serveAgent(app, { hostname: "127.0.0.1", port: free }, seconds))
    stops.push(() => server.stop(true))
    return port as number
  }

  test("the agent keeps an idle limit by default", () => {
    expect(IDLE_TIMEOUT_S).toBeGreaterThan(0)
  })

  test("a socket that sends half a request is closed", async () => {
    const { app } = await harness()
    const port = listenIdle(app, 1)
    let closed = false
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, close: () => void (closed = true) } })
    socket.write("POST /offpeak/v1/chat/completions HTTP/1.1\r\nHost: a\r\n")
    const end = Date.now() + 15_000
    while (!closed && Date.now() < end) await Bun.sleep(100)
    expect(closed).toBe(true)
  }, 20_000)

  test("a signed stream outlives the idle limit while the GPU is quiet", async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const row = await harness({ hold, reply: () => ({ text: "first piece, then the rest of it" }) })
    const port = listenIdle(row.app, 1)
    const { signRouterBody } = await import("../src/proxy.ts")
    const payload = JSON.stringify(row.chatBody())
    const header = await signRouterBody(router as never, { reqId: newReqId(), ts: row.clock.now, payload })
    const res = await fetch(`http://127.0.0.1:${port}${CHAT}`, { method: "POST", headers: { "content-type": "application/json", "x-offpeak-req": header }, body: payload })
    const reader = res.body!.getReader()
    await reader.read()
    await Bun.sleep(9_000)
    release()
    let text = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(text).toContain("[DONE]")
  }, 20_000)
})

describe("streaming over a real socket", () => {
  const listen = (app: { fetch: (req: Request) => Response | Promise<Response> }) => {
    const { server, port } = serveOnFreePort((free) => Bun.serve({ port: free, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch }))
    stops.push(() => server.stop(true))
    return `http://127.0.0.1:${port}`
  }

  const signedChat = async (row: Awaited<ReturnType<typeof agentHarness>>, url: string) => {
    const { signRouterBody } = await import("../src/proxy.ts")
    const payload = JSON.stringify(row.chatBody())
    const reqId = newReqId()
    const header = await signRouterBody(router as never, { reqId, ts: row.clock.now, payload })
    const res = await fetch(`${url}${CHAT}`, { method: "POST", headers: { "content-type": "application/json", "x-offpeak-req": header }, body: payload })
    return { res, reqId }
  }

  test("a token reaches the caller while vLLM is still working", async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const row = await harness({ hold, reply: () => ({ text: "first piece, then the rest of it" }) })
    const url = listen(row.app)
    const { res } = await signedChat(row, url)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("first")) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    expect(seen).toContain("first")
    expect(seen).not.toContain("[DONE]")
    release()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    expect(seen).toContain("data: [DONE]")
  })
