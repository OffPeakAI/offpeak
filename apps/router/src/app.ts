import { mppChat } from "./expansion/mpp.ts"
import { telegramWebhook } from "./expansion/telegram.ts"
import { indexFeed } from "./expansion/index-feed.ts"
import { sessionChat } from "./expansion/chat.ts"
import { Hono, type Context, type Next } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HOUR_CLOSE_GRACE_S, hourEnd } from "@offpeak/shared"
import { trpcServer } from "@hono/trpc-server"
import { ipLimit } from "./auth/limits.ts"
import { createNonce, sessionWallet, verifyLogin } from "./auth/siwe.ts"
import { applyVoucher } from "./pay/authorize.ts"
import { auth, issueKey, serveChat, type Stack } from "./pipeline.ts"
import { serveEmbeddings } from "./openai/embeddings.ts"
import { dueNightSlots, runBatch, serveCancelBatch, serveCreateBatch, serveGetBatch } from "./openai/batches.ts"
import { serveFileContent, serveUploadFile } from "./openai/files.ts"
import { listModels } from "./openai/models.ts"
import { publishedTokenizer } from "./metering/tokenize.ts"
import { priceBoard } from "./offpeak/prices.ts"
import { serveUsageList, usageRecord } from "./offpeak/usage.ts"
import { windowBoard, windowCalldata } from "./offpeak/windows.ts"
import { openDispute } from "./offpeak/disputes.ts"
import { serviceStatus } from "./offpeak/status.ts"
import { closeChannel, payerChannelView } from "./offpeak/channels.ts"
import { sealedHostsView } from "./routing/attest.ts"
import { channelId, signature, voucherBody, wallet } from "./pay/schemas.ts"
import { registerBody, registerCalldata, rememberHost } from "./hosts-api/register.ts"
import { acceptPriceSheet } from "./hosts-api/price-sheet.ts"
import { hostPayouts } from "./hosts-api/payouts.ts"
import { auditResponse } from "./hosts-api/audit-response.ts"
import { closeHour } from "./metering/hourclose.ts"
import { appRouter } from "./trpc/router.ts"
import { clientIp, featureOff, sameSecret } from "./http.ts"
import { mountWeb } from "./web.ts"
import { calibrationReport } from "../../auditor/src/calibrate.ts"
import { serveCanary } from "./audit/canary.ts"
import { z } from "zod"

const modelQuery = z.string().min(1).max(128).optional()
const nonceBody = z.object({ wallet })
const loginBody = z.object({ message: z.string().max(4096), signature })
/** Routes anyone can reach and that write to the database, per address per minute. */
const NONCES_PER_MINUTE = 30n
const LOGINS_PER_MINUTE = 30n
const REGISTERS_PER_MINUTE = 10n
const OPEN_BODY_BYTES = 32 * 1024

