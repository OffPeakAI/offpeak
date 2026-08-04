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
