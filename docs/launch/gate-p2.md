# Gate P2 status

Agent payments: channels first, `upto` as the fallback, `exact` for fixed prices. IC4 is the milestone that proves them.

| Check | Owner | Status | Evidence or what is left |
|---|---|---|---|
| Channels | A | Pass | `Channel` invariants: paid plus refunded equals deposits, no close before 2 hours, the latest voucher in the challenge always lands |
| Escrow | A | Pass | `X402` invariants: the escrow holds exactly the open maximums, and a revoked approval cannot reduce one |
| Real tokens | A | Pass | `bun run contracts:fork` runs `upto` and a channel through the real USDG and Permit2 |
| Close race | A | Pass | IC4: the keeper lands the voucher in 100 of 100 runs on an RPC with added latency, where 10% of calls fail and half of those lose the response after the node acted |
| 1,000 calls | A + B | Pass, router in process | IC4: an agent's channel through the router, claimed as it goes, settled to the host |
| `upto` first token | A + B | Pass, local | IC4: 20 calls under the 1.5 second target. Rerun with the live chain's block times |
| Client signing | B | Pass | The SDK and MCP send `X-Offpeak-Channel-Auth` on every channel request, and contract wallets sign through EIP-1271 (`tests/integration/channel-wallets.test.ts`) |
| Cooperative close | A + B | Pass, local | `packages/sdk/test/chain.test.ts` runs `op.channels.close` through the real router and the real `ChannelManager` on anvil, and shows the contract refusing any signer but its payee |
| Night jobs | B | Pass, router in process | `/v1/batches` plans inside its deadline and refuses a locked price over the cap, and the MCP tool sends both |
| External audit of P2 contracts | Outside | Not started | Blocks lifting the beta cap |

## Blocking P2 launch

1. **External audit of the payment contracts.** They go live only after it, and all high and critical findings need fixing and a re-review.
2. **Four new keys.** Relay, capturer, keeper and channel payee, listed in `docs/runbooks/deploy-mainnet.md`. The first three need gas. The payee only signs, and the router holds it in `OFFPEAK_CHANNEL_PAYEE_KEY`. Without it, cooperative close answers 503 and agents wait out the challenge.

## Decided here

- **`upto` starts at 0.05 USDG, so it covers few chat calls.** The 402 now quotes each request's real maximum cost, with 10% over for prices that move before the paid retry. Under 0.05 USDG it offers channels only, as the build doc sets. Most single chat calls are under that, so a wallet with no channel cannot pay for them. If `upto` should cover them, quote at the minimum instead and change section 3.10.

## Deploying P2

Rehearsed by `bun run deploy:rehearse`, which runs each step on a fork of the live chain:

1. `forge script script/DeployP2.s.sol --broadcast` deploys both contracts and writes `packages/abis/deployments/p2-proposal.json`.
2. The multisig sends that file's `schedule` calldata to the timelock.
3. After 48 hours, the multisig sends its `execute` calldata.
4. `VerifyWiring` reads the wiring back and confirms it.

## Lifting the beta cap

The cap lifts only after the external audit gate passes:

1. The multisig schedules `disableBetaCap()` on the vault through the timelock.
2. After 48 hours, it executes it.
3. Set `betaCapLifted` to `true` in `contracts/config/chains/4663.json`, or `VerifyWiring` fails on purpose.

## Capacity

Settlement built and signed one hour of 200,000 records from 2,000 buyers in 121 seconds on a laptop, against the 5-minute target (`bun run load:settlement`).

Building is not the limit, but the chain is. A transaction holds 32M gas, so that same hour fits 1,154 of its 2,000 prepaid buyers, and the smallest 846 are excluded by rule and page someone. See `docs/runbooks/settle-gas-limit.md`.

## Money that does not follow the normal path

Settlement handles each of these by rule, so none needs a person:

- **Served but never paid:** the record's host is paid from the reserve after 24 hours.
- **Paid after that write-off:** the late money joins fees.
- **Paid for an excluded record:** the payment draws in full, and the payer gets the difference back as a refund.
- **Collected with no payment row,** such as a router crash mid-request: after 24 hours the money joins fees.
- **A row asking for more than the pool holds:** it waits, so it cannot stall the hour.
