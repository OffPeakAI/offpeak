import { resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Hono } from "hono"

const DIST = fileURLToPath(new URL("../../web/dist", import.meta.url))
const API = /^\/(v1|trpc|health|idx|public|mock)(\/|$)/
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

function serve(file: Bun.BunFile, cache: string) {
  return new Response(file, {
    headers: {
      "content-type": file.type,
      "cache-control": cache,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  })
}

/** Serves the built web app after every API route. Page paths fall back to index.html. */
export function mountWeb(app: Hono, dist = DIST) {
  const root = resolve(dist)
  app.get("*", async (c) => {
    let path: string
    try {
      path = decodeURIComponent(c.req.path)
    } catch {
      return c.notFound()
    }
    if (API.test(path)) return c.notFound()
    const target = resolve(root, `.${path}`)
    if (target !== root && !target.startsWith(`${root}${sep}`)) return c.notFound()
    const file = Bun.file(target)
    if (path !== "/" && (await file.exists())) return serve(file, path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache")
    if (/\.[a-z0-9]+$/i.test(path)) return c.notFound()
    const index = Bun.file(resolve(root, "index.html"))
    return (await index.exists()) ? serve(index, "no-cache") : c.notFound()
  })
}
