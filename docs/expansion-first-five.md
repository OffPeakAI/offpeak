# First five expansion components

This change adds working application and service code. It does not deploy contracts, register a Telegram bot, configure external agent platforms or enable production traffic. Existing [P1](launch/gate-p1.md), [P2](launch/gate-p2.md) and [P3](launch/gate-p3.md) launch requirements still apply.

| Component | Implemented here | Deployment boundary |
| --- | --- | --- |
| Pons / Virtuals | Operator-capped tool, GAME custom-function adapter, runtime MCP/API setup page at `/agents` | Configure the actual runtime; no marketplace listing or token-contract change |
| MPP + Bursar | Custom MPP channel transport and SDK wrapper; separate Bursar mandate-funded merchant gateway | Configure channel contracts and MPP secret; deploy/fund the gateway separately |
| OffPeak Chat | Wallet-session web chat, per-message cap, usage download, Telegram Mini App handoff | Host the app on HTTPS; configure Telegram webhook and wallet connectivity |
| Windows | Host creation and collateral plan, existing buy/resale pages, active holding-to-chat link | Deployed/audited WindowMarket and host capacity required |
| OFFPEAK Index | Signed hourly model-specific prices derived from settled receipts, SDK signature verification, `/index` UI | Requires real eligible receipts; no derivatives or on-chain oracle |

## Router and web rollout

1. Use Bun 1.4.4 and `bun install --frozen-lockfile`.
2. Apply the serving migration with the existing deployment process (`bun run db:serving`). It adds `serving.expansion_replays` and router-role permissions. The normal session sweeper expires these IDs.
3. Build the web app: `bun run --filter @offpeak/web build`. Deploy the router and its web assets in the same release. `/chat`, `/agents`, `/windows` and `/index` use the same origin.
4. Set the optional MPP and Telegram variables below only when their dependencies are ready. Leave them unset to keep those endpoints disabled.
5. Check `/v1/status`, `/v1/models` and `/v1/index`; exercise wallet login, an intentionally low cap and one explicitly authorized funded request. Confirm a saved usage record and backend usage agree.

Chat uses the existing wallet session and vault balance. Signing in moves no funds; each Send authorizes an inference request within its displayed cap. No API key is created. The conversation stays in tab memory; router/hosts still process its content. This implementation uses completed responses, not token-by-token display. Stop cancels the connection but does not guarantee zero billable work. Clear/changed wallet discards the local conversation. The public model list now exposes `offpeak.kind`, so embeddings are excluded from chat choices.

The total cap includes buyer fees and the router's maximum reservation across eligible failover hosts. It can refuse a request whose eventual usage might have been cheaper. Flex and sealed requests do not accept this new cap. Existing per-token max-price controls remain available.

## MPP session method

Set `OFFPEAK_MPP_SECRET` to a dedicated random secret of at least 32 characters, shared by router replicas. Channel feature flags and deployed channel contracts must also be valid. Rotating this secret invalidates outstanding challenges.

`Accept-Payment: offpeak-channel` on `/v1/chat/completions` requests a Payment challenge. The custom method is `offpeak-channel`, intent `session`: it authenticates an existing USDG channel, then uses OffPeak's existing metering and voucher settlement. It is not the generic `evm`/`tempo` charge method and is not automatically interoperable with arbitrary MPP wallets. Request JSON is canonically encoded; challenges bind body, realm, path, price/charge caps and a 120-second expiry. Credentials are single use across replicas. The signed OffPeak usage record is the billing record; no final-payment receipt is fabricated.

```ts
import { Offpeak, mppChannelFetch } from '@offpeak/sdk'
const op = new Offpeak({
  baseURL: process.env.OFFPEAK_PUBLIC_BASE_URL!,
  wallet, // existing authorized signer
  channel: { id: channelId }, // use the SDK's existing funded-channel configuration
  fetch: mppChannelFetch(),
})
await op.chat({ model, messages, max_tokens: 512 }, { maxChargeMicro: 10000n })
```

For Bursar, use the [merchant gateway runbook](../services/bursar-gateway/README.md) and [mandate client adapter](../packages/agents/README.md). Its fixed task price is distinct from direct metered billing. The gateway's backend receipt names the merchant as payer; it does not manufacture a distinct buyer for every agent.

## Telegram

Set `OFFPEAK_CHAT_PUBLIC_URL=https://your-app-origin.example/chat` and `OFFPEAK_TELEGRAM_WEBHOOK_SECRET` to 32–256 random letters, digits, underscores or hyphens. In BotFather, configure the HTTPS app domain/menu for your existing bot. Register `/v1/telegram/webhook` using Telegram `setWebhook` with the same `secret_token` and `allowed_updates: ["message"]`. Keep the bot token in your secret manager; do not put it in the repository or command history. Registration is an operator step and is not performed by starting the router.

The bot responds in private chats to `/start`, `/ask prompt` or ordinary text with an Open Chat button. It ignores groups. The prompt travels in the URL fragment and is not sent as an HTTP query. Sending still requires the user's wallet session and an explicit Send. This is a Mini App handoff, not a custodial inline-response bot. Verify your wallet supports the Telegram webview before rollout; this change does not add WalletConnect.

## Windows

Registered routable hosts can review a capacity listing under `/windows`, approve its USDG collateral, then sign the existing `WindowMarket.create` call. The plan validates exact-hour boundaries, auction order, registered model/speed and the 70% capacity ceiling. Contract simulation remains authoritative for overlapping reservations. Collateral is 20% of units times starting price, rounded up. Each unit represents one million tokens.

Buy and resale use the existing contract paths. An active holding opens `/chat?window=ID`. A short or expired holding fails rather than automatically spending vault credit. No new contracts or contract-address changes are included.

## Index

`GET /v1/index` publishes the last 24 completed hours, grouped by exact model digest. Prices are integer micro-USDG per million combined input/output tokens, including buyer fees; they should not be compared directly with separate input or output list prices.

Only final, settled receipts are eligible. Non-prepaid modes also need collected/drawn payment evidence. Refunded records, same-wallet self-payments, zero-cost Windows and duplicates are excluded. Each bucket needs at least 10 records, 5 payer wallets and 3 hosts; no host may represent more than 50% of tokens. Distinct wallets do not prove distinct people. Above 10,000 eligible receipts the feed suppresses publication instead of silently truncating its sample. Empty or concentrated buckets show a reason, never a zero price.

The response includes receipt IDs, methodology, expiry and a domain-separated publisher signature. Use SDK `verifyIndex` with independently pinned router signer, chain ID and usage-ledger address. A signature authenticates the publisher; it does not establish market independence. The current version excludes occupancy and peak/off-peak spread because the required slot measurements are not yet recorded. It is a read-only feed, not an audited oracle for financial settlement.

## Checks

```sh
bun test apps/router/test/expansion packages/agents/test services/bursar-gateway/test
bun run lint:claims
bun run scan:names
```

Run the existing router, SDK and web regression checks as part of rollout. Local tests use deterministic hosts and chain doubles; production GPU inference, wallet webviews, funded settlement and contract audit are separate checks.
