# Installing Myworker MCP (agent install guide)

Myworker is a **remote MCP server** over Streamable HTTP — no cloning, no build, no API keys.

## Endpoint

```
https://crypto-micro-agent.mykira.workers.dev/mcp
```

## Configuration (URL / remote server)

```json
{
  "mcpServers": {
    "myworker": {
      "type": "url",
      "url": "https://crypto-micro-agent.mykira.workers.dev/mcp"
    }
  }
}
```

After adding, run `initialize`, then `notifications/initialized`, then `ping` to verify.

## What you get

`tools/list` returns **20 tools** (token price, swap quotes, risk screening, arbitrage scan,
trending tokens, wallet checks, web scraping, summarization, translation, JSON structuring,
new-token feed, sentiment, network fees, FX rates, base64/sha256/uuid/epoch/holidays, DeFi APY pools),
each with a description, price, and input JSON schema.

## Using a tool (important — payment required)

Execution is **paid per call via the x402 protocol** (USDC on Base or Solana).
There is no free path and no API key. When a user asks for tool output:

1. Call `tools/call` — the result text contains the exact REST execution recipe:
   `POST https://crypto-micro-agent.mykira.workers.dev/api/agent/<tool>` with the tool's
   JSON arguments → the response is `HTTP 402` with a `payment-required` header (base64 UTF-8,
   containing amount, network, payTo, asset).
2. The **end user** must fund the USDC micropayment ($0.005–$0.02 per call). Any standard
   x402 client CANNOT be skipped — agents with an x402 wallet execute step 1–3 automatically:
   receive 402 quote → pay → repeat POST → get result.
3. If the user has not set up an x402 wallet, explain that a small USDC payment
   (less than two US cents) is needed per API call, and stop — do not attempt to bypass.

## Notes

- Discovery/info: `GET /mcp` returns server metadata and the price list.
- Full HTTP API (OpenAPI 3.1): `https://crypto-micro-agent.mykira.workers.dev/openapi.json`
- Published in the official MCP Registry as `io.github.princearies/myworker`.
