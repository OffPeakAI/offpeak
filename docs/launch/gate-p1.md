# Gate P1 status

P1 launches as a capped public beta (500 USDG per buyer) once every gate below passes. The external audit is not a P1 gate: it blocks lifting the cap.

| Gate | Owner | Status | Evidence or what is left |
|---|---|---|---|
| Vault exit | A | Pass | `VaultExit` invariants, mutation checks, and exit with real USDG on a fork of the live chain |
| Reserve | A + B | Pass | `Reserve` invariants, including UTC midnight. `tests/integration/live-router.test.ts` runs the router as a real process against the contracts: a lowered cap refuses the next request, and a withdraw-all stops new holds |
| Settlement | A | Pass | `Settlement` invariants, and `tests/integration/settlement-72h.test.ts`: three signers, 72 hours, no disagreements |
| Pricing | B | Pass, mock engine and fixture tokenizer | Billed at the live price at request start, the floor rule enforced on every sheet the router takes, nonce and weekly limit included, and caps never exceeded. `apps/host-agent/test/router-wire.test.ts` signs real-tokenizer counts through the real agent. Rerun on real vLLM |
| Swap detection | B + A | Court passes, statistics open | `AuditCourt` invariants hold no full slash without a panel Confirm. Left: real calibration on two GPU classes, and the auditor filing challenges |
| Beta cap | A | Ready | `VerifyWiring` checks it. Run it on mainnet after deploying |
| Claims | B | Lint passes | Competitor figures must be rechecked the week of launch |

## Blocking launch

1. **The launch models.** The host agent proxies vLLM, and the router counts with each model's pinned tokenizer and refuses to boot on mainnet without one. Only a test tokenizer is pinned so far. Each launch model needs its manifest in `OFFPEAK_MODELS_FILE`, and the 1,000-prompt count check against real vLLM has not run.
2. **The auditor files nothing yet.** Challenges need the evidence format in `packages/shared/src/evidence.ts`.
3. **Real GPU calibration.** Swap detection has only run on simulated scores.
4. **Mainnet roles.** Three Safes and the operational keys, listed in `docs/runbooks/deploy-mainnet.md`.
5. **The deploy itself,** followed by `VerifyWiring`.

## Rehearsed

`bun run deploy:rehearse` runs the three real scripts against a fork of the live chain. `bun run contracts:fork` deposits, settles and exits with the real USDG and Permit2.

Chain facts checked on 2026-11-01:

- Transient storage works, so the reentrancy guard is safe there.
- Permit2 is at the canonical address, with a code hash specific to this chain.
- USDG is an upgradeable, pausable proxy supporting EIP-2612 and EIP-3009.
- Blocks arrive about every 0.1 seconds.
- Safe contracts are deployed.

## Load

Settlement built and signed 200,000 records from 2,000 buyers in 121 seconds against the 5-minute target, on one laptop (`bun run load:settlement`). One settle holds far fewer buyers than that: see `docs/runbooks/settle-gas-limit.md`.
