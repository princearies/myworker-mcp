# Web3-Agent Topic Recap — 2026-10-14 (dikemas kini 2026-10-19)

## ⭐ BARU 19 Okt 2026 (malam): 3 SERVIS BAHARU (17 → 20) + PENEMUAN PENTING

### Servi tambahan (semua additive, 1 entri `PLUGIN_LIST` setiap satu)
| Servis | Harga | Fungsi | Sumber |
|---|---|---|---|
| `fx-kadar` | $0.005 | Kadar FX semasa (asas + sasaran kod 3 huruf, ≥6 sasaran); MERANGKUMI MYR | currency-api (fawazahmed0) via jsdelivr → exchangerate-api v4 → open.er-api.com (`result:"success"`) → frankfurter.dev |
| `util-kotak` | $0.005 | Deterministik: encode64/decode64/sha256(hex)/uuid v4/masa(unix+ISO UTC)/cuti awam (maks 20; keutamaan tahun t-1..t+1; sinonim SINGAPURA→SG dll) | berjalan (crypto.subtle) + date.nager.at |
| `yield-defi` | $0.01 | Pool APY terbaik semua rangkaian, TVL≥$10jt, disusun APY; opsyen "stabil"; cache 10 min | yields.llama.fi (DefiLlama) |

### Kajian pasaran (kenapa 3 ini)
Bots beli: (1) utiliti deterministik volum tinggi (median $0.002, jutaan tx), (2) kikis web→LLM-ready
(Firecrawl ~6% tx x402), (3) analiti on-chain (Heurist ~12%), (4) audit kod (AgentLisa ~10%),
(5) skor risiko (x402-secure ~7%), (6) yield DeFi. 87% semua tx ≤$0.10. Trend: endpoint MCP.

### PENEMUAN PENTING (jaga, berulang kena 2-3 kali)
1. **fetch Worker: option `cf: { cacheTtl, cacheEverything }` pada fetch luaran menghasilkan 404/kerosakan
   untuk jsdelivr/exchangerate-api/frankfurter** — TANPA option itu (`fetch(url, { headers })` sahaja)
   semua sumber pulang 200. Bonus: jangan letak cf-cache ke fetch pihak ketiga; guna cache melori
   sendiri (cth `YIELD_CACHE`). Rujuk `/api/agent/fx-debug?key=` (debug berpassword; WAJIB
   didaftarkan SEBELUM laluan generik `:servis`, jika tidak ditangkap handler generik).
2. **Regex matawang wajib `\b[A-Z]{3}\b`** — tanpa sempadan perkataan, kata "KADAR" dipecah jadi
   "KAD" → sumber 404 (benda yang jangan berulang).
3. open.er-api.com pulang `{result:"success"}` (BUKAN "ok").
4. argBazaar `default: {text: teks}` → handler menerima body.text = ayat penuh; handler util mesti
   memanggil formatskan() untuk membuang kata kunci awalan (base64/encode/decode/sha256/hash)
   sebelum decoding.
5. op/param parsing: imbas SEMUA perkataan ayat (bukan kata pertama sahaja) untuk deteksi op.

### Ujian hidup (semua lulus) 19 Okt ~01:20 UTC — dari VPS
`fx-kadar` USD→MYR 4.0818/SGD 1.2796/EUR 0.8898 ✓ · decode aGVsbG8=→"hello" ✓ · encode ✓ ·
sha256 ✓ · uuid ✓ · masa (2026-10-19T01:15Z) ✓ · cuti SG 11/US 17 ✓ · yield (Base aerodrome
86.67% APY) ✓ · REGRESI: harga (Jupiter) ✓ — 20/20 katalog & ROI tiada rosak.

### Kemas kini lain
- **Servi #21–22 (19 Okt akhir):** `imbas-kontrak` ($0.02, ERC-20 Base — heuristik: kod/proxy
  EIP-1967/mint/renounce/blacklist selector + ERC20 metadata; PELAJARAN: sesetengah RPC awam
  pulang hex TANPA `0x` — BigInt('0x'+hex) wajib) + `kadar-gas` ($0.005 — eth_gasPrice
  publicnode ETH/Base/Arbitrum/Optimism + tip Solana + USD anggaran). Deploy `ff81e6c2`;
  MCP auto 22 alat; x402scan 22/22; regresi penuh lulus.
- Repo public `github.com/princearies/myworker-mcp` — README perlu refresh bila nampak
  servis/tambah (README.md ada jadual 22 servis — kemas kini pada checkpoint).
- Deploy terakhir: `4c69b08b`. x402scan: **20/20 didaftarkan** (`node tools/daftar-x402scan.cjs`;
  kebergantungan dipasang dulu: `npm i viem @signinwithethereum/siwe @x402/extensions --no-save`).
- **MCP endpoint (Streamable HTTP)** — deploy `ebd27f72` (Hono, ADDITIVE sahaja):
  - `POST /mcp` JSON-RPC 2.0: `initialize` → protocolVersion 2025-06-18 + captcha; `tools/list`
    (20 alat — nama/desc/harga/inputSchema diwaris dari PLUGIN_LIST, BACA SAHAJA); `ping`;
    `notifications/initialized` (202); kaedah asing → -32601.
  - `tools/call` TIDAK melaksanakan servis (tiada laluan guna-percuma baharu) — kembalikan panduan
    pelaksanaan REST x402 + contoh output. `GET /mcp` = info JSON katalog berharga.
  - Kod: `registerMcp(app)` dalam src/agent.ts + 1 baris panggilan dalam src/index.ts
    (selepas `registerAgent(app)`). Sifar perubahan ke atas servis REST/bot/cron/D1.
  - Ujian hidup: 6/6 MCP lulus + regresi lengkap lulus (402 challenge + header payment-required,
    /agentbazaar, /agent, /api/agent, /.well-known/x402.json, /openapi.json semua 200/normal).
- PayAI Bazaar auto-index dari openapi (tiada tindakan manual).
- AgentBazaar masih menunggu API platform pulih; bila pulih, jalankan daftar semula —
  niat fx-kadar/util-kotak/yield-defi SUDAH masuk `NIAT_BAZAAR`.
