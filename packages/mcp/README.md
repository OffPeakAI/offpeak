# @offpeak/mcp

MCP tools for Offpeak, over stdio or streamable HTTP. An agent can run a completion at the off-peak live price, read prices, schedule a night job, and check its signed usage records.

| Tool | Input | What comes back |
|---|---|---|
| `offpeak_complete` | `model`, `messages`, `max_tokens`, `max_price?`, `tools?`, `response_format?` | Text or tool calls, the signed usage record, its local verification and recount |
| `offpeak_prices` | `model?` | Live price, cheapest host, next 24 hours of the forecast |
| `offpeak_schedule_job` | `model`, `requests[]`, `deadline`, `max_price?` | Job id, locked price, planned hours, estimated cost |
| `offpeak_usage` | `req_id?`, `since?`, `recount?` | Records with their verification result and proof status |

`max_price` is `{ in, out }`: decimal USD per 1M tokens, fee included. The live price at request start is what you pay. Above your cap `offpeak_complete` fails with `price_above_cap`. If a record still bills above it, the call fails with `over_max_price` and the request id, so you can dispute it.

A tool that fails answers with `isError` and `{ error: { code, message } }`.

## Spend limits

An agent acts on whatever text it reads, so these limits are the operator's, and no tool call can raise them.

- **`OFFPEAK_CALL_CAP_MICRO`**, 1 USDG by default, is the most one tool call can cost. It is also the most an `upto` may authorize. A call's cost is worked out before it runs: every input byte as a token, plus `max_tokens`, at the call's `max_price`. Above the limit the tool fails with `call_cap`, and `offpeak_schedule_job` counts the whole job, with 4096 tokens for a line that sets no `max_tokens`.
- **`OFFPEAK_DAY_CAP_MICRO`**, 10 USDG by default, is the most these tools spend in a UTC day. Once the running total would pass it, tools fail with `day_cap` until the day ends. A call counts what its record bills, a job its `estimated_cost`, and an `upto` the whole amount it signs, since a capture can take all of it. A call that fails with no way to tell whether it was served counts at its worst case.
- **`OFFPEAK_MAX_PRICE`**, `in=1,out=4` by default, is the `max_price` for a call that sets none, in the same units. A higher `max_price` from a call is lowered to it.

The running total lives in this process, and a stdio client starts a server per session. Set `OFFPEAK_SPEND_FILE` to keep it across restarts, or each session starts the day at zero.

## Running it

```bash
# stdio
OFFPEAK_PUBLIC_BASE_URL=https://api.example OFFPEAK_API_KEY=op_live_... bun run packages/mcp/src/main.ts

# streamable HTTP, at http://127.0.0.1:8790/mcp
OFFPEAK_PUBLIC_BASE_URL=https://api.example OFFPEAK_API_KEY=op_live_... bun run packages/mcp/src/main.ts --http
```

As an MCP client entry:

```json
{
  "mcpServers": {
    "offpeak": {
      "command": "bun",
      "args": ["run", "packages/mcp/src/main.ts"],
      "env": { "OFFPEAK_PUBLIC_BASE_URL": "https://api.example", "OFFPEAK_API_KEY": "op_live_..." }
    }
  }
}
```

## Paying

Use an API key, an agent wallet, or both.

- **`OFFPEAK_API_KEY`** pays from your prepaid vault balance. Night jobs need it.
- **`OFFPEAK_AGENT_WALLET_KEY`** is a key for a local wallet. It stays in this process and signs vouchers and payer proofs here. Requests carry signatures, never the key. Use a wallet that holds only what you mean this agent to spend.

With a wallet, set `OFFPEAK_CHANNEL_ID` to use an open channel, or `OFFPEAK_CHANNEL_DEPOSIT`, `OFFPEAK_CHANNEL_STATE_FILE` and `OFFPEAK_RPC_URL` to open one on the first call. The state file keeps the channel's id, so a restart reuses it and funds a new one only once that channel has closed or is about to expire. A start that cannot read the file, or cannot read the channel it names, stops rather than deposit again. Give each running server its own file. With neither, and no API key, a call pays by `upto`, which needs a Permit2 approval and has a 1 USDG limit per call. The router offers `upto` only from 0.05 USDG, so most single calls need a channel or a key. A channel wins over an API key when both are set.

A voucher is signed only for what verified usage records cover. Each record must match the prompt sent and the output received, recount with the model's tokenizer, bill no more input tokens than the request could hold, fit that request's `max_tokens`, and carry a time from while it ran. A deployment that publishes no tokenizer gets no voucher unless you set `OFFPEAK_CHANNEL_PAY_UNCOUNTED=true`. If the records do not add up, `offpeak_complete` shows the reason in `channel.voucher_problem` and no voucher is signed, so the router's credit limit stops further spend. On restart, an existing channel starts from the last voucher you kept, and the router's `owed` past that is not signed, because no record you hold covers it. `OFFPEAK_CHANNEL_STATE_FILE` also keeps the ids of counted records, so none is paid for twice across a restart.

