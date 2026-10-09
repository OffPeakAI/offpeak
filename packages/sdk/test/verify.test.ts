import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { LAUNCH_TOKENIZER, feeMicro, leafFor, loadModelTokenizer, parseRecord, readManifest, recordToMessage, domain, usageTypes, type UsageEnvelope, type UsageRecord } from "@offpeak/shared"
import { addressOf } from "@offpeak/abis"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../shared/src/test-keys.ts"
import { ask, bootRouter, buyerAccount, client, inProcess } from "./support.ts"
import { OffpeakError, envelopeSchema, verifyUsage, type ChatResult, type ChatStream } from "../src/index.ts"
import { issueKey } from "../../../apps/router/src/pipeline.ts"

const vectors = JSON.parse(readFileSync(new URL("../../shared/fixtures/vectors.json", import.meta.url), "utf8"))
const ledger = addressOf("UsageLedger")
const router = roleAccount("router")
const host = roleAccount("host")

/** A record both real test keys signed, so a check can only fail on what it is checking. */
async function signed(record: UsageRecord): Promise<UsageEnvelope> {
  const typed = { domain: domain("OffpeakUsage", ledger), types: usageTypes, primaryType: "UsageRecord" as const, message: recordToMessage(record) as never }
  const routerSig = await router.signTypedData(typed)
  const hostSig = await host.signTypedData(typed)
  return { v: 1, record, routerSig, hostSig, leaf: leafFor(record, routerSig, hostSig), hostCounts: { tokensIn: record.tokensIn, tokensOut: record.tokensOut }, sealed: false, proofUrl: `/v1/usage/${record.reqId}` }
}

const verify = (env: UsageEnvelope, opts?: Parameters<typeof verifyUsage>[4]) => verifyUsage(env, ledger, router.address, host.address, opts)

const base = (): UsageRecord => parseRecord(vectors.usage[0].record)

describe("golden vectors", () => {
  test("every vector record passes", async () => {
    for (const row of vectors.usage) {
      const env: UsageEnvelope = { v: 1, record: parseRecord(row.record), routerSig: row.routerSig, hostSig: row.hostSig, leaf: row.leaf, hostCounts: { tokensIn: 0, tokensOut: 0 }, sealed: false, proofUrl: "" }
      const report = await verifyUsage(env, vectors.addresses.contracts.UsageLedger, vectors.addresses.router, vectors.addresses.host)
      expect(report).toMatchObject({ ok: true, routerOk: true, hostOk: true, costOk: true, leafOk: true, reasons: [] })
    }
  })

  test("the voucher signature matches the vector byte for byte", async () => {
    const { channelId, seq, cumulative, signature } = vectors.voucher
    let posted: { sig: string; seq: string; cumulative: string } | null = null
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/voucher")) {
        posted = JSON.parse(String(init?.body))
        return Response.json({ accepted: true })
      }
      return Response.json({ deposit: "1000000", claimed: "0", cumulative: "0", owed: "0", latestSeq: String(BigInt(seq) - 1n), status: 1, expiry: "9999999999" })
    }) as typeof fetch
    const booted = await bootRouter()
    const onChain = { readContract: async () => ({ payer: buyerAccount.address, deposit: 1_000_000n, claimed: 0n, lastSeq: BigInt(seq) - 1n, expiry: 9_999_999_999n, challengeEndsAt: 0n, status: 1 }) }
    const op = client(booted, { fetch: fake, publicClient: onChain as never })
    await op.channels.attach(channelId)
    const receipt = await op.channels.voucher(BigInt(cumulative))
    expect(receipt?.sig).toBe(signature)
    expect(posted!).toEqual({ seq, cumulative, sig: signature })
  })
})

