# Deploy P1 to Robinhood Chain

P1 deploys five contracts: `UsageLedger`, `HostRegistry`, `OffpeakVault`, `AuditCourt` and `FeeSplitter`. Payment, Window and token contracts join later through `setPeers`, after their audits.

## Before you start

1. Create the Safes: `multisig` (2 of 3, holds the timelock), `guardian` (2 of 3, separate people) and `panel` (at least 3 of 5 human reviewers who hold no other Offpeak key).
2. Generate one key per role on separate machines: three settlers, three rulers, router signer, relay, capturer, keeper, channel payee. The router holds two of these: the router signer and the channel payee. It stops at boot if they are one key.
3. Set `treasury` and `opsWallet`.
4. Fill in `contracts/config/chains/4663.json`. Check the USDG address against Paxos's or Robinhood's published list.
5. Fund a fresh deployer key with a little ETH. The whole deployment uses about 19M gas.

## Rehearse

```bash
bun run contracts:fork
```

```bash
bun run deploy:rehearse
```

The first deploys onto a fork of the live chain, against the real USDG and Permit2, then deposits, settles and exits. The second runs the exact scripts below against a fork and verifies the wiring. Neither touches the real config or deployment files.

## Deploy

Pre-flight runs first, and a bad config stops it before any transaction.

```bash
cd contracts && forge script script/Deploy.s.sol --rpc-url "$OFFPEAK_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast
```

```bash
cd contracts && forge script script/HandOffOwnership.s.sol --rpc-url "$OFFPEAK_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast
```

```bash
cd contracts && forge script script/VerifyWiring.s.sol --rpc-url "$OFFPEAK_RPC_URL"
```

`VerifyWiring` sends nothing and reverts naming the first check that fails. The deployer key holds nothing afterwards, so discard it.

## After

1. Commit `packages/abis/deployments/4663.json`.
2. Fund the protocol reserve with `fundReserve`.
3. Run `VerifyWiring` on a schedule, and after every timelock change.

## Router configuration

| Variable | Notes |
|---|---|
| `OFFPEAK_ROUTER_SIGNER_KEY` | Signs usage records and hour closes. |
| `OFFPEAK_CHANNEL_PAYEE` | The address `ChannelManager` was deployed with. |
| `OFFPEAK_CHANNEL_PAYEE_KEY` | Optional. Signs cooperative closes and nothing else, so it holds no gas. It must be the key of `OFFPEAK_CHANNEL_PAYEE`, or the router will not boot. Without it, close answers `503 close_unavailable` and agents use the 2-hour challenge. |
| `OFFPEAK_MODELS_FILE` | `[{ name, digest, contextLength, kind, tokenizer: { manifest, dir } }]`. With `OFFPEAK_ENV=mainnet` every model needs `tokenizer`, its manifest must hash to `digest`, and every pinned file must match. A host refuses to sign counts that differ from its own, so a wrong tokenizer here leaves requests unbilled. |

To rotate the payee key, redeploy `ChannelManager`: its payee is immutable.

The tokenizer files are public, because buyers fetch them from `GET /v1/tokenizers/:digest` to recount. Keep only tokenizer and template files in `dir`.

The router writes `serving.host_load` every 15 seconds and rebuilds yesterday's and today's `serving.host_stats` every hour.

## Auditor configuration

| Variable | Notes |
|---|---|
| `OFFPEAK_CANARY_CORPUS_FILE` | The operator's own canary prompts, kept outside this repo. Hosts build from this repo, so a host holds every prompt in it and could serve the real model only on those. With `OFFPEAK_ENV=mainnet` the auditor will not boot without this file. |
| `OFFPEAK_AUDIT_SAMPLE_KEK` | Wraps each day's sample key. Keep it out of database backups. |

Run `bun run corpus:check <file>` before each corpus change. It checks size, variety and placeholders, and refuses any template from the public sample at `apps/auditor/src/corpus/sample.json`. A mainnet boot runs the same checks. Write the prompts yourself, keep the file with the same care as a key, and never commit it. Every prompt that reaches a host can be collected by that host, so add new ones as the old ones age.

Host images leave out the auditor's code. That does not stop a host reading it in this repo, which is why the corpus lives elsewhere.

Audit sample bodies are encrypted with a per-day key, and the wrapped key is deleted from `serving.audit_day_keys` with the last body of that day. Two copies outlive that deletion, so the 72-hour promise depends on how you run them:

- Database backups keep wrapped keys and encrypted bodies for as long as the backup lives. Keep backups of the `serving` schema for no more than 72 hours, or leave `serving.audit_samples` and `serving.audit_day_keys` out of them.
- The KEK stays in the environment for good, so anyone holding it and an old backup can read those bodies. Rotate it when a backup leaves your control. Rotating drops any unexpired sample, because its day key can no longer be unwrapped.

## Later phases

P2 and P3 each go live only after their own external audit, and each follows the same steps. `bun run deploy:rehearse` runs all of them on a fork.

1. Deploy with a fresh key. Neither script needs the multisig, and nothing goes live yet.

```bash
cd contracts && forge script script/DeployP2.s.sol --rpc-url "$OFFPEAK_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast
```

```bash
cd contracts && forge script script/DeployP3.s.sol --rpc-url "$OFFPEAK_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast
```

2. Each script writes `packages/abis/deployments/p2-proposal.json` or `p3-proposal.json`. From the multisig, send its `schedule` calldata to the `timelock` address in the file.
3. After 48 hours, send its `execute` calldata.
4. Run `VerifyWiring`. It reports the new phase once the wiring is live.
5. Commit `packages/abis/deployments/4663.json`.

Keep `tokenHooksEnabled` off, and leave `burnKeeper` and the swap adapter unset, until the legal gate passes.

