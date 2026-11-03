# Security

Offpeak is pre-launch. Nothing here is on mainnet yet, and the contracts have had internal reviews but no external audit.

## Report a vulnerability

Please do not open a public issue, and do not post details anywhere public.

1. Message the official X account, [@UseOffPeak](https://x.com/UseOffPeak), and ask for a private channel. Say only that you have a security report and which part of the repo it touches.
2. Send the details over the private channel once it is set up: the commit, the file and line, the steps to reproduce, and what an attacker gains.

Only trust the account above. The official links are listed in [`website/docs-md/HOLDERS.md`](website/docs-md/HOLDERS.md). Nobody from Offpeak will ask for a private key or a seed phrase.

There is no bug bounty.

## Scope

In scope, at the current `main`:

- `contracts/src` and `contracts/script`, the contracts and their deploy scripts
- `apps/router`, `apps/host-agent`, `apps/auditor` and `apps/scheduler`
- `services/`, the indexer, settlement signers, facilitator, keepers and rulings, leaving out the two mock services
- `packages/`, the SDK, MCP tools, shared code, ABIs and audit tests
- `deploy/`, the host containers and model manifests
- `db/`, the schemas and migrations

Out of scope:

- `apps/web` and `website/`, the dashboard and public site
- `services/mock-facilitator`, `services/mock-indexer`, tests, fixtures and other local-only tooling
- USDG, Permit2, Robinhood Chain, vLLM and other third-party code, which should go to their own maintainers
- The items under Known risks below, unless you can show worse than they describe
- Attacks on the operators' accounts or machines, and any testing against third-party services

[`docs/audit-scope.md`](docs/audit-scope.md) has the same list path by path.

## Privileged roles

Nothing is deployed, so these holders are the plan. [`docs/architecture.md`](docs/architecture.md) has each role's functions and how it changes.

- **Owner.** A timelock with a 48 hour delay, driven by the `multisig` Safe (2 of 3). The deployer key holds nothing after handoff.
- **Guardian.** The `guardian` Safe (2 of 3), separate people from the multisig. It can pause and claw back without a delay.
- **Settlers.** Three keys on separate machines, 2 of 3.
- **Rulers.** Three keys on separate machines, 2 of 3.
- **Panel.** The `panel` Safe, at least 3 of 5 human reviewers who hold no other Offpeak key.
- **Router signer and channel payee.** Two separate keys, both held by the router.
- **Relay and capturer.** Two keys, both held by the facilitator.
- **Keeper.** One key, held by the keepers.
- **Burn keeper.** Unset until the legal gate passes.

## Known risks

These come from [`docs/launch/security-review.md`](docs/launch/security-review.md) and [`docs/launch/gate-p3.md`](docs/launch/gate-p3.md), which call them accepted, for the external auditors to weigh. That external audit has not happened yet, so this list can change. It covers only these items. It does not say the code has no other issues.

### Contracts, P1 and P2

- **Challenge griefing.** Any challenge blocks a host's credit withdrawals and exit. Holding one open costs about 50 USDG per cycle, or nothing if the rulers stay silent for 14 days, because a timeout gives the whole bond back. The build doc sets those amounts.
- **USDG pauses.** A pause longer than 2 hours can make a voucher miss its challenge. One that outlasts an escrow's 15 minute grace can make a capture miss its window, so the payer keeps the money and the host is paid from the reserve after 24 hours. See [`docs/runbooks/usdg-freeze.md`](docs/runbooks/usdg-freeze.md).
- **Settler keys.** Two of three can understate a buyer's `lastTs` inside the request hour, and new settlers take effect after the 48 hour timelock. Buyers can leave in 2 hours, so that delay is enough for them.
- **Stray transfers.** USDG sent directly to a contract stays there. There is deliberately no owner function that could move it.

### Router

- **A cut stream bills what the router received, not what the host generated.** The host may produce a little more before the abort reaches it.
- **A router can under-report a cut stream.** The host signs a partial record it cannot fully check. The router is already trusted within the request hour.

### Windows, P3

- **A host can buy its own Window.** A second wallet that buys unsold units gets a full refund on failure, plus a share of the collateral, which shrinks what real buyers receive. They still get at least 20% of the start price per unit, the share if every unit had sold. The chain cannot tell the wallets apart.
- **`maxTps` is self-reported.** A host can raise it with `updateServing` to pass the 70% rule. The Window still has to meet `minTps`, or the collateral pays out.
- **Holders who never claim.** The host's half of their unused value and any dust stay in the market. Claims never expire, and no owner path can move them.
- **A host can dodge by request shape.** Windows only, and Windows are not deployed. A buyer can cause the same results, so nothing goes on record when a host hangs only on long prompts, schemas or tool lists, or answers 400, 413 or 422 to any body with some field. A sealed host can do this with any 4xx, and any sealed body past about 800 bytes reads as a long prompt. A router canary would not help, because it is a short plain request, which such a host answers. A holder can send that request too, and it counts if it fails.

The wider honest limits are in [`docs/limits.md`](docs/limits.md), and the trust model is in [`docs/architecture.md`](docs/architecture.md).
