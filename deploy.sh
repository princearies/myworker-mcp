#!/bin/bash
set -e

# 1. Create D1 database
wrangler d1 create crypto_agent_db

# 2. Apply schema
wrangler d1 execute crypto_agent_db --file=./schema.sql

# 3. Set secrets (run interactively or via CI)
wrangler secret put PRIVATE_KEY
wrangler secret put TELEGRAM_BOT_TOKEN

# 4. Set public vars
wrangler deploy --var WALLET_ADDRESS:"0xYourAgentWalletAddress" --var BASE_RPC:"https://mainnet.base.org"
