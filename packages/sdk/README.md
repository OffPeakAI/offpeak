# @offpeak/sdk

TypeScript client for Offpeak: an OpenAI-compatible endpoint for open-weight models served by bonded hosts. It pays by API key, payment channel or `upto`, and checks every signed usage record itself.

```ts
import { Offpeak } from "@offpeak/sdk"

const op = new Offpeak({ baseURL: "https://api.example", apiKey: "op_live_...", deployment: "local" })

const result = await op.chat({ model: "ofm-8b", messages: [{ role: "user", content: "hello" }], max_tokens: 64 })
console.log(result.text)

const report = await op.verifyUsage(result.envelope)
console.log(report.ok, report.reasons)
```

`deployment` says where the contracts live. It defaults to chain 4663, and the client refuses to sign or verify against an address that is not published. Pass `"local"`, or your own `{ contracts, roles }`. `router` sets the expected router signer when the deployment does not name it.

## Paying

| You configure | How a call pays |
|---|---|
| `wallet` and a channel | From the channel. Each request carries a fresh payer proof, and each response gets a voucher. |
| `apiKey` | From your prepaid vault balance. |
| `wallet` alone | `upto`, signed when the router answers 402. The router offers it only from 0.05 USDG. |

A channel comes first when you have one. Window draws always use the API key. Wallets can be a viem `WalletClient` or a local account with `rpcUrl`. Keys stay in the wallet: the router only ever gets signatures.

`op.openai` is a configured `openai` client, and everything above works through it the same way. Offpeak's own stream events are kept out of its chunks. Find the record with `op.usageRecord(chunk.id)`. It never retries by itself, because a retried POST can pay twice.

## Chat options

```ts
await op.chat(params, {
  maxPrice: { inPerM: 150_000n, outPerM: 600_000n }, // µUSDG per 1M tokens, fee included
  flex: "2026-11-02T06:00:00Z",                      // wait for a cheaper hour instead of failing at the cap
  windowId: 7n,                                      // draw a Window first
  windowFallback: true,                              // serve from your balance if the Window runs short
})
```

Above `maxPrice` the call fails with `price_above_cap` and the next cheaper hour in `err.detail`. With `flex` you get `{ queued: true, jobId }`. Set `stream: true` in `params` to get a `ChatStream`: iterate it, then call `final()`.

Failures throw `OffpeakError` with `code`, `status` and `detail`.

## Channels

```ts
const op = new Offpeak({ baseURL, wallet, deployment: "local" })

await op.channels.open(5_000_000n, Math.floor(Date.now() / 1000) + 86_400) // 5 USDG, from your own wallet
await op.chat(params)                                                      // voucher signed and sent after the response
const closed = await op.channels.close()
```

Every channel request carries a proof signed by the payer over its own body and time. The router allows 60 seconds either way, so keep your clock right.

Set `channel: { deposit, expirySeconds }` in the constructor to open on the first call, or `channel: { id, known }` to use a channel you already have. `op.channels.attach(id, { seq, cumulative })` picks one up after a restart. Keep those two numbers from `op.channels.snapshot()`.

`channel.store` keeps the channel across restarts. With `deposit` and `store: fileChannelStore(path)`, a start reuses the kept channel, and deposits again only once that channel has closed or is about to expire. A store that cannot be read stops the start, and so does a kept channel that cannot be read. Without a store, `deposit` opens a new channel in every process. Give each running client its own store.

Attaching reads the channel from the chain, so it needs an RPC. It starts from what the chain shows you have paid, plus `cumulative` if you pass it. Debt from before the attach is never signed by itself, because no record you hold covers it: the router's `owed` shows in `snapshot().unsigned`, and only `op.channels.voucher(owed)` takes it on.

**A voucher is signed only for what verified records cover.** After each response the client checks the record's signatures, cost and leaf, that its host is registered, that it belongs to your wallet and this channel, that it is within any `maxPrice`, and that it was not used before. It also holds the record to the request that paid for it: `promptHash` must match the body you sent, `outputHash` the reply you received, `tokensOut` must fit that request's `max_tokens`, and `ts` must fall while it ran. With the model's tokenizer it recounts both token counts too. When the deployment publishes none, those two counts go unchecked here, and the limit on `tokensOut` still holds. It then signs the reported `owed` only if those records add up to it. If they do not, nothing is signed, `op.channels.snapshot().refused` says why, and the router's credit limit stops further spend.

A `store` also keeps the ids of the records already counted, so the same record cannot be paid for again after a restart. Without one, the time check still turns away a record more than a minute older than the request.

If you stop a stream early, the router bills what it served, and you get no record for that part. The next `owed` is then higher than your records. Check it, then accept it with `op.channels.voucher(owed)`. The same call with no argument sends what is verified, which is how you voucher by hand with `channel: { autoVoucher: false }`.

### Closing

`close()` signs `CooperativeClose`, gets the channel payee's signature from the router, and sends the transaction from your own wallet. It first checks that the transaction is exactly the close you signed.

If the router refuses, has no payee key, cannot be reached, or sends anything else, the client sends `requestClose` from your wallet and tells you:

```ts
if (closed.mode === "challenge") console.log(closed.notice, closed.challengeEndsAt)
```

On that path your deposit stays locked until the 2-hour challenge period ends, so the latest voucher can land. The rest then comes back to you.

## Pay per call with upto

With a wallet and nothing else, `op.chat` signs the Permit2 witness when the router answers 402. Approve Permit2 once with `op.x402.approvePermit2(amount)`.

The 402 quotes the request's maximum cost, and you pay only what the record bills. The router offers `upto` from 0.05 USDG. Below that it offers channels only, and `op.chat` fails with `payment_required` and those offers.

To handle it yourself:

