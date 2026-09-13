import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { AUDIT_BODY_RETENTION_S, dayIndex } from "@offpeak/shared"
import { openDb } from "../../router/src/store.ts"
import { SAMPLE_PPM, SAMPLE_TTL_S, drawsSample, dueSamples, openSample, parseKek, runRetention, storeSample, trafficShape } from "./sample.ts"

const KEK = randomBytes(32)
const NOW = 1_800_000_000
const SECRET = "the-canary-string-in-a-private-prompt"

async function openedIn(opted: boolean) {
  const db = await openDb()
  await db.query("INSERT INTO serving.accounts (id, wallet, audit_opt_in) VALUES ('acct', '0xabab', $1)", [opted])
  return db
}

const sample = (reqId: string, ts = NOW) => ({ reqId, host: "0xhost", modelDigest: "0xmodel", accountId: "acct", body: { messages: [{ role: "user", content: SECRET }] }, text: "an answer", toolCalls: [], ts })

describe("audit samples", () => {
  test("a buyer who did not opt in stores nothing", async () => {
    const db = await openedIn(false)
    expect(await storeSample(db, KEK, sample("0x1"))).toBe(false)
    expect(await storeSample(db, KEK, { ...sample("0x2"), accountId: null })).toBe(false)
    expect((await db.query("SELECT 1 FROM serving.audit_samples")).rows).toHaveLength(0)
    expect((await db.query("SELECT 1 FROM serving.audit_day_keys")).rows).toHaveLength(0)
  })

  test("bodies are encrypted at rest and open with the day's key", async () => {
    const db = await openedIn(true)
    expect(await storeSample(db, KEK, sample("0x1"))).toBe(true)
    const [row] = await dueSamples(db, NOW, 10)
    expect(row!.enc_body).not.toContain(SECRET)
    expect(Buffer.from(row!.enc_body, "base64url").toString("latin1")).not.toContain(SECRET)
    const keys = await db.query<{ wrapped: string }>("SELECT wrapped FROM serving.audit_day_keys")
    expect(keys.rows).toHaveLength(1)
    expect((await openSample(db, KEK, row!))?.body).toEqual(sample("0x1").body)
  })

  test("the wrong KEK reads nothing", async () => {
    const db = await openedIn(true)
    await storeSample(db, KEK, sample("0x1"))
    const [row] = await dueSamples(db, NOW, 10)
    await expect(openSample(db, randomBytes(32), row!)).rejects.toThrow()
  })

  test("a body moved onto another request's row does not open", async () => {
    const db = await openedIn(true)
    await storeSample(db, KEK, sample("0x1"))
    const [row] = await dueSamples(db, NOW, 10)
    await expect(openSample(db, KEK, { ...row!, req_id: "0x2" })).rejects.toThrow()
  })

  test("each UTC day has its own key", async () => {
    const db = await openedIn(true)
    await storeSample(db, KEK, sample("0x1"))
    await storeSample(db, KEK, sample("0x2"))
    await storeSample(db, KEK, sample("0x3", NOW + 86_400))
    const keys = await db.query<{ day: number }>("SELECT day FROM serving.audit_day_keys ORDER BY day")
    expect(keys.rows.map((row) => row.day)).toEqual([dayIndex(NOW), dayIndex(NOW) + 1])
  })

  test("the retention job deletes bodies inside 72 h, even when it runs an hour late", async () => {
    const db = await openedIn(true)
    await storeSample(db, KEK, sample("0x1"))
    expect(SAMPLE_TTL_S).toBeLessThan(AUDIT_BODY_RETENTION_S)
    expect((await runRetention(db, NOW + SAMPLE_TTL_S - 1)).bodies).toBe(0)
    const lateRun = NOW + SAMPLE_TTL_S + 3_599
    expect(lateRun).toBeLessThan(NOW + AUDIT_BODY_RETENTION_S)
    expect((await runRetention(db, lateRun)).bodies).toBe(1)
    expect((await db.query("SELECT 1 FROM serving.audit_samples")).rows).toHaveLength(0)
  })

  test("the key goes with the last body it protected, and never before", async () => {
    const db = await openedIn(true)
    const dayEnd = (dayIndex(NOW) + 1) * 86_400 - 1
    await storeSample(db, KEK, sample("0x1"))
    await storeSample(db, KEK, sample("0x2", dayEnd))
    const [, last] = await dueSamples(db, NOW, 10)
    await runRetention(db, NOW + SAMPLE_TTL_S)
    expect((await openSample(db, KEK, last!))?.text).toBe("an answer")
    const done = await runRetention(db, dayEnd + SAMPLE_TTL_S + 1)
    expect(done).toEqual({ bodies: 1, keys: 1 })
    expect((await db.query("SELECT 1 FROM serving.audit_day_keys")).rows).toHaveLength(0)
    expect(await openSample(db, KEK, last!)).toBeNull()
  })

  test("the database refuses a body kept past 72 h", async () => {
    const db = await openedIn(true)
    await storeSample(db, KEK, sample("0x1"))
    await expect(db.query("UPDATE serving.audit_samples SET expires_at = created_at + interval '73 hours'")).rejects.toThrow()
  })

  test("a concurrent first write lands every process on one key", async () => {
    const db = await openedIn(true)
    await Promise.all(Array.from({ length: 8 }, (_, i) => storeSample(db, KEK, sample(`0x${i}`))))
    const rows = await dueSamples(db, NOW, 10)
    expect(rows).toHaveLength(8)
    for (const row of rows) expect((await openSample(db, KEK, row))?.text).toBe("an answer")
  })

  test("about 2% of requests are drawn", () => {
    const draws = 200_000
    let hits = 0
    for (let i = 0; i < draws; i++) if (drawsSample()) hits++
    const expected = (draws * SAMPLE_PPM) / 1_000_000
    expect(Math.abs(hits - expected)).toBeLessThan(5 * Math.sqrt(expected))
  })

  test("a KEK must be 32 bytes of hex", () => {
    expect(parseKek(undefined)).toBeNull()
    expect(parseKek("short")).toBeNull()
    expect(parseKek("ab".repeat(32))?.length).toBe(32)
  })
})

describe("traffic shape", () => {
  test("keeps parameters and no content", () => {
    const shape = trafficShape({ temperature: 0.73, top_p: 0.91, max_tokens: 300, stream: true, messages: [{ role: "system", content: SECRET }, { role: "user", content: SECRET }], tools: [{ name: SECRET }] })
    expect(shape).not.toContain(SECRET)
    expect(JSON.parse(shape)).toMatchObject({ temperature: 0.7, topP: 0.9, maxTokens: 512, stream: true, system: true, turns: 1, tools: 1 })
  })

  test("an absent parameter stays absent", () => {
    expect(JSON.parse(trafficShape({ messages: [] }))).toMatchObject({ temperature: null, topP: null, maxTokens: null, stream: false, format: null, seed: false })
  })
})