- **PEMASARAN MCP (19 Okt malam):** repo public `github.com/princearies/myworker-mcp`
  (README + server.json + openapi.json + logo 400×400 + llms-install.md; BERSIH tiada token).
  TERTERBIT di **Official MCP Registry**: `io.github.princearies/myworker` (REMOTE streamable-http,
  status ACTIVE; mcp-publisher.exe di laptop, aute GitHub device-flow). Huraian server.json
  MAX 100 aksara (ralat 422 kalau lebih). **Cline Marketplace**: issue #3086 menunggu review.
  Glama.ai & PulseMCP (sedang pause) auto-pickup dari Official Registry — CHECKPOINT 22–23 Okt:
  sahkan tersenarai + lejar pembeli baru. mcp.so = berbayar $39 (tiang tunggu keputusan).

## ⭐ BARU 2026-10-19 (petang): PENJAJARAN HARGA (pricing realignment)
- Sebab: ejen AI autonomi buat ribuan panggilan; algoritma kos mereka **mengelak servis > $0.05**.
  Satu-satunya servis yang terjual ialah $0.02 (sentimen). $0.15–0.30 tidak bergerak.
- Keputusan pengguna: harga semua servis dalam **$0.001–$0.02**. Lantaran teknikal: fasilitator
  PayAI ~$0.001–0.0013 setiap settlement → **floor $0.005** (bawah itu makan keuntungan).
- Harga baharu (17 servis, deploy `6e5eb999-1d6f-4511-93d3-cd9fadf5d5d1`, disahkan hidup via GET /agentbazaar):
  - **$0.005**: harga, trending, yuran-rangkaian, ringkas, terjemah, json
  - **$0.01**: quote, tulis, tokens-baharu, banding-token
  - **$0.02**: risiko, saring-token, peluang, kikis-web, kikis-ringkas, periksa-dompet, sentimen (kekal — terbukti)
- Cara ubah: edit `harga:` dalam PLUGIN_LIST (src/agent.ts) + deploy ~2s. Boleh juga set
  `AGENT_PRICES` (JSON) dalam wrangler.toml tanpa mengubah kod.
- Nota: AgentBazaar (endpoint /agentbazaar) membaca harga yang sama secara langsung.
- Kajian seterusnya: jika volum masih rendah selepas 3-5 hari, pertimbang (a) turun lagi ke $0.002
  untuk servis sangat ringan, (b) promosi/tambah saluran — harga sahaja tidak menjanjikan pembeli.



## ⭐ BARU 2026-10-19: PEMBELI LUAR PERTAMA + AGENTBAZAAR (saluran kedua)

### 💰 Pembayar luar pertama (disahkan on-chain)
- Servis `sentimen` ($0.02) dibayar **0.02 USDC di Base** (eip155:8453) pada 18 Okt 21:18 UTC.
- Pembayar `0xa1d1c0cf717402ff3651aa4873ccf9610b01978` (smart wallet, nonce 0 — klien agen automatik).
  Tx `0xdc4d91b1560c523b3b60a549f66072f0083818a9648d73a05155278ae33e57ba` disahkan:
  USDC Transfer → dompet Base kita `0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD` (baki kini 0.02 USDC).
- Lejar jujur worker: 2045 cabaran, 34 bayaran, **hasil pembeli luar = $0.02** (baki $0.905 = ujian sendiri).
- Keputusan: saluran x402 v2 + PayAI facilitator BERFUNGSI dengan pembeli luar. Teruskan penemuan + tambah saluran.

### 🔌 AGENTBAZAAR (agentbazaar.dev) — endpoint SIAP, API MEREKA DOWN
- Marketplace agen **Solana-native** (A2A/MCP/Telegram), daftar percuma, 97% hasil ke agent,
  platform tanggung gas. Kontrak push: `POST {task, files, buyer, jobId}` → `{result:"<teks>"}` (<30s).
- Kod tambahan dalam `src/agent.ts` (deploy `a44024fc-e540-4fb3-b334-12fea6ac8454`):
  - `GET /agentbazaar` → info awam + senarai servis (untuk manusia & crawler).
  - `POST /agentbazaar` → penerima tugasan. Tanpa `jobId` atau `x-bazaar-key` sah → 400 (elak penggunaan percuma).
  - `GET /api/agent/bazaar?key=<AGENT_STATS_KEY>&had=N` → log tugasan (jumlah, per servis, terkini).
  - Niat MS/EN → servis (`NIAT_BAZAAR`), pengarah AI umum (`ai-umum`) untuk tugasan tanpa padan.
  - Log D1 jadual `bazaar_tasks` (berasingan daripada `agent_calls`) + notifikasi Telegram pemilik.
  - Input wajib tiada → panduan ringkas (cth: "periksa dompet" tanpa alamat).
- Ujian hidup 19 Okt (semua lulus): harga 2 token ✓, saring-token bonk (selamat, skor 10) ✓,
  terjemah ✓, ai-umum ✓, panduan dompet ✓, log bazaar ✓. Telegram notify dihantar.
- ⚠️ **API AgentBazaar sedang DOWN** (19 Okt 23:26 UTC): `agentbazaar.dev/agents/register` → 404,
  `www.agentbazaar.dev/*` → 404, `api.agentbazaar.dev` → **525** (origin SSL gagal).
  Pendaftaran belum boleh disiapkan. Skrip SIAP: `tools/daftar-agentbazaar.cjs`
  (jana dompet identiti BAHARU `~/.agentbazaar-wallet.json` chmod 600, tandatangan
  ed25519 base64 mengikut SDK rasmi, POST /agents/register mod push, ownerEmail
  ag.azaman78+myworker@gmail.com, harga $0.10). Guna: `node tools/daftar-agentbazaar.cjs`
  — JALANKAN SEMULA BILA API PULIH. Dompet identiti: `DjQLfQWk4w925nQoCGTXQbpjC89XC8BWkRvu3zdKK8KD`.
  ⚠️ Jangan guna `Keypair.sign` — @solana/web3.js v1.99 TIADA kaedah itu; guna
  `@noble/curves/ed25519` dengan seed 32 bait (`secretKey.slice(0,32)`).

### Status direktori (19 Okt 2026, disahkan hidup)

