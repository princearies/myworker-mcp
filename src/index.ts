import { Hono } from 'hono'
import { Keypair, Connection, clusterApiUrl, LAMPORTS_PER_SOL } from '@solana/web3.js'
import bs58 from 'bs58'
import { registerAgent, handleAgentCommand, registerMcp } from './agent'

type Bindings = {
  SOLANA_PRIVATE_KEY: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  WALLET_ADDRESS?: string
  SOLANA_RPC?: string
  PAPER_TRADING_MODE?: string
  PAPER_TRADING_UNTIL?: string
  MIN_PROFIT_PCT?: string
  AGENT_WALLET?: string
  AGENT_STATS_KEY?: string
  AGENT_PRICES?: string
  SOL_NETWORK?: string
  DB?: D1Database
  DB_INCOME?: D1Database
  AI?: any
}

const app = new Hono<{ Bindings: Bindings }>()

// ===== Paper-Trading config (7-day simulation, zero financial risk) =====
const PAPER_START_ISO = '2026-10-14T00:00:00Z'
const PAPER_END_ISO = '2026-10-21T00:00:00Z' // 7 days
const MIN_PROFIT_PCT = 0.2 // out - in - fees > 0.2%
const EST_FEES_LAMPORTS = 12000 // ~2 signatures + Jupiter fee buffer
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvW5'
const TRI_FEES_LAMPORTS = 18000 // 3 legs x ~6000

// ==== MODEL KOS SEBENAR ====
// Semua kos ditolak SEBELUM untung dilaporkan (net profit sahaja).
const BASE_FEE_PER_SIG_LAMPORTS = 5000   // fi asas Solana
const SIGS_PER_SWAP = 1                  // 1 swap Jupiter = 1 signature
const PRIORITY_FEE_LAMPORTS = 50000      // 0.00005 SOL/tx
const SLIPPAGE_BPS_PER_LEG = 10          // 0.10% realisasi setiap leg
const ATA_RENT_LAMPORTS = 2039280        // sekali sahaja, boleh refund

type KosSebenar = { fi: number, priority: number, slippage: number, ata: number, jumlah: number, pct: number }

function kosSebenar(inputLamports: number, legs: number, includeAta = false): KosSebenar {
  const fi = BASE_FEE_PER_SIG_LAMPORTS * SIGS_PER_SWAP * legs
  const priority = PRIORITY_FEE_LAMPORTS * legs
  const slippage = Math.floor((inputLamports * SLIPPAGE_BPS_PER_LEG * legs) / 10000)
  const ata = includeAta ? ATA_RENT_LAMPORTS : 0
  const jumlah = fi + priority + slippage + ata
  return { fi, priority, slippage, ata, jumlah, pct: inputLamports > 0 ? (jumlah / inputLamports) * 100 : 0 }
}

function isPaperActive(env: Bindings): boolean {
  if ((env.PAPER_TRADING_MODE || 'true').toLowerCase() === 'false') return false
  const until = env.PAPER_TRADING_UNTIL || PAPER_END_ISO
  return new Date().toISOString() < until
}

function getWalletKeypair(privateKeyStr: string): Keypair {
  if (privateKeyStr.startsWith('[')) {
    const secretKey = Uint8Array.from(JSON.parse(privateKeyStr))
    return Keypair.fromSecretKey(secretKey)
  } else {
    try {
      const secretKey = bs58.decode(privateKeyStr)
      return Keypair.fromSecretKey(secretKey)
    } catch {
      const binaryString = atob(privateKeyStr)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)
      return Keypair.fromSecretKey(bytes)
    }
  }
}

// Throttle global: lite-api.jup.ag ada kadar (req/s). Tanpa jarak, burst
// (/arbitrage-check hantar ~11 quote) kena 429 → PAPER_QUOTE_ERROR.
// Adaptif: satu 429 → semua panggilan berikutnya perlahan automatik (cooldown).
let jupNext = 0
let jupCooldown = 0
async function jupThrottle() {
  const now = Date.now()
  const at = Math.max(now, jupNext, jupCooldown)
  jupNext = at + 400
  const d = at - now
  if (d > 0) await new Promise((r) => setTimeout(r, d))
}
// Tandakan 429/ralat → perlahan semua panggilan selama sebentar.
function jupPause(ms: number) {
  jupCooldown = Math.max(jupCooldown, Date.now() + ms)
}

// Cache quote 10s — memotong jumlah panggilan Jupiter dengan banyak
// (cth SOL->USDC 100M dikongsi antara 2-leg, 3-leg dan cross-check).
const quoteCache = new Map<string, { at: number, data: any }>()

