# RPC outage

Settlement retries by itself and needs no one to act unless the outage outlasts the alert.

1. **Check the three signers' providers.** Each signer has its own, so one outage only stops one signer, and two can still settle.
2. **If two or more are down,** point them at a working endpoint with `OFFPEAK_RPC_URL` and restart them. `https://rpc.mainnet.chain.robinhood.com` and `https://robinhood.drpc.org` are both public fallbacks for reads.
3. **Late settlement is safe.** Hours settle in order, one per batch, so signers catch up on their own. Withdraw-all needs no settlement at all, and if a buyer exits first, `_coverShortfall` takes the hour's shortfall from fees, then the reserve, then every host credit in that batch pro rata. That last step emits `CreditShortfall`, and hosts lose that amount for the hour.
