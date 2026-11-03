import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { Stack } from "../context.ts"
const update = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({ text: z.string().max(8000).optional(), chat: z.object({ id: z.number().int().safe(), type: z.string() }) })
    .optional(),
})
export function telegramConfig(env: NodeJS.ProcessEnv) {
  const secret = env.OFFPEAK_TELEGRAM_WEBHOOK_SECRET,
    raw = env.OFFPEAK_CHAT_PUBLIC_URL
  if (!secret && !raw) return undefined
  if (!secret || !raw || !/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw Error("Telegram needs a public chat URL and a 32–256 character webhook secret")
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/chat")
    throw Error("OFFPEAK_CHAT_PUBLIC_URL must be an HTTPS /chat URL without credentials, query or fragment")
  return { secret, url: url.href }
}
/** Telegram opens the wallet-paid chat in a Mini App. The bot never holds a wallet or spends for a user. */
export async function telegramWebhook(stack: Stack, req: Request) {
  const config = stack.telegram
  if (!config) return new Response(null, { status: 404 })
  const provided = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") ?? ""),
    expected = Buffer.from(config.secret)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return new Response(null, { status: 403 })
  const parsed = update.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return new Response(null, { status: 400 })
  const message = parsed.data.message
  if (!message || message.chat.type !== "private") return Response.json({ ok: true })
  const seen = await stack.db.query(
    `INSERT INTO serving.expansion_replays (id,expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
    [`telegram:${parsed.data.update_id}`, stack.clock() + 86400],
  )
  if (!seen.rows.length) return Response.json({ ok: true })
  const text = message.text ?? "",
    prompt = text.startsWith("/ask ") ? text.slice(5).trim() : text.startsWith("/") ? "" : text.trim()
  const url = new URL(config.url)
  if (prompt) url.hash = new URLSearchParams({ prompt }).toString()
  return Response.json({
    method: "sendMessage",
    chat_id: message.chat.id,
    text: prompt
      ? "Open Chat to choose your model and authorize this message."
      : "Chat with open models using your wallet. Set a cap for each message and keep its signed usage record. Use /ask followed by your question.",
    reply_markup: { inline_keyboard: [[{ text: "Open OffPeak Chat", web_app: { url: url.href } }]] },
  })
}
