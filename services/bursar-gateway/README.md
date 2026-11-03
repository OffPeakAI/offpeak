# Bursar merchant gateway

A fixed-price, non-streaming text endpoint for [Bursar mandate payments](https://github.com/bursar-world/bursar). It uses the published `@bursar/core@0.2.0` commitment and contract interfaces. Bursar's native one-time MPP charge and OffPeak's Permit2 payments use different contracts. This gateway accepts Bursar's **x402 escrow mandate lane**; the router's custom MPP channel transport is separate.

The buyer locks the published fixed task price in Bursar escrow. The merchant uses its own funded OffPeak API account for inference, with a total charge cap no greater than that price. Output is persisted before the merchant requests escrow release. Failed inference requests do not release escrow; unreleased locks can be reclaimed through Bursar after their deadline. Release is subject to Bursar's dispute/settlement rules and is not immediate final payout.

## Run

From the workspace root, install with Bun 1.4.4, configure the variables in this directory's `.env.example`, then:

```sh
bun run services/bursar-gateway/src/main.ts
```

The service listens only on `127.0.0.1:8793`. Put it behind an HTTPS reverse proxy, preserve `/v1/chat/completions`, and use that exact public origin in `BURSAR_GATEWAY_ORIGIN`. Route it separately from the main router. The origin cannot include a path. Use a dedicated PostgreSQL database/role with permission to create the `gateway` schema; startup applies the idempotent schema. Back up this database before upgrades.

Before enabling traffic:

- Verify the chain-4663 escrow, factory, six-decimal USDG asset and merchant addresses from your actual deployment. Startup verifies chain ID, escrow settlement asset and minimum lock. It does not deploy contracts.
- Fund the merchant's OffPeak account and gas wallet explicitly. Use a dedicated merchant key, never the router signer. Configure only models that are actually served.
- Set a fixed task price that covers the maximum input/output request you accept, and confirm your Bursar mandate permits the merchant and `service:inference.text`.
- Verify a small authorized transaction in your own staging environment, including a failed inference and reclaim. Repository tests use chain ports and in-memory PostgreSQL; no funded chain transaction was performed by those tests.
- Put request-rate and concurrent-connection limits at the reverse proxy. Keep the service private until that configuration is in place.

`GET /health` and `GET /v1/models` are read-only. `POST /v1/chat/completions` requires `x-offpeak-max-charge` (micro-USDG), supports up to 30 text messages of 8,000 characters each, and up to 512 output tokens. It rejects streaming, tools and unsupported models. The 402 response advertises its fixed price. The Bursar SDK supplies an exact-body, URL-bound lock proof.

## Retry and recovery

A database uniqueness constraint prevents a lock from starting more than one task. Row locks serialize settlement attempts. Retrying a completed task with the exact original proof serves the stored result; a settlement retry never runs inference again. A crash while a task is `running` requires operator investigation: the service refuses another inference for that lock. This favors avoiding double work over automatic recovery.

A release transaction whose outcome is unknown is reconciled against the on-chain lock and saved output commitment. If release is already confirmed but its transaction hash was lost, settlement metadata contains `transaction: null`; it never invents a hash. Preserve the original payment proof for retrieval. A fresh Bursar SDK paid-fetch call can create a different lock.

Stored output may contain user content. Restrict database access, encrypt backups, and set an operational retention policy. If pruning output, retain each lock's consumed identifier so it cannot execute again. Do not log payment headers or conversations. Only the output commitment and a retrieval URL go on chain.

## Local verification

```sh
bun test services/bursar-gateway/test packages/agents/test
```

These cover price caps, binding, wrong payer/payee/amount/capability, deadline, factory/event checks, concurrent reuse, inference failure and interrupted settlement. Production RPC, proxy and funded deployment verification remain separate launch checks.
