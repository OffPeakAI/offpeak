# API

Amounts are decimal strings of µUSDG, and prices are µUSDG per 1M tokens. Errors use the OpenAI shape, `{ error: { message, type, code } }`.

Prepaid buyers send `Authorization: Bearer op_live_…`. Agents pay by channel or x402.

## Chat

`POST /v1/chat/completions` accepts an OpenAI-shaped chat body. `n` greater than 1 is rejected. The output limit is the lowest of what you asked, 4096, and what is left of the model's context.

Every message needs a `role` of `system`, `developer`, `user`, `assistant`, `tool` or `function`, or the request is `400 bad_messages`. `max_tokens` and `max_completion_tokens` must be positive whole numbers, or `400 bad_max_tokens`. A body that cannot be billed is `400 bad_body` before any payment is taken: a number too large to represent, such as `1e999`, or messages the model's chat template refuses. If the host turns a request down with a 4xx, you get `400 host_refused` and nothing is charged.

Every response carries the signed usage record: the `X-Offpeak-Usage` header and `offpeak_usage` in the body, or an event at the end of a stream.

### Streams

A stream ends with `event: offpeak.usage`, then `data: [DONE]`. A channel request also gets `event: offpeak.channel` just before it, with the `owed` figure.

A stock OpenAI client reads every `data:` line as a chunk, whatever its event name, and would fail on a bare envelope. So each `offpeak.*` event is also a valid empty chunk: `id`, `object: "chat.completion.chunk"`, `created`, `model` and `choices: [{ index: 0, delta: {}, finish_reason }]`, with the envelope's fields (or `owed`) alongside. `offpeak.usage` carries OpenAI's `usage` figures too. The first content chunk carries `role: "assistant"`, which OpenAI's stream helpers need.

### What `promptHash` covers

`promptHash` covers the body as sent to the host, not the body you sent. For chat that is your body with `max_completion_tokens` removed, `stream: true`, the output limit in `max_tokens`, and `stream_options: { include_usage: true }`. For embeddings it is `{ model, input: [...], encoding_format }`. The SDK, the dashboard and disputes rebuild this from your body.

## Embeddings

`POST /v1/embeddings` takes `input` as a string or up to 2,048 strings, and bills input tokens only.

## Models and tokenizers

`GET /v1/models` lists compatibility names.

`GET /v1/tokenizers/:digest` gives `{ context_length, tokenizer }`. `tokenizer` holds the model's manifest and the text of its pinned files, or `null` when this deployment publishes none. The files are public. Check them against the record's model digest rather than trusting the router: `tokenizerFromFiles` in `@offpeak/shared` refuses any that do not hash to it, and the SDK and dashboard use it.

## Prices

`GET /v1/prices?model=` gives `{ model, digest, now?, hosts, next168h }`.

- `hosts` lists every host with a sheet in force: `{ host, live, base, floor, effective_discount_30d_bps, sealed }`. The discount is `null` until the nightly job has data for that host. It leaves out Window draws, which carry no price.
- `next168h` is `[{ hour, forecast_in, forecast_out }]`. `hour` is the absolute hour, `floor(unix / 3600)`, starting at the current hour. Each row is the lowest forecast across routable hosts.
- `now` is left out when no routable host has a price.
- Every price is a buyer price, fee included: the default fee, or your own with an API key.
- With no `model`, the first chat model. An unknown model is a 404.

## Usage

`GET /v1/usage/:reqId` gives `{ envelope, proof }`. `envelope` is the record as the response carried it. `proof` is `{ hour, leaf, proof, root, txHash }` once the hour settles, `null` until then. No key is needed: a record names no wallet, and a request id cannot be guessed.

`GET /v1/usage` lists your own records, newest first, with an API key or a signed-in session.

| Query | Meaning |
|---|---|
| `since` | Unix seconds or ISO 8601 |
| `limit` | 1 to 100, default 50 |
| `before_ts`, `before_id` | Carry on from the `next` of the last page |

It answers `{ records: [{ envelope, status }], next }`. `next` is `null` on the last page. A wallet paying by channel alone has no key, so it keeps its own records.

## Recounting a request

Three ways, all using the model's real tokenizer:

- **Dashboard:** open a record under Usage and choose Recount this request. Everything pasted stays in your browser unless you then dispute with it.
- **SDK:** `op.verifyUsage(envelope, { recount: { prompt, output: { text, toolCalls, finish } } })`. `prompt` is the body you sent.
- **MCP:** `offpeak_complete` recounts every call. `offpeak_usage` takes `recount` with `req_id`.

`recount.tokenizer` in the report is `model`, or `byte` when the deployment publishes no tokenizer for that model. A byte count sits above a real one, so it cannot show an overcharge.

## x402 and channels

