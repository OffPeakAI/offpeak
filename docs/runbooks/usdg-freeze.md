# USDG frozen on a contract

USDG is an upgradeable, pausable token, and its issuer can freeze addresses. Nothing on chain can undo that, and Offpeak has no way around it.

1. **Confirm it:** a transfer involving the vault, registry or court reverts inside the token.
2. **Guardian pauses usage** with `setUsagePaused(true)`, so no new usage builds up against balances that cannot move.
3. **Tell users** what is frozen and what is not. The honest limits page already says USDG can be frozen by its issuer.
4. **Contact the issuer.** Only Paxos can lift it.

## What a freeze does to payments

- **A frozen buyer or agent:** captures, channel closes and escrow expiries still finish. Their refund waits in `owed` on that contract, and they collect it with `claimOwed` once the freeze lifts.
- **A frozen challenger or host:** challenges still finalize. Their payment waits in `owed` on `AuditCourt` the same way.
- **USDG paused entirely:** nothing moves. If a pause outlasts a channel's 2 hour challenge or an escrow's 15 minute grace, a voucher or capture can miss its window. The host is paid from the reserve after 24 hours, as with any write-off.