| Saluran | Status |
|---|---|
| PayAI Bazaar | ✅ 17/17 (auto-index) |
| x402scan | ✅ 17/17 didaftarkan (public server page) |
| AgentBazaar | 🟡 endpoint siap, API merekap down (404/525) — tunggu & retry |
| x402-list.com | ❌ belum tersenarai (1020 servis disemak); import `imported:x402scan` belum sampai; submit manual $1 (ditolak) |
| x402all.com | ❌ `/api/register` 404 (endpoint belum hidup) |
| x402register.com | ❌ pasif, probe sendiri |
| 402agents.xyz | ❌ katalog kosong (0 agen) |
| CDP Bazaar / agentic.market | ❌ perlukan akaun CDP (tindakan user) |

## ⭐ BARU 2026-10-18: Agent API (x402) — bot menjual servis kepada bot/agen lain
- Worker sama: `crypto-micro-agent` (bot @Mypekerja1_bot). Semua tambahan, tiada regresi.
- Endpoint jualan: `GET /agent` (katalog), `GET /api/agent`, `/.well-known/x402.json`,
  `/.well-known/x402` (format x402scan), `/openapi.json` (disyorkan x402scan), `POST /api/agent/:servis`.
- 8 servis: crypto → `harga` $0.002, `quote` $0.004, `risiko` $0.01, `peluang` $0.02;
  AI → `ringkas` $0.004, `terjemah` $0.003, `tulis` $0.008, `json` $0.005.
- Bayaran: x402 "lean" — 402 + header `PAYMENT-REQUIRED`; pembeli bayar USDC (SPL) atau SOL asli
  dengan `reference` Solana Pay, kemudian panggil semula dengan `X-Payment-Ref` / `X-Payment-Tx`.
  Pengesahan sendiri on-chain (getSignaturesForAddress → getTransaction jsonParsed, `maxSupportedTransactionVersion: 1`),
  replay-protected (`tx_sig UNIQUE`), hasil di-cache.
- Hasil masuk D1 `income-db` + jadual `agent_calls` (bukan DB_INCOME.transactions).
- Arahan Telegram: `/start`, `/servis`, `/beli <id> <arg>`, `/semak <challenge>`, `/hasil` (owner).
- Ops: `GET /api/agent/whoami?key=<AGENT_STATS_KEY>` → sahkan token bot + webhook + dompet.
  `GET /api/agent/stats?key=<AGENT_STATS_KEY>` → cabaran/dibayar/hasil.
- AGENT_STATS_KEY = `d68aa3b0811f4dbda6b2`. Dompet terima = `3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E`.
- **Secret `TELEGRAM_BOT_TOKEN` kini terikat** = token @Mypekerja1_bot (id 8538775664, nama "Myworker"),
  diambil dari `~/workspace/web3-agent/.env`. ⚠️ Token dalam `~/.hermes/.env` ialah bot LAIN
  (@Awang78_bot id 8983953542, tiada webhook) — jangan silap.
- Pembaikan Jupiter: throttle adaptif (400ms/slot, cooldown 1800ms selepas 429, 5 cubaan) + cache quote.
  Hasil: `/arbitrage-check` 4/4 imbasan **0 ralat** (sebelum ini kerap `PAPER_QUOTE_ERROR`).
- STATUS PEMBAYARAN: belum ada pembayar sebenar (9 cabaran, 0 dibayar). Perlu didaftarkan ke indeks
  (x402scan `https://www.x402scan.com/resources/register`, Agent Bazaar) + promosi.
- ✅ UJIAN BAYARAN BENAR (18 Okt, mainnet): 0.0001 SOL dihantar dari dompet ujian sementara ke
  dompet bot → API **mengesan sendiri melalui `reference`** (cubaan pertama) → servis `harga`
  berjalan → rekod `dibayar=1, hasil_usd=0.002`. Tx `3kPYYuVHWNFuABTRHzz782mw2nHdUikEzAPo2m6zavU5vMJpRV4WUm1MfeMNpruCauFFZztcbDy7uR53mZjSWHLW`.
  Kos ujian = 0.000015 SOL (fi sahaja). Akaun USDC (ATA) dicipta: `4hwXhPAj197L13tqWLreqHZuAPHM7K3oTgBedtVeDRCW`
  (kos 0.001493 SOL) → kini boleh terima USDC tanpa pembeli bayar rent. Baki bot: 0.010492 SOL.
  Nota: kod kini terima juga bayaran BIASA (tanpa reference) jika pembeli beri `X-Payment-Tx`.
- ✅ UJIAN 8/8 SERVIS (18 Okt, mainnet, duit betul): semua 8 berfungsi — `harga`, `quote`, `risiko`,
  `peluang` (crypto) + `ringkas`, `terjemah`, `tulis`, `json` (AI). Jumlah kutipan ujian US$0.084.