An unpaid request gets a 402 with `channel` listed first, after the same checks a paid one gets: an unknown model is a 404, and a price over your cap is a 429.

The 402 for chat quotes the request's real maximum cost: input bytes as an upper bound on input tokens, the output limit, the dearer of the two hosts it could fail over between, and the fee, plus 10% so a price that rises before your paid retry does not refuse it. `upto` captures only what the record bills.

`upto` is offered only from 0.05 USDG, as the build doc sets. Below that the 402 offers channels only, which covers most single chat calls. Embeddings also offer `exact`.

A wallet can have 8 x402 payments waiting for the chain at once. One more is `429 unconfirmed_limit`, and a slot frees when the chain answers. A stream's pre-confirmation budget counts the input's cost as well as the output's.

`GET /v1/channels/:id` gives `{ deposit, claimed, cumulative, owed, latestSeq, status, expiry, closing }`. `cumulative` is the latest accepted voucher. `owed` adds what has been served but not vouchered.

`POST /v1/channels/:id/voucher` takes `{ seq, cumulative, sig }`.

`POST /v1/channels/:id/close` takes `{ finalCumulative, deadline, payerSig }`, with both amounts as decimal strings, and gives `{ routerSig, to, data, value, chainId }` for your own wallet to send. `routerSig` keeps the contract's parameter name, and is signed by the channel payee key. A router with no payee key answers `503 close_unavailable`, and the buyer uses `requestClose` and the 2-hour challenge.

## Night jobs

`POST /v1/batches` honours `metadata.offpeak_deadline` (ISO 8601, up to 7 days out; default 24 hours) and `X-Offpeak-Max-Price` or `metadata.offpeak_max_price` (`in=0.15,out=0.60`). Plans use only whole hours that end 30 minutes before the deadline. No such hour is `400 no_hours`. A locked price over the cap is `429 price_above_cap` with `cheapest_deadline`, and nothing is created. A chat request with `X-Offpeak-Flex` waits for its cap instead: when the plan's average is over the cap, the job locks at the cap, its lines run only in an hour whose live price is at or under that, and any left at the deadline lapse unbilled.

`POST /v1/files` holds up to 200 files and 512 MiB per account, and past that answers `429 file_quota`. A job's input file goes when the job ends, and any other file after 7 days.

## Disputes

`POST /v1/disputes` takes `{ req_ids, reason, material? }` with a signed-in session. `material` is `{ prompt, output, tool_calls?, finish? }`, and `prompt` is the body you sent. The router recounts with the model's tokenizer. The dashboard's `disputes.open` takes the same `material`.

## Hosts

`POST /v1/hosts/price-sheet` takes `{ sheet, sig }` with amounts as decimal strings, which is what `offpeak-host price-sheet set` posts. It answers `{ ok: true, sheetHash }`, or 400 with `{ ok: false, error }`. `error` is one of `floor_above_0_6_min_base`, `valid_from_too_soon`, `nonce_not_increasing`, `weekly_sheet_limit`, `bad_signature`, `bad_length`, `base_not_positive`, `bad_sheet` or `host_not_registered`, which means the sheet's host is not in the registry or has been delisted. The nonce must rise per host and model, and a host gets 24 changes a week.

`POST /v1/hosts/audit-response` takes `{ challengeId, response }` and gives `AuditCourt.respond` calldata for this deployment's court.

`POST /v1/keys` makes a key and leaves your audit choice as it was.

## Status

`GET /v1/status` reports feature flags. `token_hooks` stays off until counsel review.

`GET /v1/audits/calibration` publishes the audit test id and version, thresholds, baselines, the latest calibration report for each model, and the live false-flag counts. `status` stays `not_calibrated` until a calibration on real GPU hosts passes its gates. Until then the thresholds are placeholders, and any simulated figure describes the method on synthetic data, not real swaps.

## Sealed tier

The sealed tier is not switched on yet. `GET /v1/status` reports `sealed: false`, and sealed requests answer 501 with `sealed_unavailable`.

Sealed chats are `POST /v1/chat/completions` with `content-type: application/offpeak-hpke` and three clear headers: `X-Offpeak-Model`, `X-Offpeak-Max-Tokens` (1 to 4096) and `X-Offpeak-Sealed-Host`. The body is `0x01 ‖ clientTimeMs(u64 BE) ‖ enc(32) ‖ ciphertext`, in RFC 9180 base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM and `info = "offpeak-hpke/v1"`. The AAD is the first 9 bytes followed by the ASCII path, `/v1/chat/completions`.

