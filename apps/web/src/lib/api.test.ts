import { afterEach, describe, expect, test } from "bun:test"
import { ApiError, Refused, explain, rest, trpcMutation, trpcQuery, trpcUrl } from "./api.ts"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function answer(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Response.json(body, { status })
  }) as typeof fetch
  return calls
}

describe("what a check refuses", () => {
  test("reaches the reader in its own words", () => {
    expect(explain(new Refused("The router named another chain, so nothing was sent."))).toBe("The router named another chain, so nothing was sent.")
    expect(explain(new Error("anything else"))).toBe("That did not go through. Nothing was sent.")
  })
})

describe("tRPC over fetch", () => {
  test("queries put the input in the URL and the session in a header", async () => {
    const calls = answer(200, { result: { data: { ok: 1 } } })
    expect(await trpcQuery("usage.get", { reqId: "0x1" }, "sess_a")).toEqual({ ok: 1 })
    expect(calls[0]?.url).toBe(`/trpc/usage.get?input=${encodeURIComponent('{"reqId":"0x1"}')}`)
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer sess_a")
  })

  test("no session sends no header, and no input adds no query", async () => {
    const calls = answer(200, { result: { data: 1 } })
    await trpcQuery("account.network")
    expect(calls[0]?.url).toBe("/trpc/account.network")
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false)
  })

  test("mutations post the bare input", async () => {
    const calls = answer(200, { result: { data: 1 } })
    await trpcMutation("keys.create", { label: "a" }, "sess_a")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.body).toBe('{"label":"a"}')
  })

  test("errors keep the router's code", async () => {
    answer(400, { error: { message: "beta_cap", data: { code: "BAD_REQUEST", httpStatus: 400 } } })
    const failure = await trpcMutation("account.depositPlan", {}).catch((err) => err)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure.message).toBe("beta_cap")
    expect(explain(failure)).toContain("500 USDG beta cap")
  })

  test("a reply with no JSON is an error, not a crash", async () => {
    globalThis.fetch = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch
    const failure = await trpcQuery("x").catch((err) => err)
    expect(failure.status).toBe(502)
  })

  test("the URL helper encodes input", () => {
    expect(trpcUrl("a.b", { x: "&" })).toBe("/trpc/a.b?input=%7B%22x%22%3A%22%26%22%7D")
  })
})

describe("plain routes", () => {
  test("read the OpenAI error shape", async () => {
    answer(404, { error: { message: "Not found", type: "invalid_request", code: "not_found" } })
    const failure = await rest("/v1/channels/1/close").catch((err) => err)
    expect(failure).toMatchObject({ code: "not_found", status: 404 })
  })
})

describe("explaining failures", () => {
  test("a session failure asks for a sign-in", () => {
    expect(explain(new ApiError("UNAUTHORIZED", 401, "UNAUTHORIZED"))).toContain("Sign in again")
  })

  test("server failures stay vague", () => {
    expect(explain(new ApiError("INTERNAL_SERVER_ERROR", 500, "Service unavailable"))).toBe("The service did not answer. Try again in a moment.")
  })

  test("wallet refusals are named", () => {
    expect(explain(new Error("User rejected the request."))).toBe("You declined this in your wallet.")
    expect(explain(new Error("Provider not found."))).toContain("No browser wallet")
  })

  test("a revert shows its reason and an unknown failure says nothing went", () => {
    expect(explain(new Error("The contract function reverted with: PriceAboveMax"))).toContain("PriceAboveMax")
    expect(explain(new Error("weird"))).toBe("That did not go through. Nothing was sent.")
  })

  test("raw custom error bytes never reach the page", () => {
    expect(explain(new Error("Execution reverted with reason: custom error 0x9d819744: c1c1."))).toBe("The chain would refuse this, so nothing was sent.")
  })
})