- 🐞 2 PEPIJAT DITEMUI & DIBAIKI (18 Okt) — deploy versi `cfcdc6a1-f32c-46ab-8a81-4208deea2122`:
  1. `mints()` menukar alamat mint ke huruf kecil → mint base58 jadi TAK SAH → servis `harga`/`risiko`
     gagal untuk token sebenar. Kini hanya NAMA SIMBOL yang di-lowercase (mint kekal huruf asal).
  2. Servis `json` membalut jawapan dalam kod fence ``` — kini dibuang, klien boleh `JSON.parse` terus.
- Dompet ujian kekal: `H4QdKftASRRgo3wJ9jTimFNDZnFxexhVDptSzjWqQB7h` (kunci disimpan di VPS
  `~/.agent-test-wallet.json`) — supaya baki ujian tidak tersangkut lagi.
- ⚠️ Kerugian kecil: dompet ujian SEMENTARA yang PERTAMA (kuncinya tidak disimpan) tertinggal
  ~0.0016 SOL dalam `69RB2Y5gmqEmTYsqfYcJiaAhKDiFbmfNUU87q5oTuQr3` — tidak boleh dipulihkan.
- ✅ AUDIT RASMI LULUS (18 Okt): `npx -y @agentcash/discovery crypto-micro-agent.mykira.workers.dev -v`
  → 8/8 laluan dikesan, semuanya `paid` + harga + `[x402]`, panduan dijumpai, **0 isu**
  (sebelum ini: SCHEMA_INPUT/OUTPUT_MISSING, L2/L3 price/protocol missing).
  Kunci yang menjadikannya lulus: per-operasi `x-payment-info: { protocols: [{x402:{}}],
  price: {mode:'fixed',currency:'USD',amount} }`, `security: []`, dan
  `extensions.bazaar.schema.properties.input.properties.body` +
  `...output.properties.example` (bentuk tepat yang dibaca oleh validator — lihat `ekstensiBazaar()`
  dan `contohOutput()` dalam `src/agent.ts`). Tambahan: `/openapi.json`, `/llms.txt`,
  `info.contact`, `info.x-guidance`, `x-agentcash-guidance.llmsTxtUrl`, `/favicon.svg|ico`.

## x402 STANDARD v2 + BASE (18 Okt 2026) - kompatibel sepenuhnya
- Dua laluan bayaran serentak: (a) STANDARD x402 v2 (`PAYMENT-SIGNATURE` -> fasilitator
  `/verify` + `/settle`, tiada kunci peribadi di worker), (b) LEGACY lean (bayar dulu
  on-chain dengan `reference`, retry dengan `X-Payment-Ref`/`X-Payment-Tx`).
- Header diterima: `PAYMENT-SIGNATURE`, `X-PAYMENT`, `X-PAYMENT-SIGNATURE`; payload v2
  (`payload.accepted`) dan v1 (skema di peringkat atas) dinormalkan melalui `reqV1()`.
- Fasilitator: `https://facilitator.payai.network` (tanpa API key). `accepts` standard:
  USDC Solana `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (feePayer
  `CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww`) + USDC Base `eip155:8453`
  (payTo `0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD`). SOL asli kekal di `cara_bayar` sahaja.
- `accepts` v2 TIDAK boleh ada `maxAmountRequired`/`resource`/`description` (PayAI tolak) -
  hanya `scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra`; `resource`
  ialah objek di peringkat atas.
- Ujian pengesahan: klien rasmi `@x402/fetch` + `ExactSvmScheme`/`ExactEvmScheme` (dompet kosong)
  -> server 402 + `PAYMENT-RESPONSE` `invalid_exact_svm_transaction_simulation_failed` /
  `invalid_exact_evm_insufficient_balance` = saluran lengkap berfungsi, cuma tiada dana.
- 11/11 servis lulus semakan pematuhan v2 (Solana + Base) + audit `@agentcash/discovery`.

## KATALOG / PENEMUAN (Bazaar) - 18 Okt 2026
- Garis panduan rasmi: https://docs.payai.network/x402/facilitators/bazaar
- Penyenaraian AUTOMATIK - tiada borang/akaun/penyerahan manual. Fasilitator mengkatalog
  daripada pembayaran yang membawa deklarasi `extensions.bazaar`.
- Deklarasi DIBETULKAN: `info.input` mesti `{type:'http', method, queryParams|bodyType+body}`
  (bukan JSON Schema mentah). Kini dijana oleh `ekstensiBazaar(id, kaedah)` dalam `src/agent.ts`,
  disemak dengan `validateDiscoveryExtensionSpec` + `validateDiscoveryExtension` daripada
  `@x402/extensions` -> 22/22 lulus (11 servis x GET/POST).
- Sokongan GET + HEAD ditambah (`app.get` + `app.on('HEAD', ...)`); input diambil dari query
  string, jadi probe katalog baca-sahaja (HEAD -> GET) mendapat 402 (dahulu risiko 404/405).
- `resource` kini ada `serviceName`, `tags`, `iconUrl` - dipaparkan dalam senarai katalog.
- PENTING: penyenaraian berlaku hanya selepas `/verify` BERJAYA (atau `/settle`). Verify yang
  gagal (tiada dana) + deklarasi sah = TIADA header `EXTENSION-RESPONSES` dan TIADA baris
  katalog. Jadi tidak perlu bayar untuk tersenarai, tetapi perlu pembayar yang cukup dana.
- Katalog PayAI Bazaar: 20,922 peniaga / 20,863 sumber / 1,145 host; ~19.5k settlement/24j.
  Kita BELUM tersenarai (katalog penuh 20,941 item diimbas).
- x402bazaar.org: kita TIADA akaun; ia marketplace proksi (SKALE/Base/Polygon, fi 5%) -
  keutamaan rendah, hanya perlu daftar jika murah.
- `EXTENSION-RESPONSES` header = alat diagnostik: `processing` (diterima), `rejected` + sebab,
  tiada header = klien tidak echo deklarasi. Gunakan `/discovery/listing-status?resource=...`.

## KEJAYAAN (18 Okt 2026) - TERSENARAI DALAM KATALOG PAYAI BAZAAR
- Ujian settle SEBENAR berjaya di Solana mainnet (tx `32aUgGtxSUep9XQT4LD2mwd5XvF8xJS2PTCiEZ2Cvt5EqiqXtbvohEHrvpYhzEczLbYFiR4U4W7zqPRwdjR3jgt`).
  `PAYMENT-RESPONSE` = `{"success":true,...,"amount":"2000"}`; servis `harga` berjalan; D1 +US$0.002.
- **11/11 servis TERSENARAI** dalam katalog PayAI Bazaar (disahkan dengan mengimbas 20,975 item).
  `harga` melalui `/settle`; 10 lagi melalui `/verify` SAHAJA -> penyenaraian KOS SIFAR.
- Punca kejayaan: sokongan **GET + HEAD** + deklarasi `extensions.bazaar` yang sah. Sumber POST
  sahaja ditangguhkan (`resource_needs_settlement`); sumber GET yang menjawab 402 diterima terus.
- Kos sebenar ujian: ~0.0000135 SOL (fi swap + tx). 0.0015 SOL ditukar jadi **0.155819 USDC**
  (kekal dalam dompet, bukan hilang). Tx swap `64DLnNJog4DxvP8qovNLmUzUnUNGcv2Da3byuuV7oyvFLhppfdtQAWeAisMW6NsLoJXLDLJiP9H31oVDzLhRNtbT`.
- AMARAN: bayaran ujian itu bayaran-DIRI (payer = payTo), jadi +US$0.002 dalam D1 BUKAN hasil sebenar.
  Hasil sebenar dari pembeli luar = **$0** setakat ini.
- AMARAN KONFIGURASI: `WALLET_ADDRESS` dalam `~/workspace/web3-agent/.env` BASI (menunjuk ke dompet
  HP Brave `CW5gwvQX...`). Worker guna `wrangler.toml` (`3mqWx...`) - betul, tetapi patut dibetulkan.
- Nota teknikal: `SOLANA_PRIVATE_KEY` dalam `.env` ialah **base64 (64 bait)**, bukan base58.

## PLUGIN REGISTRY + HARGA BAHARU + BASE DAHULU + LEJAR (18 Okt 2026)
- **Registry plugin** dalam `src/agent.ts` (`PLUGIN_LIST`): SATU tempat mendaftar/menukar servis.
  Semua yang lain dijana daripadanya — `SERVIS`, `HARGA_LALAI`, `PROMPT_AI`, `skemaInput()`,
  `contohOutput()`, `inputDariBody()`, `promptAi()`, `jalankanServis()`. Menambah servis baharu =
  tambah SATU entri; tiada tempat lain perlu diubah.
- **Harga baharu** (naik dari $0.002–0.02): harga $0.02 · quote $0.03 · tulis $0.03 ·
  ringkas/terjemah/json $0.02 · trending $0.05 · periksa-dompet $0.10 · kikis-web $0.10 ·
  risiko $0.15 · peluang $0.25. Sebab: fi fasilitator ~$0.002/settlement dan purata pasaran Base
  ~$0.31/tx — pada $0.002, sasaran $5/hari MUSTAHIL walaupun kita menang 100% trafik Solana.
- **Base DAHULU** dalam `accepts[]` (eip155:8453 sebelum Solana) — 85% aliran dana x402 di Base.
- **Lejar sebenar**: `GET /api/agent/lejar?key=...&had=N&katalog=1` → satu baris = satu bayaran,
  `jenis` = `pembeli-luar` atau `ujian-sendiri` (dari `AGENT_UJIAN_PAYERS`).
  `ringkasan.hasil_pembeli_luar_usd` = PENDAPATAN SEBENAR.
- **PENEMUAN PENTING (ketepatan angka)**: 2 pembayar yang tidak dikenali dalam D1 —
  `69RB2Y5gmqEmTYsqfYcJiaAhKDiFbmfNUU87q5oTuQr3` dan `CSPZMDnMawCeSZ8WorQnptmaAEJXELTYvGUWsKmntwLy` —
  disahkan sebagai **dompet ujian kita sendiri yang kuncinya hilang** (69RB2Y5 memang tercatat di
  atas). Kesimpulan: 17 bayaran = SEMUA ujian kita. **Hasil sebenar dari pembeli luar = $0.00.**
- Apps Script papan pemuka ditulis semula (`D:\KUNCI-BOT-SEMENTARA\apps-script-papan-pemuka.gs`,
  9588 bait, `node --check` OK) — 5 tab: Papan Pemuka, Lejar, Harian, Per Servis, Katalog.
- Deploy: `c8717f7c-3fe2-484f-9448-ae1985f01b90` (registry+harga+Base) →
  `1ac6747b-12c4-453b-8143-8ae13832f9ba` (tambah lejar). Cron `*/5` kekal aktif.
  11/11 servis masih tersenarai dalam katalog selepas semua perubahan.
- Nota "hot reload": di Cloudflare, memuat kod baharu SEMASA runtime tanpa deploy = **Dynamic
  Workers** (`env.LOADER`) tetapi **pelan berbayar $5/bulan**. Kita kekal percuma: registry +
  deploy atomik (~2 saat, sifar downtime).

## DIREKTORI x402 + PRODUK BERNILAI TINGGI (18 Okt 2026)

### Direktori — penemuan penting
- Kita SUDAH tersenarai dalam **PayAI Bazaar**: **12/12** selepas tambah `saring-token`
  (semua `isValid=true`, `listed=true`, `write=updated/verify`).
- **CDP Bazaar (Coinbase)** ialah katalog INDUK yang menjadi sumber kepada x402.new,
  x402scan, x402register.com, agentic.market, Amazon Bedrock AgentCore dan Bazaar MCP
  ("tens of thousands of agents"). Kita BELUM ada di sana.
- Berita baik: `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`
  (**tiada kunci diperlukan**) memberi `valid:true`, `simulation.outcome:"accepted"`,
  **25/25 preflight lulus** untuk SEMUA 12 servis → kita 100% serasi CDP.
- Satu-satunya langkah tinggal: **satu pembayaran yang DISELESAIKAN melalui CDP
  Facilitator** (ia mencetuskan pengindeksan). Ini perlukan **kunci CDP API**
  (akaun percuma di portal.cdp.coinbase.com); `/supported` & `/verify` CDP = 401 tanpa kunci.
- **x402-list.com**: menghantar dari hos percuma (`workers.dev`) = **$1 USDC di Base**
  (tidak dikembalikan). TETAPI ia ada laluan import automatik (`imported:bazaar`)
  daripada Bazaar → jadi jangan bayar $1; masuk CDP Bazaar dahulu.
- **x402.new** dan **x402register.com**: tiada borang; mereka mengindeks/menyiasat
  katalog awam secara automatik. Kedua-duanya juga bergantung pada CDP Bazaar.
- Kesimpulan: SEMUA direktori yang tinggal berkunci pada SATU perkara — akses CDP Facilitator.

### Produk bernilai tinggi: `saring-token` ($0.30) — servis ke-12
- SATU panggilan memberi: kuasa mint/freeze, tumpuan 10 pemegang teratas, pegangan dev,
  bilangan token yang dilancarkan dev, bilangan pemegang, skor organik, kelantangan
  beli/jual 24j, DAN — yang unik — **ujian JUAL (kesan honeypot)**, **kedalaman kecairan
  pada 5 saiz**, dan **saiz urus niaga SELAMAT**.
- Sumber data: `lite-api.jup.ag/tokens/v2/search` (percuma, sangat kaya) + `jupiter-swap-v1`
  untuk 6 quote beli/jual. Tiada API berbayar, tiada kunci pihak ketiga.
- Keputusan: `keputusan` (selamat/berhati-hati/bahaya) + `skor_risiko` 0-100 + `sebab[]`
  + `kekuatan[]`. Ujian sebenar (BONK): keputusan "selamat", skor 10, kecairan $6.2j,
  1,026,330 pemegang, susut pulang-balik 0.14%, saiz urus niaga selamat $10,000.
- **AMARAN RPC**: RPC awam SEKARANG menyekat kaedah BERINDEKS (`getTokenLargestAccounts`,
  `getTokenSupply`, `getTokenAccountsByOwner` → 403 "Indexed requests require a personal
  token"). Servis kita hanya guna kaedah BUKAN berindeks (`getAccountInfo`,
  `getSignaturesForAddress`) → selamat. Jangan tambah kaedah berindeks pada RPC awam.

### Kewangan (jujur)
- Dompet bot: **0.001661123 SOL + 0.623451 USDC** (selepas tukar 0.0045 SOL → 0.467654 USDC;
  tx `2LMHc91mnjJPsgnmk12nev8ogxtSpJyTVCT9gAET6FJFUgeZvN2DAQgQ2vE6fDWmCXixSjehewLgJ11jewbNAtkb`).
- Hasil sebenar pembeli luar: **$0.00** — semua 19 bayaran adalah ujian kita sendiri.
- Ujian settle baharu: `saring-token` (harga ujian) tx `4Rj5DMUp…` dan `MYbDXEdE…`;
  `harga` tx `3ZVYEEuG…`.
- Deploy terkini: `2d5a3bf1-858f-4a31-95d2-e5b1e08bb27e` (12 servis, harga sebenar).
- Nota: `/verify` fasilitator MENSIMULASIKAN bayaran — pembayar mesti ada baki USDC
  ≥ harga servis, jika tidak deklarasi katalog tidak dikemas kini (harga jadi basi).

### Pilihan dana pengguna: LUNO dan UPHOLD (18 Okt 2026) — keputusan: TUNGGU
- **Luno (Malaysia)**: USDC = ERC-20 sahaja dan **"Not available in Malaysia"**; penghantaran
  USDC tidak disokong di Malaysia. SOL disokong (rangkaian Solana, min hantar 0.01 SOL).
  Deposit FPX/TnG percuma (RM1 bawah RM100), keluar ke bank RM0.10. Tiada pasangan kripto/kripto.
  → Luno boleh top-up **SOL**, TIDAK boleh hantar **USDC**.
- **Uphold**: Malaysia **tiada** dalam senarai larangan mereka (Exa Card pun tersedia di Malaysia).
  Boleh hantar **USDC atas rangkaian BASE** (network fee 0.1 USDC + caj rata $0.99 = ~$1.09),
  dan boleh hantar **SOL** (rangkaian Solana).
  Had Malaysia: deposit fiat terus TIDAK disokong (kena beli crypto guna kad, caj 3.99%);
  pengeluaran fiat hanya melalui debit card VISA (2.75%, min $1). Tiada bank transfer keluar.
- **PENTING**: Luno DAN Uphold **tidak** boleh membuka **CDP Bazaar**. Kedua-duanya bukan
  facilitator x402 dan tidak memberi CDP API key. Itu masih satu-satunya kunci yang tinggal.
- Apa yang USDC-on-Base boleh beli (jujur, jangan berlebih):
  uji settle x402 sebenar atas Base (sederhana) · `x402bazaar.org` 1 USDC (rendah) ·
  `x402-list.com` $1 (SIFAR — auto-import dari Bazaar CDP) · **BUKA CDP BAZAAR = TIDAK**.
- **Keputusan pengguna (18 Okt 2026)**: JANGAN belanja apa-apa dulu. Hasil pembeli luar masih
  $0.00 → belanja sekarang = KOS, bukan pelaburan. Akaun Uphold pengguna ada baki crypto lain
  (bukan BAT); bila perlu nanti, tukar ke USDC dan hantar atas Base (atau SOL untuk yuran rangkaian).
- Langkah seterusnya yang PERCUMA dan betul: betulkan pendaftaran CDP di
  `portal.cdp.coinbase.com` (cuba log masuk Google/email, bukan SMS) — itu sahaja yang membuka
  CDP Bazaar + x402.new + x402scan + x402register.com + agentic.market.
- Alamat Base kita: `0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD`. ⚠️ JANGAN hantar aset
  rangkaian Base ke alamat Solana (`3mqWx…`), dan sebaliknya.

## KUALITI PRODUK: SUMBER + HAD + SAMPUL SERAGAM + MANIFEST MESIN (18 Okt 2026)
Langkah 1 ("kukuhkan produk dahulu") — skop diluluskan pengguna: 1 + 2 + 4.

- **(1) Sumber kedua bebas dalam `saring-token`**: RugCheck (`api.rugcheck.xyz`, PERCUMA, tiada
  kunci) kini disilang dengan analisis Jupiter kita. Dipanggil SELARI (janji dimulakan sebaik mint
  diketahui) supaya tiada masa tambahan. Jika RugCheck gagal → `null`, keputusan Jupiter tetap sah;
  servis TIDAK PERNAH gagal kerana sumber kedua.
  Output baharu: `skor: {jupiter, rugcheck, gabungan, kaedah}` (gabungan = 0.6×jupiter + 0.4×rugcheck),
  `kesepakatan: sepadan|sebahagian|berbeza`, `sumber_luar.rugcheck`, dan sebab berprefiks `[RugCheck]`.
- **(2) `sampul()` seragam**: SETIAP jawapan berjaya (12 servis) kini ada
  `meta: {dijana_pada, sumber[], had[], harga_usd, protokol:'x402 v2'}` di samping medan lama
  (`ok/servis/hasil/cache/bayaran/ms`). Satu parser untuk semua servis.
- **(2b) Setiap plugin dalam `PLUGIN_LIST` ada `sumber[]` dan `had[]` sebenar** — telus, boleh
  diaudit. 12/12 ada kedua-duanya (disahkan hidup).
- **(4) `GET /api/agent/katalog.json`** — manifest mesin: skema + contoh input/output, harga
  (USD/USDC/SOL), `sumber`, `had`, dan **statistik SEBENAR dari D1** (cabaran, dibayar, masa laksana).
  Dinamakan `kadar_dibayar_pct` (BUKAN "kadar berjaya") sebab cabaran termasuk probe crawler —
  kejujuran penting. Di-cache 5 min. Dipautkan dari `/api/agent`, `/llms.txt`, `/.well-known/ai.txt`.
- Diuji hidup: settle x402 sebenar `saring-token` ($0.30) → `skor.jup=10, rugcheck=7, gabungan=9,
  kesepakatan='sepadan'`; settle `harga` ($0.02) → `meta` lengkap. Ujian ini pembayaran SENDIRI
  (dompet bot → dompet bot, kos bersih ≈ fi fasilitator $0.0013 sahaja).
- Cron live disahkan TIDAK terjejas: `income-db.transactions` terakhir 2026-10-18 15:36:01
  (PAPER_NO_PROFIT, 1055 baris). Deploy versi `444796ce-77d7-45e8-ba80-b9ccdaa074a9`.
- Buah fikir: menaikkan harga sahaja tidak mendatangkan pembeli; yang menaikkan NILAI ialah
  ketelusan (sumber + had) dan bukti kualiti (dua sumber bebas, statistik sebenar).

## 5 SERVIS BAHARU + 4 PEMBETULAN PEPIJAT (18 Okt 2026)
Pilihan pengguna: "tambah api lagi". Jumlah sekarang **17 servis**. Setiap satu = SATU entri
dalam `PLUGIN_LIST` (harga, dokumentasi, OpenAPI, Bazaar, llms.txt dijana automatik).

| Servis | Harga | Nilai (kenapa orang bayar) | Sumber |
|---|---|---|---|
| `banding-token` | $0.06 | Banding 2-5 token + pemenang setiap metrik — satu panggilan ganti lima | jupiter tokens/v2 search |
| `tokens-baharu` | $0.06 | Token MUDA yang sudah ada dagangan sebenar DAN lulus saringan keselamatan | jupiter toporganicscore/24h (mod "baharu": recent) |
| `kikis-ringkas` | $0.06 | URL -> Markdown -> ringkasan AI dalam SATU panggilan | fetch + Workers AI |
| `sentimen` | $0.02 | Sentimen BERSTRUKTUR: skor, keyakinan, emosi, sebab | Workers AI |
| `yuran-rangkaian` | $0.02 | Taburan tip keutamaan + anggaran kos urus niaga + TPS | solana-rpc |

**Pembetulan pepijat yang ditemui semasa menguji (semua disahkan hidup):**
1. **`JUP_MINT` SALAH** — `…NsDvW5` TIDAK WUJUD di rantaian (disahkan `getAccountInfo`).
   Simbol `jup` dalam `harga`/`quote`/`risiko`/`saring-token` akan gagal. Dibetulkan kepada
   `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`. Diuji: `harga?token=jup` -> $0.2809.
2. **`askAi` memulangkan `"[object Object]"`** bila model memberi objek. Ini memusnahkan
   servis AI berstruktur. Kini objek di-JSON-kan sebelum dipulangkan.
3. **`yuran-rangkaian` memulangkan SIFAR** kerana `getRecentPrioritizationFees` dipanggil
   dengan senarai akaun KOSONG. Spec: yuran keutamaan dikira PER AKAUN boleh-tulis. Kini guna
   akaun sebenar (input atau 2 akaun paling sibuk) dan NYATAKAN akaun mana disampel. Dua
   panggilan RPC juga dijadikan BERURUTAN — dua serentak ke RPC awam sama memicu 429 (TPS null).
4. **`tokens/v2/recent` hampir selalu lulus 0** selepas tapisan: token berumur SAAT belum ada
   kecairan diindeks. Sumber ditukar ke `toporganicscore/24h` + tapisan umur — hasil sebenar:
   11 calon lulus (kecairan $57k-$667k, pemegang 2k-17k).
5. **`sentimen` ditanda `jsonOutput`** — sebelum ini servis `jenis: 'ai'` tidak menghurai JSON,
   jadi pembeli menerima TEKS JSON bukan objek. Kini ada bendera eksplisit dalam registry.

Semakan akhir: 17/17 http=402, **Base DAHULU** dalam `accepts`, `extensions.bazaar` ada,
manifest 17 servis tanpa medan kosong, **17/17 tersenarai dalam PayAI Bazaar**.
Deploy akhir `0eae73d0-35ea-4a75-9c53-e6cfde5805e3`. Kos ujian: bayaran sendiri (net sifar) +
fi fasilitator ~$0.001 setiap settle.

## PENEMUAN LUAS: x402scan + PERMUKAAN DISCOVERY (19 Okt 2026)
Matlamat pengguna: "biar dunia tahu bot kita jual servis". Deploy `e0e866d0-2a7f-4f35-a548-43ce430b2d71`.

**Perubahan kod (semua tambahan, dijana dari `PLUGIN_LIST`):**
1. `/openapi.json` — tambah `components.securitySchemes.x402` (`type: http`, `scheme: x402`) dan
   setiap operasi `security: [{x402: []}]` (dahulu `security: []`). Disemak dengan pakej
   `@agentcash/discovery`: `inferAuthMode()` memberi `paid` selagi `x-payment-info` ada, jadi
   tiada regresi — audit masih 17/17 `paid`, sumber `openapi`.
2. `ownershipProofs(env)` baharu — baca `OWNERSHIP_SIG_EVM` / `OWNERSHIP_SIG_SOLANA`. Medan
   `x-discovery.ownershipProofs` (OpenAPI) dan `ownershipProofs` (`/.well-known/x402`) hanya
   muncul bila tandatangan ADA. Kosong sekarang = medan ditinggalkan (tiada ralat).
3. `/sitemap.xml` baharu (dahulu 404) — senarai halaman awam + dokumen mesin.

**Pendaftaran x402scan BERJAYA.** Aliran sebenar (dokumentasi awam TIDAK menyebut dua langkah):
1. `GET /api/auth/csrf` → nonce.
2. SIWE (`@signinwithethereum/siwe`): tandatangan mesej EIP-4361 dengan statement `Sign into x402scan`
   → `POST /api/auth/callback/siwe-csrf` (`json:true`) → kuki `__Secure-authjs.session-token`.
   ⚠️ Kuki CSRF MESTI dihantar balik (percubaan pertama gagal `MissingCSRF`).
3. `POST /api/x402/registry/register-origin` `{origin}` → **402** dengan cabaran dalam
   `extensions["sign-in-with-x"].info` (bukan auth sesi).
4. Tandatangan cabaran itu dan hantar semula dengan header **`SIGN-IN-WITH-X`** = base64(JSON payload).
   Guna `createSIWxPayload()` + `encodeSIWxHeader()` dari `@x402/extensions/sign-in-with-x`.
5. Hasil: `{"success":true,"registered":17,"failed":0,"skipped":0,"total":17,"source":"openapi"}`.
   Halaman awam: https://www.x402scan.com/server/crypto-micro-agent.mykira.workers.dev

**Identiti penandatangan: dompet EVM `0x86fFa…`** (BUKAN dompet Solana) — sebab kunci Solana sudah
terbocor; kunci bocor tidak sepatutnya boleh "mendaftar sebagai kita". Skrip membaca kunci EVM dari
BACKUP-PROJEK.txt dan BERHENTI jika alamat tidak sepadan; kunci tidak pernah dicetak.
Skrip: `tools/daftar-x402scan.cjs` (perlu `npm i viem @signinwithethereum/siwe @x402/extensions`).
TIADA transaksi, TIADA kelulusan, TIADA dana bergerak.

**Peta saluran penemuan (disahkan hidup 19 Okt):**

| Saluran | Status |
|---|---|
| PayAI Bazaar | ✅ 17/17 (tiada pendaftaran diperlukan) |
| x402scan | ✅ 17/17 didaftarkan |
| CDP Bazaar / agentic.market | ❌ perlukan CDP — disekat (tiada akaun) |
| x402-list.com | ❌ import `imported:x402scan` — akan tiba sendiri; jika tidak, $1 |
| x402register.com | ❌ probe setiap jam, menunggu katalog awam |
| x402all.com | ❌ borang manual, percuma (draf jawapan disediakan) |
| x402-relay | manifest scanner membaca `ai.txt` + `x402.json` — kita sudah ada kedua-duanya |
| x402.be | baca CDP + PayAI → kemungkinan sudah ada |

**Kewangan (jujur):** hasil luar = **$0.00**. Semua baris berbayar ialah ujian sendiri.
Mendaftar ke lebih banyak direktori = JANGKAUAN, bukan jualan. Pesaing terbaik dalam niche
keselamatan token dapat ~6 pembayar unik / 30 hari.

## Status bot
- Worker: https://crypto-micro-agent.mykira.workers.dev (v e0e866d0 2026-10-19, 17 servis berbayar;
  terdaftar dalam x402scan + PayAI Bazaar)
- Mode: PAPER-TRADING hingga 2026-10-21T00:00:00Z, cron */5, live swap BLOCKED (BLOCKED_PAPER_MODE)
- Code: src/index.ts pakai runPaperScan() 2-way SOL->USDC->SOL, profit = out-in-12000 lamports fees, threshold >0.2%
- D1 migrated: bot-db (ALTER ADD type/token_symbol/meta) + income-db (fresh schema.sql) OK

## Wallets (4)
- EVM/Base `0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD` (18 Okt 2026) - untuk terima USDC di Base.
  Kunci di VPS `~/.agent-evm-wallet.json` (chmod 600) + `BAHAGIAN 4` dalam BACKUP-PROJEK.txt.
- Bot VPS `3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E` = 0.012 SOL (2026-10-14 16:xx UTC). Key: SOLANA_PRIVATE_KEY di VPS .env (chmod 600, 356B) + Cloudflare secret. Backup plaintext di C:\Users\faznf\Desktop\web3-agent-env-backup.txt — MESTI zip password + upload Drive + delete plaintext.
- HP Brave `CW5gwvQXsdihUNxEXNF81WbJrDsrEX5dM3bRPPg2AvVo` tinggal ~0.00294 SOL selepas hantar 0.01 ke bot. Seed 12-word dalam Brave HP (backup kertas offline).
- Laptop Brave `dZi7vtc5K9Rayz9trw7FGaSeGMnfwtJ24urocZm1uhq` tinggal ~0.00095 SOL selepas hantar 0.002 ke bot (tx 29cN2TGj... fee 0.000005001).
- WALLET_ADDRESS var kini = 3mqW (aligned 2026-10-14).

## Nota keselamatan
- 18 Okt 2026: kunci peribadi dompet Solana bot (`3mqWx...stk4E`, baki 0.0077 SOL / 0 USDC)
  TERPAPAR dalam log diagnostik satu sesi - skrip menyenaraikan "nama medan" sandaran, tetapi
  sebahagian baris BACKUP-PROJEK.txt bukan berformat `nama: nilai`, jadi nilainya ikut terpapar.
  Dompet EVM/Base (`0x86fFa64e...951aD`) dan mnemoniknya TIDAK terjejas.
- Keputusan pengguna: TERIMA RISIKO, dompet tidak diputar (nilai terjejas hanya ~$0.79).
- Peraturan mulai sekarang: JANGAN cetak kandungan BACKUP-PROJEK.txt (termasuk "nama medan").
  Guna skrip statistik sahaja (cth `~/buat-sheet-tsv.cjs` -> TSV 2 lajur).
- Jika dompet ini kelak menyimpan nilai besar: WAJIB putar - jana dompet Solana baharu (kunci
  ke VPS dahulu), pindah baki, kemas kini `WALLET_ADDRESS` + `SOLANA_PRIVATE_KEY`, deploy semula.

## Keputusan
- 0.012 SOL (~$1.25) TIDAK cukup untuk live arbitrage (profit 0.2% << fee). Kekal simulasi.
- Plan: simulasi 7 hari kumpul data, sambil tambah modal via jual service setup (Worker+Telegram+D1) ke manusia (RM30-150), BUKAN bot-jual-ke-bot (tidak realistik). Susah cari pembeli — mula dari kawan/kedai/Fiverr $5.
- Next: (1) encrypt backup + Drive, (2) revoke Telegram token + `wrangler secret put`, (3) semak 7-hari paper log, (4) bila modal $50+ + PAPER_OPPORTUNITY konsisten baru bincang live kecil.

## Sambung topic
- Cakap: "sambung topic web3-agent paper-trading" + tampal fail ini.
