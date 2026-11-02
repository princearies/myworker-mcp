#!/usr/bin/env node
/**
 * Daftar agent kita di AgentBazaar (agentbazaar.dev) — marketplace agen di Solana.
 *
 * Apa yang skrip ini buat:
 *   1. Jana dompet Solana BAHARU untuk identiti agent (sekali sahaja) —
 *      disimpan di ~/.agentbazaar-wallet.json (chmod 600). JANGAN guna dompet bot
 *      (kuncinya sudah bocor pada 18 Okt 2026), dan JANGAN cetak isi fail ini.
 *   2. Tandatangani mesej "agentbazaar:register:<timestamp>" (ed25519, base58).
 *   3. POST https://agentbazaar.dev/agents/register (mod "push" -> /agentbazaar).
 *   4. Simpan respons (tanpa kunci) ke ~/.agentbazaar-agent.json
 *
 * TIADA transaksi, TIADA kelulusan, TIADA dana bergerak. Platform tanggung gas.
 *
 * Guna:  node tools/daftar-agentbazaar.cjs [endpoint]
 *        node tools/daftar-agentbazaar.cjs --tunjuk      (papar agent sedia ada)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Keypair } = require('@solana/web3.js')
const b58 = require('bs58')
const { ed25519 } = require('@noble/curves/ed25519')

const enc = (b) => (b58.encode ? b58.encode(b) : b58.default.encode(b))
const dec = (s) => (b58.decode ? b58.decode(s) : b58.default.decode(s))

const FAIL_KUNCI = path.join(os.homedir(), '.agentbazaar-wallet.json')
const FAIL_AGENT = path.join(os.homedir(), '.agentbazaar-agent.json')
const API = 'https://www.agentbazaar.dev'

const ENDPOINT = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'https://crypto-micro-agent.mykira.workers.dev/agentbazaar'

/** Dompet identiti: baca kalau ada, jana kalau tiada. */
function dompet() {
  if (fs.existsSync(FAIL_KUNCI)) {
    const j = JSON.parse(fs.readFileSync(FAIL_KUNCI, 'utf8'))
    return Keypair.fromSecretKey(dec(j.secretKey || j.secret_key))
  }
  const kp = Keypair.generate()
  fs.writeFileSync(FAIL_KUNCI, JSON.stringify({
    publicKey: kp.publicKey.toBase58(),
    secretKey: enc(kp.secretKey),
    dibuat: new Date().toISOString(),
    nota: 'Identiti pendaftaran AgentBazaar (bukan dompet penerima bayaran).'
  }, null, 2))
  try { fs.chmodSync(FAIL_KUNCI, 0o600) } catch { /* Windows/FS tanpa chmod */ }
  return kp
}

async function main() {
  const kp = dompet()
  const pub = kp.publicKey.toBase58()
  console.log('Dompet identiti :', pub)
  console.log('Fail kunci      :', FAIL_KUNCI, '(chmod 600, jangan dibuka)')

  if (process.argv.includes('--tunjuk')) {
    const r = await fetch(`${API}/agents/${pub}`)
    console.log('GET /agents/:pubkey ->', r.status, (await r.text()).slice(0, 800))
    return
  }

  const mesej = `agentbazaar:register:${Date.now()}`
  // Keypair Solana menyimpan kunci 64 bait (32 seed + 32 public). @noble/ed25519
  // mahu seed 32 bait sahaja.
  const seed = kp.secretKey.slice(0, 32)
  // SDK rasmi (@agentsbazaar/sdk) menandatangani nacl.sign.detached dan
  // mengekod tandatangan sebagai BASE64 (bukan base58).
  const tandatangan = Buffer.from(ed25519.sign(Buffer.from(mesej, 'utf8'), seed)).toString('base64')

  const body = {
    name: 'Myworker Solana Agent',
    skills: 'solana token safety, rug check, memecoin analysis, crypto price, wallet audit, sentiment analysis, translation, web summarization',
    pricePerRequest: 20000, // $0.02 USDC (selaras dengan harga pasaran x402; floor $0.005 kerana fi fasilitator)
    description: 'Agen Solana Myworker: saringan keselamatan token (honeypot, kuasa mint/freeze, kecairan), harga & quote Jupiter, periksa dompet, token trending, yuran rangkaian, serta AI (sentimen, terjemah, ringkas, tulis). Setiap jawapan menyatakan sumber dan had — tiada angka mengelirukan.',
    deliveryMode: 'push',
    endpoint: ENDPOINT,
    ownerEmail: 'ag.azaman78+myworker@gmail.com'
  }

  console.log('Endpoint tugasan:', ENDPOINT)
  console.log('Menghantar permintaan pendaftaran…')
  const r = await fetch(`${API}/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wallet-Address': pub,
      'X-Wallet-Signature': tandatangan,
      'X-Wallet-Message': mesej
    },
    body: JSON.stringify(body)
  })
  const teks = await r.text()
  console.log('HTTP', r.status)
  console.log(teks.slice(0, 2000))

  if (r.ok) {
    try {
      fs.writeFileSync(FAIL_AGENT, JSON.stringify({ didaftar: new Date().toISOString(), endpoint: ENDPOINT, pubkey: pub, respons: JSON.parse(teks) }, null, 2))
      console.log('Respons disimpan :', FAIL_AGENT)
    } catch { fs.writeFileSync(FAIL_AGENT, teks) }
  }
}

main().catch((e) => { console.error('RALAT:', e.message); process.exit(1) })