These tools do not close a channel. Use `op.channels.close()` from `@offpeak/sdk`.

## Environment

| Variable | Needed | Meaning |
|---|---|---|
| `OFFPEAK_PUBLIC_BASE_URL` | yes | Router origin |
| `OFFPEAK_API_KEY` | this or the wallet key | Prepaid API key |
| `OFFPEAK_AGENT_WALLET_KEY` | this or the API key | Agent wallet key, `0x` and 64 hex characters |
| `OFFPEAK_DEPLOYMENT_FILE` | to verify | Path to a deployment JSON. Without one the records show as not checked. |
| `OFFPEAK_ROUTER_ADDRESS` | if the file has no router role | Expected router signer |
| `OFFPEAK_RPC_URL` | for on-chain proofs and any channel | RPC for chain 4663. Without one, records show `host_registry` as not checked |
| `OFFPEAK_CHANNEL_ID` | no | Open channel to pay from |
| `OFFPEAK_CHANNEL_SEQ`, `OFFPEAK_CHANNEL_CUMULATIVE` | to restart on a used channel | The `seq` and `signed` the server last reported. Set both, or debt from before the restart stops vouchers until you settle it |
| `OFFPEAK_CHANNEL_DEPOSIT` | no | µUSDG to deposit when opening one |
| `OFFPEAK_CHANNEL_EXPIRY_S` | no | That channel's lifetime in seconds |
| `OFFPEAK_CHANNEL_STATE_FILE` | with a deposit | Path this server keeps its channel in. With `OFFPEAK_CHANNEL_ID` it replaces `OFFPEAK_CHANNEL_SEQ` and `OFFPEAK_CHANNEL_CUMULATIVE` |
| `OFFPEAK_CHANNEL_PAY_UNCOUNTED` | no | `true` signs vouchers for a model with no published tokenizer, leaving its token counts unchecked |
| `OFFPEAK_CALL_CAP_MICRO` | no | Most one tool call can cost, in µUSDG. Default `1000000` |
| `OFFPEAK_DAY_CAP_MICRO` | no | Most these tools spend in a UTC day, in µUSDG. Default `10000000` |
| `OFFPEAK_MAX_PRICE` | no | Default and highest `max_price`, as `in=<usd>,out=<usd>`. Default `in=1,out=4` |
| `OFFPEAK_SPEND_FILE` | to hold the day cap across restarts | Path this server keeps the day's total in |
| `OFFPEAK_MCP_HOST` | no | HTTP bind address, default `127.0.0.1` |
| `OFFPEAK_MCP_PORT` | no | HTTP port, default `8790` |
| `OFFPEAK_MCP_TOKEN` | to leave this machine | Bearer token for HTTP, at least 32 characters |

The server refuses to start with an Offpeak service key in its environment.

## HTTP safety

Whoever reaches this server can spend through it. By default it listens on `127.0.0.1` and turns away requests with another `Host` or a browser page's `Origin`. To bind any other address you must set `OFFPEAK_MCP_TOKEN`, and clients then send it as `Authorization: Bearer`. It does not terminate TLS, so put it behind something that does.

## Limits of these tools

- `offpeak_usage` lists your records from the router with an API key. A wallet alone has no key, so it lists the records this server has seen since it started. With `req_id` it finds any record the router has.
- To recount a past record, pass `recount` with `req_id`: `{ prompt, output, tool_calls?, finish_reason? }`, where `prompt` is the body you sent. Nothing in it leaves this server. `offpeak_complete` recounts every call by itself. Both use the model's tokenizer, checked against the record's digest. When the deployment publishes none for that model, `tokenizer` is `none`, `countsOk` is `null`, and `ok` is false: the counts were not checked.
- `offpeak_schedule_job` sends your `max_price` and `deadline` to the router. A job over the cap is refused with a `cheapest_deadline`, and a deadline no hour fits with `no_hours`. Nothing is created either way.
- The forecast is a forecast, not a quote.

## Honest limits

- Open-weight models only. Offpeak doesn't sell closed models. Open models trail frontier models on the hardest tasks.
- Prices move. Caps protect you, and requests over your cap wait (night jobs) or fail with 429 (interactive).
- Discounts depend on host supply and idle time. With few hosts, discounts are smaller.
- Open hosts can read prompts, and so can Offpeak's router.
- Audits are statistical. They catch sustained model swaps, not every single response.
- Usage records are signed by Offpeak's router and the host. You can recount your own requests and dispute any request within 7 days.
- USDG can be frozen by its issuer. Permit2 is a shared dependency.
- During the beta, deposits are capped at 500 USDG per buyer until the external contract audit is complete.

Third-party names describe compatibility only; no affiliation.
