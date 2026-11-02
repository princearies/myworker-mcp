# tools/ — skrip operasi (bukan sebahagian Worker)

## daftar-x402scan.cjs
Mendaftar semula / mengemas kini origin kita pada **x402scan** (Merit Systems).
Pendaftaran ini satu-satunya cara masuk ke beberapa direktori lain (x402-list import
`imported:x402scan`, x402-relay crawl x402scan, x402register baca katalog awam).

```bash
npm i viem @signinwithethereum/siwe @x402/extensions
node daftar-x402scan.cjs https://crypto-micro-agent.mykira.workers.dev
```

- Guna dompet **EVM** `0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD` sebagai identiti.
- Berhenti sendiri jika alamat terbitan tidak sepadan dengan `EXPECTED`.
- Kunci peribadi dibaca dari fail sandaran, **tidak pernah dicetak**.
- **TIADA** transaksi / kelulusan / dana bergerak — hanya tandatangan mesej.

Jangkaan hasil: `{"success":true,"registered":17,"failed":0,"skipped":0,"total":17,"source":"openapi"}`

## Permukaan penemuan Worker (semua awam, tiada auth)

| Laluan | Kegunaan |
|---|---|
| `/openapi.json` | OpenAPI 3.1 + `components.securitySchemes.x402` + `x-payment-info` per operasi |
| `/.well-known/x402` | format minimum x402scan (`version:1`, `resources[]`) |
| `/.well-known/x402.json` | manifest penuh (v2) |
| `/.well-known/ai.txt` | penanda manifest (dibaca x402-relay) |
| `/llms.txt` | taklimat agen |
| `/api/agent/katalog.json` | katalog mesin + statistik D1 sebenar |
| `/sitemap.xml` | halaman awam + dokumen mesin |
| `/agent` | katalog untuk manusia |

## Status direktori (19 Okt 2026)

| Saluran | Status | Tindakan seterusnya |
|---|---|---|
| PayAI Bazaar | ✅ 17/17 | — |
| x402scan | ✅ 17/17 | jalankan semula skrip ini selepas tambah servis |
| CDP Bazaar / agentic.market | ❌ | perlukan akaun CDP — disekat |
| x402-list.com | ❌ | import automatik dari x402scan; pilihan bayar $1 ditolak |
| x402register.com | ❌ | probe setiap jam, pasif |
| x402all.com | ❌ | borang manual, percuma |
| x402-relay | ❓ | manifest scanner sudah ada bahan |

## Belum selesai
**Ownership proofs** (`x-discovery.ownershipProofs` + `ownershipProofs` dalam `/.well-known/x402`):
tandatangan EIP-191 atas **URL asal** (`https://crypto-micro-agent.mykira.workers.dev`), kemudian
tetapkan `OWNERSHIP_SIG_EVM` dalam `wrangler.toml` dan deploy semula. Medan ini ditinggalkan
selagi kosong, jadi tiada regresi. Verifier: `apps/scan/src/lib/ownership-proof.ts` (x402scan).