// Helper: Jupiter quote (lite-api v1) dengan cache + throttle + backoff.
const getJupiterQuote = async (inputMint: string, outputMint: string, amount: number) => {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`
  const ck = `${inputMint}:${outputMint}:${amount}`
  const hit = quoteCache.get(ck)
  if (hit && Date.now() - hit.at < 10000) return hit.data
  const backoff = (n: number) => new Promise((r) => setTimeout(r, 500 * n))
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await jupThrottle()
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Myworker-Solana-Bot/1.0 (Cloudflare Workers)'
        }
      })
      const textBody = await res.text()
      if (!textBody || textBody.length === 0) {
        console.warn(`Jupiter response kosong (cubaan ${attempt}/5)`)
        jupPause(1200)
        if (attempt === 5) return { error: true, message: 'Empty response from Jupiter' }
        await backoff(attempt)
        continue
      }
      const data = JSON.parse(textBody)
      if (!res.ok || (data as any)?.error) {
        console.warn('Jupiter API error:', (data as any)?.error || res.status, `(cubaan ${attempt}/5)`)
        jupPause(res.status === 429 ? 1800 : 800)
        if (attempt === 5) return { error: true, message: (data as any)?.error || 'Jupiter quote failed (final attempt)' }
        await backoff(attempt)
        continue
      }
      if (quoteCache.size > 300) quoteCache.clear()
      quoteCache.set(ck, { at: Date.now(), data })
      return data
    } catch (e: any) {
      console.error(`Fetch error to Jupiter (cubaan ${attempt}/5):`, e.message)
      jupPause(900)
      if (attempt === 5) return { error: true, message: e.message }
      await backoff(attempt)
    }
  }
  return { error: true, message: 'Failed after 5 retries' }
}

// DISABLED: live swap is permanently off during paper-trading.
// Any call to this is blocked and only logged.
const executeRealSwap = async (_env: any, _quoteResponse: any) => {
  console.warn('BLOCKED: executeRealSwap called during PAPER-TRADING mode — refused.')
  return { status: 'BLOCKED_PAPER_MODE', error: 'Live trading disabled. Paper-trading only.' }
}

type PaperScanResult = {
  status: 'PAPER_OPPORTUNITY' | 'PROFIT_CHECK' | 'PAPER_QUOTE_ERROR'
  pair: string
  inputLamports: number
  leg1OutAmount: number
  leg2OutLamports: number
  profitLamports: number
  profitPct: number
  priceImpactLeg1: number
  priceImpactLeg2: number
  detail?: string
  kodKos?: KosSebenar
  untungKasarLamports?: number
}

// True 2-way quote: SOL -> USDC -> SOL, profit = out - in - fees
async function runPaperScan(testAmountLamports: number): Promise<PaperScanResult> {
  const leg1: any = await getJupiterQuote(SOL_MINT, USDC_MINT, testAmountLamports)
  if (leg1?.error || !leg1?.outAmount) {
    return {
      status: 'PAPER_QUOTE_ERROR',
      pair: 'SOL/USDC',
      inputLamports: testAmountLamports,
      leg1OutAmount: 0,
      leg2OutLamports: 0,
      profitLamports: 0,
      profitPct: 0,
      priceImpactLeg1: 0,
      priceImpactLeg2: 0,
      detail: leg1?.message || 'leg1 quote failed'
    }
  }
  const leg1Out = parseInt(leg1.outAmount, 10) // USDC smallest units (6 decimals)
  const impact1 = leg1?.priceImpactPct ? parseFloat(leg1.priceImpactPct) : 0
  if (!leg1Out || leg1Out <= 0) {
    return {
      status: 'PROFIT_CHECK', pair: 'SOL/USDC',
      inputLamports: testAmountLamports, leg1OutAmount: 0, leg2OutLamports: 0,
      profitLamports: 0, profitPct: 0, priceImpactLeg1: impact1, priceImpactLeg2: 0,
      detail: 'leg1 zero output'
    }
  }

  const leg2: any = await getJupiterQuote(USDC_MINT, SOL_MINT, leg1Out)
  if (leg2?.error || !leg2?.outAmount) {
    return {
      status: 'PAPER_QUOTE_ERROR', pair: 'SOL/USDC',
      inputLamports: testAmountLamports, leg1OutAmount: leg1Out, leg2OutLamports: 0,
      profitLamports: 0, profitPct: 0, priceImpactLeg1: impact1, priceImpactLeg2: 0,
      detail: leg2?.message || 'leg2 quote failed'
    }
  }
  const leg2Out = parseInt(leg2.outAmount, 10) // lamports SOL
  const impact2 = leg2?.priceImpactPct ? parseFloat(leg2.priceImpactPct) : 0

  const kos = kosSebenar(testAmountLamports, 2)
  const untungKasar = leg2Out - testAmountLamports
  const profitLamports = untungKasar - kos.jumlah
  const profitPct = (profitLamports / testAmountLamports) * 100
  const profitable = profitPct > MIN_PROFIT_PCT && impact1 < 1 && impact2 < 1

  return {
    status: profitable ? 'PAPER_OPPORTUNITY' : 'PROFIT_CHECK',
    pair: 'SOL/USDC',
    inputLamports: testAmountLamports,
    leg1OutAmount: leg1Out,
    leg2OutLamports: leg2Out,
    profitLamports,
    profitPct,
    priceImpactLeg1: impact1,
    priceImpactLeg2: impact2,
    kodKos: kos,
    untungKasarLamports: untungKasar
  }
}

async function getCexSolPrice(): Promise<{ price: number, venue: string }> {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { headers: { Accept: 'application/json' } })
    const j: any = await r.json()
    const px = parseFloat(j?.data?.amount)
    if (px > 0) return { price: px, venue: 'coinbase' }
  } catch (e) { console.warn('coinbase fail', (e as any)?.message) }
  const r2 = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD', { headers: { Accept: 'application/json' } })
  const j2: any = await r2.json()
  const keys = j2?.result ? Object.keys(j2.result) : []
  if (keys.length > 0) {
    const c = j2.result[keys[0]].c
    const px = parseFloat(Array.isArray(c) ? c[0] : c)
    if (px > 0) return { price: px, venue: 'kraken' }
  }
  throw new Error('CEX price unavailable')
}

async function runCrossCheck(input: number): Promise<PaperScanResult> {
  const q: any = await getJupiterQuote(SOL_MINT, USDC_MINT, input)
  if (q?.error || !q?.outAmount) {
    return { status: 'PAPER_QUOTE_ERROR', pair: 'CEXspread/SOL', inputLamports: input, leg1OutAmount: 0, leg2OutLamports: 0, profitLamports: 0, profitPct: 0, priceImpactLeg1: 0, priceImpactLeg2: 0, detail: q?.message || 'jup leg failed' }
  }
  const jupOutUsdc = parseInt(q.outAmount, 10) / 1e6
  const solIn = input / LAMPORTS_PER_SOL
  const jupPrice = jupOutUsdc / solIn
  let cex = { price: 0, venue: 'none' }
  try { cex = await getCexSolPrice() } catch (e: any) {
    return { status: 'PAPER_QUOTE_ERROR', pair: 'CEXspread/SOL', inputLamports: input, leg1OutAmount: parseInt(q.outAmount, 10), leg2OutLamports: 0, profitLamports: 0, profitPct: 0, priceImpactLeg1: 0, priceImpactLeg2: 0, detail: 'cex fail: ' + e.message }
  }
  const gross = ((jupPrice - cex.price) / cex.price) * 100
  const kos = kosSebenar(input, 1)
  const net = gross - 0.15 - kos.pct // 0.15% fee CEX taker + kos rantaian sebenar
  const untungKasar = Math.round((input * gross) / 100)
  const profitLamports = Math.round((input * net) / 100)
  const ok = net > MIN_PROFIT_PCT
  return { status: ok ? 'PAPER_OPPORTUNITY' : 'PROFIT_CHECK', pair: 'CEXspread/SOL(' + cex.venue + ')', inputLamports: input, leg1OutAmount: parseInt(q.outAmount, 10), leg2OutLamports: input + profitLamports, profitLamports, profitPct: net, priceImpactLeg1: q?.priceImpactPct ? parseFloat(q.priceImpactPct) : 0, priceImpactLeg2: 0, kodKos: kos, untungKasarLamports: untungKasar, detail: 'jup ' + jupPrice.toFixed(4) + ' vs ' + cex.venue + ' ' + cex.price.toFixed(4) }
}

async function runTriScan(mints: string[], label: string, input: number): Promise<PaperScanResult> {
  let amt = input
  const outs: number[] = []
  let impact = 0
  for (let i = 0; i < mints.length - 1; i++) {
    const q: any = await getJupiterQuote(mints[i], mints[i + 1], amt)
    if (q?.error || !q?.outAmount) {
      return { status: 'PAPER_QUOTE_ERROR', pair: label, inputLamports: input, leg1OutAmount: outs[0] || 0, leg2OutLamports: 0, profitLamports: 0, profitPct: 0, priceImpactLeg1: impact, priceImpactLeg2: 0, detail: (q?.message || ('tri leg' + (i + 1) + ' failed')) }
    }
    amt = parseInt(q.outAmount, 10)
    outs.push(amt)
    if (q?.priceImpactPct) impact = Math.max(impact, parseFloat(q.priceImpactPct))
    if (!amt || amt <= 0) {
      return { status: 'PROFIT_CHECK', pair: label, inputLamports: input, leg1OutAmount: outs[0] || 0, leg2OutLamports: 0, profitLamports: 0, profitPct: 0, priceImpactLeg1: impact, priceImpactLeg2: 0, detail: 'tri zero output' }
    }
  }
  const kos = kosSebenar(input, mints.length - 1)
  const untungKasar = amt - input
  const profitLamports = untungKasar - kos.jumlah
  const profitPct = (profitLamports / input) * 100
  const ok = profitPct > MIN_PROFIT_PCT && impact < 1
  return { status: ok ? 'PAPER_OPPORTUNITY' : 'PROFIT_CHECK', pair: label, inputLamports: input, leg1OutAmount: outs[0] || 0, leg2OutLamports: amt, profitLamports, profitPct, priceImpactLeg1: impact, priceImpactLeg2: 0, kodKos: kos, untungKasarLamports: untungKasar }
}

async function logPaperToD1(db: any, scan: PaperScanResult) {
  if (!db) return
  const txHash = 'paper-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
  const profitSol = scan.profitLamports / LAMPORTS_PER_SOL
  const meta = JSON.stringify({
    leg1Out: scan.leg1OutAmount, leg2Out: scan.leg2OutLamports,
    impact1: scan.priceImpactLeg1, impact2: scan.priceImpactLeg2,
    kos: scan.kodKos || null, kas: scan.untungKasarLamports ?? null,
    mode: 'paper', window: `${PAPER_START_ISO}/${PAPER_END_ISO}`
  })
  await db.prepare(
    'INSERT INTO transactions (type, amount, token_symbol, tx_hash, status, meta) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind('live_arbitrage_scan', profitSol.toString(), 'SOL/USDC', txHash, scan.status, meta).run()
}

async function maybeNotifyTelegram(env: Bindings, msg: string, force = false, scan?: PaperScanResult) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.log('Telegram skip: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not bound')
    return false
  }
  // Anti-spam: only notify on real PAPER_OPPORTUNITY unless forced
  if (!force && scan?.status !== 'PAPER_OPPORTUNITY') return false
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    })
    return true
  } catch (e) {
    console.error('Telegram send failed', e)
    return false
  }
}

app.get('/', async (c) => {
  const privateKey = c.env.SOLANA_PRIVATE_KEY
  if (!privateKey) {
    return c.json({ status: 'error', message: 'SOLANA_PRIVATE_KEY tidak dijumpai dalam wrangler secret!' }, 500)
  }
  try {
    const keypair = getWalletKeypair(privateKey)
    const rpc = c.env.SOLANA_RPC || clusterApiUrl('mainnet-beta')
    const connection = new Connection(rpc, 'confirmed')
    const balance = await connection.getBalance(keypair.publicKey)
    const solBalance = balance / LAMPORTS_PER_SOL
    return c.json({
      status: 'success',
      bot: 'Solana Arbitrage Bot (Hono) — PAPER-TRADING',
      mode: isPaperActive(c.env) ? 'PAPER_TRADING' : 'PAPER_EXPIRED',
      paperWindow: `${PAPER_START_ISO} → ${c.env.PAPER_TRADING_UNTIL || PAPER_END_ISO}`,
      minProfitPct: MIN_PROFIT_PCT,
      publicKey: keypair.publicKey.toBase58(),
      balanceSOL: solBalance,
      message: 'Paper-trading only. No live swaps.'
    })
  } catch (error: any) {
    return c.json({ status: 'error', error: error.message }, 500)
  }
})

app.get('/trade', async (c) => {
  // Legacy endpoint — forced to paper mode, never executes live swap
  return c.json({
    status: 'paper_only',
    mode: 'PAPER_TRADING',
    message: 'Live trading disabled. Use /arbitrage-check for paper scan.',
    timestamp: new Date().toISOString()
  })
})

app.get('/arbitrage-check', async (c) => {
  try {
    const testAmounts = [1000000] // 0.01/0.05/0.1/0.2/0.5 SOL paper-only (minggu-2: saiz besar simulasi), ambil net terbaik
    const scans = []
    for (const ta of testAmounts) scans.push(await runPaperScan(ta))
    scans.sort((a, b) => b.profitPct - a.profitPct)
    const scan = scans[0]
    const allScans = scans.map((x) => ({ in: x.inputLamports, out: x.leg2OutLamports, pct: Number(x.profitPct.toFixed(4)), st: x.status, kosPct: Number((x.kodKos?.pct || 0).toFixed(4)), kas: x.untungKasarLamports ?? null }))
    const triRoutes: Array<[string[], string]> = [
      [[SOL_MINT, USDC_MINT, BONK_MINT, SOL_MINT], 'SOL/USDC/BONK'],
      [[SOL_MINT, BONK_MINT, USDC_MINT, SOL_MINT], 'SOL/BONK/USDC'],
    ]
    const triScans: PaperScanResult[] = []
    for (const [mints, label] of triRoutes) triScans.push(await runTriScan(mints, label, 50000000))
    const triBest = triScans.slice().sort((a, b) => b.profitPct - a.profitPct)[0]
    const triSummary = triScans.map((x) => ({ pair: x.pair, pct: Number(x.profitPct.toFixed(4)), st: x.status, detail: x.detail }))
    if (triBest && triBest.profitPct > scan.profitPct) {
      for (const k of Object.keys(triBest) as Array<keyof PaperScanResult>) (scan as any)[k] = (triBest as any)[k]
    }
    let cross: PaperScanResult | null = null
    try {
      cross = await runCrossCheck(50000000)
      if (cross.profitPct > scan.profitPct) {
        for (const k of Object.keys(cross) as Array<keyof PaperScanResult>) (scan as any)[k] = (cross as any)[k]
      }
    } catch (e) { console.error('cross check failed', (e as any)?.message) }
    const crossSummary = cross ? { pair: cross.pair, pct: Number(cross.profitPct.toFixed(4)), st: cross.status, detail: cross.detail } : null
    const db = (c.env as any).DB_INCOME || (c.env as any).DB
    await logPaperToD1(db, scan).catch((e: any) => console.error('D1 log failed', e))

    const msg =
      scan.status === 'PAPER_OPPORTUNITY'
        ? `📝 *PAPER OPPORTUNITY (simulasi)*\n• Pair: ${scan.pair}\n• In: ${(scan.inputLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\n• Out: ${(scan.leg2OutLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\n• Untung bersih: ${(scan.profitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${scan.profitPct.toFixed(3)}%)\n• Impact: ${scan.priceImpactLeg1.toFixed(2)}% / ${scan.priceImpactLeg2.toFixed(2)}%\n• Mod: PAPER, tiada swap live`
        : `📊 Paper scan: ${scan.status}\nProfit: ${scan.profitPct.toFixed(3)}% (min ${MIN_PROFIT_PCT}%)`
    await maybeNotifyTelegram(c.env, msg, false, scan)

    return c.json({
      status: scan.status,
      mode: 'PAPER_TRADING',
      liveTrading: false,
      ...scan,
      profitSOL: scan.profitLamports / LAMPORTS_PER_SOL,
      minProfitPct: MIN_PROFIT_PCT,
      bestOf: typeof allScans !== 'undefined' ? allScans : undefined,
      tri: typeof triSummary !== 'undefined' ? triSummary : undefined,
      cross: typeof crossSummary !== 'undefined' ? crossSummary : undefined,
      paperWindow: `${PAPER_START_ISO} → ${c.env.PAPER_TRADING_UNTIL || PAPER_END_ISO}`,
      timestamp: new Date().toISOString()
    })
  } catch (e: any) {
    return c.json({ status: 'ERROR', mode: 'PAPER_TRADING', detail: e.message }, 500)
  }
})

app.get('/status', async (c) => {
  try {
    const privateKey = c.env.SOLANA_PRIVATE_KEY
    if (!privateKey) {
      return c.json({ status: 'error', message: 'SOLANA_PRIVATE_KEY tidak dijumpai!' }, 500)
    }
    const keypair = getWalletKeypair(privateKey)
    const rpc = c.env.SOLANA_RPC || clusterApiUrl('mainnet-beta')
    const connection = new Connection(rpc, 'confirmed')
    const balance = await connection.getBalance(keypair.publicKey)
    const solBalance = balance / LAMPORTS_PER_SOL
    const db = (c.env as any).DB_INCOME || (c.env as any).DB
    let paperCount = 0
    let paperOpps = 0
    let avgProfit = 0
    if (db) {
      const n = await db.prepare("SELECT COUNT(*) as c FROM transactions WHERE type='live_arbitrage_scan'").first().catch(() => null)
      paperCount = (n as any)?.c || 0
      const o = await db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status='PAPER_OPPORTUNITY'").first().catch(() => null)
      paperOpps = (o as any)?.c || 0
      const a = await db.prepare("SELECT AVG(CAST(amount AS REAL)) as avg FROM transactions WHERE type='live_arbitrage_scan'").first().catch(() => null)
      avgProfit = (a as any)?.avg || 0
    }
    return c.json({
      status: 'ACTIVE_PAPER',
      bot: 'Myworker - Autonomous Digital Income Agent',
      mode: isPaperActive(c.env) ? 'PAPER_TRADING' : 'PAPER_EXPIRED',
      paperWindow: `${PAPER_START_ISO} → ${c.env.PAPER_TRADING_UNTIL || PAPER_END_ISO}`,
      liveTrading: false,
      wallet: keypair.publicKey.toBase58(),
      balanceSOL: solBalance,
      paperScans: paperCount,
      paperOpportunities: paperOpps,
      avgProfitSOL: avgProfit,
      minProfitPct: MIN_PROFIT_PCT,
      timestamp: new Date().toISOString()
    })
  } catch (e: any) {
    return c.json({ status: 'ERROR', detail: e.message }, 500)
  }
})

// ---- Agent API (x402): jual servis data crypto + AI kepada bot/agen lain ----
// Logik penuh (cabaran bayaran, pengesahan on-chain, servis) ada dalam src/agent.ts
registerAgent(app)

// MCP (Model Context Protocol) — TAMBAHAN 19 Okt, additive: katalog baca-sahaja
// daripada registry yang sama; tiada kod servis sedia ada disentuh.
registerMcp(app)

app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json()
    const message = update?.message
    if (!message) return c.json({ ok: true })

    const chatId = message.chat?.id
    const text = message.text || ''
    // No hardcoded fallback — must be bound via `wrangler secret put TELEGRAM_BOT_TOKEN`
    const botToken = c.env.TELEGRAM_BOT_TOKEN
    if (!botToken) {
      console.error('TELEGRAM_BOT_TOKEN not bound')
      return c.json({ ok: true })
    }
    const sendTelegramMessage = async (token: string, cid: number, msg: string) => {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text: msg })
      })
    }

    if (text === '/wallet') {
      // Solana
      const rpc2 = c.env.SOLANA_RPC || clusterApiUrl('mainnet-beta')
      let balSol = 'N/A'
      try {
        const kp = getWalletKeypair(c.env.SOLANA_PRIVATE_KEY)
        const conn = new Connection(rpc2, 'confirmed')
        balSol = ((await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL).toFixed(6) + ' SOL'
      } catch {}

      // EVM (Base)
      let balUsdcEvm = 'N/A'
      let balEthEvm = 'N/A'
      const evmAddr = c.env.AGENT_EVM_WALLET || ''
      if (evmAddr) {
        try {
          const usdcResp = await fetch('https://base-rpc.publicnode.com', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'eth_call',
              params: [{
                to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                data: '0x70a08231000000000000000000000000' + evmAddr.replace('0x', '')
              }, 'latest']
            })
          })
          const usdcJson = await usdcResp.json()
          if (usdcJson.result && usdcJson.result !== '0x') {
            const usdcHex = BigInt(usdcJson.result)
            balUsdcEvm = (Number(usdcHex) / 1e6).toFixed(4) + ' USDC'
          } else {
            balUsdcEvm = '0 USDC'
          }
          const ethResp = await fetch('https://base-rpc.publicnode.com', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
              params: [evmAddr, 'latest']
            })
          })
          const ethJson = await ethResp.json()
          if (ethJson.result && ethJson.result !== '0x') {
            const ethHex = BigInt(ethJson.result)
            balEthEvm = (Number(ethHex) / 1e18).toFixed(6) + ' ETH'
          } else {
            balEthEvm = '0 ETH'
          }
        } catch (e) {
          balUsdcEvm = 'error'
          balEthEvm = 'error'
        }
      }

      await sendTelegramMessage(botToken, chatId,
        '\uD83D\uDCBC *Wallet\n\n' +
        '*Solana:* `' + (c.env.WALLET_ADDRESS || 'not-set') + '`\n' +
        'Baki: ' + balSol + '\n\n' +
        '*EVM (Base):* `' + (evmAddr || 'not-set') + '`\n' +
        'USDC: ' + balUsdcEvm + '\n' +
        'ETH (gas): ' + balEthEvm + '\n\n' +
        'Mode: PAPER-TRADING (no live swap)'
      )
      return c.json({ ok: true })
    }
    if (text === '/buy') {
      await sendTelegramMessage(botToken, chatId, '⛔ /buy dilumpuhkan semasa PAPER-TRADING (7 hari simulasi). Tiada swap live akan dijalankan.')
      return c.json({ ok: true })
    }
    if (text === '/paper' || text.startsWith('/paper')) {
      const db = (c.env as any).DB_INCOME || (c.env as any).DB
      let line = `📝 Paper-trading aktif hingga ${c.env.PAPER_TRADING_UNTIL || PAPER_END_ISO}\nMin profit: ${MIN_PROFIT_PCT}%\n`
      if (db) {
        const n = await db.prepare("SELECT COUNT(*) as c FROM transactions WHERE type='live_arbitrage_scan'").first().catch(() => null)
        const o = await db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status='PAPER_OPPORTUNITY'").first().catch(() => null)
        line += `Scans: ${(n as any)?.c || 0} | Opps: ${(o as any)?.c || 0}`
      }
      await sendTelegramMessage(botToken, chatId, line)
      return c.json({ ok: true })
    }
    if (text === '/analytics' || text?.includes('/analytics')) {
      try {
        const db = (c.env as any).DB_INCOME || (c.env as any).DB
        if (!db) {
          await sendTelegramMessage(botToken, chatId, '📊 Analitik: Database D1 belum dihubungkan.')
          return c.json({ ok: true })
        }
        const recent = await db.prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 5").all()
        let msg = '📊 *Analitik Paper-Trading*\n'
        msg += `Mod: PAPER (tiada live trade)\n`
        if (recent?.results && recent.results.length > 0) {
          for (const row of recent.results as any[]) {
            msg += `- ${row.type}: ${row.amount} ${row.token_symbol || 'SOL'} (${row.status})\n`
          }
        } else {
          msg += 'Belum ada data paper scan.'
        }
        await sendTelegramMessage(botToken, chatId, msg)
      } catch (e: any) {
        await sendTelegramMessage(botToken, chatId, `📊 Ralat analitik: ${e.message}`)
      }
      return c.json({ ok: true })
    }

    // ---- Agent API (x402): jual servis kepada bot lain ----
    const isAdmin = String(chatId) === String(c.env.TELEGRAM_CHAT_ID || '')
    const diurus = await handleAgentCommand(c, text, async (m: string) => {
      await sendTelegramMessage(botToken, chatId, m)
    }, isAdmin)
    if (diurus) return c.json({ ok: true })

    try {
      const MODELS = [
        'openrouter/free',
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/meta/llama-3.2-3b-instruct',
        '@cf/google/gemma-2-9b-it'
      ]
      const systemPrompt = `Anda ialah Myworker, AI Agent Web3 & Solana (PAPER-TRADING mode, tiada live swap). Model: openrouter/free (percuma).` +
        `\nFokus SOL, USDC, BONK, JUP, Raydium, Orca, Meteora.` +
        `\nBerikan skrip TypeScript/Hono bersih dan padat. Bahasa Malaysia santai & profesional.`
      let reply = ''
      let success = false
      for (const model of MODELS) {
        try {
          let aiResponse: any
          if (model === 'openrouter/free') {
            const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text || '' }] })
            })
            const j = await orRes.json()
            if (!orRes.ok || !j?.choices?.[0]?.message?.content) {
              throw new Error(`OpenRouter response invalid: ${orRes.status} - ${JSON.stringify(j)}`)
            }
            aiResponse = { response: j.choices[0].message.content }
          } else {
            aiResponse = await (c.env as any).AI.run(model, {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: text || '' }
            ],
            max_tokens: 800
          })
          }
          if (aiResponse?.response) {
            reply = `${aiResponse.response}\n\n🤖 *Model:* \`${model}\` (paper mode)`
            success = true
            break
          }
        } catch (err: any) {
          console.warn(`Model ${model} gagal, mencuba seterusnya...`)
        }
      }
      if (!success || !reply) {
        reply = '🤖 Myworker Bot: Maaf, modul perbualan AI sedang diselenggara. Gunakan /wallet untuk semak baki.'
      }
      await sendTelegramMessage(botToken, chatId, reply)
    } catch (aiErr: any) {
      console.error('AI Error:', aiErr)
      const errMsg = aiErr?.message || JSON.stringify(aiErr)
      await sendTelegramMessage(botToken, chatId, `🤖 AI Error Debug: ${errMsg}\n\nGunakan /wallet untuk semak baki.`)
    }

    return c.json({ ok: true })
  } catch (err) {
    console.error('Webhook Error:', err)
    return c.json({ ok: true })
  }
})

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledController, env: any, ctx: ExecutionContext) => {
    ctx.waitUntil((async () => {
      console.log('=== LIVE SCANNER RUNNING (auto-reinvest) ===')
      try {
        const testAmounts = [1000000] // multi-saiz minggu-2 (0.01..0.5 SOL simulasi), ambil net terbaik
        let scan = await runPaperScan(testAmounts[0])
        for (const ta of testAmounts.slice(1)) {
          const sx = await runPaperScan(ta)
          if (sx.profitPct > scan.profitPct) scan = sx
        }
        try {
          const t1 = await runTriScan([SOL_MINT, USDC_MINT, BONK_MINT, SOL_MINT], 'SOL/USDC/BONK', 50000000)
          if (t1.profitPct > scan.profitPct) scan = t1
          const t2 = await runTriScan([SOL_MINT, BONK_MINT, USDC_MINT, SOL_MINT], 'SOL/BONK/USDC', 50000000)
          if (t2.profitPct > scan.profitPct) scan = t2
        } catch (e) { console.error('tri cron failed', (e as any)?.message) }
        try {
          const cx = await runCrossCheck(50000000)
          if (cx.profitPct > scan.profitPct) scan = cx
        } catch (e) { console.error('cross cron failed', (e as any)?.message) }

        const db = env.DB_INCOME || env.DB
        if (db) {
          const txHash = 'paper-cron-' + Date.now()
          const profitSol = scan.profitLamports / LAMPORTS_PER_SOL
          const meta = JSON.stringify({
            leg1Out: scan.leg1OutAmount, leg2Out: scan.leg2OutLamports,
            impact1: scan.priceImpactLeg1, impact2: scan.priceImpactLeg2,
            trigger: 'cron', mode: 'paper', sizes: testAmounts, bestIn: scan.inputLamports
          })
          await db.prepare(
            'INSERT INTO transactions (type, amount, token_symbol, tx_hash, status, meta) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind('live_arbitrage_scan', profitSol.toString(), 'SOL/USDC', txHash, scan.status, meta).run().catch((e: any) => console.error('D1 cron log failed', e))
        }

        // ==== LAPORAN HARIAN TELEGRAM (13:00 UTC = 9:00 malam MY) ====
        try {
          const nowD = new Date()
          if (db && nowD.getUTCHours() === 13 && nowD.getUTCMinutes() < 5) {
            const hariIni = nowD.toISOString().slice(0, 10)
            const sudah: any = await db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE type='daily_report' AND substr(created_at,1,10)=?").bind(hariIni).first()
            if (!sudah?.c) {
              const st: any = await db.prepare("SELECT COUNT(*) AS n, MAX(CAST(amount AS REAL)) AS terbaik, SUM(CASE WHEN status='PAPER_OPPORTUNITY' THEN 1 ELSE 0 END) AS opps FROM transactions WHERE type='live_arbitrage_scan' AND created_at >= datetime('now','-1 day')").first()
              const n = st?.n || 0
              const terbaik = ((st?.terbaik || 0) * 100).toFixed(4)
              const opps = st?.opps || 0
              const kosPct = kosSebenar(500000000, 2).pct.toFixed(3)
              const m = `📊 *Laporan Harian Paper-ARB*\n• Imbasan 24j: ${n}\n• Peluang ≥${MIN_PROFIT_PCT}%: ${opps}\n• Untung NET terbaik: ${terbaik}%\n• Kos sebenar (0.5 SOL): ~${kosPct}%\n• Mod: PAPER sahaja (tiada trade live)`
              const tok = env.TELEGRAM_BOT_TOKEN
              const cid = env.TELEGRAM_CHAT_ID
              if (tok && cid) {
                await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: cid, text: m, parse_mode: 'Markdown' })
                })
                await db.prepare('INSERT INTO transactions (type, amount, token_symbol, tx_hash, status, meta) VALUES (?, ?, ?, ?, ?, ?)')
                  .bind('daily_report', '0', 'SOL', 'daily-' + hariIni, 'SENT', JSON.stringify({ n, terbaik, opps })).run()
              }
            }
          }
        } catch (e: any) {
          console.error('laporan harian gagal', e?.message)
        }

        // LIVE SWAP DISABLED — never call executeRealSwap here.
        // Notify Telegram only on PAPER_OPPORTUNITY to avoid spam
        if (scan.status === 'PAPER_OPPORTUNITY') {
          const token = env.TELEGRAM_BOT_TOKEN
          const chatId = env.TELEGRAM_CHAT_ID
          if (token && chatId) {
            const notificationMsg =
              `📝 *PAPER OPPORTUNITY (cron simulasi)*\n• Pair: SOL/USDC\n• Untung bersih simulasi: ${(scan.profitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${scan.profitPct.toFixed(3)}%)\n• In: ${(scan.inputLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL → Out: ${(scan.leg2OutLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\n• Impact: ${scan.priceImpactLeg1.toFixed(2)}% / ${scan.priceImpactLeg2.toFixed(2)}%\n• Tiada swap live dijalankan`
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: notificationMsg, parse_mode: 'Markdown' })
            })
          } else {
            console.log('Telegram skip (cron): secrets not bound')
          }
        } else {
          console.log(`Paper cron: ${scan.status} profit=${scan.profitPct.toFixed(3)}%`)
        }
      } catch (cronErr: any) {
        console.error('Scheduled paper scanner error:', cronErr)
      }
    })())
  },
};
