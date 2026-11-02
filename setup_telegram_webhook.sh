#!/bin/bash
TOKEN="${TELEGRAM_BOT_TOKEN}"
WORKER_URL="https://crypto-micro-agent.ag-azaman78.workers.dev/api/telegram/webhook"
echo "Setting Telegram webhook..."
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}" -d "allowed_updates=[\"message\"]"
echo ""
