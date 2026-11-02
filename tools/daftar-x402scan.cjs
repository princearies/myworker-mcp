/**
 * Daftar origin kita pada x402scan (Merit Systems).
 *    https://www.x402scan.com/resources/register
 *
 * SKOP: SIWE (EIP-4361) + cabaran SIWX. TIADA transaksi, TIADA kelulusan token,
 * TIADA dana bergerak. Kunci peribadi dibaca dari fail sandaran dan TIDAK PERNAH dicetak.
 *
 * PENGGUNAAN
 *   npm i viem @signinwithethereum/siwe @x402/extensions
 *   node daftar-x402scan.cjs https://crypto-micro-agent.mykira.workers.dev
 *
 * ALIRAN SEBENAR (dokumentasi awam TIDAK menyebut langkah 3-4):
 *   1. GET  /api/auth/csrf                          -> nonce
 *   2. POST /api/auth/callback/siwe-csrf            -> kuki sesi
 *        (mesej EIP-4361, statement "Sign into x402scan"; kuki CSRF MESTI dihantar balik)
 *   3. POST /api/x402/registry/register-origin      -> 402 + extensions["sign-in-with-x"].info
 *   4. POST /api/x402/registry/register-origin      -> header SIGN-IN-WITH-X = base64(payload)
 *   5. 200 {"success":true,"registered":N,...}
 *
 * NOTA IDENTITI: guna dompet EVM (0x86fFa…) kerana kunci Solana sudah terbocor.
 * Skrip berhenti jika alamat terbitan tidak sepadan dengan EXPECTED.
 */
const fs = require('fs');
const { privateKeyToAccount } = require('viem/accounts');
const { SiweMessage } = require('@signinwithethereum/siwe');
const { createSIWxPayload, encodeSIWxHeader } = require('@x402/extensions/sign-in-with-x');

const BASE = 'https://www.x402scan.com';
const ORIGIN = process.argv[2] || 'https://crypto-micro-agent.mykira.workers.dev';
const EXPECTED = '0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) x402reg/1.1';
const REG_URL = `${BASE}/api/x402/registry/register-origin`;

// ---- kunci (tidak pernah dicetak) ----
let pk = null, src = null;
for (const f of ['D:\\KUNCI-BOT-SEMENTARA\\BACKUP-PROJEK.txt', `${process.env.HOME || ''}/.agent-evm-wallet.json`]) {
  if (!f || !fs.existsSync(f)) continue;
  const m = fs.readFileSync(f, 'utf8').match(/"privateKey"\s*:\s*"(0x[0-9a-fA-F]{64})"/);
  if (m) { pk = m[1]; src = f; break; }
}
if (!pk) { console.error('GAGAL: kunci EVM tidak dijumpai.'); process.exit(1); }
const account = privateKeyToAccount(pk);
console.log('sumber kunci :', src);
console.log('penandatangan:', account.address);
if (account.address.toLowerCase() !== EXPECTED.toLowerCase()) {
  console.error('GAGAL: alamat tidak sepadan — berhenti.');
  process.exit(1);
}

// ---- balang cookie ringkas ----
const jar = new Map();
function save(res) {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const pair = c.split(';')[0]; const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

(async () => {
  // ===== 1. SIWE log masuk =====
  let r = await fetch(`${BASE}/api/auth/csrf`, { headers: { 'user-agent': UA } });
  save(r);
  const { csrfToken } = await r.json();
  const issuedAt = new Date();
  const msg = new SiweMessage({
    domain: 'www.x402scan.com', uri: BASE, version: '1', address: account.address,
    statement: 'Sign into x402scan', nonce: csrfToken, chainId: 8453,
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 2 * 3600e3).toISOString()
  });
  const sig = await account.signMessage({ message: msg.prepareMessage() });
  r = await fetch(`${BASE}/api/auth/callback/siwe-csrf`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, origin: BASE, referer: `${BASE}/resources/register`, cookie: cookieHeader() },
    body: new URLSearchParams({ csrfToken, message: JSON.stringify(msg), signedMessage: sig, callbackUrl: `${BASE}/`, json: 'true' }),
    redirect: 'manual'
  });
  save(r);
  const session = [...jar.keys()].some((k) => /session-token/i.test(k));
  console.log('log masuk    :', r.status, session ? '(sesi ADA)' : '(sesi TIADA)');

  // ===== 2. cabaran SIWX =====
  r = await fetch(REG_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: BASE, referer: `${BASE}/resources/register`, cookie: cookieHeader() },
    body: JSON.stringify({ origin: ORIGIN })
  });
  const first = await r.json();
  const info = first?.extensions?.['sign-in-with-x']?.info;
  console.log('cabaran SIWX :', r.status, info ? 'diterima (nonce ' + String(info.nonce).slice(0, 8) + '…)' : 'TIADA');
  if (!info) { console.log(JSON.stringify(first).slice(0, 800)); process.exit(1); }

  // ===== 3. tandatangan cabaran & daftar =====
  const payload = await createSIWxPayload(info, account, REG_URL);
  const header = encodeSIWxHeader(payload);

  r = await fetch(REG_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'user-agent': UA, origin: BASE,
      referer: `${BASE}/resources/register`, cookie: cookieHeader(),
      'SIGN-IN-WITH-X': header
    },
    body: JSON.stringify({ origin: ORIGIN })
  });
  const txt = await r.text();
  console.log('\n--- HASIL DAFTAR ---');
  console.log('status:', r.status);
  console.log(txt.slice(0, 5000));
})().catch((e) => { console.error('RALAT:', e && e.message ? e.message : String(e)); process.exit(1); });
