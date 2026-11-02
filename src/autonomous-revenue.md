# Autonomous Revenue Engine (Scheduled Cron)

Untuk bot `crypto-agent-development` (Cloudflare Workers + Solana).

## Konfigurasi
- `wrangler.toml`: `[triggers] crons = ["*/5 * * * *"]`
- `.env` (`chmod 600`): `SOLANA_PRIVATE_KEY` (Base64, 88 char), `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`
- `.wallet_reference.txt`: `Public Key` sahaja (`3mqWx...` atau `CW5gwv...`) — tiada private key
- `scheduled()` dalam `src/index.ts` — boleh mengubah endpoint HTTP (`/arbitrage-check`) tetapi `scheduled` mesti kekal aktif.

## Mekanisme
1. Pantau `https://lite-api.jup.ag/swap/v1/quote` (bukan `/v6/quote` lama) — gunakan header `Accept: application/json` dan `User-Agent: Myworker-Solana-Bot/1.0`.
2. Pasangan: `SOL/USDC` (`So111...`/`EPjFW...`) dan `BONK/SOL` (`DezXAZ8...`/`So111...`).
3. `GET /quote?amount=10000000` (lamports; 1 SOL = 1,000,000,000 lamports).
4. Semak `quoteData.outAmount`; kira margin keuntungan.
5. Jika `profitMargin > 0.2%` (`NO_PROFIT` jika `priceImpact < 1`):
   - `executeRealSwap(env, buyQuote)` → `fetch POST https://lite-api.jup.ag/swap/v1/swap` dengan body `{ quoteResponse, userPublicKey: ... , wrapAndUnwrapSol: true }`.
   - Deserialize `VersionedTransaction` menggunakan `atob` (bukan `Buffer`, kerana `Buffer` tidak wujud dalam Workers runtime).
   - Sign dengan `keypair` (`getWalletKeypair(privateKey)`) dan `connection.sendRawTransaction()`.
6. Log ke `DB_INCOME`: `INSERT INTO transactions (type='real_arbitrage_swap', amount=..., token_symbol='SOL/USDC', tx_hash=txSignature, status='EXECUTED'/'FAILED')`.
7. Hantar laporan Telegram (`chat_id: 5495392497`) via `botToken`:
   - Format: `🚨 *ARBITRAGE ALERT* 🚨\n• Pair: SOL/USDC\n• Profit: +X SOL\n• Tx Hash: Y`
   - Atau: `📊 Auto-Income Scanner: NO_PROFIT (Jupiter API error: ...)`

## Catatan Keselamatan & Pengesahan
- `executeRealSwap` memerlukan `env.SOLANA_PRIVATE_KEY` (secret, bukan `.env` terbuka). Jangan dedahkan `privateKey` dalam output terminal (`console.error` hanya log ralat, bukan nilai penuh).
- `scheduled()` mesti balas `HTTP 200` walaupun gagal (`console.error` dalam setiap `catch`).
- `getWalletKeypair` menyokong 3 format: array JSON (`[1,2,3...]`), Base58 (`bs58.decode`), dan Base64 (`atob` fallback, 88 karakter). `.env` menyimpan `SOLANA_PRIVATE_KEY` dalam format Base64 dari `Keypair.generate()`.
- Ini bukan hanya simulasi: `executeRealSwap` menjalankan `connection.sendRawTransaction()` sebenar. Pengguna mesti mengesahkan setiap eksekusi sebelum ia dijalankan secara automatik; konfigurasi semasa (`scheduled`) menjalankan secara automatik setiap 5 minit (`*/5 * * * *`).
- Jangan laporkan deploy berjaya jika `database_id` belum sah (`PENDING_AUTH` akan gagal) atau `WALLET_ADDRESS` masih placeholder (`0x...` akan gagal dengan `BAD_DATA`).
