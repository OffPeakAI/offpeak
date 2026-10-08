# Settle gas limit

Robinhood Chain caps a transaction at 32M gas (`ArbGasInfo.getGasAccountingParams`, read on 2026-11-01). A settle is one transaction, and an hour cannot split across two, so the contract's `MAX_DEBITS = 2000` is more than fits.

## What one settle holds

From `contracts/.gas-snapshot`:

| Item | Gas each |
|---|---|
| Buyer's first debit | 62,000 |
| Buyer debited earlier that day | 24,000 |
| Host credit | 144,000 |
| Window draw | 70,000 |

With 20 hosts, one settle holds about 420 first-time buyers or 1,040 repeat ones. Channels and `upto` draw from the agent pool and add no debits, so only prepaid buyers count.

## What happens at the limit

Settlement cannot stop. `buildBatch` keeps a 30M budget, keeps the largest buyers and draws, and excludes the records of the smallest. Agent payments that do not fit simply wait for a later hour. The excluded records go to `chain.settlement_rejects` with the reason `over_batch_capacity`, those buyers are not charged, and their hosts are not paid for those records.

The alert `SettleBatchOverCapacity` pages. Lost revenue for that hour is not recoverable.

## What to do

1. Read the excluded records in `chain.settlement_rejects`, and compensate the hosts from the treasury if the amount matters.
2. If it recurs, the router must cap distinct prepaid buyers per hour below the capacity above.
3. The lasting fix is a two-part batch. That changes the vault and the shared interface, so it needs both owners, a new vault and an audit. Start it when `SettleBatchNearGasLimit` fires regularly, which leaves time.
