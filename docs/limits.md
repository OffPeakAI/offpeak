# Limits

- Open-weight models only. Offpeak does not sell closed models. Open models trail frontier models on the hardest tasks.
- Prices move. The live price shown at request start is what you pay. Caps protect you. Interactive requests over your cap fail with 429. Night jobs wait.
- Discounts depend on host supply and idle time. With few hosts, discounts are smaller.
- Open hosts can read prompts, and so can Offpeak's router, unless you use the sealed tier with client-side encryption. The sealed tier is not switched on yet.
- Audit sampling stores request bodies for up to 72 hours, only if you opt in. Opt-in buyers get 1% off.
- Audits are statistical. They catch sustained model swaps, not every single response.
- Usage records are signed by Offpeak's router and the host. You can recount your own requests and dispute any request within 7 days. Recount from a record under Usage on the dashboard, with `op.verifyUsage` in the SDK, or with `offpeak_usage` in MCP. All three use the model's own tokenizer, checked against the record's model digest. If a deployment publishes no tokenizer for a model, the counts are byte-level and the result says so.
- Sealed records cannot be recounted from your plaintext. Their counts come from the attested host.
- Your balance is prepaid credit for Offpeak, not a bank deposit and not e-money.
- Withdrawing the reserved part of a balance can take up to 2 hours.
- USDG can be frozen by its issuer. Permit2 is a shared dependency.
- During the beta, deposits are capped at 500 USDG per buyer until the external contract audit is complete.
- Holding $OFPK alone earns nothing. Token hooks are not switched on yet.

Third-party names describe compatibility only; no affiliation.