describe("signatures and leaf", () => {
  test("a real router envelope passes through op.verifyUsage", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const { envelope } = (await op.chat(ask("verify me"))) as ChatResult
    expect(await op.verifyUsage(envelope, { payer: booted.buyer })).toMatchObject({ ok: true, payerOk: true })
  })

  test("a record signed by anyone else fails that signature only", async () => {
    const env = await signed(base())
    const report = await verifyUsage(env, ledger, roleAccount("buyer").address, host.address)
    expect(report).toMatchObject({ ok: false, routerOk: false, hostOk: true, reasons: ["router_sig"] })
    const other = await verifyUsage(env, ledger, router.address, roleAccount("buyer").address)
    expect(other).toMatchObject({ ok: false, routerOk: true, hostOk: false, reasons: ["host_sig"] })
  })

  test("a changed record no longer matches either signature", async () => {
    const env = await signed(base())
    const report = await verify({ ...env, record: { ...env.record, tokensOut: env.record.tokensOut + 1 } })
    expect(report.routerOk).toBe(false)
    expect(report.hostOk).toBe(false)
    expect(report.ok).toBe(false)
  })

  test("a signature from the wrong ledger's domain fails", async () => {
    const report = await verifyUsage(await signed(base()), addressOf("OffpeakVault"), router.address, host.address)
    expect(report.routerOk).toBe(false)
  })

  test("garbage signatures fail without throwing", async () => {
    const env = await signed(base())
    const report = await verify({ ...env, routerSig: "0x1234" as Hex, hostSig: "0x" as Hex })
    expect(report).toMatchObject({ routerOk: false, hostOk: false, ok: false })
  })

  test("a wrong leaf fails", async () => {
    const env = await signed(base())
    expect((await verify({ ...env, leaf: keccak256(toBytes("other")) })).reasons).toEqual(["leaf"])
  })

  test("buyerRef must be the payer's", async () => {
    const env = await signed(base())
    expect((await verify(env, { payer: roleAccount("host").address })).reasons).toContain("buyer_ref")
  })
})

describe("cost math", () => {
  test("a host cost that does not follow from the tokens fails", async () => {
    const env = await signed({ ...base(), hostCostMicro: base().hostCostMicro + 1n })
    expect((await verify(env)).reasons).toContain("cost")
  })

  test("a fee over the default rate fails, a lower one passes, and a pinned rate is exact", async () => {
    const record = { ...base(), tokensIn: 100_000, tokensOut: 100_000 }
    const hostCost = record.tokensIn * Number(record.priceIn) / 1_000_000 + record.tokensOut * Number(record.priceOut) / 1_000_000
    const cost = BigInt(Math.ceil(hostCost))
    const at = (bps: number) => signed({ ...record, hostCostMicro: cost, feeMicro: feeMicro(cost, bps) })
    expect((await verify(await at(400))).ok).toBe(true)
    expect((await verify(await at(296))).ok).toBe(true)
    expect((await verify(await at(100))).ok).toBe(true)
    expect((await verify(await at(401))).reasons).toContain("cost")
    expect((await verify(await at(99))).reasons).toContain("cost")
    expect((await verify(await at(296), { feeBps: 296 })).ok).toBe(true)
    expect((await verify(await at(400), { feeBps: 296 })).reasons).toContain("cost")
  })

  test("an audit opt-in buyer's real record passes at its real rate", async () => {
    const booted = await bootRouter()
    const key = await issueKey(booted.stack, booted.buyer)
    await booted.stack.db.query("UPDATE serving.accounts SET audit_opt_in = true WHERE wallet = $1", [booted.buyer])
    const op = client(booted, { apiKey: key.token })
    const { envelope } = (await op.chat(ask("x".repeat(4000), 2000))) as ChatResult
    expect(envelope.record.feeMicro).toBe(feeMicro(envelope.record.hostCostMicro, 296))
    expect((await op.verifyUsage(envelope)).ok).toBe(true)
    expect((await op.verifyUsage(envelope, { feeBps: 296 })).ok).toBe(true)
    expect((await op.verifyUsage(envelope, { feeBps: 400 })).reasons).toContain("cost")
  })

  test("a Window record carries no price at all", async () => {
    const zero = { ...base(), payMode: 4 as const, priceIn: 0n, priceOut: 0n, hostCostMicro: 0n, feeMicro: 0n }
    expect((await verify(await signed(zero))).ok).toBe(true)
    expect((await verify(await signed({ ...zero, feeMicro: 1n }))).reasons).toContain("cost")
    expect((await verify(await signed({ ...zero, priceIn: 1n }))).reasons).toContain("cost")
    expect((await verify(await signed({ ...zero, hostCostMicro: 1n }))).reasons).toContain("cost")
  })
})

