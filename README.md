# Myworker — 20 Paid Micro-APIs for AI Agents (x402)

**Myworker** is a paid agent-to-agent API running on Cloudflare Workers.
AI agents and bots can call **20 micro-services** (token prices, risk screening, DeFi yields, FX rates, web scraping, and more) and pay **per call in USDC** using the [x402 protocol](https://www.x402.org/) — micropayments settled on-chain (Base & Solana).

- 🌐 **REST + x402 (paid, per call):** `https://crypto-micro-agent.mykira.workers.dev/api/agent/<service>`
- 🔌 **MCP endpoint (Streamable HTTP):** `https://crypto-micro-agent.mykira.workers.dev/mcp`
- 📄 **OpenAPI:** `https://crypto-micro-agent.mykira.workers.dev/openapi.json`
- 🏪 **Agent Bazaar test path:** `POST /agentbazaar` with `{"task": "...", "jobId": "t1"}`

## Services & pricing

| Service | Price (USDC) | What it returns |
|---|------|---|
| `harga` | $0.005 | Token price (USD), liquidity, 24h change, decimals |
| `quote` | $0.01 | Live swap quote (Jupiter): outAmount, priceImpact, route |
| `risiko` | $0.02 | Risk screen: mint/freeze authority, supply, liquidity, token age |
| `peluang` | $0.02 | Arbitrage scan — multi-size & multi-path (2-leg / 3-leg) |
| `trending` | $0.005 | Hottest Solana tokens (organic score / brain ranking) |
| `periksa-dompet` | $0.02 | Wallet check: balance, holdings, recent activity |
| `kikis-web` | $0.02 | URL scrape → JSON/Markdown/HTML (LLM-ready) |
| `ringkas` | $0.005 | Summarize any page |
| `terjemah` | $0.005 | Translation (AI) |
| `tulis` | $0.01 | AI writer for short copy |
| `json` | $0.005 | Convert any text → structured JSON |
| `saring-token` | $0.02 | Token safety screener |
| `banding-token` | $0.01 | Compare 2+ tokens side by side |
| `tokens-baharu` | $0.01 | Newly launched tokens feed |
| `kikis-ringkas` | $0.005 | URL → AI-guided concise extraction |
| `sentimen` | $0.02 | Crypto market sentiment |
| `yuran-rangkaian` | $0.005 | Solana network fees / account fees |
| `fx-kadar` | $0.005 | Live FX rates (160+ currencies incl. MYR) |
| `util-kotak` | $0.005 | Deterministic tools: base64, sha256, uuid, epoch, public holidays |
| `yield-defi` | $0.01 | Best DeFi APY pools across chains (DefiLlama), TVL-filtered |

## How payment works (x402)

1. `POST https://crypto-micro-agent.mykira.workers.dev/api/agent/<service>` with your JSON body.
2. If unpaid you get **HTTP 402** with a `payment-required` header (base64, UTF-8: price, network, payTo, asset = USDC).
3. Pay the exact amount (x402 v2, USDC on **Base** or **Solana**), sign per protocol.
4. Repeat the same POST with the payment header → service output + on-chain settlement.

Any x402 client works: [`@x402/fetch`](https://www.npmjs.com/package/x402), [PayAI facilitator](https://payai.network), Coinbase CDP facilitator, or a manual signing flow.

## MCP clients (Claude, Cursor, Cline, any MCP SDK)

Add the remote server:

```json
{ "mcpServers": { "myworker": { "type": "url", "url": "https://crypto-micro-agent.mykira.workers.dev/mcp" } } }
```

- `initialize` → protocol `2025-06-18`
- `tools/list` → all 20 tools with descriptions, prices and JSON schemas (auto-synced from the service registry)
- `tools/call` returns execution instructions (the x402 REST endpoint + example output) — execution is paid via x402, there is no free path.

## Directory listing

This repository is the canonical page for the MCP Registry entry:
`io.github.princearies/myworker` (streamable-http remote, see `server.json`).

## Contact

Issues in this repo, or `ag.azaman78+myworker@gmail.com`.
