export function Agents() {
  const origin = location.origin
  const config = {
    mcpServers: {
      offpeak: {
        command: "bun",
        args: ["run", "packages/mcp/src/main.ts"],
        env: { OFFPEAK_PUBLIC_BASE_URL: origin, OFFPEAK_CALL_CAP_MICRO: "10000", OFFPEAK_DAY_CAP_MICRO: "1000000" },
      },
    },
  }
  return (
    <>
      <header className="page-head">
        <span className="eyebrow">FOR AGENTS</span>
        <h1>Give your agent a spending limit.</h1>
        <p className="lede">
          Use OffPeak through its OpenAI-compatible API or MCP tools. The adapter keeps model access and payment controls in one place.
        </p>
      </header>
      <div className="chat-layout">
        <section className="section agent-connection">
          <h2>Connect your runtime</h2>
          <p>API base URL</p>
          <pre>{`${origin}/v1`}</pre>
          <p>Run the MCP server from an OffPeak checkout. Set your wallet or API credentials in its environment.</p>
          <pre>{JSON.stringify(config, null, 2)}</pre>
          <a href="https://github.com/OffPeakAI/offpeak/tree/main/packages/mcp" target="_blank" rel="noreferrer">
            MCP setup and payment configuration ↗
          </a>
        </section>
        <aside className="chat-settings">
          <h2>Available tools</h2>
          <ul>
            <li>Complete a prompt</li>
            <li>Inspect current prices</li>
            <li>Schedule a batch</li>
            <li>Read signed usage records</li>
          </ul>
          <p className="note">
            For Virtuals GAME, use the OffPeak function adapter in packages/agents. For Pons-launched agents, configure the agent runtime’s
            API or MCP connection. Neither requires changing a token contract.
          </p>
          <p className="note">These are developer integrations, not a platform endorsement or marketplace listing.</p>
        </aside>
      </div>
    </>
  )
}