```ts
const { header } = await op.x402.payUpto(requirement, { maxAmount })
// send it as the PAYMENT-SIGNATURE header
```

The requirement comes over the network, so the client checks the token, payee, spender, Permit2 address and `validBefore` against the deployment before signing. It also refuses anything over `uptoCapMicro`, which defaults to 1 USDG. `onUpto` is called with the amount just before signing, and throwing from it refuses the payment, so you can keep your own total.

## Checking usage

```ts
await op.verifyUsage(envelope, { payer, feeBps, recount: { prompt: requestBody, output: { text, toolCalls, finish } } })
await op.proof(reqId) // { ok, onchain, status }
```

`verifyUsage` checks both signatures, the cost math and the leaf. A fee above the default rate fails, and a lower fee passes unless you pin your rate with `feeBps`. `payer` checks the record is yours. `maxPrice` checks the record against the cap you sent. `recount` compares the hashes with your own prompt and output, and fails a record that bills more tokens than you count. It takes the body you sent and rebuilds the body the host received, because that is what `promptHash` covers.

With an RPC, `verifyUsage` also asks `HostRegistry` whether the record's host is registered with that model, because anyone can sign as a key they made up. Without one, `report.notChecked` lists `host_registry`, and the report covers signatures only. Channels always need an RPC, so vouchers never rest on an unregistered host.

A recount fetches the model's tokenizer from `GET /v1/tokenizers/:digest` and refuses files that do not hash to the record's model digest, so it trusts nothing the router says. How content reaches the template follows from the pinned template too. Pass `recount.tokenizer` to use your own. When the deployment publishes no tokenizer for that model, nothing is counted: `report.ok` is false, `report.recount.countsOk` is `null` and `report.notChecked` lists `token_count`. Treat that as not checked, not as a pass.

`op.chat` with `maxPrice` checks the record it gets back and fails with `over_max_price` if the record bills above the cap. The request is already paid for by then, so dispute it. Channel vouchers leave that amount out.

`op.proof` needs the hour to be settled. It checks the proof against the leaf this client holds, then asks `UsageLedger.verifyLeaf` over RPC. `status` is `verified`, `pending`, `local_only` (no RPC, so the chain was not asked), `mismatch` or `not_found`. Set `rpcUrl` or `publicClient`.

`op.usage({ since, limit })` lists your records from the router and needs an API key. `op.fetchUsage(reqId)` gets one record by id. `op.recentUsage(since)` and `op.usageRecord(reqId)` read the records this client has seen in this process.

## Sealed chats

The sealed tier is not switched on yet. `op.sealed` is in this client so it can be tried on a test stack. On the public router, sealed requests answer 501 until a real TDX host with a GPU has passed end to end.

```ts
const op = new Offpeak({ baseURL, apiKey, rpcUrl, sealed: { verifierUrl, gpuVerifierUrl, measurements, modelDigests } })

const hosts = await op.sealed.hosts("ofm-8b") // only hosts that passed every check
const reply = await op.sealed.chat({ model: "ofm-8b", messages, max_tokens: 256 }, { host: hosts[0] })
const stream = await op.sealed.chat({ model: "ofm-8b", messages, stream: true })
await op.sealed.check("ofm-8b") // every host, with the reasons any was refused
```

The prompt is encrypted on your machine to a key inside the host's VM, and the reply is decrypted here. `model`, `max_tokens` and the host's address travel in clear headers, because the router needs them to price and route the request. Message sizes and timing are visible to the router too, though reply frames are padded to one size, so they show a reply's length only to the nearest 200 bytes.

You verify every host yourself. Sealed calls need your own DCAP verification service, your own GPU attestation endpoint, a chain connection for `HostRegistry`, the MRTD, RTMRs and config hash you accept, and the digest you expect for each model name. Without them `op.sealed` throws `sealed_verifier_required` and nothing is sent. `configHash` is in a good host's bindings. An empty `measurements` list, or a model name missing from `modelDigests`, refuses every host.

For each host, this client picks a nonce, asks for a fresh quote through the router, and checks the quotes, TCB status, measurements, config hash, bindings, GPU result, `attestationRef` and model digest. The transcript the router lists is not used. A fresh quote can take most of a minute, so call `hosts()` once and pass a host to `chat`, as above.

`trustRouterVerification: true` skips all of this and takes the router's word that the quotes are genuine. A router that lies can then swap the key and read your prompts, so use it only on a test stack.

A stream that ends before the host's last frame throws `sealed_truncated`. A record that does not describe the bytes you sent and received, names another model, or fails its signatures throws `sealed_record_mismatch`.

Token counts on a sealed record come from the attested host, since the router cannot read the request. The VM signs them with a key that never leaves it, and the router and this client both check that signature. A record that bills more than the VM signed for throws `sealed_counts_mismatch`. The router also checks ciphertext length against those counts and flags outliers. `verifyUsage` cannot recount a sealed record, and it does not see the VM's signature, which comes with the stream.

## Honest limits

- Open-weight models only. Offpeak doesn't sell closed models. Open models trail frontier models on the hardest tasks.
- Prices move. The live price shown at request start is what you pay. Caps protect you, and requests over your cap wait (night jobs) or fail with 429 (interactive).
- Discounts depend on host supply and idle time. With few hosts, discounts are smaller.
- Open hosts can read prompts, and so can Offpeak's router, unless you use the sealed tier with client-side encryption. The sealed tier is not switched on yet.
- Audits are statistical. They catch sustained model swaps, not every single response.
- Usage records are signed by Offpeak's router and the host. You can recount your own requests and dispute any request within 7 days.
- USDG can be frozen by its issuer. Permit2 is a shared dependency.
- During the beta, deposits are capped at 500 USDG per buyer until the external contract audit is complete.

Third-party names describe compatibility only; no affiliation.
