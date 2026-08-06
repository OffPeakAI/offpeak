# OFFPEAK ($OFPK) build document B: Serving and product

**Audience:** Developer B and the AI coding agent they hand this file to. This document is self-contained: with only this file, the agent can build and test everything Doc B owns. A second document (Doc A, "Chain and settlement") covers the smart contracts, settlement, the x402 facilitator, the chain indexer and keepers. The two meet only at section 3, the interface contract, which is identical in both.

**What Offpeak is, in one paragraph.** An OpenAI-compatible inference endpoint for open-weight models served from real, bonded GPU hosts. Each host posts a price for every hour of the week; the router measures load, and idle hosts drop to at least 40% below their posted price. Buyers prepay USDG on Robinhood Chain (chain id 4663) into a vault that stays theirs to withdraw; agents can pay per call with no key over x402 (payment channels first, `upto` as fallback). Every response carries a signed usage record; hourly Merkle roots and settlement go on-chain. Hosts post bonds and are audited for model swaps. Windows are tradable reservations of future capacity. $OFPK is a utility token (fee tiers, extra host bond weight, early Window access), never a share of fees.

**How to use this document.** Build in the milestone order in section 7. Every module in section 4 lists the functions, data shapes, rules and tests it needs. Section 5 lists the tests; section 6 the launch gates; section 8 is a "do not" list. Treat section 3 as frozen: if you need to change it, stop and open an interface-change PR. Until Doc A's live services exist, use the mocks in 3.11.

**Commit identity.** All commits in this project use the project identity, never a personal one:

```bash
git config user.name  "ALIAS Contributor"
git config user.email "contributor@offpeak.invalid"
```

Before any push: run `gitleaks detect --redact` over the full history and `bun run scan:names` (greps history and tree for a deny list of personal names, emails and machine paths kept outside the repo in `~/.offpeak-denylist`). A non-empty result blocks the push.

---

## 1. Goals

