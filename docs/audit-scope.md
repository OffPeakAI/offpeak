# Audit scope

The paths below are what an external audit should cover. No external audit has happened yet, and nothing is on mainnet. When one starts, the audited commit gets a tag, and that tag goes here.

## In scope

### Contracts

| Path | Phase | Notes |
|---|---|---|
| `contracts/src/OffpeakVault.sol` | P1 | |
| `contracts/src/UsageLedger.sol` | P1 | |
| `contracts/src/HostRegistry.sol` | P1 | |
| `contracts/src/AuditCourt.sol` | P1 | |
| `contracts/src/FeeSplitter.sol` | P1 | |
| `contracts/src/ChannelManager.sol` | P2 | Goes live only after its own audit |
| `contracts/src/X402Escrow.sol` | P2 | Goes live only after its own audit |
| `contracts/src/WindowMarket.sol` | P3 | Goes live only after its own audit |
| `contracts/src/OfpkHooks.sol` | P3 | Goes live only after its own audit, and the legal gate |
| `contracts/src/interfaces/` | All | |
| `contracts/src/lib/` | All | |
| `contracts/script/` | All | Deploy, hand-off and wiring checks |
| `contracts/config/chains/4663.json` | All | Addresses stay zero until a deployment |
| `contracts/foundry.toml` | All | Compiler settings |

### Off-chain code

| Path | What it is |
|---|---|
| `apps/router/` | API, routing, pricing, metering, payments and disputes |
| `apps/host-agent/` | Host metering, signing, model checks and the sealed tier |
| `apps/auditor/` | Canaries, scoring and challenge filing |
| `apps/scheduler/` | Night jobs and price forecasts |
| `services/common/` | Shared service code and environment checks |
| `services/settlement/` | Settlement signers |
| `services/rulings/` | Ruling signers and the panel packet |
| `services/indexer/` | Chain event ingestion and views |
| `services/facilitator/` | x402 verification, relay and capture |
| `services/keepers/` | Timed chain jobs |
| `packages/shared/` | Types, hashing, evidence format and the shared schema |
| `packages/sdk/` | Client SDK |
| `packages/mcp/` | MCP tools |
| `packages/abis/` | ABIs and deployment files |
| `packages/audit-tests/` | Audit statistics |
| `db/` | Schemas and migrations |
| `deploy/` | Host containers and model manifests |

## Out of scope

| Path | Why |
|---|---|
| `apps/web/`, `website/` | Dashboard and public site |
| `services/mock-facilitator/`, `services/mock-indexer/` | Local stand-ins, never deployed |
| `contracts/src/mocks/`, `contracts/test/`, `contracts/lib/` | Test code and vendored `forge-std` |
| `tests/`, `tools/` and every `*.test.ts` | Tests and local tooling |
| `node_modules/` and other third-party code | USDG, Permit2, OpenZeppelin, Safe, vLLM and the chain itself are dependencies. See `docs/architecture.md` |

## Read first

- [`docs/architecture.md`](architecture.md): components, roles and trust assumptions
- [`docs/invariants.md`](invariants.md): the properties the suites check
- [`docs/launch/security-review.md`](launch/security-review.md): internal reviews, with the fixed and accepted items
- [`docs/limits.md`](limits.md): the honest limits
- [`SECURITY.md`](../SECURITY.md): how to report a finding
