# Pausing

Use this when something is wrong on chain or in settlement, and more damage could land while you work it out. If in doubt, pause. It is cheap to undo, and buyers can still leave.

Nothing is on mainnet yet, so the contacts below are placeholders. Fill them in before launch, and keep the real list out of this repo.

| Who | Contact |
|---|---|
| Guardian signer 1 | `<guardian-signer-1-contact>` |
| Guardian signer 2 | `<guardian-signer-2-contact>` |
| Guardian signer 3 | `<guardian-signer-3-contact>` |
| On-call engineer | `<on-call-contact>` |
| Public announcements | `<announcement-owner-contact>` |

## The two switches

Both are on `OffpeakVault`, and the guardian Safe (2 of 3) sends them with no timelock.

| Call | What stops | What keeps working |
|---|---|---|
| `setUsagePaused(true)` | The router stops serving new requests, with reason `paused`. This is the router obeying the flag, not the contracts refusing usage | Settlement of hours already served, withdrawals and withdraw-all |
| `setSettlesPaused(true)` | `settle`, `refund`, `distributeRewards` and `postPerformance`, so no batch, refund, reward or Window performance lands | Withdrawals and withdraw-all |

Neither switch stops `withdraw`, `requestWithdrawAll` or `executeWithdrawAll`. There is no pause on the channel or x402 contracts.

## Which one

- **Bad or suspect settlement batch, or a settler key in doubt:** pause settles. Then follow `docs/runbooks/settlement-key-compromise.md`.
- **USDG frozen on a contract:** pause usage. Then follow `docs/runbooks/usdg-freeze.md`.
- **Router or host trouble that bills people wrongly:** pause usage.
- **A contract bug, or you do not know yet:** pause both.

## Steps

1. **Reach two guardian signers.** One signer cannot pause alone.
2. **Send the pause** from the guardian Safe. Note the transaction hash.
3. **Check it.** `usagePaused` and `settlesPaused` on the vault show the new state, and a `Paused` event carries both values. For a usage pause, confirm the router refuses a test request.
4. **Claw back if a bad batch landed.** `clawBack(host, hour, reason)` on `HostRegistry` reaches credits inside their 24 hour hold, so do this early.
5. **Tell users** what stopped, what still works and when you will next update them. Withdrawals keep working, so say so.
6. **Watch what a long pause costs.** Vouchers and captures can miss their windows if the chain or USDG is the cause. See `docs/runbooks/stuck-channel-close.md` and `docs/runbooks/usdg-freeze.md`. While settles are paused, `SettlementLagging` and `SettlementLate` will fire, and that is expected.

## Unpausing

1. Find the cause, and fix it or rotate what was exposed.
2. Run `VerifyWiring` against the live config. It sends nothing.
3. Send `setSettlesPaused(false)` or `setUsagePaused(false)` from the guardian Safe, the same way.
4. Watch `settle_lag_seconds` fall as the hours catch up in order, and check that `SignersDisagree` stays quiet.
5. Tell users it is over, and publish what happened.

## Not covered by an alert yet

No metric reports the pause flags, so nothing pages when someone pauses. Until one exists, watch the vault's `Paused` event, or the `chain.vault_state` table the indexer keeps.