### 1.1 Doc B delivers
1. `apps/router`: OpenAI-compatible API (`/v1/chat/completions` with streaming, tools and JSON mode; `/v1/embeddings`; `/v1/batches` + `/v1/files` for night jobs; `/v1/models`), Offpeak API, host API, x402 and channel payment handling, signed usage records, hour close.
2. Pricebook and load measurement: signed price sheets, router-measured utilisation, live prices, forecasts, effective-discount stats.
3. Billing: holds and capture against the on-chain reserve (read through Doc A's indexer API), channel vouchers, `upto` with a pre-confirmation budget, Window draw-down.
4. `apps/scheduler`: night jobs with a price locked at scheduling time and spread across cheap hours.
5. `apps/host-agent`: runs beside vLLM with a pinned image and GPU class, verifies model files against digests, meters and signs usage, serves health, and for the sealed tier produces TDX + GPU attestation and an HPKE key.
6. `apps/auditor`: likelihood audits, disguised canaries, sequential testing, calibration, evidence bundles, and challenge filing through `AuditCourt`.
7. Postgres/Timescale schema `serving`, writes to schema `shared` per 3.6.
8. `packages/sdk` (TypeScript) with usage verification, channel and `upto` payment helpers, and client-side encryption for the sealed tier; `packages/mcp` MCP tools.
9. `apps/web`: dashboard (balance, caps, withdraw, usage with verification, API keys, channels, Windows, disputes) and the public price page.
10. `tools/usage-faker`, the mock host engine, and `bun run lint:claims`.

### 1.2 Non-goals for Doc B
Solidity, the settlement signers, the facilitator internals, the chain indexer and keepers (Doc A). Doc B never sends transactions on behalf of users; it returns calldata for the user's wallet to sign. Doc B's only on-chain writes are the auditor's `AuditCourt.challenge` filings and the host agent operator's own host transactions (registration, price sheets are off-chain signatures, credit withdrawal).

### 1.3 Design decisions this document fixes (requirements)
1. **Withdraw-all.** The router stops serving a buyer within 1 s of `WithdrawAllRequested` (fast-lane push). Records keep their true start `ts`; no record for that buyer may start after the request time. Settlement may debit the request hour up to the request time (Doc A).
2. **Agents pay through channels first.** The 402 response lists `channel` first. `upto` is offered only when the request's maximum cost is ≥ 0.05 USDG, and its on-chain `authorize` never sits in front of the first token: verify off-chain (≤ 40 ms), start serving, stream up to a pre-confirmation budget of 256 output tokens or 0.02 USDG, then pause until `Authorized` arrives.
3. **Channel challenge period.** The router writes every accepted voucher to `shared.channel_state` at once so Doc A's keeper can claim during the 2-hour challenge period after a payer's `requestClose`. The router stops accepting new requests on a channel after `CloseRequested` or within 2 h of `expiry`.
4. **No 100% slash without human review.** The auditor files; ruling keys rule; a human panel must confirm any 100% swap slash. The auditor's job is to keep false flags ≤ 1% per host-week and to supply two independent signals before filing a swap.
5. **Window resale fee** shown everywhere as "1% of the sale price + 10% of your markup".
6. **Floor rule:** `floorIn ≤ 0.6 × min(baseIn[0..167])` and `floorOut ≤ 0.6 × min(baseOut[0..167])`. The pricebook rejects sheets that break it.
7. **Calendar:** 16 weeks with checkpoints (3.12).

---

## 2. Stack and repository layout

### 2.1 Stack
- **Runtime:** Bun ≥ 1.3, TypeScript strict, ESM.
- **HTTP:** Hono 4 for the public OpenAI-compatible and Offpeak APIs (streaming via `streamSSE`); tRPC v11 (`@hono/trpc-server`) for the web dashboard's authenticated procedures (`account.*`, `keys.*`, `usage.*`, `channels.*`, `windows.*`, `disputes.*`, `hosts.*`).
- **DB:** Postgres 16 + TimescaleDB with Drizzle ORM and drizzle-kit; PGlite for unit tests.
- **Queue/cache:** Redis 7 + BullMQ (scheduler, auditor, hour close, retention jobs); Redis Lua scripts for atomic holds.
- **Chain:** viem 2 for reads, EIP-712 signing and verification. Contract ABIs from `@offpeak/abis` only.
- **Inference:** vLLM OpenAI-compatible server in a pinned container image (by digest) on the host; the host agent is a Bun process in the same compose project.
- **Tokenizers:** `@huggingface/transformers` tokenizer + chat template loading from the model's public `tokenizer.json` / `tokenizer_config.json` (pinned by sha256 in the model manifest).
- **Crypto:** `@hpke/core` (RFC 9180) for the sealed tier; WebCrypto underneath; no hand-written primitives.
- **Web:** Vite + React 19 + TanStack Query + wagmi/viem; static build served by Hono; Sign-In with Ethereum (EIP-4361) sessions.
- **MCP:** `@modelcontextprotocol/sdk` (stdio and streamable HTTP).
- **Validation:** zod 4 on every input.

### 2.2 Monorepo layout (whole project; Doc B owns the rows marked B)

```
offpeak/
  packages/
    shared/        (A+B)       # see section 3
    abis/          (A)         # generated ABIs + deployments (read-only for B)
    sdk/           (B)         src/{client.ts, verify.ts, proofs.ts, channel.ts, upto.ts, sealed/{attest.ts, hpke.ts, stream.ts}}
    mcp/           (B)         src/{server.ts, tools/*.ts}
    audit-tests/   (B)         # versioned statistical tests; Doc A's ruling service executes them
  apps/            (B)
    router/        src/
      main.ts  app.ts  env.ts  context.ts
      openai/      chat.ts  embeddings.ts  batches.ts  files.ts  models.ts  stream.ts  tools.ts  json-mode.ts
      offpeak/     prices.ts  usage.ts  windows.ts  disputes.ts  status.ts  channels.ts
      hosts-api/   register.ts  price-sheet.ts  payouts.ts  audit-response.ts
      auth/        keys.ts  siwe.ts
      pay/         prepaid.ts  holds.lua  x402.ts  channel.ts  window.ts  quote.ts
      pricing/     pricebook.ts  load.ts  live.ts  forecast.ts  stats.ts
      routing/     select.ts  health.ts  hostclient.ts
      metering/    tokenize.ts  records.ts  hourclose.ts
      chainview/   indexer-client.ts  push.ts
      trpc/        router.ts  procedures/*.ts
    scheduler/     src/{main.ts, plan.ts, run.ts}
    host-agent/    src/{main.ts, config.ts, digest.ts, gpu.ts, proxy.ts, meter.ts, sign.ts, health.ts, cli.ts, mock-engine.ts,
                        sealed/{tdx.ts, gpu-evidence.ts, hpke.ts, bindings.ts}}
    auditor/       src/{main.ts, sample.ts, score.ts, sequential.ts, calibrate.ts, canaries.ts, corpus.ts, evidence.ts, file.ts}
    web/           src/{pages/*, components/*, lib/*}
  db/serving/      (B)         schema.ts + migrations
  tools/usage-faker/ (B)
  tools/lint-claims.ts (B)
```

### 2.3 Root scripts Doc B must provide
`router:dev`, `scheduler:dev`, `auditor:dev`, `host:dev [--mock-engine]`, `web:dev`, `db:serving`, `tools:usage-faker`, `lint:claims`, `test:b`, `test:integration` (shared), `load:router`.

## 3. Interface contract (identical in Doc A and Doc B)

> This section is copied word for word into both build documents. Neither developer changes it alone. A change needs a pull request that edits `packages/shared` and this section in both documents, approved by both owners (`CODEOWNERS` lists both people for `packages/shared/**` and `docs/build/**`). When the code and this text disagree, the golden vectors in `packages/shared/fixtures/` decide, and the text gets fixed.

### 3.1 Ownership map

| Area | Owner | Consumer |
|---|---|---|
| `contracts/**` (Foundry), `packages/abis` (generated ABIs + deployment JSON) | A | B reads ABIs, never edits |
| `services/settlement`, `services/facilitator`, `services/indexer`, `services/keepers` | A | B calls the HTTP APIs in 3.8 and 3.9 |
| `apps/router`, `apps/host-agent`, `apps/auditor`, `apps/scheduler`, `apps/web`, `packages/sdk`, `packages/mcp` | B | A runs them only in integration tests |
| `packages/shared` (types, zod schemas, EIP-712 typed data, Merkle, money math, fixtures) | A and B jointly | both |
| `packages/audit-tests` (statistical tests by `testId`: `score(samples, baseline) → {statistic, threshold, flagged}`, pure and deterministic) | B | A's ruling service executes a pinned version |
| Postgres schema `shared` (3.6) | B writes, A reads (except the columns marked A-writes) | both |
| Postgres schema `chain` | A | B reads through the indexer API only, never by SQL |
| Postgres schema `serving` | B | A never reads it |

One monorepo, `offpeak/`, Bun workspaces. Both devs push to it. Private by default.

### 3.2 Units, time and hashing rules

- **Money.** USDG has 6 decimals. Every on-chain and shared amount is an integer in USDG base units ("micro", µUSDG). TypeScript type `Micro = bigint`. Solidity `uint128` for amounts, `uint256` only at the ERC-20 boundary. Never use floats for money anywhere.
- **Prices.** `PricePerM = bigint`, µUSDG per 1,000,000 tokens (so $0.20 per 1M tokens = `200000n`). Stored as `uint64`.
- **Request cost.** `hostCostMicro = ceilDiv(tokensIn * priceIn + tokensOut * priceOut, 1_000_000n)`, minimum `1n` when any tokens were served. `feeMicro = ceilDiv(hostCostMicro * feeBps, 10_000n)`. Buyer pays `hostCostMicro + feeMicro`. `feeBps` defaults to `400` (4%); `296` for audit-sampling opt-in buyers (1% off the buyer total, funded from the fee); minus the $OFPK tier discount from `OfpkHooks.feeDiscountBps(payer)`; never below `100`. Implement once in `packages/shared/src/money.ts`; both sides import it.
- **Hours.** `hour = floor(unixSeconds / 3600)` (a `uint64` hour index, UTC). Hour of week `how ∈ [0,167]`: `days = floor(ts / 86400)`, `dow = (days + 3) mod 7` (Monday = 0), `how = dow * 24 + floor((ts mod 86400) / 3600)`. A request belongs to the hour of its **start** timestamp.
- **Addresses.** Lowercase `0x` hex in the database and JSON. Checksummed only in UI.
- **Hex.** `bytes32` values are `0x` + 64 lowercase hex chars.
- **Digests.** `modelDigest = keccak256(abi.encode(weightsSha256, tokenizerSha256, chatTemplateSha256))` where each input is the sha256 of the canonical file manifest (sorted `path\tsha256\n` lines). `imageDigest` = the OCI image digest bytes (`sha256:` stripped, as bytes32). `gpuClass = keccak256(utf8(name))` for names in the GPU class list (3.10).
- **Prompt and output hashes.** `promptHash = keccak256(utf8(canonicalJson(requestBodyAsSentToHost)))`; `outputHash = keccak256(utf8(concatenatedOutputText + "\u0000" + canonicalJson(toolCalls ?? [])))`. Canonical JSON = keys sorted, no whitespace, UTF-8 (RFC 8785 subset). For sealed-tier requests both hashes are over the ciphertext bytes instead, and `sealed = true` in the record's off-chain envelope.
- **Merkle.** OpenZeppelin `MerkleProof`-compatible: sorted-pair keccak256, leaves double-hashed, odd node promoted. Leaves ordered by `reqId` ascending. Empty hour → no root posted, `records = 0` batch still settles (zero root allowed only when `records == 0`).

### 3.3 EIP-712 domains

All domains use `chainId = 4663` (local anvil also runs with `--chain-id 4663`, see 3.11) and `version = "1"`.

| Domain `name` | `verifyingContract` | Signed types | Signer(s) |
|---|---|---|---|
| `OffpeakUsage` | `UsageLedger` | `UsageRecord`, `HourClose` | router key and host key (both) / router key |
| `OffpeakSettlement` | `OffpeakVault` | `SettleBatch`, `RefundBatch`, `RewardBatch` | 2 of 3 settlement keys |
| `OffpeakChannel` | `ChannelManager` | `Voucher`, `CooperativeClose` | payer (voucher); payer + channel payee (coop close) |
| `OffpeakPriceSheet` | `HostRegistry` | `PriceSheet` | host operator key |
| `OffpeakAudit` | `AuditCourt` | `Ruling`, `PanelDecision` | 2 of 3 ruling keys / panel multisig (EIP-1271) |
| `OffpeakWindows` | `WindowMarket` | `WindowPerformance` | 2 of 3 settlement keys |
| Permit2 (`Permit2`, no version) | Permit2 canonical address | `PermitWitnessTransferFrom` with `UptoWitness` / `ExactWitness` / `ChannelOpenWitness` | payer |

Typed-data definitions (`packages/shared/src/eip712.ts`, mirrored as Solidity typehash constants):

```
UsageRecord(bytes32 reqId,bytes32 buyerRef,address host,bytes32 modelDigest,uint32 tokensIn,uint32 tokensOut,bytes32 promptHash,bytes32 outputHash,uint64 priceIn,uint64 priceOut,uint64 hostCostMicro,uint64 feeMicro,uint8 payMode,bytes32 payRef,uint64 ts,bytes32 sheetHash)

HourClose(uint64 hour,uint32 records,bytes32 root,bytes32 totalsHash)

SettleBatch(uint256 chainId,address vault,uint64 hour,bytes32 root,bytes32 totalsHash,Debit[] debits,Credit[] credits,WindowDraw[] windowDraws,uint128 fees,uint128 agentPoolDraw,uint128 reserveDraw,bytes32 agentPaymentsHash)
Debit(address buyer,uint128 amount,uint64 lastTs)
Credit(address host,uint128 amount)
WindowDraw(uint256 windowId,address holder,uint64 tokens)
RefundBatch(uint64 batchId,Refund[] refunds)
Refund(address payer,uint128 amount,bytes32 refundId)
RewardBatch(uint64 week,Credit[] credits)

Voucher(bytes32 channelId,uint64 seq,uint128 cumulative)
CooperativeClose(bytes32 channelId,uint128 finalCumulative,uint64 deadline)

PriceSheet(address host,bytes32 modelDigest,uint64[168] baseIn,uint64[168] baseOut,uint64 floorIn,uint64 floorOut,uint64 validFrom,uint64 nonce)

Ruling(uint256 challengeId,uint8 outcome,uint16 slashBps,bytes32 refundRoot,bytes32 reasonHash)
PanelDecision(uint256 challengeId,uint8 decision,uint16 finalSlashBps,bytes32 refundRoot,bytes32 reasonHash)

WindowPerformance(uint256 windowId,uint32 measuredSeconds,uint32 belowMinSeconds,bytes32 evidenceRoot)

UptoWitness(bytes32 reqId,address payee,uint256 maxAmount,uint64 validBefore,bytes32 resourceHash)
ExactWitness(bytes32 reqId,address payee,uint256 amount,uint64 validBefore,bytes32 resourceHash)
ChannelOpenWitness(bytes32 channelSalt,address payee,uint64 expiry)
```

Notes that both sides must follow:
- `payMode`: `0` prepaid vault, `1` x402 upto, `2` x402 exact, `3` channel, `4` window draw-down.
- `payRef`: `0x0` for prepaid; the Permit2 `reqId` for x402; the `channelId` for channels; `bytes32(windowId)` for windows.
- Window draw-down records (`payMode 4`) carry `priceIn = priceOut = hostCostMicro = feeMicro = 0` (the Window was paid at purchase); settlement draws `tokensIn + tokensOut` from the holder's Window.
- `buyerRef = keccak256(abi.encode(payerAddress, reqId))`. The payer can recompute it; an outsider cannot link leaves to a wallet. The payer address itself lives only in the `shared.usage_records` row and in the `Debit` list.
- Permit2 witness type strings (exact bytes, Permit2 requires the referenced types in alphabetical order):
  - `"UptoWitness witness)TokenPermissions(address token,uint256 amount)UptoWitness(bytes32 reqId,address payee,uint256 maxAmount,uint64 validBefore,bytes32 resourceHash)"`
  - `"ExactWitness witness)ExactWitness(bytes32 reqId,address payee,uint256 amount,uint64 validBefore,bytes32 resourceHash)TokenPermissions(address token,uint256 amount)"`
  - `"ChannelOpenWitness witness)ChannelOpenWitness(bytes32 channelSalt,address payee,uint64 expiry)TokenPermissions(address token,uint256 amount)"`
  - The Permit2 `spender` is always the Offpeak contract that calls Permit2 (`X402Escrow` or `ChannelManager`).
- Threshold signatures (`SettleBatch`, `WindowPerformance`, `Ruling`): `bytes thresholdSig` = concatenation of exactly two 65-byte ECDSA signatures by two distinct members of the 3-key set, ordered by signer address ascending. Contracts reject duplicates, non-members, unsorted order and malleable `s`.
- `totalsHash = keccak256(abi.encode(RootTotals))` with
  `RootTotals{uint32 records; uint64 tokensIn; uint64 tokensOut; uint128 prepaidDebit; uint128 agentCollected; uint128 windowDrawn; uint128 hostCredit; uint128 fees}`.
- Usage leaf: `leaf = keccak256(bytes.concat(keccak256(abi.encode(usageStructHash, keccak256(routerSig), keccak256(hostSig)))))`.
- `agentPaymentsHash = keccak256(abi.encode(bytes32[] paymentIds))`, sorted ascending, the x402 `reqId`s and channel payment ids drawn from the agent pool (collected) or written off against the protocol reserve (uncollected 24 h after their usage hour) by this batch (3.5).
- Batch conservation, checked on-chain: `Σ debits actually taken + shortfall cover + agentPoolDraw + reserveDraw == Σ credits + fees`. `credits` and `fees` cover prepaid records of hour `H` plus the agent records whose payments this batch draws or writes off. Window draw-downs are paid from Window escrow inside `WindowMarket.applyDraws` and are not in `credits`.
- Debit order: `debits` sorted by buyer ascending, unique; `credits` sorted by host ascending, unique.

### 3.4 UsageRecord envelope (what every response carries)

Every successful response (JSON or stream) returns the record. Non-stream: header `X-Offpeak-Usage: <base64url(JSON envelope)>` and body field `offpeak_usage`. Stream: a final SSE event `event: offpeak.usage` before `data: [DONE]`.

```ts
// packages/shared/src/usage.ts
export type UsageRecord = {
  reqId: Hex;            // keccak256(utf8(ulid)) chosen by the router
  buyerRef: Hex;
  host: Hex;             // host operator address
  modelDigest: Hex;
  tokensIn: number;      // router's own count with the model's public tokenizer
  tokensOut: number;
  promptHash: Hex;
  outputHash: Hex;
  priceIn: bigint;       // live PricePerM at request start (host price, before fee)
  priceOut: bigint;
  hostCostMicro: bigint;
  feeMicro: bigint;
  payMode: 0 | 1 | 2 | 3 | 4;
  payRef: Hex;
  ts: number;            // unix seconds, request start
  sheetHash: Hex;        // EIP-712 hash of the PriceSheet used
};
export type UsageEnvelope = {
  v: 1;
  record: UsageRecord;   // bigints as decimal strings in JSON
  routerSig: Hex;        // EIP-712 OffpeakUsage, router key
  hostSig: Hex;          // EIP-712 OffpeakUsage, host operator key (host agent signs the same struct)
  leaf: Hex;
  hostCounts: { tokensIn: number; tokensOut: number }; // host's own counts, for disputes
  sealed: boolean;
  proofUrl: string;      // GET /v1/usage/{reqId} returns record + Merkle proof once the hour is posted
};
```

Rules: the router counts tokens independently. If the host's counts differ from the router's by more than `max(2, 0.5%)` the router bills its own count, flags the request (`serving.metering_flags`) and the auditor may file a metering challenge. Both signatures are over the router's counts; a host agent refuses to sign counts more than `max(2, 0.5%)` away from its own (the request is then served unbilled and flagged).

### 3.5 Settlement handoff (router → settlement)

The handoff is a Postgres table plus a Redis stream notice. No HTTP between router and settlement.

1. The router inserts one row per finished, billable request into `shared.usage_records` **in the same transaction** that captures the hold (prepaid) or marks the agent payment collected-pending (x402/channel). `status = 'final'`.
2. It `XADD`s `offpeak:usage` `{reqId, hour}` (notice only; the table is the truth).
3. An hour `H` closes at `(H+1)*3600 + 600` seconds (10-minute grace for streams that started in `H`; the router hard-caps any request at 10 minutes). At close the router inserts `shared.usage_hours(hour, records, root, totals, router_close_sig)` with an `HourClose` signature. After that, inserts for hour `H` are refused by a trigger.
4. Agent payments: the router writes one `shared.agent_payments` row per x402 payment and per accepted channel voucher (`amount_micro` = Σ host cost + fee of the records it covers). When the facilitator captures an x402 payment or a keeper lands a channel claim covering that voucher's `seq`, A writes `collected_tx` and `collected_hour`. Each `SettleBatch` draws from the agent pool every collected payment not yet drawn, regardless of its usage hour; a payment still uncollected 24 h after its usage hour is written off (`written_off_hour`) and its hosts are paid from the protocol reserve (`reserveDraw`). Both kinds are listed in `agentPaymentsHash`.
5. Each of the three settlement signers independently reads hour `H`, recomputes the root and totals from rows, verifies every `routerSig` and `hostSig`, checks against `usage_hours`, computes debits, credits, window draws and agent draws, and signs `SettleBatch`. Any one signer can submit once it holds two signatures. Target: posted by `(H+1)*3600 + 3300` (55 minutes after the hour ends).
6. After the batch lands, A writes `shared.usage_records.settled_hour_tx` (A-writes column) and the indexer serves Merkle proofs.
7. Voids: the router may set `status = 'void'` only before the hour closes (for example, a host-signature failure). After close, corrections go through disputes (3.6 `shared.refunds`).

### 3.6 Shared tables (Postgres 16 + Timescale; schema `shared`)

DDL lives in `packages/shared/sql/shared.sql`, applied by a migration both apps run (`bun run db:shared`). Drizzle definitions in `packages/shared/src/db.ts`.

```sql
CREATE SCHEMA IF NOT EXISTS shared;

CREATE TABLE shared.usage_records (
  req_id          text PRIMARY KEY,               -- bytes32 hex
  hour            bigint NOT NULL,
  ts              bigint NOT NULL,                -- unix seconds, request start
  payer           text NOT NULL,                  -- lowercase address (vault buyer, x402 payer, channel payer, window holder)
  buyer_ref       text NOT NULL,
  host            text NOT NULL,
  model_digest    text NOT NULL,
  tokens_in       integer NOT NULL,
  tokens_out      integer NOT NULL,
  prompt_hash     text NOT NULL,
  output_hash     text NOT NULL,
  price_in        bigint NOT NULL,
  price_out       bigint NOT NULL,
  host_cost_micro bigint NOT NULL,
  fee_micro       bigint NOT NULL,
  pay_mode        smallint NOT NULL CHECK (pay_mode BETWEEN 0 AND 4),
  pay_ref         text NOT NULL,
  sheet_hash      text NOT NULL,
  window_id       numeric(78,0),                  -- pay_mode 4 only
  router_sig      text NOT NULL,
  host_sig        text NOT NULL,
  leaf            text NOT NULL,
  sealed          boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'final' CHECK (status IN ('final','void')),
  settled_hour_tx text,                           -- A-writes
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_hour_idx ON shared.usage_records (hour, status);
CREATE INDEX usage_records_payer_idx ON shared.usage_records (payer, hour);

CREATE TABLE shared.usage_hours (
  hour             bigint PRIMARY KEY,
  records          integer NOT NULL,
  root             text NOT NULL,                 -- 0x00..00 when records = 0
  totals           jsonb NOT NULL,                -- RootTotals, bigints as strings
  totals_hash      text NOT NULL,
  router_close_sig text NOT NULL,
  closed_at        timestamptz NOT NULL DEFAULT now(),
  settle_tx        text,                          -- A-writes
  settled_at       timestamptz                    -- A-writes
);

CREATE TABLE shared.agent_payments (
  payment_id     text PRIMARY KEY,                -- x402 reqId, or keccak256(channelId, seq) for a channel claim
  kind           text NOT NULL CHECK (kind IN ('upto','exact','channel')),
  payer          text NOT NULL,
  amount_micro   bigint NOT NULL,                 -- what the router is owed (sum of covered records' host cost + fee)
  req_ids        text[] NOT NULL,                 -- usage records this payment covers
  channel_id     text,
  voucher_seq    bigint,
  voucher_sig    text,                            -- latest payer voucher for channels (router writes)
  collected_tx   text,                            -- A-writes
  collected_hour bigint,                          -- A-writes
  drawn_hour     bigint,                          -- A-writes: SettleBatch hour that drew it
  written_off_hour bigint,                        -- A-writes: SettleBatch hour that paid it from the reserve
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shared.channel_state (               -- router writes latest voucher; keepers read
  channel_id   text PRIMARY KEY,
  payer        text NOT NULL,
  latest_seq   bigint NOT NULL,
  cumulative   bigint NOT NULL,
  voucher_sig  text NOT NULL,
  claimed      bigint NOT NULL DEFAULT 0,          -- A-writes (mirrors chain)
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shared.window_perf (                 -- router writes per-window throughput samples
  window_id     numeric(78,0) NOT NULL,
  ts            timestamptz NOT NULL,
  tokens_per_s  real NOT NULL,
  demanded      boolean NOT NULL,                 -- true when holders had requests waiting
  PRIMARY KEY (window_id, ts)
);
SELECT create_hypertable('shared.window_perf', 'ts', if_not_exists => TRUE);

CREATE TABLE shared.refunds (                     -- dispute outcomes (B writes), paid by the next RefundBatch (A) into the payer's vault balance
  id          text PRIMARY KEY,
  payer       text NOT NULL,
  amount      bigint NOT NULL,
  reason      text NOT NULL,
  req_ids     text[] NOT NULL,
  paid_hour   bigint,                             -- A-writes
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Triggers in the same file: refuse insert/update on `usage_records` for an hour present in `usage_hours`; refuse updates to any column except `status` (pre-close), `settled_hour_tx`; refuse deletes everywhere. Database roles: `offpeak_router` (B services) can insert/update B columns; `offpeak_chain` (A services) can select all and update only A-writes columns. Column-level `GRANT UPDATE (...)`.

### 3.7 Contract surface Doc B consumes

ABIs are generated by A into `packages/abis/src/*.ts` (`as const` for viem) from Foundry output, with addresses in `packages/abis/deployments/{4663,local}.json`. B imports only from `@offpeak/abis`.

```solidity
// OffpeakVault — buyers
function deposit(uint256 amount) external;
function depositWithPermit2(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig) external;
function setCaps(uint128 hourlyCap, uint128 dailyCap) external;     // dailyCap 0 → 4 × hourlyCap
function withdraw(uint256 amount) external;                         // ≤ balance − reserve(buyer)
function requestWithdrawAll() external;
function executeWithdrawAll(address buyer) external;                // anyone, once due
function settle(SettleBatch calldata b, RootTotals calldata t, bytes calldata thresholdSig) external;  // t must hash to b.totalsHash
function refund(RefundBatch calldata r, bytes calldata thresholdSig) external;   // paid from protocolReserve
function reserveOf(address buyer) external view returns (uint256);
function buyerState(address buyer) external view returns (BuyerView memory);
event Deposited(address indexed buyer, uint256 amount, uint256 balance);
event CapsChangeRequested(address indexed buyer, uint128 hourlyCap, uint128 dailyCap, uint64 effectiveAfterHour);
event CapsChanged(address indexed buyer, uint128 hourlyCap, uint128 dailyCap);
event Withdrawn(address indexed buyer, uint256 amount, uint256 balance);
event WithdrawAllRequested(address indexed buyer, uint64 requestedAt, uint64 dueAt);
event WithdrawAllExecuted(address indexed buyer, uint256 amount);
event Settled(uint64 indexed hour, bytes32 root, bytes32 totalsHash, uint128 debited, uint128 credited, uint128 fees);
event DebitClamped(uint64 indexed hour, address indexed buyer, uint128 requested, uint128 debited);
event Refunded(address indexed payer, uint128 amount, bytes32 refundId);
event AgentPoolCredited(bytes32 indexed paymentId, uint256 amount);   // x402 reqId, or keccak256(abi.encode(channelId, seq))
event CreditShortfall(uint64 indexed hour, uint128 amount);
event Paused(bool usagePaused, bool settlesPaused);

// HostRegistry — hosts
function register(RegisterParams calldata p) external;              // bonds pulled; status = Probation for 72h
function updateServing(bytes32[] calldata modelDigests, uint32[] calldata maxTps, bytes32 imageDigest, bytes32 gpuClass, bytes32 attestationRef) external; // resets 72h probation
function activate(address host) external;                           // anyone, after probation
function verifyPriceSheet(PriceSheet calldata s, bytes calldata sig) external view returns (bool ok, bytes32 sheetHash); // signature + floor rule
function topUpBond(uint256 usdg, uint256 ofpk) external;
function updateEndpoint(bytes32 endpointHash) external;
function exit() external;                                           // 7-day unbonding, frozen during open challenges
function finalizeExit() external;
function withdrawCredits() external;                                // releasable credits only
function hostView(address host) external view returns (HostView memory);
function requiredBond(address host) external view returns (uint256);
function routable(address host) external view returns (bool);      // Active, bond ≥ required, not frozen
event HostRegistered(address indexed host, bytes32 imageDigest, bytes32 gpuClass, bytes32[] modelDigests, uint32[] maxTps, uint64 probationEnds, bytes32 attestationRef);
event BondChanged(address indexed host, uint256 bondUsdg, uint256 bondOfpk);
event HostStatusChanged(address indexed host, uint8 status);         // 0 None 1 Probation 2 Active 3 Frozen 4 Exiting 5 Delisted
event CreditsAccrued(address indexed host, uint64 indexed hour, uint128 amount, uint64 releasableAt);
event CreditsClawedBack(address indexed host, uint64 indexed hour, uint128 amount, bytes32 reason);
event CreditsWithdrawn(address indexed host, uint256 amount);

// UsageLedger
function rootOf(uint64 hour) external view returns (bytes32 root, bytes32 totalsHash);
function verifyLeaf(uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool);
event RootPosted(uint64 indexed hour, bytes32 root, bytes32 totalsHash, uint32 records);

// X402Escrow — fallback agent path
function authorize(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig, address payer, UptoWitness calldata w) external;  // facilitator relay only
function authorizeBatch(AuthorizeCall[] calldata calls) external;
function capture(bytes32 reqId, uint256 actual) external;           // capturer only; actual ≤ max
function captureBatch(bytes32[] calldata reqIds, uint256[] calldata actuals) external;
function settleExact(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig, address payer, ExactWitness calldata w) external;
function expire(bytes32 reqId) external;                            // anyone after validBefore + EXPIRY_GRACE
event Authorized(bytes32 indexed reqId, address indexed payer, uint256 maxAmount, uint64 validBefore);
event Captured(bytes32 indexed reqId, uint256 actual, uint256 refunded);
event ExactSettled(bytes32 indexed reqId, address indexed payer, uint256 amount);
event Expired(bytes32 indexed reqId, uint256 refunded);
event AuthorizeFailed(bytes32 indexed reqId, bytes reason);

// ChannelManager — primary agent path
function open(uint256 deposit, uint64 expiry, bytes32 salt) external returns (bytes32 channelId);
function openWithPermit2(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig, address payer, ChannelOpenWitness calldata w) external returns (bytes32 channelId);
function topUp(bytes32 channelId, uint256 amount) external;
function settleChannel(bytes32 channelId, Voucher calldata v, bytes calldata payerSig) external;   // payee or keeper
function requestClose(bytes32 channelId) external;                  // payer, any time → challenge period
function finalizeClose(bytes32 channelId) external;                 // anyone after challengeEndsAt
function cooperativeClose(bytes32 channelId, CooperativeClose calldata c, bytes calldata payerSig, bytes calldata routerSig) external;
function channelView(bytes32 channelId) external view returns (ChannelView memory);
event ChannelOpened(bytes32 indexed channelId, address indexed payer, uint256 deposit, uint64 expiry);
event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 deposit);
event ChannelClaimed(bytes32 indexed channelId, uint64 seq, uint128 cumulative, uint128 paid);
event CloseRequested(bytes32 indexed channelId, uint64 challengeEndsAt);
event ChannelClosed(bytes32 indexed channelId, uint128 paidToPayee, uint256 refundedToPayer);

// WindowMarket (ERC-1155, 1 unit = 1M tokens)
function create(WindowParams calldata w, uint256 collateral) external returns (uint256 id);
function priceNow(uint256 id) external view returns (uint256 hostPricePerUnit, uint256 buyerPricePerUnit);
function buy(uint256 id, uint256 units, uint256 maxBuyerPricePerUnit) external;
function cancel(uint256 id, uint256 units) external;                // before t0
function list(uint256 id, uint256 units, uint256 pricePerUnit) external returns (uint256 listingId);
function delist(uint256 listingId) external;
function buyListing(uint256 listingId, uint256 units, uint256 maxPricePerUnit) external;
function claimExpired(uint256 id) external;                         // after t1 + finality
function claimFailure(uint256 id) external;                         // after performance is final and failed
function applyDraws(uint64 hour, WindowDraw[] calldata draws) external;  // vault only, inside settle
function postPerformance(WindowPerformance calldata p, bytes calldata thresholdSig) external;
function disputePerformance(uint256 id) external;                   // host, within 24h of a post
function windowView(uint256 id) external view returns (WindowView memory);
function holderView(uint256 id, address holder) external view returns (HolderView memory);
event WindowCreated(uint256 indexed id, address indexed host, bytes32 modelDigest, uint64 t0, uint64 t1, uint32 minTps, uint64 units);
event WindowBought(uint256 indexed id, address indexed buyer, uint256 units, uint256 hostPricePerUnit, uint256 fee);
event WindowCancelled(uint256 indexed id, address indexed holder, uint256 units, uint256 refund);
event Listed(uint256 indexed listingId, uint256 indexed id, address indexed seller, uint256 units, uint256 pricePerUnit);
event ListingFilled(uint256 indexed listingId, address indexed buyer, uint256 units, uint256 fee);
event Drawn(uint256 indexed id, address indexed holder, uint64 tokens, uint256 unitsBurned);
event PerformancePosted(uint256 indexed id, uint32 measuredSeconds, uint32 belowMinSeconds, bool failed, uint64 finalAt);
event Claimed(uint256 indexed id, address indexed holder, uint8 kind, uint256 amount);

// AuditCourt
function challenge(Evidence calldata e) external returns (uint256 challengeId);   // pulls 100 USDG bond
function respond(uint256 challengeId, bytes32 responseHash) external;             // host, within 24h
function postRuling(Ruling calldata r, bytes calldata thresholdSig) external;
function appeal(uint256 challengeId, bytes32 appealHash) external;                // host, swap rulings only
function postPanelDecision(PanelDecision calldata d, bytes calldata panelSig) external;
function finalize(uint256 challengeId) external;
function claimRefund(uint256 challengeId, address buyer, uint256 amount, bytes32[] calldata proof) external;
event ChallengeFiled(uint256 indexed challengeId, address indexed host, address indexed challenger, uint8 kind, bytes32 evidenceHash);
event HostResponded(uint256 indexed challengeId, bytes32 responseHash);
event RulingPosted(uint256 indexed challengeId, uint8 outcome, uint16 slashBps);
event PanelReviewOpened(uint256 indexed challengeId, uint64 reviewEndsAt);
event PanelDecided(uint256 indexed challengeId, uint8 decision, uint16 finalSlashBps);
event ChallengeFinalized(uint256 indexed challengeId, uint16 slashBps, uint256 slashedUsdg, uint256 slashedOfpk);

// OfpkHooks
function tierOf(address a) external view returns (uint8);
function feeDiscountBps(address a) external view returns (uint16);
function earlyAccess(address a) external view returns (bool);
function routingBonusBps(address host) external view returns (uint16);
```

Shared Solidity structs (`contracts/src/interfaces/OffpeakTypes.sol`; TS mirrors in `packages/shared/src/types.ts`):

```solidity
struct BuyerView { uint256 balance; uint256 reserve; uint128 hourlyCap; uint128 dailyCap; uint128 pendingHourlyCap; uint128 pendingDailyCap; uint64 capsEffectiveAfterHour; uint64 withdrawRequestedAt; uint64 withdrawDueAt; uint64 lastSettledHour; bool usagePaused; }
struct RegisterParams { bytes32[] modelDigests; uint32[] maxTps; bytes32 imageDigest; bytes32 gpuClass; bytes32 endpointHash; bytes32 attestationRef; uint256 bondUsdg; uint256 bondOfpk; }
struct HostView { address operator; uint8 status; uint256 bondUsdg; uint256 bondOfpk; uint256 requiredBond; bytes32 imageDigest; bytes32 gpuClass; bytes32 attestationRef; uint64 probationEnds; uint8 strikes; uint32 openChallenges; uint256 releasableCredits; uint256 pendingCredits; }
struct ChannelView { address payer; uint256 deposit; uint128 claimed; uint64 lastSeq; uint64 expiry; uint64 challengeEndsAt; uint8 status; }  // 0 None 1 Open 2 Closing 3 Closed
struct WindowParams { bytes32 modelDigest; uint64 t0; uint64 t1; uint32 minTps; uint64 units; uint64 startPricePerUnit; uint64 endPricePerUnit; uint64 auctionStart; uint64 auctionEnd; }
struct Evidence { address host; uint8 kind; bytes32 modelDigest; bytes32 samplesRoot; uint32 sampleCount; bytes32 testId; int256 statistic; int256 threshold; string uri; }  // kind: 0 Swap 1 Throughput 2 Metering 3 Canary
```

### 3.8 Indexer API (A serves, B consumes)

Base `OFFPEAK_INDEXER_URL`, all `GET`, JSON, bigints as decimal strings, `Authorization: Bearer $OFFPEAK_INTERNAL_TOKEN` for `/idx/*`; `/public/*` is unauthenticated and rate-limited. Every response carries `{ head: { block, blockTs, finalizedBlock }, data }`. Freshness target: event visible ≤ 2 s after inclusion (RHC confirmations = 1 for reads that only *tighten* serving, e.g. withdraw requests; `OFFPEAK_CONFIRMATIONS` for credits).

| Route | Data |
|---|---|
| `/idx/v1/buyers/:addr` | `BuyerView` + `{ unsettledHours, servable: boolean, reason?: "withdraw_requested" \| "paused" \| "no_balance" \| "no_caps" }`. A pending cap decrease keeps the buyer servable at the new lower cap; `pendingHourlyCap` / `pendingDailyCap` tell the router which cap to use |
| `/idx/v1/hosts` / `/idx/v1/hosts/:addr` | `HostView` + `{ models: {digest, maxTps}[], routable, routingBonusBps, endpointHash }` |
| `/idx/v1/channels/:id` | `ChannelView` |
| `/idx/v1/escrows/:reqId` | `{ status: "none" \| "authorized" \| "captured" \| "expired", maxAmount, captured, txHash }` |
| `/idx/v1/windows/:id` and `/idx/v1/windows/:id/holders/:addr` | `WindowView` / `HolderView` (balance, lockedPartial, drawnTokens) |
| `/idx/v1/settlements/:hour` | `{ root, totalsHash, txHash, settledAt }` |
| `/idx/v1/usage/:reqId/proof` | `{ hour, leaf, proof: Hex[], root, txHash }` or 404 until settled |
| `/idx/v1/challenges?host=` | challenge list with status |
| `/idx/v1/ofpk/:addr` | `{ tier, feeDiscountBps, earlyAccess }` |
| `/public/v1/stats/hosts` | per host: bond, status, strikes, 30-day settled revenue |

Push: Redis pub/sub channel `offpeak:chain` with messages `{ type, ...args, block, txHash }`, `type ∈ { WithdrawAllRequested, CapsChangeRequested, CapsChanged, Deposited, Settled, HostStatusChanged, BondChanged, CloseRequested, ChannelClaimed, AgentPoolCredited, Authorized, AuthorizeFailed, ExactSettled, Captured, Expired, WindowBought, Drawn, PerformancePosted, RulingPosted, PanelDecided, ChallengeFinalized, Paused }`. B must react to `WithdrawAllRequested`, `CapsChangeRequested`, `Paused`, `CloseRequested`, `HostStatusChanged` within 1 s by refusing new holds for that buyer, channel or host.

### 3.9 Facilitator API (A serves, B consumes)

Base `OFFPEAK_FACILITATOR_URL`. x402 v2 field names; v1 accepted on input. Network `eip155:4663`, asset USDG.

- `POST /x402/verify` body `{ paymentPayload, paymentRequirements }` → `{ isValid, invalidReason?, payer }`. Off-chain checks only (signature, Permit2 nonce unused, payer→Permit2 allowance ≥ max, balance ≥ max, deadline ≥ now + 30 s, payee/asset/network match, not on deny list). p95 ≤ 40 ms with warm RPC cache.
- `POST /x402/settle` body `{ paymentPayload, paymentRequirements, mode: "authorize" | "exact" }` → `{ success, txHash, status: "submitted" | "confirmed", errorReason? }`. Returns at submission (`submitted`); confirmation is published on Redis `offpeak:chain` (`Authorized` / `ExactSettled`) and on `GET /x402/status/:reqId`.
- `POST /x402/capture` (internal, bearer) body `{ reqId, actual }` → `{ queued: true }`. Captures are batched every 5 s or 50 items.
- `GET /x402/supported` → `{ kinds: [{ scheme: "upto", network: "eip155:4663" }, { scheme: "exact", ... }, { scheme: "channel", ... }] }`.
- Channels need no facilitator call per request: B verifies vouchers locally with `packages/shared` and writes `shared.channel_state`. A's keeper claims on-chain.

### 3.10 Constants and environment variables

Constants (`packages/shared/src/constants.ts`, mirrored in Solidity):

| Name | Value |
|---|---|
| `CHAIN_ID` | 4663 |
| `PERMIT2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical; verify code hash at deploy) |
| `FEE_BPS_DEFAULT` / `FEE_BPS_AUDIT_OPT_IN` / `FEE_BPS_MIN` | 400 / 296 / 100 |
| `LOAD_FACTOR_MIN` / `LOAD_FACTOR_MAX` | 0.4 / 1.2 (as bps: 4000 / 12000) |
| `FLOOR_MAX_RATIO_BPS` | 6000: `floorIn ≤ 0.6 × min(baseIn[0..167])`, `floorOut ≤ 0.6 × min(baseOut[0..167])` |
| `HOUR_CLOSE_GRACE_S` / `MAX_REQUEST_S` | 600 / 600 |
| `SETTLE_TARGET_S` | 3300 after hour end |
| `WITHDRAW_ALL_MAX_DELAY_S` | 7200 |
| `HOST_CREDIT_DELAY_S` | 86400 |
| `HOST_MIN_BOND` | 2,000 USDG; required = max(2,000 USDG, 20% of trailing-30-day credits) |
| `PROBATION_S` | 259200 (72 h) |
| `UNBONDING_S` | 604800 (7 days) |
| `CHANNEL_CHALLENGE_S` | 7200 (2 h); channel min lifetime 6 h |
| `CHANNEL_SETTLE_EVERY_S` / `CHANNEL_SETTLE_EVERY_MICRO` | 300 / 1,000,000 |
| `UPTO_MIN_MAX_MICRO` | 50,000 (0.05 USDG; below this the 402 offers channels only) |
| `UPTO_PRECONFIRM_BUDGET_MICRO` / `UPTO_PRECONFIRM_TOKENS` | 20,000 / 256 |
| `X402_EXPIRY_GRACE_S` | 900 |
| `CHALLENGE_BOND` | 100 USDG; loser forfeits 50% to the host |
| `HOST_RESPONSE_S` | 86400 |
| `PANEL_REVIEW_S` | 604800 (7 days) |
| `SWAP_SLASH_BPS` / `BREACH_SLASH_BPS` | 10000 (after panel confirm only) / 2000, delist on second strike |
| `WINDOW_CANCEL_REFUND_BPS` / `WINDOW_EXPIRY_REFUND_BPS` | 9500 of host price + full fee / 5000 of host price for unused tokens |
| `WINDOW_RESALE_FEE` | 1% of sale price + 10% of markup over the seller's cost basis |
| `WINDOW_FAILURE_BELOW_BPS` | 2000 (below minTps more than 20% of demanded seconds) |
| `WINDOW_MAX_SHARE_BPS` | 7000 (hosts keep ≥ 30% of each hour out of Windows) |
| `WINDOW_COLLATERAL_BPS` | 2000 of `units × startPricePerUnit` |
| `DISPUTE_WINDOW_S` | 604800 (buyers dispute within 7 days) |
| `AUDIT_BODY_RETENTION_S` | 259200 (72 h, opt-in only) |
| `FEE_SPLIT_BPS` | ops 8000 / treasury 1000 / host rewards 500 / burn 500 |
| `BETA_CAP_PER_BUYER_MICRO` | 500,000,000 (500 USDG) until the external audit gate passes |

GPU classes (initial list; adding one is an interface change): `h100-80g-sxm`, `h100-80g-pcie`, `h200-141g`, `a100-80g`, `l40s-48g`, `rtx4090-24g`, `cpu-tdx-dev` (local tests only, never routable on mainnet).

Environment variables (all prefixed `OFFPEAK_`; validated with zod at boot in each service; a missing required var is a boot failure):

| Var | Used by | Notes |
|---|---|---|
| `OFFPEAK_ENV` | all | `local` \| `testnet-fork` \| `mainnet` |
| `OFFPEAK_CHAIN_ID` | all | 4663 |
| `OFFPEAK_RPC_URL`, `OFFPEAK_RPC_ARCHIVE_URL` | A, B (reads) | archive RPC for the indexer backfill |
| `OFFPEAK_CONFIRMATIONS` | A | default 2 |
| `OFFPEAK_DEPLOYMENT_FILE` | all | path to `packages/abis/deployments/<env>.json` (addresses come from here, not individual vars) |
| `OFFPEAK_DATABASE_URL` | all | Postgres; `pglite://memory` allowed in unit tests |
| `OFFPEAK_REDIS_URL` | all | |
| `OFFPEAK_INTERNAL_TOKEN` | all | service-to-service bearer, ≥ 32 bytes |
| `OFFPEAK_INDEXER_URL`, `OFFPEAK_FACILITATOR_URL` | B | |
| `OFFPEAK_INDEXER_MODE` | B | `live` \| `mock` (3.11) |
| `OFFPEAK_ROUTER_SIGNER_KEY` | B router | signs UsageRecord, HourClose |
| `OFFPEAK_ROUTER_ADDRESS` | A | expected router signer (settlement verifies) |
| `OFFPEAK_CHANNEL_PAYEE` | A, B | ChannelManager payee address (immutable at deploy) |
| `OFFPEAK_CHANNEL_PAYEE_KEY` | B router | optional; signs `CooperativeClose`; without it close is refused |
| `OFFPEAK_SETTLER_INDEX`, `OFFPEAK_SETTLER_KEY` | A settlement | one key per process, three processes on three machines |
| `OFFPEAK_SETTLER_ADDRESSES` | A, B | comma list of the three |
| `OFFPEAK_KEEPER_KEY` | A keepers | gas only plus channel claims |
| `OFFPEAK_FACILITATOR_RELAY_KEY` | A facilitator | relays authorize/settleExact |
| `OFFPEAK_CAPTURER_KEY` | A facilitator | the only key allowed to `capture` |
| `OFFPEAK_RULING_KEY` | A ruling service | one per process, three processes |
| `OFFPEAK_AUDITOR_KEY` | B auditor | files challenges, holds challenge bonds |
| `OFFPEAK_HOST_OPERATOR_KEY` | B host agent | the host's own key, never on Offpeak machines |
| `OFFPEAK_HOST_ENDPOINT` | B host agent | public URL the router calls |
| `OFFPEAK_PUBLIC_BASE_URL` | B | e.g. the API origin |
| `OFFPEAK_TDX_VERIFIER_URL` | B router | DCAP quote verification service |
| `OFFPEAK_GPU_ATTESTATION_URL` | B router | NVIDIA remote attestation service endpoint |
| `OFFPEAK_DENYLIST_URL` | A facilitator | sanctions/deny list source, refreshed hourly |
| `OFFPEAK_RELAY_FLOOR_WEI` | A facilitator | below this native balance `verify` answers `facilitator_unavailable` |
| `OFFPEAK_MOCK_AUTHORIZE_DELAY_MS` | A facilitator mock | default 400 |
| `OFFPEAK_API_KEY`, `OFFPEAK_AGENT_WALLET_KEY` | B SDK/MCP (client side) | never set on Offpeak servers |

Key separation rule (both sides enforce at boot): no two roles above may share a private key; a service that finds another role's key in its environment refuses to start.

### 3.11 Mocking plan (build in parallel from day 1)

- **Golden vectors (day 1, jointly).** `packages/shared/fixtures/vectors.json`: 5 UsageRecords with router and host test-key signatures, their leaves and Merkle root and proofs; one SettleBatch with 2-of-3 signature; one Voucher; one Upto and one Exact Permit2 witness digest; one PriceSheet hash; one Ruling. Test keys are anvil's default mnemonic accounts 1–9 (documented in the file). A's Foundry tests and both TS test suites must reproduce every hash byte for byte. This file is the interface lock.
- **Local chain (A delivers by end of week 1, B uses).** `bun run chain:local` starts anvil with `--chain-id 4663` on `127.0.0.1:8545`, etches Permit2's canonical bytecode at the canonical address, deploys `MockUSDG` (6 decimals, faucet), `MockOFPK`, and all Offpeak contracts, and writes `packages/abis/deployments/local.json`. Early contracts may be stubs that emit the right events.
- **Mock indexer (A delivers week 1).** `services/indexer` with `OFFPEAK_INDEXER_MODE=mock` serves the 3.8 routes from `packages/shared/fixtures/indexer/*.json` and accepts `POST /mock/emit {type, ...}` to publish `offpeak:chain` messages, so B can test every serving reaction (stop on withdraw request, etc.) without a chain.
- **Mock facilitator (A delivers week 2).** `services/facilitator --mock`: real signature verification, no chain; `settle` returns `submitted` and publishes `Authorized` after a configurable delay (default 400 ms) so B can test the pre-confirmation budget.
- **Usage faker (B delivers by end of week 1, A uses).** `bun run tools:usage-faker --hour <H> --n 5000 --buyers 50 --hosts 5 --modes 0,1,3` writes valid signed `shared.usage_records`, `shared.agent_payments`, `shared.channel_state` and a closed `shared.usage_hours` row using the fixture keys. A builds and tests the whole settlement pipeline against it.
- **Mock host (B delivers week 1).** `apps/host-agent --mock-engine` serves an OpenAI-compatible fake model with deterministic output and real host-signing, so A's end-to-end tests run without GPUs.
- **Contract test doubles (A).** `contracts/test/mocks/` exposes `MockVaultForRouter` with settable `buyerState` for B's fork tests if needed.

### 3.12 Shared milestone calendar and integration checkpoints

Week 1 starts on the day both devs begin. "Day N" in kill criteria counts from that phase's public launch. Estimates assume one developer plus an AI coding agent per track, five working days a week, and include test-writing time. The original 22-day estimate for M1–M5 excluded integration, onboarding, audit and beta, so the plan below is longer on purpose.

| Week | Doc A (chain and settlement) | Doc B (serving and product) | Checkpoint |
|---|---|---|---|
| 1 | Monorepo, `packages/shared` + vectors (joint), local chain script, stub contracts with final events, mock indexer | Monorepo apps skeleton, Postgres/Timescale migrations, usage faker, mock host, router skeleton (`/v1/models`, chat passthrough to mock host) | **IC0 (end W1):** vectors reproduce in Foundry and both TS suites; B's router reads a mock-indexer buyer; A's settlement reads faker rows |
| 2–3 | OffpeakVault (reserves, caps, withdraw-all incl. request-hour rule), HostRegistry (bonds, probation, credit delay, clawback), UsageLedger; fuzz + invariants | Router v1: routing, streaming, tools, JSON mode, embeddings, token counting, signed UsageRecords; host agent v1 (vLLM, pinned image, metering, host signature); pricebook (sheets, floor rule, load factor, live prices) | **IC1 (end W3):** a prepaid call on local anvil end to end: deposit → hold → stream → envelope verifies with `packages/shared` |
| 4 | Indexer live, settlement signers ×3 + submitter, Merkle proofs, keepers (withdraw-all executor, credit release) | Billing holds/capture vs indexer reserve, hour close, `/v1/usage/:id`, dashboard v1 (balance, usage, withdraw), price page | **IC2 (end W4):** 3 consecutive local hours settle from real router traffic; proofs verify; withdraw-all inside an hour debits that hour up to the request time |
| 5 | AuditCourt (challenge, response, 2-of-3 ruling, panel review, appeal, slashing, refunds), ruling service; P1 contract freeze → external audit starts | Auditor v1 (likelihood audits, canaries, sequential test, calibration harness on 2 GPU classes), filing through AuditCourt; host onboarding flow with 72 h probation | **IC3 (end W5):** simulated swap host flagged and challenged; ruling → panel → slash on local chain; honest host not flagged in calibration run |
| 6 | RHC mainnet deploy (beta cap on), fork tests, monitoring, runbooks | 3 launch models on studio-run GPU hosts, first outside hosts in probation, docs + claims lint, load test | **Gate P1** (section 6 lists the gate checks) → **P1 public beta, end of W6** with the 500 USDG per-buyer cap |
| 7–8 | X402Escrow (upto + exact, batch authorize/capture), ChannelManager (challenge period, coop close), facilitator live, channel keeper | Channel path in router + SDK (primary agent path), upto fallback with pre-confirmation budget, x402 402 responses, MCP tools | **IC4 (end W8):** agent opens channel, 1,000 calls, keeper claims, challenge-period close race test passes; upto call TTFT within SLO |
| 9 | External audit fixes for P1 contracts; audit of P2 contracts starts; lift beta cap when the audit gate passes | Scheduler: night jobs (`/v1/batches`, `X-Offpeak-Flex`), price forecast, spreading | **Gate P2** → **P2 launch, end of W10** (W10 = buffer, fixes, docs) |
| 11–13 | WindowMarket (Dutch auction, cancel, resale fee, partial-unit lock, performance posting, claims, 70% cap), OfpkHooks early access | Windows in router (draw-down first, `X-Offpeak-Window`), minTps measurement into `shared.window_perf`, Windows UI and board | **IC5 (end W13):** Window bought, drawn across 2 hours, resold with correct fee, expired and failure claims pay correctly on local chain |
| 14–15 | Audit of WindowMarket + changes; sealed-tier attestation registry fields; fee splitter + burn keeper (only if counsel approves, section 6) | Sealed tier: TDX + GPU evidence in host agent, router attestation verifier, SDK client-side HPKE encryption | **IC6 (end W15):** encrypted request served by a sealed host; router logs show ciphertext only |
| 16 | Mainnet deploy of P3 contracts | Load test, docs, launch | **Gate P3** → **P3 launch, end of W16** |

Kill and pivot rules (unchanged in substance, each counted from that phase's launch):
- P1, day 14: under $3,000 of cash-paid inference (excluding Offpeak's own tests and canaries) or under 100 paying accounts → reposition as an agent-only pay-per-call endpoint.
- P2, day 30: under 5 independent hosts → open a self-serve host tier for smaller models.
- P3, day 60: under $10,000 of Windows sold → drop Windows (contracts stay deployed for claims; UI and new sales off).

Weekly sync (30 min, both devs): review open interface-change PRs, run the integration suite `bun run test:integration` (A's contracts + B's router + settlement on local anvil), update this calendar.

---

## 4. Module specifications (Doc B)

### 4.1 Router request pipeline (`apps/router`)

Every inference request runs the same pipeline. Each step is a function with the signature shown; the handler composes them.

```ts
type Ctx = { db: Db; redis: Redis; idx: IndexerClient; fac: FacilitatorClient; signer: RouterSigner; cfg: RouterConfig; clock: () => number };

parseRequest(c: HonoContext): Promise<InferenceRequest>               // zod; OpenAI shapes
resolveModel(ctx, req): Promise<ModelEntry>                            // name → modelDigest, tokenizer, context length
authenticate(ctx, c): Promise<Payer>                                   // API key | channel | x402 | window
estimate(ctx, req, model): { tokensInEst: number; maxTokensOut: number }
quote(ctx, model, req, payer): Promise<Quote>                          // live price snapshot, candidate hosts, max cost
authorizePayment(ctx, payer, quote): Promise<PaymentHold>              // hold / channel credit / upto verify+authorize / window units
callHost(ctx, host, req, quote, hold): AsyncIterable<HostChunk>        // with failover before first token
meter(ctx, model, req, output): { tokensIn: number; tokensOut: number; promptHash: Hex; outputHash: Hex }
finalizeRecord(ctx, ...): Promise<UsageEnvelope>                       // router sig + host sig
capturePayment(ctx, hold, envelope): Promise<void>                     // one DB transaction with the shared.usage_records insert
respond(c, output, envelope)
```

Types:

```ts
type InferenceRequest = {
  kind: "chat" | "embeddings";
  model: string; body: Record<string, unknown>; stream: boolean;
  maxTokens: number;                       // required for billing: default min(4096, context − input), capped by model
  maxPrice?: { inPerM: Micro; outPerM: Micro }; // X-Offpeak-Max-Price, buyer price incl. fee
  flexDeadline?: number;                   // X-Offpeak-Flex (unix s)
  windowId?: bigint;                       // X-Offpeak-Window
  sealed: boolean;                         // content-type application/offpeak-hpke
};
type Payer =
  | { mode: 0; accountId: string; wallet: Hex; feeBps: number }
  | { mode: 1 | 2; wallet: Hex; payment: X402Payment; feeBps: number }
  | { mode: 3; wallet: Hex; channelId: Hex; feeBps: number }
  | { mode: 4; wallet: Hex; windowId: bigint };
type Quote = { snapshotId: string; how: number; hostCandidates: HostCandidate[]; priceIn: PricePerM; priceOut: PricePerM; maxCostMicro: Micro; sheetHash: Hex };
```

**Endpoints (OpenAI-compatible)**
- `POST /v1/chat/completions`: `messages`, `stream`, `max_tokens`/`max_completion_tokens`, `temperature`, `top_p`, `stop`, `seed`, `tools`, `tool_choice`, `response_format` (`{type:"json_object"}` and `{type:"json_schema", json_schema}`), `logprobs`, `n = 1` only (reject `n > 1` with 400). Tools and JSON mode pass to vLLM (guided decoding for `json_schema`); the router validates JSON-mode output parses and returns `finish_reason: "length"` honestly when truncated. Streaming uses SSE with OpenAI chunk shapes; the final events are `event: offpeak.usage` with the envelope, then `data: [DONE]`.
- `POST /v1/embeddings`: `input` (string or array, ≤ 2,048 items), `encoding_format` float/base64; billed on input tokens only; `exact` x402 allowed because the cost is known before serving.
- `POST /v1/files` (purpose `batch`) and `POST /v1/batches`, `GET /v1/batches/:id`, `POST /v1/batches/:id/cancel`, `GET /v1/files/:id/content`: OpenAI batch format; `completion_window` accepts `"24h"` or `metadata.offpeak_deadline` (ISO 8601). See 4.7.
- `GET /v1/models`: `{ id, object: "model", owned_by: "offpeak", offpeak: { digest, context_length, hosts, live_price_from: {in, out}, sealed_available } }`. Model ids are compatibility names only.

**Headers**
- Request: `Authorization: Bearer op_live_…` (prepaid key) or none (x402/channel); `X-Offpeak-Max-Price: in=0.15,out=0.60` (USD per 1M tokens, buyer price incl. fee); `X-Offpeak-Flex: 2026-11-02T06:00:00Z`; `X-Offpeak-Window: <id>`; `X-Offpeak-Window-Fallback: prepaid`; `X-Offpeak-Channel: <channelId>`; `X-Offpeak-Voucher: <base64url({seq, cumulative, sig})>`; `PAYMENT-SIGNATURE` / `X-PAYMENT` (x402 v2 / v1).
- Response: `X-Offpeak-Usage`, `X-Offpeak-Price: in=…,out=…` (live buyer price used), `X-Offpeak-Host: <address>`, `X-Offpeak-Channel-Owed: <cumulative>` for channels, `PAYMENT-RESPONSE` for x402.

**Error rules (OpenAI error shape `{error:{message,type,code}}`)**
- Live price above `X-Offpeak-Max-Price` → interactive: `429 price_above_cap` with `{ best_price, next_cheaper_hour, next_cheaper_price }`; with `X-Offpeak-Flex` → `202` and a batch job instead.
- Caps or reserve exhausted → `402 insufficient_reserve` (prepaid) with `{ hourly_remaining, daily_remaining, available }`.
- Withdraw-all pending → `403 withdraw_pending`. Caps decrease pending → served at the new lower cap.
- No healthy host for the model within the SLO → `503 no_capacity` with the next forecast hour that has capacity.
- Unpaid agent request → `402` with x402 `PaymentRequired` (4.5.3).
- Hard limits: request runtime 10 minutes (then the stream ends with `finish_reason: "length"` and the record bills what was served); body ≤ 4 MB; per-key rate limits (default 600 rpm).

**Failover:** if the chosen host errors or exceeds 3 s to first byte, retry the next candidate once, before any token reached the client. Only the host that served is billed; the failure counts against the first host's health.

### 4.2 Token counting and records (`metering/`)
- `tokenize.ts` loads each model's tokenizer and chat template from the manifest (sha256-pinned files). `countChat(model, body)` applies the chat template exactly as vLLM does for that model (including tool definitions and the generation prompt) and returns the input token count; `countOutput(model, text, toolCalls)` returns output tokens. Acceptance: on a 1,000-prompt fixture per launch model, router counts equal vLLM's `usage` counts exactly for ≥ 99.5% and within the 3.4 tolerance for all.
- `records.ts`:
  ```ts
  buildRecord(input: { reqId: Hex; payer: Payer; host: Hex; model: ModelEntry; counts: Counts; quote: Quote; ts: number; payRef: Hex }): UsageRecord
  signRecord(signer: RouterSigner, r: UsageRecord): Promise<Hex>          // EIP-712 OffpeakUsage
  requestHostSignature(host: HostClient, r: UsageRecord, routerSig: Hex): Promise<{ hostSig: Hex; hostCounts: Counts }>
  envelope(r, routerSig, hostSig, hostCounts, sealed): UsageEnvelope     // leaf via packages/shared
  ```
  Cost fields come only from `packages/shared/money.ts`. For `payMode 4` all price and cost fields are 0.
- Persistence: `capturePayment` inserts into `shared.usage_records` and `serving.requests` (metadata only: req id, account, model, host, tokens, latency, ttft, status, error code, pay mode; never prompt or output text) in one transaction with the hold capture or agent-payment update.
- `hourclose.ts`: BullMQ job at `hourEnd(H) + 600` s: lock the hour (`SELECT … FOR UPDATE` on a `serving.hour_locks` row so no insert races), build the tree and `RootTotals` from `shared.usage_records`, sign `HourClose`, insert `shared.usage_hours`. Idempotent. Must complete by `hourEnd(H) + 900`.

### 4.3 Pricebook, load and live prices (`pricing/`)

**Price sheets**
```ts
type PriceSheet = { host: Hex; modelDigest: Hex; baseIn: bigint[168]; baseOut: bigint[168]; floorIn: bigint; floorOut: bigint; validFrom: number; nonce: bigint };
validateSheet(s: PriceSheet, sig: Hex): Result<{ sheetHash: Hex }, SheetError>
```
Rules: EIP-712 signature by the host operator (domain `OffpeakPriceSheet`); every base > 0; `floorIn * 10000 ≤ 6000 * min(baseIn)` and `floorOut * 10000 ≤ 6000 * min(baseOut)` (error `floor_above_0_6_min_base`); `validFrom ≥ now + 3600` (hosts cannot reprice the current hour); `nonce` strictly increasing per host and model; at most 24 sheet changes per host per week. Stored in `serving.price_sheets` with the signature; served at `GET /v1/prices/sheets/:hash`. The sheet in force for a request is the latest one with `validFrom ≤ ts`.

**Load measurement (`load.ts`)**: the router, not the host, measures utilisation. For each host × model, every second: `served_tps = tokens streamed in the last 1 s (output) + prefill tokens / 4` (prefill weighted); `u = EWMA_60s(served_tps) / maxTps` where `maxTps` is the registered value from `HostRegistry` (via indexer). Every 15 s write `serving.host_load(host, model_digest, ts, util, ttft_p95, inflight, healthy)` (Timescale hypertable, 90-day retention, 1-minute continuous aggregate).

**Live price (`live.ts`)**
```ts
loadFactorBps(u: number): number   // clamp(4000 + 10000·u, 4000, 12000)
livePrice(sheet, how, lfBps): { in: PricePerM; out: PricePerM }
  // in  = max(floorIn,  ceilDiv(baseIn[how]  * lfBps, 10000))
  // out = max(floorOut, ceilDiv(baseOut[how] * lfBps, 10000))
```
A price snapshot (all hosts × models) is computed every 15 s, given an id, stored in Redis for 1 h. The request is billed at the snapshot in force at its start (`quote.snapshotId`), never re-priced mid-stream. Buyer price = host price + fee (3.2).

**Forecast (`forecast.ts`)**: per host × model × hour of week, EWMA over the last 4 weeks of hourly mean `u` (default 0.3 when no history). `forecastPrice(host, model, hour)` = live-price formula on the forecast `u`. Used by `/v1/prices` (next 168 h) and the scheduler.

**Stats (`stats.ts`)**: per host, 30-day effective discount = `1 − Σ billed host cost / Σ (tokens × base price at that request's hour)`, computed nightly into `serving.host_stats` and shown on the price page.

### 4.4 Routing (`routing/`)
```ts
selectHost(ctx, model: ModelEntry, quote: PartialQuote, opts: { sealed: boolean; windowHost?: Hex; canary?: boolean }): HostCandidate[]
```
1. Candidates: hosts serving `modelDigest` with `routable == true` (indexer) and status `Active`; hosts in `Probation` only when `opts.canary`; sealed requests only hosts with a verified attestation (4.10); a Window request only the Window's host.
2. Healthy: health probe OK within 30 s, 5-minute error rate < 5%, `u < 0.95`, and for interactive requests TTFT p95 over 15 minutes < 1.5 s.
3. Price: live buyer price ≤ `maxPrice` when given.
4. Order by live host price ascending; within 1% of the best, by routing weight `bondUsdg × (10000 + routingBonusBps) / 10000`, then audit record (fewer strikes, then more audited samples this week).
5. Return the top 3 for failover.

`hostclient.ts`: HTTP/2 keep-alive pool per host; each request carries `X-Offpeak-Req` = `{reqId, ts, bodyHash}` signed by the router key so the host agent can refuse traffic not from the router.

### 4.5 Billing (`pay/`)

#### 4.5.1 Prepaid (vault balance)
```ts
type BuyerChain = BuyerView & { servable: boolean; reason?: string; fetchedAt: number };
getBuyer(ctx, wallet): Promise<BuyerChain>   // indexer, cached in Redis, invalidated by offpeak:chain push
holdPrepaid(ctx, wallet, maxCostMicro): Promise<Hold | { error: "insufficient_reserve" | "withdraw_pending" | "paused" }>
capturePrepaid(ctx, hold, actualMicro): Promise<void>
releaseHold(ctx, hold): Promise<void>
```
`holds.lua` runs atomically per buyer and admits a hold only if all hold:
- `servable` (no withdraw request, not paused, balance > 0, caps > 0);
- current-hour spend + open holds in this hour + new hold ≤ effective hourly cap now (the **lower** of the current and any pending cap);
- today's spend + open holds + new hold ≤ effective daily cap now;
- unsettled spend (all `shared.usage_records` for this payer in hours after `lastSettledHour`, tracked in Redis counters rebuilt from SQL on start) + open holds + new hold ≤ on-chain `balance`.

The hold is `maxCostMicro = cost(tokensInEst, maxTokensOut, live price) + fee`. Capture charges the actual cost (≤ hold; if actual > hold because of a tokenizer edge case, charge the hold and flag). Holds expire after 15 minutes. `WithdrawAllRequested`, `CapsChangeRequested`, `Paused` pushes cancel admission for that buyer within 1 s; in-flight requests finish (their start `ts` is before the request time).

#### 4.5.2 Channels (primary agent path)
```ts
admitChannel(ctx, channelId, newMaxMicro): Promise<ChannelAdmit | ChannelError>
acceptVoucher(ctx, channelId, v: { seq: bigint; cumulative: Micro; sig: Hex }): Promise<void>
```
- Channel view from the indexer: status `Open`, `expiry > now + 2h`, not `CloseRequested`.
- Local state: `V` = latest accepted voucher cumulative (`shared.channel_state`), `U` = cost of served records not yet covered by a voucher.
- Admit if `U + newMax ≤ creditLimit` (default `min(250,000 µUSDG, 10% of deposit)`) and `V + U + newMax ≤ deposit`.
- After the response the envelope and `X-Offpeak-Channel-Owed` report `owed = V + U`. The client signs `Voucher{channelId, seq, cumulative = owed}` and sends it with its next request or via `POST /v1/channels/:id/voucher`.
- `acceptVoucher`: payer signature valid (EOA or EIP-1271) under `OffpeakChannel`; `seq > latest`; `cumulative` equals an owed value the router reported at a response boundary (otherwise reject); then in one transaction update `shared.channel_state` and insert `shared.agent_payments{payment_id = keccak256(abi.encode(channelId, seq)), kind: "channel", amount_micro = cumulative − V, req_ids = covered records}`.
- No chain transaction per request; signature checks only. Exposure if a client stops signing is bounded by `creditLimit`; this is a house risk and is reported in metrics (`channel_unvouchered_micro`).
- On `CloseRequested` (push), stop admitting at once; the keeper (Doc A) lands the latest voucher.

#### 4.5.3 x402 (`upto` fallback, `exact` for known-cost calls)
- 402 body (x402 v2 `PaymentRequired`, also in the `PAYMENT-REQUIRED` header), `accepts` in this order:
  1. `{ scheme: "channel", network: "eip155:4663", asset: USDG, extra: { channelManager, payee, minDeposit: "1000000", minExpirySeconds: 21600, creditLimit } }`
  2. `{ scheme: "upto", network, asset, maxAmountRequired, payTo: vault, extra: { permit2, spender: x402Escrow, reqId, validBefore, witness: "UptoWitness" } }`, included only when `maxAmountRequired ≥ 50,000 µUSDG`
  3. `{ scheme: "exact", … }` only for embeddings and fixed-cost calls.
- `upto` flow (TTFT-safe):
  1. `fac.verify` (≤ 40 ms). Invalid → 402 with reason.
  2. `fac.settle({mode: "authorize"})` returns `submitted`; subscribe to `Authorized:<reqId>` / `AuthorizeFailed:<reqId>`.
  3. Start the host call at once. Stream to the client until the pre-confirmation budget is reached (256 output tokens or 20,000 µUSDG of cost, whichever first). If `Authorized` has not arrived, buffer further tokens (do not send) until it does; if it has not arrived in 15 s, or `AuthorizeFailed` arrives, end the stream with an error event and do not bill. Interactive TTFT never waits on the chain.
  4. After completion, `fac.capture({reqId, actual})` and insert `shared.agent_payments{payment_id: reqId, kind: "upto", amount_micro: actual}` with the usage record in one transaction.
- `exact` (embeddings): verify, settle `exact`, serve; same budget rules apply to large inputs.
- Metrics: `ttft_ms{pay_mode}`, `upto_preconfirm_stall_ms`, `upto_unbilled_micro`.

#### 4.5.4 Windows
- `X-Offpeak-Window: <id>` draws the Window first. Admit if `t0 ≤ now < t1`, holder (the key's wallet) available tokens = `balance × 1e6 − drawnPartial − pendingLocalDraws ≥ tokensInEst + maxTokensOut`. Route to the Window's host only.
- Records: `payMode 4`, `payRef = bytes32(windowId)`, zero prices.
- If tokens run short and `X-Offpeak-Window-Fallback: prepaid` is set, serve from prepaid instead; otherwise `402 window_exhausted`.
- Throughput sampling: every minute per active Window, write `shared.window_perf(window_id, ts, tokens_per_s, demanded)` where `demanded` = any holder request waited or was in flight. Windows reserve capacity: the router keeps the Window host's share for holders and serves non-holders only from the remaining capacity.

### 4.6 Hosts API and onboarding (`hosts-api/`)
- `POST /v1/hosts/register`: body `{ operator, endpoint, models: [{name, digest, maxTps}], imageDigest, gpuClass, attestation? }` signed by the operator (EIP-191 personal message over the canonical JSON). Returns the `HostRegistry.register` calldata for the operator to send. When the indexer reports `HostRegistered`, the router probes the endpoint (`/offpeak/v1/info`, digest checks, sample request) and the host enters canary-only probation for 72 h.
- `POST /v1/hosts/price-sheet`: signed `PriceSheet`; validated by 4.3.
- `GET /v1/hosts/payouts`: credits pending, releasable, clawed (from the indexer) plus served tokens per hour.
- `POST /v1/hosts/audit-response`: uploads the host's response document for a challenge (stored content-addressed) and returns `AuditCourt.respond` calldata with its hash.

### 4.7 Scheduler: night jobs (`apps/scheduler`)
- Intake: `POST /v1/batches` (or any chat request with `X-Offpeak-Flex`). Prepaid accounts only in P2 (channels in a later interface change).
- `plan.ts`:
  ```ts
  planJob(job: { lines: BatchLine[]; model: ModelEntry; deadline: number; maxPrice?: Price; buyer: Hex }): Plan
  type Plan = { lockedPrice: { in: PricePerM; out: PricePerM }; estimatedMaxMicro: Micro; slots: { hour: number; lines: number[] }[] };
  ```
  Eligible hours = whole hours from the next hour to the hour before `deadline − 30 min`. `lockedPrice` = the token-weighted **average** forecast live price over the eligible hours that the plan actually uses (not the minimum), computed when the job is accepted, plus fee. Spreading: water-fill lines into hours in order of forecast price, putting at most 20% of an hour's forecast idle capacity (all hosts for that model) and at most the buyer's hourly cap into any one hour, so jobs do not pile onto one hour. If `maxPrice` is given and the locked price exceeds it, reject with `price_above_cap` and the cheapest feasible deadline.
- Admission: the whole `estimatedMaxMicro` must fit the buyer's caps across the planned hours and their balance; the scheduler places per-hour holds when each hour starts.
- `run.ts`: at each slot hour, executes lines through the normal pipeline with `quote` overridden to `lockedPrice` (records carry the locked price; hosts that opted in to night jobs receive it, which is never below their floor because it averages `max(floor, …)` values). If live prices in the slot are above the locked price, the scheduler first moves lines to later eligible hours; in the last eligible hour it runs anyway at the locked price.
- Output: OpenAI batch output JSONL with each line's `offpeak_usage` envelope; batch object carries `offpeak: { locked_price, deadline, planned_hours, estimated_cost, actual_cost }`.
- Cancel: lines not yet run are released.

### 4.8 Host agent (`apps/host-agent`)

Runs on the host's machine next to vLLM. The host operator's key (`OFFPEAK_HOST_OPERATOR_KEY`) never leaves this machine.

- `config.ts`: `host.yaml` with `operator`, `endpoint`, `gpuClass`, `image: vllm/vllm-openai@sha256:<digest>`, and models `[{ name, path, manifest, maxTps, vllmArgs }]`. Allowed `vllmArgs` are a fixed list per model in the approved recipe (tensor parallel size, max model len, dtype, enable prefix caching). Anything outside the recipe fails boot.
- `digest.ts`: at boot, hash every model file, build the manifest (`path\tsha256`), compute `modelDigest` (3.2) and refuse to start if it differs from the registered digest. Re-hash daily.
- `gpu.ts`: read `nvidia-smi --query-gpu=name,memory.total,uuid --format=csv`; map to a GPU class; refuse to start on mismatch with `host.yaml` and the registration.
- `proxy.ts`: `POST /offpeak/v1/chat/completions` and `/offpeak/v1/embeddings` accept only requests with a valid router `X-Offpeak-Req` signature (router address from config, checked against `UsageLedger.routerSigner` at boot); forward to vLLM on localhost; stream back. `GET /offpeak/v1/info` returns `{ operator, modelDigests, imageDigest, gpuClass, agentVersion, sealed, nightJobModels }`. The agent speaks plain HTTP on loopback, behind a TLS proxy the operator runs, and checks the signature header before it reads a body. `POST /offpeak/v1/score` (reference hosts only, auditor-authenticated): teacher-forcing scorer that returns per-token log-probabilities of a given output under the model (`prompt_logprobs` over chat-template(prompt) + output, `max_tokens: 1`).
- `meter.ts`: counts input and output tokens with the same tokenizer and template as the router; also records vLLM's `usage`.
- `sign.ts`: `POST /offpeak/v1/sign` receives the router's `UsageRecord` and `routerSig`; checks that `reqId` was served here, that `modelDigest`, prices (against the host's own sheets) and token counts are within tolerance (3.4); returns `hostSig` and `hostCounts`. Keeps a local append-only log of signed records for 30 days (the host's own evidence in disputes).
- `health.ts`: `GET /offpeak/v1/health` with in-flight requests and queue depth (advisory; the router measures load itself).
- `cli.ts` (`offpeak-host`): `init`, `verify` (digests, GPU, image), `register` (prints and optionally sends `HostRegistry.register` with the operator key; bonds pulled in USDG and optionally $OFPK), `price-sheet set --file sheet.json` (validates the floor rule locally, signs EIP-712, posts), `credits` and `credits withdraw`, `exit`.
- `mock-engine.ts` (`--mock-engine`): deterministic fake OpenAI server (output = a seeded function of the prompt) so the whole stack runs without GPUs; supports a `--swap-rate 0.1 --swap-model small` mode for auditor simulations.

### 4.9 Auditor (`apps/auditor`)

The auditor finds hosts that serve a different or quantised model than they registered, and metering or throughput breaches. It files bonded challenges with `OFFPEAK_AUDITOR_KEY`. Rulings and the human panel are Doc A's services; the auditor supplies the evidence.

**Inputs**
1. **Canaries** (`canaries.ts`): sent through ordinary-looking prepaid accounts (auditor-funded vault wallets, varied caps, ages and request patterns), at ~0.5% of each host's requests, with realistic prompts from an operator-held corpus file outside this repo, because hosts build from it (licensed or self-written; no customer data; `corpus/sample.json` is for tests only) and parameters drawn from the live distribution of real traffic (temperature, top_p, max_tokens, tools). The router cannot tell hosts which requests are canaries; it routes them normally (canary accounts are not flagged anywhere the host can observe). A subset are deterministic prompts at temperature 0 with short, robust expected answers; the check accepts any answer in the set observed on reference hosts across GPU classes.
2. **Audit samples** (`sample.ts`): for buyers who opted in to audit sampling (1% off), a random 2% of requests keep the prompt and output, encrypted at rest with a per-day key, deleted after 72 h (`retention` job; keys destroyed with the data). Buyers who did not opt in contribute only hashes and metering checks.
3. Minimum per host per model per week: ≥ 200 audited responses. Hosts with less traffic get extra canaries to reach it. Probation hosts get canaries only.

**Likelihood audit (`score.ts`)**: for each sample, a studio-run reference host for the same model and GPU class (attested, sealed tier where available) scores the served output tokens under the claimed model (teacher forcing). Statistic per response: `ℓ = mean log p(token_t | prefix)` over output tokens. Baselines `μ, σ` per (model digest, GPU class, image digest, temperature bucket {0, (0,0.5], (0.5,1.0], >1.0}, output length bucket {≤64, ≤256, ≤1024, >1024}) from honest hosts. Standardise `z = (ℓ − μ) / σ` (one-sided: swaps and quantisation lower `ℓ`).

**Sequential test (`sequential.ts`, published in `@offpeak/audit-tests` as `testId = "llr-mix-v1"`)**: mixture sequential probability ratio test over a host's samples in the week:
`Λ_n = Σ_i log( (1 − ε)·φ(z_i) + ε·φ(z_i + δ) ) − log φ(z_i)` with `ε = 0.10` (swap fraction to detect) and `δ` from calibration (the shift a quantised or smaller model causes for that model). Evaluate only once `n ≥ 200`. Flag when `Λ_n ≥ log(A)` with `A` set so that the per-host-week false-flag rate on honest data is ≤ 1%. `z` is winsorised at ±3.5, one payer's samples add at most 3.5 to `Λ_n`, and only responses whose parameters calibration covered are scored, so opted-in buyers cannot force a flag.

**Calibration plan (`calibrate.ts`)**
1. Before P1: for each launch model, run honest studio hosts on at least two GPU classes, two vLLM image versions and varied batch loads (no batch-invariant mode) to collect ≥ 20,000 scored responses per model; fit baselines per bucket.
2. Simulate swaps: int4 (AWQ/GPTQ) and fp8 quantisations, the next smaller sibling model, and a different fine-tune, mixed in at 5%, 10% and 25% of responses. Fit `δ` per model.
3. Choose `A` by bootstrap over honest host-weeks (≥ 50 simulated host-weeks per model × GPU class) so the false-flag rate is ≤ 1%; report the power at `ε = 10%` within 200 samples (gate: ≥ 95%).
4. Recalibrate when a new image digest, GPU class or model is approved, and weekly from live data from attested reference hosts only, gating both μ and σ (a host with no flags is not proven honest). Publish thresholds, baselines and the calibration report at `/v1/audits/calibration`.
5. Track the live false-flag proxy: flags on attested reference hosts (should be zero) and on hosts later cleared by the panel.

**Filing (`evidence.ts`, `file.ts`)**
- **Swap** challenge only with two independent signals: the sequential test flags, **and** either canary exact-match failures above their own calibrated threshold or a replication of the likelihood test on a second, independent reference host. Without both, file nothing and increase canary rate for that host for a week.
- **Metering** challenge: sustained token-count disagreements beyond tolerance (`serving.metering_flags`), or host signatures refusing correct counts.
- **Throughput** challenge: for Windows, only when the host disputes a performance post.
- Evidence bundle: sample leaves with Merkle proofs against posted roots, canary prompts and outputs in full (they are Offpeak's own), opted-in buyer samples as hashes plus encrypted bodies accessible only to ruling processes and panel members, scores, baselines, test id and version, statistic and threshold. Stored content-addressed; `Evidence.samplesRoot` commits to it; `Evidence.uri` points to the access-controlled store.
- `AuditCourt.challenge(e)` with the auditor key (holds challenge-bond USDG; alert below 1,000 USDG).
- The auditor never decides a slash and never contacts hosts directly about an audit.

### 4.10 Sealed tier (host agent `sealed/`, router verifier, SDK)
- Hardware: Intel TDX confidential VM with an NVIDIA GPU in confidential-computing mode. The pinned image digest and model digest are measured into the VM.
- Host agent at boot, inside the VM: generate an X25519 HPKE key pair (private key never leaves memory); generate a counts signing key (it never leaves memory either); build `bindings = { v: 1, modelDigest, imageDigest, operator, hpkePublicKey, countsSigner, configHash, gpuEvidenceHash }`, where `configHash` is `sha256(canonicalJson({ modelName, engine, tsmRoot, gpuTool }))`; `report_data = sha256(canonicalJson(bindings)) ‖ nonce` (32-byte nonce, zero for the boot quote); obtain a TDX quote via the kernel configfs-tsm interface (`/sys/kernel/config/tsm/report`); collect GPU evidence with the NVIDIA attestation SDK, whose command is fixed in the image and never read from `host.yaml`. The engine must be `http://127.0.0.1` with no proxy in the environment, or the boot stops. `attestationRef = sha256(bootQuote)`, registered in `HostRegistry`. `GET /offpeak/v1/attest?nonce=` returns a fresh quote, GPU evidence, bindings and the HPKE key.
- Router verifier (`routing/attest.ts`): verify the TDX quote with a DCAP quote verification service (`OFFPEAK_TDX_VERIFIER_URL`) and accept TCB status `UpToDate` or `SWHardeningNeeded` only; check MRTD, RTMRs and `configHash` against the allow-list for the pinned image; check `report_data` against the bindings; verify GPU evidence through NVIDIA's remote attestation service (overall result must be true); confirm `attestationRef` matches the registry. Re-verify every 24 h and on every host restart with a fresh nonce. Publish verified hosts at `GET /v1/sealed/hosts` with the verification transcript.
- Wire format (`application/offpeak-hpke`; stream `application/offpeak-hpke-stream`): RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, `info = "offpeak-hpke/v1"`. Request bytes: `0x01 ‖ clientTimeMs(u64 BE) ‖ enc(32) ‖ ciphertext`; AAD = the first 9 bytes ‖ ASCII path. Response: `responseNonce(16)` then frames `flag(1) ‖ len(u32 BE) ‖ ct` keyed from `context.Export("offpeak-hpke/v1 response", 16)` with HKDF salt `enc ‖ responseNonce`; nonce = base nonce XOR frame index; flag `0x01` marks the last frame so truncation is detectable; each frame's plaintext is `dataLen(u16 BE) ‖ data ‖ zeros`, always 202 bytes, and frames cut the stream at fixed offsets, so sizes do not show token lengths. Replay window ±60 s; the agent rejects a repeated `enc`.
- Routing metadata the router needs travels in clear headers: `X-Offpeak-Model`, `X-Offpeak-Max-Tokens`, `X-Offpeak-Sealed-Host`. The router cannot count tokens on ciphertext, so sealed records use the attested host agent's counts (signed inside the VM with the key `countsSigner` names, which the router and SDK verify, because the operator key lives outside the VM); the router stops input at `request bytes + 256` for every pay mode, checks ciphertext length is consistent with the counts (bytes per token within the model's observed range, set in production, or the model is not served) and flags outliers. Docs state this.
- Clients that verify for themselves take a fresh quote under their own nonce, relayed by the router so the host does not see who asked.
- Prompt and output hashes for sealed records are over ciphertext bytes; `sealed = true` in the envelope.

### 4.11 Database schema `serving` (Drizzle, `db/serving/schema.ts`)

Money columns are `bigint` µUSDG (`mode: "bigint"`). Timestamps `timestamptz`. Addresses lowercase text.

| Table | Columns (key ones) |
|---|---|
| `accounts` | `id`, `wallet` unique, `audit_opt_in` bool, `created_at` |
| `api_keys` | `key_hash` pk (sha256 of `op_live_…`), `account_id`, `label`, `rpm_limit`, `created_at`, `revoked_at` |
| `siwe_sessions` | `id`, `wallet`, `nonce`, `expires_at` |
| `holds` | `id`, `account_id`, `wallet`, `hour`, `amount`, `status` (held/captured/released/expired), `req_id`, `expires_at` |
| `hosts_cache` | `address`, `endpoint`, `status`, `routable`, `bond_usdg`, `routing_bonus_bps`, `gpu_class`, `image_digest`, `attestation_ref`, `strikes`, `updated_at` |
| `host_models` | `host`, `model_digest`, `model_name`, `context`, `max_tps` |
| `price_sheets` | `host`, `model_digest`, `valid_from`, `base_in bigint[168]`, `base_out bigint[168]`, `floor_in`, `floor_out`, `nonce`, `sig`, `sheet_hash` |
| `host_load` (hypertable) | `host`, `model_digest`, `ts`, `util`, `ttft_p95_ms`, `inflight`, `healthy` |
| `host_stats` | `host`, `day`, `served_tokens`, `billed_host_micro`, `base_value_micro`, `effective_discount_bps` |
| `requests` | `req_id`, `account_id`, `wallet`, `model_digest`, `host`, `pay_mode`, `tokens_in`, `tokens_out`, `ttft_ms`, `duration_ms`, `status`, `error_code`, `sealed`, `ts` |
| `metering_flags` | `req_id`, `host`, `router_counts`, `host_counts`, `reason` |
| `channels_local` | `channel_id`, `payer`, `unvouchered_micro`, `last_owed`, `last_owed_req_ids text[]` |
| `x402_requests` | `req_id`, `payer`, `max_amount`, `status`, `preconfirm_stall_ms` |
| `jobs`, `job_lines`, `job_slots` | batch jobs, lines with status and output file offsets, planned hour slots |
| `files` | `id`, `account_id`, `purpose`, `bytes`, `sha256`, `storage_key`, `expires_at` |
| `audit_samples` | `req_id`, `host`, `model_digest`, `enc_body`, `day_key_id`, `expires_at` (≤ 72 h) |
| `canary_accounts`, `canary_runs` | auditor wallets; runs with expected sets, outputs, pass/fail |
| `audit_scores` | `req_id`, `host`, `model_digest`, `bucket`, `ll_mean`, `z`, `ref_host` |
| `audit_baselines` | `model_digest`, `gpu_class`, `image_digest`, `temp_bucket`, `len_bucket`, `mu`, `sigma`, `n`, `version` |
| `audit_runs` | `host`, `model_digest`, `week`, `n`, `llr`, `threshold`, `flagged`, `filed_challenge_id` |
| `disputes` | `id`, `wallet`, `req_ids text[]`, `reason`, `submitted_material_hash`, `status`, `outcome`, `refund_id` |
| `hour_locks` | `hour` pk |
| `sealed_attestations` | `host`, `attestation_ref`, `verified_at`, `tcb_status`, `transcript jsonb` |

Retention jobs: `audit_samples` deleted at `expires_at` (hourly); `host_load` 90 days; `requests` 400 days (metadata only).

### 4.12 Offpeak public API (`offpeak/`)
- `GET /v1/prices?model=` → `{ model, digest, now: { in, out, host }, hosts: [{ host, live: {in,out}, base: {in,out}, floor, effective_discount_30d_bps, sealed }], next168h: [{ hour, forecast_in, forecast_out }] }` (buyer prices incl. the default fee; caller-specific fee with auth).
- `GET /v1/usage/:reqId` → `{ envelope, proof?: { hour, root, proof, txHash } }` (proof from the indexer once settled).
- `GET /v1/usage?since=&limit=&before_ts=&before_id=` → the caller's records, newest first, with an API key or session: `{ records: [{ envelope, status }], next }`.
- `GET /v1/tokenizers/:digest` → `{ context_length, tokenizer }`: the pinned tokenizer files a buyer needs to recount, or `null` when none are published. Buyers check them against the digest.
- `POST /v1/windows/buy|cancel|list|claim` → `{ to, data, value: "0", chainId }` calldata for the user's wallet (plus a Permit2 or approve step when needed). `GET /v1/windows` board (P3): live Dutch price, resale listings with the fee shown as "1% + 10% of markup".
- `POST /v1/channels/:id/voucher` → accepts a voucher (4.5.2). `GET /v1/channels/:id` → `{ deposit, claimed, cumulative, owed, latestSeq, status, expiry }`.
- `POST /v1/disputes` `{ req_ids, reason, material? }` within 7 days of each record's `ts`. Automatic checks: recount tokens if the buyer supplies the prompt and output (hashes must match the record); verify signatures and price against the sheet. Outcomes: `upheld` → insert `shared.refunds` (Doc A pays it into the buyer's vault balance) and a metering flag; `rejected` with reasons. Response within 72 h.
- `GET /v1/status` → feature flags (`channels`, `upto`, `night_jobs`, `windows`, `sealed`, `token_hooks`, `beta_cap`) and service health; the claims lint reads it.
- `GET /v1/audits/calibration` (4.9).
- `GET /v1/sealed/hosts` (4.10).

### 4.13 MCP tools (`packages/mcp`)
| Tool | Input | Output |
|---|---|---|
| `offpeak_complete` | `{ model, messages, max_tokens, max_price?, tools?, response_format? }` | completion text/tool calls + usage envelope |
| `offpeak_prices` | `{ model? }` | live price, cheapest host, next 24 h forecast |
| `offpeak_schedule_job` | `{ model, requests[], deadline, max_price? }` | job id, locked price, planned hours, estimated cost |
| `offpeak_usage` | `{ req_id?, since?, recount? }` | records with verification result and proof status |

Auth: API key (env `OFFPEAK_API_KEY`) or an agent wallet with a channel (`OFFPEAK_AGENT_WALLET_KEY` stays local; the MCP server signs vouchers itself). Tool descriptions follow Appendix P.

### 4.14 SDK (`packages/sdk`, TypeScript)
```ts
const op = new Offpeak({ baseURL, apiKey?, wallet?: WalletClient, channel?: { deposit: Micro; expirySeconds: number } });
op.openai                                     // a configured `openai` client (baseURL swap)
op.chat(params, opts?: { maxPrice?, flex?, windowId?, sealed?: boolean })
op.verifyUsage(env: UsageEnvelope, opts?: { recount?: { prompt, output } }): Promise<VerifyReport>  // both sigs, cost math, leaf, optional local recount
op.proof(reqId): Promise<{ ok: boolean; onchain: boolean }>          // fetch proof and check UsageLedger.verifyLeaf via RPC
op.channels.open(deposit, expiry) / .voucher(owed) / .close()        // auto-vouchers after each response
op.x402.payUpto(requirement)                                          // Permit2 witness signing
op.sealed.hosts(model) / op.sealed.chat(params)                       // verify attestation transcript, HPKE encrypt, decrypt stream
```
Sealed client rules: refuse a host whose transcript fails (quote verified by the configured verifier, TCB status, measurement allow-list, bindings, GPU result, registry `attestationRef`); allow `trustRouterVerification: false` to require the client's own verifier URL. The SDK never sends plaintext to the router for sealed calls.

### 4.15 Web (`apps/web`)
- **Price page (public):** per model the live buyer price, cheapest host, 168-hour forecast chart, hosts table (live, base, floor, 30-day effective discount, bond, status, sealed). Footer: "Third-party names describe compatibility only; no affiliation."
- **Dashboard (SIWE):** balance, reserve, withdrawable now, caps (with the "lower caps apply after the next settled hour" note), deposit (approve or Permit2), withdraw, withdraw-all with a countdown to the 2-hour guarantee, usage list (envelope, local verification, proof status), API keys, audit-sampling opt-in (1% off) with the 72 h retention statement, disputes, channels (deposit, owed, close).
- **Windows (P3):** board, buy at the live Dutch price, list for resale with the fee preview "1% of sale price + 10% of markup = X", cancel (95%), claims.
- **Hosts:** onboarding guide, registration helper, payouts, challenges and responses.
- **Docs:** API reference, honest limits (Appendix P), status.

### 4.16 Claims lint (`tools/lint-claims.ts`)
- Fails on banned phrases (Appendix P) in `apps/web`, `docs`, `packages/*/README.md`, MCP tool descriptions, API error strings.
- Fails when text claims a feature is live while `GET /v1/status` (or the offline fixture) has its flag off; qualified phrases ("not switched on yet", "coming in P2") pass.
- Fails when a competitor figure lacks a date and source link.

---

## 5. Tests (Doc B)
- **Unit:** money math against vectors; live price and floor rule (property tests: for any valid sheet, idle `u = 0` gives ≤ 60% of base every hour); load factor bounds; holds Lua (concurrency fuzz with 1,000 parallel admits never exceeds caps or balance); voucher acceptance (wrong seq, wrong boundary, wrong signer, EIP-1271); 402 ordering and the `upto` minimum; tokenizer counts vs vLLM fixtures; record building and envelope verification vs vectors; scheduler water-filling (no hour above 20% of forecast idle capacity or the buyer's hourly cap; locked price = weighted average); sequential test on synthetic data.
- **Router integration (mock indexer + mock facilitator + mock host):** prepaid stream end to end with envelope verification; `WithdrawAllRequested` push stops admission within 1 s and no record starts after it; caps decrease applies immediately; price above cap → 429 or 202 with flex; failover before first token; channel flow with 1,000 requests and auto-vouchers; client stops vouchering → stops at credit limit; `upto` with 400 ms and 5 s authorize delays: TTFT unaffected, output pauses at the budget, `AuthorizeFailed` ends unbilled; window draw-down and fallback; hour close idempotent under concurrent inserts.
- **Auditor simulation (mock engine with swap mode):** `--swap-rate 0.10` flagged within 200 samples in ≥ 95% of runs; honest mock hosts with injected GPU-class noise flagged in ≤ 1% of host-weeks; swap filing requires the second signal.
- **Sealed:** HPKE round trip vectors; truncated stream detected; replayed `enc` rejected; router logs and DB contain no plaintext (grep test over captured logs with a canary string).
- **Load:** `bun run load:router` 500 concurrent streams against mock hosts: router overhead p95 < 30 ms to first token; holds admission p95 < 5 ms.
- **Integration with Doc A (`test:integration`):** local anvil + real indexer, facilitator, settlement and keepers: IC1–IC6 scenarios from 3.12.

---

## 6. Launch gates

A phase launches only when every gate marked for it passes and the evidence (CI run links, reports) is attached to the release issue.

| Gate | Pass condition | Owner | Blocks |
|---|---|---|---|
| Vault exit | Fuzz/invariant: `withdraw(balance − reserve)` always works; `executeWithdrawAll` ≤ 2 h after request with settlement halted; no settle debits an hour after the request hour or a record after the request time | A | P1 |
| Reserve | Cap decrease then withdraw can't leave unpaid usage; router never serves beyond the on-chain reserve (B's router test against A's contracts) | A + B | P1 |
| Settlement | One settle per hour; debits = root totals; per-buyer hourly/daily caps; EIP-712 domain bound; host credits clawable for 24 h; three signers agree on 72 consecutive local hours of faker + real traffic | A | P1 |
| Pricing | Billed = live price at request start; floor ≤ 0.6 × min hourly base enforced; caps never exceeded | B | P1 |
| Swap detection | Simulation: a host swapping to a quantised or smaller model on ≥ 10% of responses is flagged within 200 audited samples; ≤ 1% false flags per host-week on honest hosts across at least two GPU classes; no 100% slash without panel confirmation (contract invariant) | B (stats) + A (court) | P1 |
| Beta cap | `betaCapEnabled = true` on mainnet and verified by `VerifyWiring` | A | P1 |
| x402 and channels | `upto` pulls the max before serving beyond the pre-confirmation budget; a revoked approval can't get free inference beyond that budget; channel close waits for the 2 h challenge period and the latest voucher always lands in tests | A + B | P2 |
| Windows | Conservation across buy/cancel/resale/draw/claim; partial units non-transferable; failure claims funded by escrow + collateral; resale fee = 1% + 10% of markup | A | P3 |
| External audit | Independent audit of all contracts deployed in that phase; all high/critical fixed and re-reviewed | A | Lifting the 500 USDG per-buyer beta cap; P2 and P3 contracts go live only after their audit |
| L1 legal | Written counsel review of: no-KYC custodial-style USDG balances, $OFPK utility hooks, fee burn. Until it passes, `tokenHooksEnabled = false` and no $OFPK messaging | Project lead | Enabling token hooks and burn |
| Claims | `bun run lint:claims` passes; competitor figures rechecked that week with dated source captures | B | each launch |

Additional Doc B launch checks: TTFT p95 < 1.5 s on launch models under expected load; 3 launch models live on studio-run hosts with at least one outside host through probation (P1); sealed-tier transcript verifiable by the SDK with the client's own verifier (P3).

---

## 7. Milestone order (Doc B)

Follow 3.12 for calendar weeks. Write tests first in each step.

1. **B0 (W1, days 1–2):** `packages/shared` jointly with A (money, EIP-712, Merkle, vectors, `shared.sql`).
2. **B1 (W1, days 3–5):** app skeletons, `db/serving` migrations, usage faker, mock host engine, router `/v1/models` + chat passthrough to the mock host. **IC0.**
3. **B2 (W2):** tokenizer counting, record building and signing, host agent v1 (digest, GPU check, proxy, meter, sign), envelope in responses.
4. **B3 (W3):** pricebook (sheets, floor rule), load measurement, live prices, routing, tools, JSON mode, embeddings, failover. **IC1.**
5. **B4 (W4):** prepaid holds vs indexer (Lua), push reactions, hour close, `/v1/usage/:id`, `/v1/prices`, dashboard v1 and price page. **IC2.**
6. **B5 (W5):** auditor (canaries, samples with retention, scoring, sequential test, calibration harness, evidence, filing); host onboarding with probation; disputes. **IC3.**
7. **B6 (W6):** launch models on studio hosts, outside-host probation, docs and claims lint, load test. **Gate P1.**
8. **B7 (W7–8):** channel payments (admission, vouchers, owed reporting), `upto` with pre-confirmation budget, `exact` for embeddings, 402 responses, SDK payment helpers, MCP tools. **IC4.**
9. **B8 (W9–10):** scheduler and `/v1/batches`, `X-Offpeak-Flex`, forecasts. **Gate P2.**
10. **B9 (W11–13):** Window draw-down, `shared.window_perf`, Windows board and resale UI. **IC5.**
11. **B10 (W14–15):** sealed tier (host attestation, router verifier, SDK HPKE). **IC6.**
12. **B11 (W16):** load test, docs, launch. **Gate P3.**

---

## 8. Do not (Doc B)

- Do not change anything in section 3 without an interface-change PR approved by both owners.
- Do not serve a prepaid buyer beyond the on-chain reserve, after a withdraw-all request, above a pending lower cap, or while usage is paused.
- Do not put an on-chain transaction in front of the first token. Do not stream past the `upto` pre-confirmation budget before `Authorized`.
- Do not accept channel requests after `CloseRequested` or within 2 h of `expiry`; do not delay writing accepted vouchers to `shared.channel_state`.
- Do not re-price a request mid-stream, bill a price other than the snapshot at request start (or the locked night-job price), or accept a price sheet that breaks the floor rule.
- Do not store prompts or outputs except opted-in audit samples (encrypted, ≤ 72 h); do not log request bodies; do not read sealed plaintext anywhere outside the host VM.
- Do not resell or proxy any third-party hosted model API or aggregator account. Every model is open-weight and served by a registered, bonded host.
- Do not file a swap challenge without two independent signals; do not let the auditor decide or execute a slash.
- Do not let hosts identify canary traffic (no canary flags in host-visible headers, timing or accounts).
- Do not hold or use any user's private key; return calldata for their wallet instead.
- Do not read the `chain` schema directly; use the indexer API.
- Do not use floats for money, or any time zone other than UTC in logic.
- Do not write copy that breaks Appendix P; do not describe $OFPK as yield, rewards or a fee share.
- Do not commit `.env*`, keys, model weights, customer data or corpora with unclear licences; do not commit with any identity other than `ALIAS Contributor <contributor@offpeak.invalid>`.
- Do not copy code, names, comments, addresses or configuration from any other project or repository; write every module fresh from this spec.

---

## Appendix G. Repository hygiene
- `.gitignore`: `node_modules`, `.env*`, `.data/`, `models/`, `*.safetensors`, `*.pem`, `*.key`, `apps/web/dist`.
- Pre-commit hook (`.githooks/pre-commit`, enabled by `bun run prepare`): `gitleaks protect --staged --redact`, `bun run scan:names --staged`, `bun run lint:claims --changed`.
- Pre-push: full-history `gitleaks detect --redact` and `scan:names`.
- CI is disabled on the remote until the project lead enables it; run the same checks locally via `bun run ci:local`.

---

## Appendix P. Product rules (copy, UI, docs, API error text)

These rules apply to every string a user can see: web pages, API errors, SDK docs, MCP tool descriptions, launch posts, README files. CI runs `bun run lint:claims` (Doc B builds it, both docs require it), which fails on the banned phrases below and on any claim that a feature is live while `GET /v1/status` says it is off.

**What we don't say**
- Never "Claude/GPT at a discount" or any closed model at a discount, "guaranteed cheapest", "staking rewards", "APY", "yield", "passive income", "returns". Say "off-peak price", "live price", "withdrawable balance".
- $OFPK is utility only: fee discount tiers, extra bond weight for hosts (slashable), early access to Windows. Never describe it as a share of fees, a revenue stream, a credit stream or an investment. "Holding $OFPK alone earns nothing."
- No partnership language with Robinhood, OpenRouter, model labs, Paxos or any host. Model names describe compatibility only. Site footer, verbatim: "Third-party names describe compatibility only; no affiliation."
- Never claim competitors will be shut down. When comparing, quote the clause, give its date and link the archived source capture; let readers judge. Every competitor figure carries the date it was checked and is rechecked the week of each launch; unchecked figures are marked "(unverified)" or removed.

**Honest limits (shown on the docs page and linked from pricing and signup)**
- Open-weight models only. Offpeak doesn't sell closed models. Open models trail frontier models on the hardest tasks.
- Prices move. The live price shown at request start is what you pay; caps protect you, and requests over your cap wait (night jobs) or fail with 429 (interactive).
- Discounts depend on host supply and idle time. With few hosts, discounts are smaller.
- Open hosts can read prompts, and so can Offpeak's router, unless you use the sealed tier with client-side encryption.
- Audit sampling stores request bodies for up to 72 h, only if you opt in (opt-in buyers get 1% off).
- Audits are statistical. They catch sustained model swaps, not every single response.
- Usage records are signed by Offpeak's router and the host. You can recount your own requests and dispute any request within 7 days.
- Withdrawing the reserved part of a balance can take up to 2 hours.
- USDG can be frozen by its issuer; Permit2 is a shared dependency.
- During the beta, deposits are capped at 500 USDG per buyer until the external contract audit is complete.