export function createApp(stack: Stack) {
  const app = new Hono()
  const internal = (authorization: string | undefined) => Boolean(stack.internalToken) && sameSecret(authorization, `Bearer ${stack.internalToken}`)
  const ipOf = (c: Context) => clientIp(c.req.raw, c.env, stack.proxyHops ?? 0)
  const perIp = (scope: string, limit: bigint) => async (c: Context, next: Next) => (await ipLimit(stack, ipOf(c), scope, limit)) ?? next()
  const openBody = bodyLimit({ maxSize: OPEN_BODY_BYTES, onError: (c) => c.json({ error: { message: "Body too large", type: "invalid_request", code: "body_too_large" } }, 413) })
  app.onError((err, c) => {
    console.error(JSON.stringify({ service: "router", event: "request_failed", path: c.req.path, error: String(err) }))
    return c.json({ error: { message: "Service unavailable", type: "server_error", code: "unavailable" } }, 503)
  })
  app.get("/health", (c) => c.json({ ok: true }))
  app.get("/v1/status", (c) => c.json(serviceStatus(stack)))
  app.post("/v1/telegram/webhook", bodyLimit({ maxSize: 64 * 1024 }), (c) => telegramWebhook(stack,c.req.raw))
  app.get("/v1/index", perIp("index", 30n), async (c) => { c.header("Cache-Control", "no-store"); return c.json(await indexFeed(stack)) })
  app.post("/v1/chat/session", bodyLimit({ maxSize: 128 * 1024 }), (c) => sessionChat(stack, c.req.raw, ipOf(c)))
  app.get("/v1/models", async (c) => c.json(await listModels(stack)))
  app.get("/v1/tokenizers/:digest", (c) => {
    const digest = c.req.param("digest").toLowerCase()
    const model = stack.models.find((row) => row.digest.toLowerCase() === digest)
    if (!model) return c.json({ error: { message: "Unknown model", type: "invalid_request", code: "model_not_found" } }, 404)
    const body = `{"context_length":${model.contextLength},"tokenizer":${publishedTokenizer(digest) ?? "null"}}`
    return c.body(body, 200, { "content-type": "application/json", "cache-control": "public, max-age=86400" })
  })
  app.post("/v1/chat/completions", bodyLimit({ maxSize: 4 * 1024 * 1024 }), (c) => mppChat(stack, c.req.raw, req => serveChat(stack, req, undefined, ipOf(c))))
  app.post("/v1/embeddings", (c) => serveEmbeddings(stack, c.req.raw, ipOf(c)))
  app.post("/v1/files", (c) => serveUploadFile(stack, c.req.raw))
  app.get("/v1/files/:id/content", (c) => serveFileContent(stack, c.req.raw, c.req.param("id")))
  app.post("/v1/batches", (c) => serveCreateBatch(stack, c.req.raw))
  app.get("/v1/batches/:id", (c) => serveGetBatch(stack, c.req.raw, c.req.param("id")))
  app.post("/v1/batches/:id/cancel", (c) => serveCancelBatch(stack, c.req.raw, c.req.param("id")))
  app.post("/v1/batches/:id/run", async (c) => {
    if (!internal(c.req.header("authorization"))) return c.json({ error: { message: "Forbidden", type: "auth", code: "forbidden" } }, 403)
    return c.json(await runBatch(stack, c.req.param("id"), await c.req.json().catch(() => null)))
  })
  app.get("/internal/night-jobs/due", async (c) => {
    if (!internal(c.req.header("authorization"))) return c.json({ error: { message: "Forbidden", type: "auth", code: "forbidden" } }, 403)
    return c.json({ slots: await dueNightSlots(stack) })
  })
  app.get("/v1/usage", (c) => serveUsageList(stack, c.req.raw))
  app.get("/v1/usage/:reqId", async (c) => {
    const row = await usageRecord(stack, c.req.param("reqId"))
    if (!row) return c.json({ error: { message: "Not found", type: "invalid_request", code: "not_found" } }, 404)
    return c.json(row)
  })
  app.post("/v1/usage/close/:hour", async (c) => {
    if (!internal(c.req.header("authorization"))) return c.json({ error: { message: "Forbidden", type: "auth", code: "forbidden" } }, 403)
    const hour = Number(c.req.param("hour"))
    if (!Number.isInteger(hour) || stack.clock() < hourEnd(hour) + HOUR_CLOSE_GRACE_S) {
      return c.json({ error: { message: "Hour is still open", type: "invalid_request", code: "hour_open" } }, 409)
    }
    const closed = await closeHour(stack.db, hour, stack.router, stack.usageLedger)
    return c.json({
      idempotent: closed.idempotent,
      root: "root" in closed ? closed.root : undefined,
      records: closed.totals ? closed.totals.records : undefined,
    })
  })
  app.get("/v1/prices", async (c) => {
    const name = c.req.query("model")
    const model = name ? stack.models.find((row) => row.name === name) : stack.models.find((row) => row.kind === "chat")
    if (!model) return c.json({ error: { message: "Unknown model", type: "invalid_request", code: "model_not_found" } }, 404)
    // A key prices the board at its own fee. Anyone else sees the default.
    const payer = c.req.header("authorization")?.startsWith("Bearer op_live_") ? await auth(stack, new Request(c.req.url, { headers: { authorization: c.req.header("authorization")! } })) : null
    if (payer instanceof Response) return payer
    return c.json(await priceBoard(stack, model, payer?.mode === 0 ? payer.feeBps : undefined))
  })
  app.get("/v1/windows", async (c) => c.json({ windows: await windowBoard(stack), resale: "1% of the sale price + 10% of your markup" }))
  app.post("/v1/windows/:action", async (c) => {
    if (!stack.flags.windows) return featureOff("Windows")
    const action = c.req.param("action")
    if (action !== "buy" && action !== "cancel" && action !== "list" && action !== "claim") {
      return c.json({ error: { message: "Unknown action", type: "invalid_request", code: "bad_action" } }, 400)
    }
    return c.json(windowCalldata(stack, action, await c.req.json()))
  })
  app.post("/v1/disputes", async (c) => {
    const wallet = await sessionWallet(stack, c.req.header("authorization"))
    if (!wallet) return c.json({ error: { message: "Sign in first", type: "auth", code: "no_session" } }, 401)
    const result = await openDispute(stack, wallet, await c.req.json().catch(() => null))
    if ("error" in result) return c.json({ error: { message: result.error, type: "invalid_request", code: result.error } }, 400)
    return c.json(result)
  })
  app.post("/v1/channels/:id/voucher", async (c) => {
    const id = channelId.safeParse(c.req.param("id"))
    const channel = id.success ? await stack.indexer.channel(id.data) : null
    if (!id.success || !channel) return c.json({ error: { message: "Not found", type: "invalid_request", code: "not_found" } }, 404)
    const body = voucherBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { message: "Voucher cannot be read", type: "payment", code: "bad_voucher" } }, 400)
    const refused = await applyVoucher(stack, channel, id.data, body.data)
    return refused ?? c.json({ accepted: true })
  })
  app.post("/v1/channels/:id/close", async (c) => {
    const id = channelId.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: { message: "Not found", type: "invalid_request", code: "not_found" } }, 404)
    return closeChannel(stack, id.data, await c.req.json().catch(() => null))
  })
  app.post("/v1/auth/nonce", perIp("nonce", NONCES_PER_MINUTE), openBody, async (c) => {
    const body = nonceBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { message: "Wallet cannot be read", type: "invalid_request", code: "bad_wallet" } }, 400)
    return c.json(await createNonce(stack, body.data.wallet))
  })
  app.post("/v1/auth/login", perIp("login", LOGINS_PER_MINUTE), openBody, async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null))
    const login = body.success ? await verifyLogin(stack, body.data.message, body.data.signature) : { ok: false as const }
    return login.ok ? c.json({ session: login.session, wallet: login.wallet }) : c.json({ error: { message: "Login failed", type: "auth", code: "bad_login" } }, 401)
  })
  app.post("/v1/keys", async (c) => {
    const wallet = await sessionWallet(stack, c.req.header("authorization"))
    if (!wallet) return c.json({ error: { message: "Sign in first", type: "auth", code: "no_session" } }, 401)
    return c.json(await issueKey(stack, wallet))
  })
  app.get("/v1/channels/:id", (c) => payerChannelView(stack, c.req.param("id"), c.req.header("x-offpeak-channel-auth")))
  app.post("/v1/hosts/register", perIp("register", REGISTERS_PER_MINUTE), openBody, async (c) => {
    const body = registerBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { message: "Registration cannot be read", type: "invalid_request", code: "bad_registration" } }, 400)
    const remembered = await rememberHost(stack, body.data)
    if ("error" in remembered) return c.json({ error: { message: "Operator signature is invalid", type: "auth", code: remembered.error } }, 401)
    return c.json({ ...registerCalldata(stack.registry as `0x${string}`, body.data), ...remembered })
  })
  app.post("/v1/hosts/price-sheet", async (c) => {
    const result = await acceptPriceSheet(stack, await c.req.json().catch(() => null))
    return c.json(result, result.ok ? 200 : 400)
  })
  app.get("/v1/hosts/:addr/payouts", async (c) => c.json(await hostPayouts(stack, c.req.param("addr"))))
  app.post("/v1/hosts/audit-response", async (c) => auditResponse(stack, await c.req.json().catch(() => null)))
  app.get("/v1/audits/calibration", async (c) => c.json(await calibrationReport(stack.db)))
  app.post("/internal/audit/canary", (c) => {
    if (!stack.internalToken || !sameSecret(c.req.header("x-offpeak-internal"), stack.internalToken)) return c.json({ error: { message: "Forbidden", type: "auth", code: "forbidden" } }, 403)
    return serveCanary(stack, c.req.raw)
  })
  app.get("/v1/sealed/hosts", (c) => {
    const model = modelQuery.safeParse(c.req.query("model"))
    if (!model.success) return c.json({ error: { message: "Bad model", type: "invalid_request", code: "bad_model" } }, 400)
    return c.json(sealedHostsView(stack, model.data))
  })
  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: async (_opts, c) => {
        const authorization = c.req.header("authorization")
        return { stack, wallet: await sessionWallet(stack, authorization), session: authorization?.slice("Bearer ".length) ?? null }
      },
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") console.error(JSON.stringify({ service: "router", event: "trpc_failed", path, error: String(error.cause ?? error) }))
      },
    }),
  )
  mountWeb(app, stack.webDist)
  return app
}
