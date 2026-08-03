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