The reply is `application/offpeak-hpke-stream`: `responseNonce(16)`, then frames of `flag(1) ‖ len(u32 BE) ‖ ct`, keyed from `context.Export("offpeak-hpke/v1 response", 16)` through HKDF with salt `enc ‖ responseNonce` and info `offpeak-hpke/v1 response`, taking 28 bytes as a 16-byte key and a 12-byte base nonce. Each frame's nonce is the base nonce XOR the frame index, and its AAD is its own 5-byte header, so the last-frame flag cannot be changed in transit. Flag `0x00` is data and `0x01` is the host's last frame. Each frame's plaintext is `dataLen(u16 BE) ‖ data ‖ zeros`, always 202 bytes, so every host frame is 223 bytes on the wire. The frames carry the engine's SSE stream cut at fixed 200-byte offsets, not at its events, so a frame's size says nothing about the token inside it. The last frame holds whatever is left.

After the last frame the router adds one clear frame of its own, flag `0x02`, with JSON instead of ciphertext: `{ usage, counts, channelOwed? }`, or `{ error }` when the request ended unbilled. That frame is outside `outputHash`. `counts` is what the VM signed, described below.

Admission, holds and capture are the ordinary ones. The hold is priced from the ciphertext length and `X-Offpeak-Max-Tokens`, counting the request's bytes plus 256 as its input tokens, and the VM refuses a body that names another model and caps `max_tokens` at that header. The VM counts the input before the engine runs. A body it cannot count, or that counts past that input limit, answers 400 with `uncountable`, and a body nested more than 64 levels deep answers 400 with `bad_request`. The client names the host because it encrypted to that host's key, so there is no failover. Night jobs cannot be sealed. `upto` pauses on ciphertext bytes, which is stricter than tokens.

The router cannot count tokens on ciphertext, so sealed records use the attested host agent's counts, signed inside the VM. `counts` is `{ reqId, tokensIn, tokensOut, promptHash, outputHash, sig }`, where `sig` is an EIP-191 signature over the canonical JSON of those fields without `sig`, plus `domain: "offpeak-sealed-counts/v1"`. The key is made in the VM at boot and never leaves it, and its address is `countsSigner` in the bindings. The operator key lives outside the VM, so it cannot stand in. The router bills nothing and flags `sealed_bad_counts` when the signature fails or the counts are for another request, and `sealed_output_hash` when a finished stream's counts cover other bytes. It stops input at the same limit the hold used, for Windows too, and flags `over_input_ceiling` if the VM reported more. The SDK checks the same signature when a stream closes, and throws `sealed_counts_mismatch` if a record bills more than the VM signed for. The signature is not in the envelope, so `verifyUsage` on its own still sees only the router's and the operator's.

The router also checks that ciphertext length is consistent with those counts, leaving out the bytes no token accounts for, and flags outliers in `serving.metering_flags` with the reason `sealed_length_outlier`. The range is the model's `sealedBytesPerToken`, or 1 to 512 bytes per token outside production. In production a model with no range answers 503 with `sealed_no_length_range`, and no sealed request is served for it. A request has one flag row, and its reasons are comma-separated. `promptHash` and `outputHash` are keccak256 over the request bytes and the host's response bytes, and `sealed` is true in the envelope.

`GET /v1/sealed/hosts?model=` lists hosts the router has verified: `{ enabled, note?, hosts: [{ host, modelDigest, hpkePublicKey, attestationRef, tcbStatus, verifiedAt, transcript }] }`. A transcript holds a fresh quote under the router's nonce, the boot quote, both sets of bindings, the GPU evidence, the registry values and the verdicts. Hosts are checked when first seen, every 24 h, and whenever the running boot changes. With `OFFPEAK_TDX_VERIFIER_URL` or `OFFPEAK_GPU_ATTESTATION_URL` unset, or an empty `OFFPEAK_SEALED_MEASUREMENTS`, no host is listed.

The bindings are `{ v, modelDigest, imageDigest, operator, hpkePublicKey, countsSigner, configHash, gpuEvidenceHash }`. `configHash` is `sha256(canonicalJson({ modelName, engine, tsmRoot, gpuTool }))`, which covers everything in `host.yaml` that decides where decrypted bytes go. Each row of `OFFPEAK_SEALED_MEASUREMENTS`, and of the SDK's `measurements`, is `{ imageDigest, mrtd, rtmrs, configHash }`, so a host with a changed configuration does not pass. A sealed agent will not boot unless its engine is `http://127.0.0.1` with no proxy in its environment, and the GPU evidence command is fixed in the image.

A client that checks hosts itself takes its own quote. It sends `POST /v1/chat/completions` with `content-type: application/offpeak-hpke`, `X-Offpeak-Sealed-Host`, `X-Offpeak-Attest-Nonce` (32 bytes of hex) and no body. The router passes on the host's `GET /offpeak/v1/attest` reply for that nonce: `{ nonce, hpkePublicKey, bindings, quote, gpuEvidence, boot }`. It answers 400 with `bad_sealed_headers`, or 503 with `sealed_host_unavailable` or `no_attestation`, and 501 while the tier is off.
