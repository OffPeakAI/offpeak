# Internal security review

An independent internal review of the P1 and P2 contracts, run on 2026-11-01 ahead of the external audit. It does not replace that audit.

It found no direct way to steal a buyer's funds. Each finding below came with a working proof of concept unless noted.

## Fixed

| Severity | Finding | Fix |
|---|---|---|
| High | A swap ruling 7 days or more after filing could never be confirmed, so the host escaped the slash | The panel gets 7 days after the review ends, however late the ruling came |
| High | Governance could reach bonds: an empty peer slot let a new peer record credits it never funded | The registry tracks what it owes in `totalOwed` and refuses any credit it does not hold USDG for |
| High | Governance could swap the rulers and panel, then fake a Confirm, faster than a host could leave | Signer changes take 8 days on top of the timelock, longer than the 7 day unbonding |
| Medium | Stacked Breach rulings could take about 99% of a bond with no panel | A delisted host takes no further Breach slash, so two rulings are the most that can land |
| Medium | Credits released during a dispute survived a 100% slash | A full slash forfeits every unwithdrawn credit, and they sweep to the reserve |
| Medium | A gas-burning contract wallet could revert a whole `authorizeBatch` | Each item runs on a fixed 300,000 gas |
| Medium | A blocklisted challenger could lock a host for good | Court payments that fail wait in `owed` for `claimOwed` |
| Medium | A payer could add code to its account after being served and make its vouchers unlandable | A key's own signature counts first, whatever code the account has later |
| Low | Concurrent Breach rulings could oversubscribe a refund tree | A claim pays what is left instead of reverting |
| Low | A frozen payer could block capture, expiry and channel close | Refunds that fail wait in `owed` for `claimOwed` |

## Accepted, for the external auditors to weigh

- **Challenge griefing.** Any challenge blocks a host's credit withdrawals and exit. Holding one open costs about 50 USDG per cycle, or nothing if the rulers stay silent for 14 days, because a timeout gives the whole bond back. The build doc sets those amounts.
- **USDG pauses.** A pause longer than 2 hours can make a voucher miss its challenge. See `docs/runbooks/usdg-freeze.md`.
- **Settler keys.** Two of three can understate a buyer's `lastTs` inside the request hour, and new settlers take effect after the 48 hour timelock. Buyers can leave in 2 hours, so that delay is enough for them.
- **Stray transfers.** USDG sent directly to a contract stays there. There is deliberately no owner function that could move it.

# Window review

A second independent internal review, of `WindowMarket`, `OfpkHooks` and their services, run on 2026-11-01. It also does not replace the external audit.

## Fixed

| Severity | Finding | Fix |
|---|---|---|
| Critical | The same id twice in a batch transfer slipped past the partial-unit lock, which could make every later settle revert | Batch transfers are off, and a draw can no longer underflow |
| Critical | The same trick reset bases, so a holder could take escrow from other holders | Batch transfers are off |
| Critical | One `list` at a huge price stopped the indexer, and so settlement | Prices must fit their type, the column holds any value, and an event that cannot apply is logged and paged instead of stopping ingest |
| High | Settlement could build more draws than the vault or the chain accepts | Draws have a cap and a gas cost in the budget, and the smallest are excluded by rule |
| High | Performance read the router's rows as throughput, which they are not | `perf.ts` reads one sample a minute as the build doc defines. The router must change to match, see `docs/launch/gate-p3.md` |
| High | A holder could use tokens, move the units away and pay nothing | Units cannot leave from the start until the Window's hours settle |
| Medium | A post after the 30 day fallback could pay collateral twice | Posting closes at the fallback |
| Medium | Replaying the first signatures could finalize a dispute | Only a settler can answer a dispute |
| Medium | Many small credits could make a court seizure run out of gas | A host has one credit entry per hour |
| Low | A non-zero tier 0, an unbounded early access period, `minTps` of zero, claims ahead of settlement, a frozen host blocking the last claim, an unbound `window_id` | Each is refused or handled, with its own test |

The burn's `minOut` from the first review is also closed: only a keeper the timelock names can burn.

## Live router review

Two independent reviews of the router after it moved onto live services. These cover router code, not contracts.

| Severity | Finding | Fix |
|---|---|---|
| Critical | A Window fallback served free inference, because the record still billed zero | Who pays is settled before routing, and a fallback is an ordinary prepaid request |
| Critical | A higher sequence on an old boundary lowered what was owed, which credited hosts twice | Vouchers only raise what is owed, and paid boundaries are deleted |
| Critical | `upto` replies skipped the authorization gate unless they were long streams | Every reply waits for authorization before billing, and a failure bills nothing |
| High | Anyone holding a channel id could spend its credit | Each request carries a payer signature over its body, with a nonce, and a replay is refused |
| High | `owed` included other requests' reservations, and a crash leaked them | Reservations are separate rows that expire |
| High | Vouchers could orphan a request or cover one twice | Each boundary holds only its own requests |
| High | A cancelled stream or streamed bad JSON went unbilled | Both bill what came through |
| High | `max_tokens` was priced but never sent to the host | The host gets the priced limit, and a record cannot exceed the hold |
| High | A failure after the record committed lost the capture | Captures queue in the record's transaction and a sweep finishes them |
| High | Dashboard reads, disputes and API keys had no auth | They need a session and take the wallet from it |
| Medium | Tightening pushes only cleared caches, and a stale event could undo a newer one | Pushes apply at once, and only a later block undoes them |
| Medium | One replayed proof, a stuck host, an empty stream, a bad price header and stale host stats | Each has a fix and a test in `apps/router/test/review-fixes.test.ts` |

## Accepted, for the external auditors to weigh

- **A cut stream bills what the router received, not what the host generated.** The host may produce a little more before the abort reaches it.
- **A router can under-report a cut stream.** The host signs a partial record it cannot fully check. The router is already trusted within the request hour.

See `docs/launch/gate-p3.md`: a host buying its own Window, self-reported `maxTps`, and holders who never claim.

