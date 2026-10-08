# Gate P3 status

P3 sells Windows. They go live only after their external audit.

| Check | Owner | Status | Evidence or what is left |
|---|---|---|---|
| Conservation | A | Pass | `WindowConservation` invariants: the market holds exactly its escrows and collateral, and nothing stays behind after the last claim |
| Partial units | A | Pass | `PartialUnits` invariants: a partly used unit cannot move, and its holder always keeps a unit |
| Failure claims | A | Pass | IC5 and unit tests: holders get what they paid for undrawn tokens, plus a share of all the collateral by units held at the start |
| Resale fee | A | Pass | IC5: 1% of the sale plus 10% of the markup, matching `windowResaleFeeMicro` |
| Full life on a local chain | A + B | Pass, router in process | IC5: bought, resold, drawn across two hours, settled, then expired, failed and disputed endings |
| Real chain | A | Pass | `bun run contracts:fork` runs a Window against the real USDG, and `bun run deploy:rehearse` deploys P3 through the timelock |
| Window calldata | B | Pass | `windowCalldata` sends to `WindowMarket` |
| Throughput samples | B | Pass, router in process | `apps/router/src/pay/window-perf.ts` writes one `shared.window_perf` row per minute, with a real rate and `demanded` true when a holder request waited or was in flight |
| External audit of Windows | Outside | Not started | P3 contracts go live only after it |
| Legal review, L1 | Project lead | Not started | Until it passes, `tokenHooksEnabled` stays false and there is no $OFPK messaging |

## Blocking P3 launch

1. **External audit of `WindowMarket` and `OfpkHooks`.** All high and critical findings need fixing and a re-review.
2. **The sealed tier,** owned by the serving track. The code is in and has only run against fakes, so `sealed` stays off in `GET /v1/status`. It needs a real TDX VM with a confidential-computing GPU, a DCAP verification service, real MRTD and RTMR values in `OFFPEAK_SEALED_MEASUREMENTS`, and the SDK's own-verifier check on that transcript.

## Accepted, for the external auditors to weigh

- **A host can buy its own Window.** A second wallet that buys unsold units gets a full refund on failure, plus a share of the collateral, which shrinks what real buyers receive. They still get at least 20% of the start price per unit, the share if every unit had sold. The chain cannot tell the wallets apart.
- **`maxTps` is self-reported.** A host can raise it with `updateServing` to pass the 70% rule. The Window still has to meet `minTps`, or the collateral pays out.
- **Holders who never claim.** The host's half of their unused value and any dust stay in the market. Claims never expire, and no owner path can move them.

## How Windows differ from the build doc

- Units cannot leave a wallet from the start until the Window's hours settle. Otherwise a holder could use tokens, then move the units before the hour settled, and pay nothing. Resale still works before the start, and units listed before it can still be bought.
- Batch transfers are off. The same id twice in a batch slipped past the per-transfer checks.

- The 70% rule counts tokens, not whole units. A host below about 400 tokens per second reserves less than one unit an hour, which would otherwise round to zero and refuse every Window.
- Performance reads the settlement set from the vault, so a key rotation reaches Windows without a redeploy.
- `applyDraws` shrinks a draw it cannot cover instead of reverting, because it runs inside `settle`. Settlement checks balances first, so this only guards against a stalled hour.
- Claims open 30 days after a Window ends even if settlement never posts, so a dispute or an outage cannot hold them forever.
- `WindowMarket` is compiled at 200 optimizer runs, the only contract that needs it, to stay under the 24 KB limit.