describe("local recount", () => {
  async function served() {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const prompt = ask("count me", 16)
    const result = (await op.chat(prompt)) as ChatResult
    return { op, prompt, result, text: result.text! }
  }

  test("your own prompt and output recount to the record", async () => {
    const { op, prompt, result, text } = await served()
    const report = await op.verifyUsage(result.envelope, { recount: { prompt, output: text, tokenizer: LAUNCH_TOKENIZER } })
    expect(report.ok).toBe(true)
    expect(report.recount).toMatchObject({ promptOk: true, outputOk: true, countsOk: true, tokensIn: result.envelope.record.tokensIn, tokensOut: result.envelope.record.tokensOut })
  })

  test("a stream's record recounts from the same body, and the router's output limit is rebuilt", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const prompt = { model: "ofm-8b", messages: [{ role: "user", content: "no limit asked" }], max_completion_tokens: 12 }
    const final = await ((await op.chat({ ...prompt, stream: true })) as ChatStream).final()
    const report = await op.verifyUsage(final.envelope, { recount: { prompt: { ...prompt, stream: true }, output: { text: final.text!, finish: final.finishReason }, tokenizer: LAUNCH_TOKENIZER } })
    expect(report.ok).toBe(true)
  })

  test("a request near the model's context still recounts, because the limit comes from the router's published context", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const prompt = { model: "ofm-8b", messages: [{ role: "user", content: "x".repeat(6000) }] }
    const result = (await op.chat(prompt)) as ChatResult
    expect((await op.verifyUsage(result.envelope, { recount: { prompt, output: result.text!, tokenizer: LAUNCH_TOKENIZER } })).ok).toBe(true)
    const blind = await verifyUsage(result.envelope, ledger, router.address, host.address, { recount: { prompt, output: result.text!, tokenizer: LAUNCH_TOKENIZER } })
    expect(blind.reasons).toEqual(["prompt_hash"])
  })

  test("embeddings recount from their input", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const res = await op.openai.embeddings.create({ model: "ofm-embed", input: "hello embeddings", encoding_format: "float" }).then((reply) => reply as unknown as { offpeak_usage: unknown })
    const envelope = envelopeSchema.parse(res.offpeak_usage)
    const report = await op.verifyUsage(envelope, { recount: { prompt: { input: "hello embeddings" }, output: "", tokenizer: LAUNCH_TOKENIZER } })
    expect(report.ok).toBe(true)
    expect(report.recount?.tokensIn).toBe(envelope.record.tokensIn)
  })

  test("with no published tokenizer the counts read as not checked, never as a pass", async () => {
    const { op, prompt, text, result } = await served()
    const report = await op.verifyUsage(result.envelope, { recount: { prompt, output: text } })
    expect(report.ok).toBe(false)
    expect(report.notChecked).toContain("token_count")
    expect(report.reasons).toEqual(["token_count_not_checked"])
    expect(report.recount).toMatchObject({ promptOk: true, outputOk: true, countsOk: null, tokenizer: "none" })
  })

  test("a tokenizer 404 cannot pass a 4x overbill by falling back to byte counts", async () => {
    const booted = await bootRouter()
    const send = inProcess(booted.app)
    const op = client(booted, { apiKey: booted.key.token, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/v1/tokenizers/") ? new Response("not found", { status: 404 }) : send(input, init))) as typeof fetch })
    const messages = [{ role: "user", content: "x".repeat(400) }]
    const prompt = { model: "ofm-8b", messages, max_tokens: 8 }
    const tokensIn = 100
    const env = await signed({ ...base(), host: host.address.toLowerCase() as Hex, tokensIn, tokensOut: 2, priceIn: 1_000n, priceOut: 1_000n, hostCostMicro: 1n, feeMicro: 1n })
    const report = await op.verifyUsage(env, { host: host.address, recount: { prompt, output: "short" } })
    expect(report.ok).toBe(false)
    expect(report.recount?.countsOk).toBeNull()
    expect(report.reasons).toContain("token_count_not_checked")
  })

  test("the model's published tokenizer counts", async () => {
    const { op, prompt, result, text } = await served()
    const dir = new URL("../../shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/", import.meta.url).pathname
    const tokenizer = loadModelTokenizer(readManifest(`${dir}manifest.json`), dir)
    const real = await op.verifyUsage(result.envelope, { recount: { prompt, output: text, tokenizer } })
    expect(real.recount?.tokenizer).toBe("model")
    expect(real.recount?.tokensIn).toBe(tokenizer.countChat(prompt as never))
  })

  test("a different prompt or output fails", async () => {
    const { op, prompt, result, text } = await served()
    expect((await op.verifyUsage(result.envelope, { recount: { prompt: ask("something else", 16), output: text } })).reasons).toContain("prompt_hash")
    expect((await op.verifyUsage(result.envelope, { recount: { prompt, output: `${text}!` } })).reasons).toContain("output_hash")
  })

  test("a record billing more than you count fails, and one billing less does not", async () => {
    const messages = [{ role: "user", content: "x".repeat(10) }]
    const prompt = { model: "ofm-8b", messages, max_tokens: 8 }
    const count = (tokensIn: number, tokensOut: number) => signed({ ...base(), tokensIn, tokensOut, hostCostMicro: 1n, feeMicro: 1n, priceIn: 1n, priceOut: 1n })
    const over = await verify(await count(500, 500), { recount: { prompt, output: "short", tokenizer: LAUNCH_TOKENIZER } })
    expect(over.reasons).toContain("token_count")
    const under = await verify(await count(1, 1), { recount: { prompt, output: "short", tokenizer: LAUNCH_TOKENIZER } })
    expect(under.reasons).not.toContain("token_count")
  })

  test("a sealed record cannot be recounted from plaintext and says so", async () => {
    const report = await verify({ ...(await signed(base())), sealed: true }, { recount: { prompt: {}, output: "" } })
    expect(report.reasons).toContain("recount_sealed")
    expect(report.ok).toBe(false)
  })
})

describe("input checks", () => {
  test("an envelope that is not one never reaches the voucher path", async () => {
    const booted = await bootRouter()
    const send = inProcess(booted.app)
    const op = client(booted, {
      apiKey: booted.key.token,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await send(input, init)
        const body = (await res.json()) as Record<string, unknown>
        return Response.json({ ...body, offpeak_usage: { v: 1, record: { payMode: 9 } } })
      }) as typeof fetch,
    })
    await expect(op.chat(ask("broken envelope"))).rejects.toThrow()
  })

  test("an unpublished deployment cannot verify", async () => {
    const booted = await bootRouter()
    const { envelope } = (await client(booted, { apiKey: booted.key.token }).chat(ask("hi"))) as ChatResult
    const op = client(booted, { deployment: "4663", apiKey: booted.key.token })
    expect(() => op.verifyUsage(envelope)).toThrow(OffpeakError)
  })

  test("a pinned router address overrides the deployment", async () => {
    const booted = await bootRouter()
    const { envelope } = (await client(booted, { apiKey: booted.key.token }).chat(ask("hi"))) as ChatResult
    const op = client(booted, { router: buyerAccount.address })
    expect((await op.verifyUsage(envelope)).reasons).toContain("router_sig")
  })
})
