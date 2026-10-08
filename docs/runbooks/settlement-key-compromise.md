# Settlement key compromise

One stolen key can do nothing: every batch needs two of three. Treat any suspected key as stolen anyway.

1. **Guardian pauses settles.** `setSettlesPaused(true)` from the guardian Safe. This also stops refunds and rewards. Withdrawals and withdraw-all keep working.
2. **Guardian claws back the last 24 hours of host credits** for any bad batch: `clawBack(host, hour, reason)`. Credits past 24 hours are out of reach, which is why speed matters.
3. **Rotate.** Generate a new key, then have the multisig queue `setSettlers` on the vault. It takes 48 hours through the timelock.
4. **Unpause** once the new set is live and `VerifyWiring` passes with the updated config.

Buyers can leave throughout: withdraw-all pays out within 2 hours whatever settlement is doing.

## Ruling keys and the panel

These change more slowly, on purpose. The multisig calls `proposeSigners` through the 48 hour timelock, then anyone calls `applySigners` 8 days later. That wait outlasts the 7 day host unbonding, so a host sees any new signer set coming in time to start leaving. Two stolen ruling keys can take at most two 20% slashes in that time: after the second strike the host is delisted and further Breach rulings take nothing, and a full slash always needs the panel.
