/* ============================================================================
 * Agent API (x402 "lean") — bot pekerja MENJUAL SERVIS kepada bot/agen lain.
 *
 *   POST /api/agent/<servis>  tanpa bayaran
 *     -> 402 + harga (USDC & SOL) + dompet + "reference" unik
 *   Bot bayar ke dompet (SOL asli atau USDC SPL), "reference" dimasukkan dalam tx
 *     -> panggil semula dengan X-Payment-Ref: <reference>  (atau X-Payment-Tx: <sig>)
 *   Worker sahkan SENDIRI on-chain: getSignaturesForAddress(reference) ->
 *     getTransaction -> kira beza baki dompet kita (SOL + USDC). Replay ditolak
 *     (tx_sig UNIQUE). Hasil di-cache supaya idempotent.
 *
 * TIADA private key digunakan di sini. Bot ini hanya TERIMA bayaran.
 * ==========================================================================*/
import bs58 from 'bs58'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'

const CAIP2_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const CAIP2_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const LAMPORTS = 1000000000
const TTL_CABARAN = 900 // 15 minit

// Simbol yang kita kenal (baki: beri alamat mint penuh).
const SIMBOL: Record<string, string> = {
  sol: SOL_MINT, usdc: USDC_MINT, bonk: BONK_MINT, jup: JUP_MINT
}

/* ============================================================================
 * PLUGIN REGISTRY — satu-satunya tempat untuk mendaftar / menukar servis.
 *
 * MENAMBAH SERVIS BAHARU = tambah SATU entri dalam PLUGIN_LIST di bawah.
 * Semua yang berikut dijana AUTOMATIK dari sini:
 *   - harga dalam cabaran 402 (USDC di Solana + USDC di Base)
 *   - accepts[] x402 v2, deklarasi ekstensi Bazaar, /openapi.json
 *   - /llms.txt, /ai.txt, .well-known/x402.json, halaman /agent, papan pemuka
 * Tiada fail atau tempat lain perlu diubah.
 * ==========================================================================*/

/** Tukar apa-apa nilai kepada teks yang dipangkas (selamat untuk null/undefined). */
const str = (v: any): string => String(v ?? '').trim()

type Plugin = {
  /** Nama servis dalam URL: /api/agent/<id> */
  id: string
  nama: string
  jenis: 'crypto' | 'ai' | 'data'
  desc: string
  /** Harga dalam USD (dibayar sebagai USDC, 6 desimal). */
  harga: number
  /** Contoh input (JSON) untuk paparan & skema. */
  contoh: string
  /**
   * SENARAI SUMBER DATA — dipaparkan kepada pembeli supaya mereka boleh menilai
   * dan mengaudit sendiri. Ini yang membezakan servis kita daripada pembalut API kosong.
   */
  sumber?: string[]
  /** HAD / PERINGATAN tentang hasil. Kejujuran menaikkan nilai, bukan menurunkannya. */
  had?: string[]
  /** Batas aksara input (servis AI). */
  maxInput?: number
  /**
   * Servis AI yang memulangkan JSON BERSTRUKTUR (bukan teks bebas).
   * Menandakannya bermakna jawapan akan dihurai jadi objek untuk pemanggil.
   */
  jsonOutput?: boolean
  /** Bina argumen 'input' dari body JSON atau query string. */
  input: (body: any) => string
  /** Skema JSON input (discovery Bazaar + /openapi.json). */
  skema: () => any
  /** Contoh output (discovery Bazaar). */
  outputContoh: () => any
  /** Pelaksana. Pulangkan TEKS hasil (JSON untuk servis data). */
  jalankan: (env: any, input: string, body?: any) => Promise<string>
  /** Khusus servis AI. */
  ai?: { sistem: string, prompt: (input: string, body: any) => string }
}

/** Skema input standard untuk servis AI. */
const aiSkema = (id?: string): any => {
  const properties: any = { text: { type: 'string', description: 'Teks input' } }
  if (id === 'terjemah') properties.to = { type: 'string', description: 'Sasaran: ms, en, zh, ta' }
  if (id === 'json') properties.skema = { type: 'string', description: 'Bentuk JSON yang dikehendaki' }
  return { type: 'object', properties, required: ['text'], example: { text: 'teks contoh' } }
}

/** Contoh output standard untuk servis AI. */
const aiContoh = (id: string): any => ({ ok: true, servis: id, hasil: 'Teks hasil daripada model AI…' })

/** Pembungkus pelaksana servis AI (prompt + model dikongsi). */
const aiPlugin = (id: string) => (env: any, input: string, body?: any) => aiJalankan(env, id, input, body)

/** Sumber & had yang dikongsi semua servis AI (Workers AI) — supaya konsisten. */
const SUMBER_AI = ['cloudflare-workers-ai (Llama 3.3 70B; sandaran Llama 3.2 3B / Gemma 2 9B)']
const HAD_AI = ['Output model AI boleh tersilap — semak sebelum digunakan.']

/**
 * DAFTAR PLUGIN — susunan di sini menentukan susunan dalam dokumen.
 * Untuk servis baharu: salin satu entri, tukar id/nama/desc/harga/logik.
 */
const PLUGIN_LIST: Plugin[] = [
  {
    id: 'baca-baki',
    nama: 'Baca baki dompet',
    jenis: 'crypto',
    harga: 0.003,
    desc: 'Baca baki SOL (Solana) atau ETH + USDC (Base) untuk satu alamat. Murah dan pantas.',
    sumber: ['solana-rpc', 'base-rpc.publicnode.com'],
    had: ['Hanya menyokong Solana dan Base.'],
    contoh: '{"alamat":"0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD","rangkaian":"base"}',
    input: (b: any) => `${str(b.alamat ?? b.address ?? b.text ?? '')} ${str(b.rangkaian ?? b.network ?? 'solana')}`.trim(),
    skema: () => ({
      type: 'object',
      properties: {
        alamat: { type: 'string', description: 'Alamat dompet (base58 untuk Solana, 0x... untuk Base)' },
        rangkaian: { type: 'string', enum: ['solana', 'base'], description: 'Rangkaian blockchain (lalai: solana)' }
      },
      required: ['alamat'],
      example: { alamat: '0x86fFa64e9693D1bf2804c5Ec2bf63dC0250951aD', rangkaian: 'base' }
    }),
    outputContoh: () => ({ ok: true, servis: 'baca-baki', hasil: { rangkaian: 'base', alamat: '0x...', baki_eth: 0.0, baki_usdc: 0.04 } }),
    jalankan: async (env: any, input: string) => JSON.stringify(await servisBacaBaki(env, input))
  },

  {
    id: 'harga',
    nama: 'Harga token',
    jenis: 'crypto',
    harga: 0.005,
    desc: 'Harga USD, kecairan (liquidity), perubahan 24j dan desimal bagi satu atau lebih token. Input: "token" (simbol atau mint, boleh dipisah koma).',
    sumber: ['jupiter-tokens-v2 (lite-api.jup.ag)'],
    had: ['Data 24j daripada Jupiter; token tanpa pasaran langsung mungkin tiada harga.'],
    contoh: '{"token":"sol,bonk"}',
    input: (b) => str(b.token ?? b.text ?? b.mint ?? 'sol'),
    skema: () => ({
      type: 'object',
      properties: { token: { type: 'string', description: 'Simbol (sol, usdc, bonk, jup) atau alamat mint penuh. Boleh dipisah koma.' } },
      required: ['token'],
      example: { token: 'sol,bonk' }
    }),
    outputContoh: () => ({ ok: true, servis: 'harga', hasil: [{ token: 'SOL', mint: 'So111…112', harga_usd: 103.25, kecairan: 1520000000, perubahan_24j: 1.8, desimal: 9 }] }),
    jalankan: async (env, input) => JSON.stringify(await servisHarga(env, input))
  },
  {
    id: 'quote',
    nama: 'Quote swap',
    jenis: 'crypto',
    harga: 0.01,
    desc: 'Quote pertukaran sebenar dari Jupiter: outAmount, priceImpact, route. Input: "dari", "ke", "jumlah" (unit terkecil, cth lamports).',
    sumber: ['jupiter-swap-v1 (/quote)'],
    had: ['Quote bukan transaksi — harga boleh berubah sebelum dilaksanakan.'],
    contoh: '{"dari":"sol","ke":"usdc","jumlah":100000000}',
    input: (b) => `${str(b.dari ?? b.from ?? 'sol')} ${str(b.ke ?? b.to ?? 'usdc')} ${str(b.jumlah ?? b.amount ?? '100000000')}`,
    skema: () => ({
      type: 'object',
      properties: {
        dari: { type: 'string', description: 'Mint/simbol input (cth sol)' },
        ke: { type: 'string', description: 'Mint/simbol output (cth usdc)' },
        jumlah: { type: 'integer', description: 'Jumlah dalam unit terkecil (cth lamports)' }
      },
      required: ['dari', 'ke', 'jumlah'],
      example: { dari: 'sol', ke: 'usdc', jumlah: 100000000 }
    }),
    outputContoh: () => ({ ok: true, servis: 'quote', hasil: { inputMint: 'So111…112', outputMint: 'EPjF…t1v', inAmount: '100000000', outAmount: '103120000', priceImpactPct: '0.0004', slippageBps: 50 } }),
    jalankan: async (env, input) => JSON.stringify(await servisQuote(env, input))
  },
  {
    id: 'risiko',
    nama: 'Semak risiko token',
    jenis: 'crypto',
    harga: 0.02,
    desc: 'Mint authority, freeze authority, supply, desimal, kecairan & umur token — dengan syor risiko. Input: "token".',
    sumber: ['solana-rpc (getAccountInfo)', 'jupiter-tokens-v2'],
    had: ['Tidak menguji honeypot atau kebolehan jual — guna "saring-token" untuk itu.'],
    contoh: '{"token":"bonk"}',
    input: (b) => str(b.token ?? b.text ?? b.mint ?? 'sol'),
    skema: () => ({
      type: 'object',
      properties: { token: { type: 'string', description: 'Simbol atau alamat mint penuh.' } },
      required: ['token'],
      example: { token: 'bonk' }
    }),
    outputContoh: () => ({ ok: true, servis: 'risiko', hasil: { mint: 'DezX…B263', mint_authority: null, freeze_authority: null, kecairan_usd: 42000000, umur_hari: 900, skor: 'rendah', nota: 'Tiada authority, kecairan sihat.' } }),
    jalankan: async (env, input) => JSON.stringify(await servisRisiko(env, input))
  },
  {
    id: 'peluang',
    nama: 'Cari peluang arbitraj',
    jenis: 'crypto',
    harga: 0.02,
    desc: 'Imbas berbilang saiz + laluan (2-leg dan 3-leg) di Jupiter, pulangkan peluang terbaik dengan untung bersih selepas fi. Data di-cache 30s.',
    sumber: ['jupiter-swap-v1 (berbilang saiz & laluan)'],
    had: ['Untung dikira selepas fi sahaja — slippage sebenar dan latensi boleh menghapuskannya.'],
    contoh: '{}',
    input: () => '',
    skema: () => ({ type: 'object', properties: {} }),
    outputContoh: () => ({ ok: true, servis: 'peluang', hasil: { masa: '2026-10-18T06:00:00Z', peluang: [{ laluan: ['SOL', 'USDC', 'BONK', 'SOL'], untung_pct: 0.12, saiz_sol: 0.05, nota: 'selepas fi' }] } }),
    jalankan: async (env) => JSON.stringify(await servisPeluang(env))
  },
  {
    id: 'trending',
    nama: 'Token trending',
    jenis: 'data',
    harga: 0.005,
    desc: 'Senarai token Solana paling panas (skor organik Jupiter) atau paling baharu. Setiap token: harga, kecairan, mcap, perubahan 24j, bilangan pemegang, umur, tag. Pilihan: "tempoh" (5m|1h|6h|24h), "had" (1-50), "jenis" (organik|baharu).',
    sumber: ['jupiter-tokens-v2 (skor organik & token terbaharu)'],
    had: ['"organik" ialah penilaian Jupiter, bukan bukti bebas.'],
    contoh: '{"tempoh":"24h","had":10,"jenis":"organik"}',
    input: (b) => {
      const j = str(b.jenis).toLowerCase() === 'baharu' ? 'baharu' : 'organik'
      const t = ['5m', '1h', '6h', '24h'].includes(str(b.tempoh)) ? str(b.tempoh) : '24h'
      const h = Math.min(Math.max(parseInt(str(b.had) || '10', 10) || 10, 1), 50)
      return j + '|' + t + '|' + h
    },
    skema: () => ({
      type: 'object',
      properties: {
        tempoh: { type: 'string', description: 'Tempoh untuk jenis organik', enum: ['5m', '1h', '6h', '24h'] },
        had: { type: 'integer', description: 'Bilangan token (1-50), lalai 10' },
        jenis: { type: 'string', description: 'organik (skor organik Jupiter) atau baharu (token terbaru)', enum: ['organik', 'baharu'] }
      },
      example: { tempoh: '24h', had: 10, jenis: 'organik' }
    }),
    outputContoh: () => ({ ok: true, servis: 'trending', hasil: { sumber: 'jupiter-tokens-v2', jenis: 'organik', tempoh: '24h', masa: '2026-10-18T06:00:00Z', token: [{ pangkat: 1, simbol: 'SOL', nama: 'Wrapped SOL', mint: 'So111…112', harga_usd: 103.25, kecairan_usd: 927000000, mcap_usd: 58000000000, perubahan_24j_pct: -1.2, bilangan_pemegang: 1200000, skor_organik: 98.5, label_organik: 'high', disahkan: true, umur_hari: 1600, tag: [] }] } }),
    jalankan: async (env, input) => JSON.stringify(await servisTrending(env, input))
  },
  {
    id: 'periksa-dompet',
    nama: 'Periksa dompet',
    jenis: 'data',
    harga: 0.02,
    desc: 'Semak dompet Solana: wujud, baki SOL, jenis akaun, program pemilik, bilangan & masa aktiviti, dengan amaran risiko. Untuk bot mengesahkan pengguna sebelum transaksi. Input: "dompet".',
    sumber: ['solana-rpc (getAccountInfo, getSignaturesForAddress, getBalance)'],
    had: ['Berdasarkan sehingga 50 transaksi terakhir sahaja.', 'Bukan analisis forensik — dompet baharu tidak semestinya berisiko.'],
    contoh: '{"dompet":"3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E"}',
    input: (b) => str(b.dompet ?? b.wallet ?? b.address ?? b.text),
    skema: () => ({
      type: 'object',
      properties: { dompet: { type: 'string', description: 'Alamat dompet Solana (base58)' } },
      required: ['dompet'],
      example: { dompet: '3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E' }
    }),
    outputContoh: () => ({ ok: true, servis: 'periksa-dompet', hasil: { dompet: '3mqW…tk4E', wujud: true, baki_sol: 0.0081, jenis_akaun: 'dompet sistem', program_pemilik: '11111111111111111111111111111111', boleh_laksana: false, saiz_data_bait: 0, tx_dalam_sampel: 12, ada_tx_lebih_lama: false, aktiviti_terkini: '2026-10-18T07:40:00.000Z', aktiviti_terawal_dalam_sampel: '2026-10-18T06:10:00.000Z', amaran: ['Dompet baharu'], nota: 'Berdasarkan sehingga 50 transaksi terakhir sahaja.' } }),
    jalankan: async (env, input) => JSON.stringify(await servisDompet(env, input))
  },
  {
    id: 'kikis-web',
    nama: 'Kikis laman web',
    jenis: 'data',
    harga: 0.02,
    desc: 'Ambil URL dan pulangkan kandungannya sebagai Markdown bersih (buang menu, skrip, iklan) — jimat token untuk agen AI. Input: "url", pilihan "had" (bilangan aksara, 500-40000).',
    sumber: ['fetch terus URL awam (HTML)'],
    had: ['Halaman ber-JS (SPA) mungkin tidak lengkap.', 'Halaman yang menyekat bot boleh gagal.'],
    contoh: '{"url":"https://example.com","had":12000}',
    input: (b) => str(b.url ?? b.text),
    skema: () => ({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL penuh bermula dengan http:// atau https://' },
        had: { type: 'integer', description: 'Had aksara Markdown (500-40000), lalai 12000' }
      },
      required: ['url'],
      example: { url: 'https://example.com', had: 12000 }
    }),
    outputContoh: () => ({ ok: true, servis: 'kikis-web', hasil: { url: 'https://example.com/', tajuk: 'Example Domain', markdown: '# Example Domain\n\nThis domain is for use in illustrative examples.', panjang: 58, panjang_asal: 58, dipotong: false } }),
    jalankan: async (env, input, body) => JSON.stringify(await servisKikis(env, input, body))
  },
  {
    id: 'ringkas',
    nama: 'Ringkas teks',
    jenis: 'ai',
    harga: 0.005,
    maxInput: 6000,
    desc: 'Ringkaskan teks panjang jadi poin padat. Input: "text".',
    sumber: SUMBER_AI,
    had: HAD_AI,
    contoh: '{"text":"..."}',
    input: (b) => str(b.text ?? b.input ?? b.prompt ?? b.q),
    skema: () => aiSkema(),
    outputContoh: () => aiContoh('ringkas'),
    ai: {
      sistem: 'Anda editor profesional. Ringkaskan teks yang diberi kepada poin utama yang padat dan tepat. Jangan tambah maklumat baharu. Jawab dengan ringkasan sahaja, tiada mukadimah.',
      prompt: (input) => input
    },
    jalankan: aiPlugin('ringkas')
  },
  {
    id: 'terjemah',
    nama: 'Terjemah',
    jenis: 'ai',
    harga: 0.005,
    maxInput: 4000,
    desc: 'Terjemah teks. Sasaran melalui "to" (ms|en|zh|ta). Input: "text".',
    sumber: SUMBER_AI,
    had: HAD_AI,
    contoh: '{"text":"...","to":"en"}',
    input: (b) => str(b.text ?? b.input ?? b.prompt ?? b.q),
    skema: () => aiSkema('terjemah'),
    outputContoh: () => aiContoh('terjemah'),
    ai: {
      sistem: 'Anda penterjemah profesional. Terjemah dengan tepat dan semula jadi, kekalkan maksud dan nada. Jawab dengan terjemahan sahaja, tiada nota atau mukadimah.',
      prompt: (input, body) => {
        const to = str(body?.to).toLowerCase().slice(0, 8)
        return 'Terjemah ke ' + (to || 'Bahasa Melayu jika teks bukan Melayu; Inggeris jika teks Melayu') + ':\n\n' + input
      }
    },
    jalankan: aiPlugin('terjemah')
  },
  {
    id: 'tulis',
    nama: 'Tulis kandungan',
    jenis: 'ai',
    harga: 0.01,
    maxInput: 2000,
    desc: 'Jana kandungan: kapsyen, penerangan produk, emel, idea. Arahan dalam "text".',
    sumber: SUMBER_AI,
    had: HAD_AI,
    contoh: '{"text":"Iklan kafe di Kajang"}',
    input: (b) => str(b.text ?? b.input ?? b.prompt ?? b.q),
    skema: () => aiSkema(),
    outputContoh: () => aiContoh('tulis'),
    ai: {
      sistem: 'Anda copywriter berpengalaman untuk pasaran Malaysia. Hasilkan kandungan yang jelas, menarik dan boleh terus digunakan. Jawab dengan kandungan sahaja.',
      prompt: (input) => input
    },
    jalankan: aiPlugin('tulis')
  },
  {
    id: 'json',
    nama: 'Ekstrak JSON',
    jenis: 'ai',
    harga: 0.005,
    maxInput: 6000,
    desc: 'Tukar teks tidak berstruktur jadi JSON sah. Bentuk melalui "skema". Input: "text".',
    sumber: SUMBER_AI,
    had: [...HAD_AI, 'JSON boleh gagal dihurai jika model menyimpang — klien patut tangani ralat hurai.'],
    contoh: '{"text":"...","skema":"{nama,harga}"}',
    input: (b) => str(b.text ?? b.input ?? b.prompt ?? b.q),
    skema: () => aiSkema('json'),
    outputContoh: () => aiContoh('json'),
    ai: {
      sistem: 'Anda pengekstrak data. Pulangkan JSON SAHAJA — tiada kod fence, tiada penjelasan. Guna null bila maklumat tiada.',
      prompt: (input, body) => {
        const skema = str(body?.skema ?? body?.schema).slice(0, 800)
        return (skema ? 'Bentuk JSON yang dikehendaki: ' + skema + '\n\n' : '') + 'Teks:\n' + input
      }
    },
    jalankan: aiPlugin('json')
  },
  {
    id: 'saring-token',
    nama: 'Saringan keselamatan token',
    jenis: 'crypto',
    harga: 0.02,
    desc: 'Saringan keselamatan PENUH satu token dalam SATU panggilan: kuasa mint/freeze, tumpuan pemegang teratas, ujian JUAL (kesan honeypot), kedalaman kecairan pada 5 saiz, saiz urus niaga selamat, dan keputusan risiko 0-100 dengan sebab. Input: "token" (simbol atau mint), pilihan "saiz_usd".',
    sumber: [
      'jupiter-tokens-v2 (metadata, pemegang, skor organik)',
      'jupiter-swap-v1 (ujian beli/jual + kedalaman 5 saiz)',
      'solana-rpc (sandaran getAccountInfo)',
      'rugcheck.xyz /report/summary (sumber kedua BEBAS: risiko, LP terkunci %)'
    ],
    had: [
      'Saringan automatik daripada data awam — bukan nasihat pelaburan.',
      'Pasaran bergerak: keputusan sah pada masa panggilan sahaja.',
      'Ujian jual guna saiz kecil; tingkah laku pada saiz besar boleh berbeza.'
    ],
    contoh: '{"token":"bonk","saiz_usd":100}',
    input: (b) => str(b.token ?? b.mint ?? b.text ?? 'bonk'),
    skema: () => ({
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Simbol (sol, usdc, bonk, jup) atau alamat mint penuh.' },
        saiz_usd: { type: 'integer', description: 'Saiz ujian jual dalam USD (10-5000, lalai 100).' }
      },
      required: ['token'],
      example: { token: 'bonk', saiz_usd: 100 }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'saring-token',
      hasil: {
        mint: 'DezX…B263', simbol: 'Bonk', nama: 'Bonk',
        keputusan: 'selamat', skor_risiko: 3,
        skor: { jupiter: 0, rugcheck: 7, gabungan: 3, kaedah: '0.6 × jupiter + 0.4 × rugcheck' },
        kesepakatan: 'sepadan',
        sumber_luar: {
          rugcheck: {
            skor_normal: 7,
            lp_terkunci_pct: 16.3,
            risiko: [{ nama: 'Mutable metadata', tahap: 'warn', keterangan: 'Token metadata can be changed by the owner' }],
            sumber: 'rugcheck.xyz /tokens/{mint}/report/summary'
          }
        },
        sebab: ['[RugCheck] Mutable metadata'],
        kekuatan: ['kuasa cetak (mint authority) sudah dilumpuhkan', '1026331 pemegang', 'kecairan kukuh ($6212655)'],
        asas: { harga_usd: 0.00000294, kecairan_usd: 6212655, mcap_usd: 259110648, umur_hari: 863, desimal: 5, bilangan_pemegang: 1026331 },
        kuasa: { mint_authority_aktif: false, freeze_authority_aktif: false },
        tumpuan: { top10_peratus: 30.33, dev_peratus: 0.00000017, dev_melancarkan_token: 10 },
        kualiti_pasaran: { skor_organik: 82.58, label_organik: 'high', disahkan: true, tag: ['verified', 'community'] },
        kedalaman_kecairan: [{ saiz_usd: 100, price_impact_pct: 0.001 }, { saiz_usd: 10000, price_impact_pct: 0.0107 }],
        saiz_urus_niaga_selamat_usd: 10000,
        ujian_jual: { status: 'NORMAL', saiz_ujian_usd: 100, susut_pulang_balik_pct: 0.14 },
        nota: 'Saringan automatik daripada DUA sumber awam bebas (Jupiter + RugCheck). Bukan nasihat pelaburan.'
      }
    }),
    jalankan: async (env, input, body) =>
      JSON.stringify(await servisSaring(env, input, Math.min(Math.max(Math.round(Number(body?.saiz_usd) || 100), 10), 5000)))
  },
  {
    id: 'banding-token',
    nama: 'Banding token',
    jenis: 'crypto',
    harga: 0.01,
    desc: 'Banding 2 hingga 5 token Solana bersebelahan — harga, kecairan, mcap, perubahan 24j, pemegang, skor organik — serta pemenang setiap metrik. Satu panggilan ganti lima. Input: "token" (dipisah koma).',
    sumber: ['jupiter-tokens-v2 (search, satu panggilan setiap token)'],
    had: ['Pemenang dikira daripada medan yang ADA sahaja; token baharu mungkin tiada data 24j.', 'Perbandingan bergerak dengan pasaran — sah pada masa panggilan.'],
    contoh: '{"token":"sol,bonk,jup"}',
    input: (b) => str(b.token ?? b.tokens ?? b.text ?? 'sol,bonk,jup'),
    skema: () => ({
      type: 'object',
      properties: { token: { type: 'string', description: '2 hingga 5 simbol atau mint, dipisah koma (cth: sol,bonk,jup)' } },
      required: ['token'],
      example: { token: 'sol,bonk,jup' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'banding-token',
      hasil: {
        bilangan: 3,
        token: [
          { pangkat: 1, simbol: 'SOL', harga_usd: 103.2, kecairan_usd: 1520000000, mcap_usd: 56000000000, perubahan_24j_pct: 1.8, bilangan_pemegang: 2100000, skor_organik: 95 },
          { pangkat: 2, simbol: 'Bonk', harga_usd: 0.00000288, kecairan_usd: 6191426, mcap_usd: 253954399, perubahan_24j_pct: -2.9, bilangan_pemegang: 1026498, skor_organik: 82.8 }
        ],
        pemenang: { kecairan_tertinggi: 'SOL', pemegang_terbanyak: 'SOL', skor_organik_tertinggi: 'SOL', naik_24j_tertinggi: 'SOL', turun_24j_paling_banyak: 'Bonk' }
      }
    }),
    jalankan: async (env, input) => JSON.stringify(await servisBanding(env, input))
  },
  {
    id: 'tokens-baharu',
    nama: 'Token muda ditapis',
    jenis: 'crypto',
    harga: 0.01,
    desc: 'Token Solana MUDA yang sudah ada daya tarikan dan LULUS saringan keselamatan: kuasa cetak & beku mesti dilumpuhkan, bekalan pembangun kecil, kecairan/pemegang/tumpuan 10 teratas melepasi had anda. Mod "baharu" memberi pelancaran terkini dengan saringan audit sahaja (kecairan belum diindeks — dinyatakan jujur).',
    sumber: ['jupiter-tokens-v2 (toporganicscore/24h — token muda dengan dagangan sebenar)', 'jupiter-tokens-v2 (recent + search — mod "baharu")'],
    had: [
      'Risiko token muda tetap SANGAT tinggi walaupun lulus tapisan.',
      'Kecairan boleh ditarik dalam beberapa minit — sahkan semula sebelum urus niaga.',
      'Mod "baharu" tidak menapis kecairan (data belum diindeks); lihat medan data_pasaran_lengkap.'
    ],
    contoh: '{"jenis":"organik","had":10,"maks_umur_hari":7,"min_kecairan_usd":5000,"min_pemegang":25}',
    input: (b) => `${str(b.jenis ?? 'organik')}|${str(b.had ?? '10')}|${str(b.min_kecairan_usd ?? '5000')}|${str(b.min_pemegang ?? '25')}|${str(b.top10_maks_peratus ?? '70')}|${str(b.maks_umur_hari ?? '7')}`,
    skema: () => ({
      type: 'object',
      properties: {
        jenis: { type: 'string', description: '"organik" (lalai, token muda dengan dagangan + tapisan penuh) atau "baharu" (pelancaran terkini, audit sahaja)' },
        had: { type: 'integer', description: 'Bilangan token untuk dipulangkan (1-25), lalai 10' },
        min_kecairan_usd: { type: 'integer', description: 'Kecairan minimum dalam USD, lalai 5000' },
        min_pemegang: { type: 'integer', description: 'Bilangan pemegang minimum, lalai 25' },
        top10_maks_peratus: { type: 'integer', description: 'Had peratus pegangan 10 pemegang teratas (10-100), lalai 70' },
        maks_umur_hari: { type: 'integer', description: 'Umur maksimum token dalam hari, lalai 7 (mod organik sahaja)' }
      },
      example: { jenis: 'organik', had: 10, maks_umur_hari: 7, min_kecairan_usd: 5000, min_pemegang: 25 }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'tokens-baharu',
      hasil: {
        jenis: 'organik',
        tapisan: { kuasa_cetak_dan_beku_mesti_dilumpuhkan: true, pembangun_maks_peratus: 5, maks_umur_hari: 7, min_kecairan_usd: 5000, min_pemegang: 25, top10_maks_peratus: 70 },
        dipindai: 50, lulus: 11,
        token: [{ pangkat: 1, simbol: 'FTR', mint: 'AbC…xY', umur_hari: 3, harga_usd: 0.0012, kecairan_usd: 509189, perubahan_24j_pct: 42.1, bilangan_pemegang: 17594, skor_organik: 87, audit: { kuasa_cetak_dilumpuhkan: true, kuasa_beku_dilumpuhkan: true }, tumpuan: { top10_peratus: 14.0, pembangun_peratus: 0.2 }, data_pasaran_lengkap: true }],
        ditolak_contoh: [{ simbol: 'SCAM', mint: '4pQ…2m', sebab: ['kuasa cetak (mint authority) masih aktif'] }]
      }
    }),
    jalankan: async (env, input) => JSON.stringify(await servisTokensBaharu(env, input))
  },
  {
    id: 'kikis-ringkas',
    nama: 'Kikis web + ringkas',
    jenis: 'data',
    harga: 0.02,
    desc: 'Ambil URL, tukar jadi Markdown bersih, DAN ringkaskan dengan AI dalam SATU panggilan. Input: "url", pilihan "arahan" (apa yang hendak difokuskan) dan "had" (bilangan aksara).',
    sumber: ['fetch terus URL awam (HTML)', 'cloudflare-workers-ai (ringkasan)'],
    had: ['Halaman ber-JS (SPA) mungkin tidak lengkap.', 'Ringkasan terhad kepada 12,000 aksara pertama Markdown.'],
    contoh: '{"url":"https://example.com","arahan":"Apakah tawaran utama halaman ini?"}',
    input: (b) => str(b.url ?? b.text),
    skema: () => ({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL penuh bermula dengan http:// atau https://' },
        arahan: { type: 'string', description: 'Apa yang hendak difokuskan dalam ringkasan (pilihan)' },
        had: { type: 'integer', description: 'Had aksara Markdown sebelum diringkaskan (500-40000), lalai 12000' }
      },
      required: ['url'],
      example: { url: 'https://example.com', arahan: 'Apakah tawaran utama halaman ini?' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'kikis-ringkas',
      hasil: {
        url: 'https://example.com/', tajuk: 'Example Domain',
        arahan: 'Apakah tawaran utama halaman ini?',
        ringkasan: '• Halaman contoh untuk penggunaan dalam dokumen.\n• Tiada tawaran komersial; hanya penerangan domain contoh.',
        markdown: '# Example Domain\n\nThis domain is for use in illustrative examples.',
        panjang: 58, dipotong: false
      }
    }),
    jalankan: async (env, input, body) => JSON.stringify(await servisKikisRingkas(env, input, body))
  },
  {
    id: 'sentimen',
    nama: 'Analisis sentimen',
    jenis: 'ai',
    harga: 0.02,
    maxInput: 6000,
    jsonOutput: true,
    desc: 'Analisis sentimen teks/ulasan/berita: positif, neutral atau negatif dengan skor -1 hingga 1, keyakinan, emosi dan sebab. Pulangan BERSTRUKTUR (objek), bukan teks bebas. Input: "text".',
    sumber: SUMBER_AI,
    had: [...HAD_AI, 'Skor ialah penilaian model, bukan ukuran pasaran.'],
    contoh: '{"text":"Produk ini memang berbaloi, penghantaran pantas!"}',
    input: (b) => str(b.text ?? b.input ?? b.prompt ?? b.q),
    skema: () => aiSkema(),
    outputContoh: () => ({
      ok: true,
      servis: 'sentimen',
      hasil: { sentimen: 'positif', skor: 0.82, keyakinan: 0.9, emosi: ['gembira', 'puas hati'], sebab: ['memuji nilai produk', 'memuji kepantasan penghantaran'], panjang_teks: 48 }
    }),
    jalankan: async (env, input) => JSON.stringify(await servisSentimen(env, input))
  },
  {
    id: 'yuran-rangkaian',
    nama: 'Yuran rangkaian Solana',
    jenis: 'crypto',
    harga: 0.005,
    desc: 'Yuran rangkaian Solana semasa: taburan tip keutamaan (minimum, median, p75, p90, maksimum) dan anggaran kos satu urus niaga 200,000 unit pengiraan, berserta TPS rangkaian. Input pilihan: "akaun" (alamat boleh-tulis dipisah koma, maks 5) untuk anggaran tepat.',
    sumber: ['solana-rpc (getRecentPrioritizationFees, getRecentPerformanceSamples)'],
    had: [
      'Tip keutamaan BERBEZA mengikut akaun — tanpa "akaun", angka kita ialah rujukan dua akaun paling sibuk sahaja.',
      'Anggaran untuk rujukan; kos sebenar bergantung pada unit pengiraan urus niaga anda.',
      'Tip keutamaan berubah setiap slot (~400ms).'
    ],
    contoh: '{"akaun":"So11111111111111111111111111111111111111112"}',
    input: (b) => str(b.akaun ?? b.accounts ?? b.text ?? ''),
    skema: () => ({
      type: 'object',
      properties: {
        akaun: { type: 'string', description: 'Alamat akaun boleh-tulis dalam urus niaga anda, dipisah koma (maks 5). Kosong = guna SOL & USDC sebagai rujukan.' }
      },
      example: { akaun: 'So11111111111111111111111111111111111111112' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'yuran-rangkaian',
      hasil: {
        akaun_disampel: ['So11111111111111111111111111111111111111112'],
        akaun_lalai: false,
        yuran_asas_lamports_setiap_tandatangan: 5000,
        keutamaan_mikro_lamport_setiap_unit: { minimum: 0, median: 1000, p75: 7000, p90: 79790, maksimum: 2760538, bilangan_sampel: 150 },
        contoh_anggaran_200k_unit_pengiraan: { lamports_yuran_asas: 5000, lamports_tip_pada_median: 200, jumlah_lamports: 5200, jumlah_sol: 0.0000052, jumlah_usd: 0.0009 },
        tps_rangkaian_anggaran: 4873
      }
    }),
    jalankan: async (env, input) => JSON.stringify(await servisYuran(env, input))
  },
  {
    id: 'fx-kadar',
    nama: 'Kadar FX semasa',
    jenis: 'data',
    harga: 0.005,
    desc: 'Kadar pertukaran matawang semasa (open.er-api.com; sandaran ECB Frankfurter). Merangkumi MYR. Input: "dari" (kod asas) + "ke" (sasaran dipisah koma).',
    sumber: ['currency-api (fawazahmed0) via jsdelivr', 'open.er-api.com — sandaran', 'frankfurter.app (ECB) — sandaran'],
    had: [
      'Kadar rujukan pasaran — bank pertukaran menambah spread sendiri.',
      'Kod matawang tidak sah dipulangkan sebagai null.'
    ],
    contoh: '{"dari":"usd","ke":"myr,sgd,eur"}',
    input: (b) => str(b.dari ?? b.from ?? b.matawang ?? b.text ?? b.token ?? 'usd'),
    skema: () => ({
      type: 'object',
      properties: {
        dari: { type: 'string', description: 'Matawang asas, kod 3 huruf (cth usd). Boleh sertakan sasaran dalam ayat: "usd myr sgd".' },
        ke: { type: 'string', description: 'Sasaran kod 3 huruf, dipisah koma (maks 6). Kosong = eur,gbp,sgd,idr.' }
      },
      required: ['dari'],
      example: { dari: 'usd', ke: 'myr,sgd,eur' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'fx-kadar',
      hasil: { sumber: 'open.er-api.com', diemas: 'Sat, 18 Oct 2026 00:02:01 +0000', asas: 'USD', kadar: { MYR: 4.2, SGD: 1.28, EUR: 0.86 }, nota: 'Nilai kadar untuk 1 USD…' }
    }),
    jalankan: async (env, input, body) => JSON.stringify(await servisFx(env, input, body))
  },
  {
    id: 'util-kotak',
    nama: 'Kotak alat utiliti',
    jenis: 'data',
    harga: 0.005,
    desc: 'Utiliti deterministik untuk agent: base64 encode/decode, hash SHA-256 (hex), UUID v4, waktu semasa (unix + ISO UTC), cuti awam (maks 20, 100+ negara). Input: "op" + "text" (atau tahun/negara untuk cuti).',
    sumber: ['berjalan (crypto.subtle, deterministik)', 'date.nager.at (cuti)'],
    had: ['SHA-256 satu hala — tak boleh dibalik.', 'Nama cuti dalam bahasa tempatan dari sumber.', 'Output deterministik + cacheable (selamat berbilang kali).'],
    contoh: '{"op":"sha256","text":"hello"}',
    input: (b) => str(b.op ?? b.text ?? b.input ?? b.prompt ?? ''),
    skema: () => ({
      type: 'object',
      properties: {
        op: { type: 'string', description: 'encode64 | decode64 | sha256 | uuid | masa | cuti' },
        text: { type: 'string', description: 'Teks untuk encode64/decode64/sha256' },
        tahun: { type: 'integer', description: 'Tahun cuti (lalai tahun semasa)' },
        negara: { type: 'string', description: 'Kod negara ISO 2 (cth MY, US, ID, SG; lalai MY)' }
      },
      required: ['op'],
      example: { op: 'sha256', text: 'hello' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'util-kotak',
      hasil: { op: 'sha256', panjang_masukan: 5, sha256_hex: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', sha256_bait: 32 }
    }),
    jalankan: async (env, input, body) => JSON.stringify(await servisUtil(env, input, body))
  },
  {
    id: 'yield-defi',
    nama: 'Yield DeFi terbaik',
    jenis: 'data',
    harga: 0.01,
    desc: 'Pool DeFi APY tertinggi merentas semua rangkaian (DefiLlama): disungi TVL ≥ $10 juta, disusun APY. Pilihan: "jumlah" (1-10, lalai 5), "stabil" = hanya pool stablecoin. Cache 10 minit.',
    sumber: ['defillama-yields (yields.llama.fi)'],
    had: [
      'APY pasaran berubah setiap hari; bonus rewards sering tidak malar.',
      'TVL disungi ≥ $10 juta untuk elak pool kecil dengan APY membingungkan.'
    ],
    contoh: '{"jumlah":5}',
    input: (b) => str(b.jumlah ?? b.n ?? b.text ?? b.input ?? '5'),
    skema: () => ({
      type: 'object',
      properties: {
        jumlah: { type: 'integer', description: 'Bilangan pool (1-10, lalai 5)' },
        stabil: { type: 'boolean', description: 'Hanya pool stablecoin (cth Aave, Compound)' }
      },
      example: { jumlah: 5, stabil: false }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'yield-defi',
      hasil: { sumber: 'defillama-yields', disungi_tvl_usd: 10000000, jumlah_diminta: 2, tapis_stabil: false, hasil: [{ projek: 'Pendle', simpbol: 'USDe/Ethena PT', rangkaian: 'Ethereum', apy_peratus: 15.4, apy_asas_peratus: 15.4, apy_bonus_peratus: null, tvl_usd: 210000000, stabil: true }, { projek: 'Aave', simpbol: 'ABUSD-C', rangkaian: 'Polygon', apy_peratus: 8.1, apy_asas_peratus: 6.2, apy_bonus_peratus: 1.9, tvl_usd: 560000000, stabil: true }] }
    }),
    jalankan: async (env, input, body) => JSON.stringify(await servisYield(env, input, body))
  },
  {
    id: 'imbas-kontrak',
    nama: 'Imbas kontrak (Base)',
    jenis: 'data',
    harga: 0.02,
    desc: 'Pengimbasan heuristik kontrak ERC-20 di Base: kod kontrak, nama/simbol/desimal/bekalan, proxy upgradeable (EIP-1967), dan selector berisiko (mint, renounceOwnership, blacklist). Input: "token" (alamat 0x…).',
    sumber: ['Base RPC awam (publicnode, mainnet.base.org, llamarpc, blastapi) — failover', 'crypto.subtle / penguraian hex berjalan'],
    had: [
      'Heuristik statik — bukan audit keselamatan penuh; simulasi jual-beli honeypot tidak dilakukan.',
      'Kegagalan semua RPC awam pulangkan ralat; RPC awam boleh throttle pada masa sibuk.',
      'Alamat bukan EVM (Solana) tak disokong — guna servis "risiko".'
    ],
    contoh: '{"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}',
    input: (b) => str(b.token ?? b.kontrak ?? b.alamat ?? b.text ?? ''),
    skema: () => ({
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Alamat kontrak di Base (cth USDC base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)' }
      },
      required: ['token'],
      example: { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'imbas-kontrak',
      hasil: { rangkaian: 'Base', alamat: '0x…', kontrak: true, saiz_kod_bait: 21519, erc20: { nama: 'USD Coin', simbol: 'USDC', desimal: 6, bekalan: { raw: '999…', paparan: '9991234.56' } }, proxy_upgradeable: false, selector_dikesan: { mint_std: false, renounce_own: true, blacklist: false }, rumusan_risiko: [], nota: 'Heuristik statik — bukan audit.' }
    }),
    jalankan: async (env, input, body) => JSON.stringify(await servisKontrak(env, input, body))
  },
  {
    id: 'kadar-gas',
    nama: 'Kadar gas rantai-tetamu',
    jenis: 'data',
    harga: 0.005,
    desc: 'Gas live (eth_gasPrice) untuk Ethereum, Base, Arbitrum, Optimism + tip keutamaan Solana (RPC awam percuma). Termasuk anggaran USD untuk transfer standard (21k gas). Input pilihan: "rangkaian" (cth base / sol / ethereum).',
    sumber: ['RPC awam publicnode.com (EVM)', 'api.mainnet-beta.solana.com (tip keutamaan)', 'coinbase spot (harga ETH-USD untuk anggaran)'],
    had: [
      'Nilai eth_gasPrice adalah kadar sekejap — boleh berubah panas dalam 1 blok.',
      'Anggaran USD guna harga ETH spot Coinbase; EIP-1559: patut tambah yuran asas +/- 20%.'
    ],
    contoh: '{"rangkaian":"base"}',
    input: (b) => str(b.rangkaian ?? b.chain ?? b.text ?? ''),
    skema: () => ({
      type: 'object',
      properties: {
        rangkaian: { type: 'string', description: 'Pilihan: base | ethereum | arbitrum | optimism | solana | kosong = semua' }
      },
      example: { rangkaian: 'base' }
    }),
    outputContoh: () => ({
      ok: true,
      servis: 'kadar-gas',
      hasil: { rangkaian: { base: { gwei: 0.0156, anggaran_usd_transfer_21k: 0.001112 } }, solana: { tip_keutamaan_median_mikrolamport: 2000, yuran_asas_flatten_lamport: 5000 } }
    }),
    jalankan: async (env, input, body) => JSON.stringify(await servisGas(env, input, body))
  }
]

/** Peta pantas id → plugin. */
const PLUGIN: Record<string, Plugin> = Object.fromEntries(PLUGIN_LIST.map((p) => [p.id, p] as [string, Plugin]))

const HARGA_LALAI: Record<string, number> = Object.fromEntries(PLUGIN_LIST.map((p) => [p.id, p.harga] as [string, number]))

/** Metadata paparan servis — DIJANA dari PLUGIN_LIST (jangan edit di sini). */
const SERVIS: Record<string, { nama: string, desc: string, jenis: 'crypto' | 'ai' | 'data', contoh: string, maxInput?: number }> =
  Object.fromEntries(PLUGIN_LIST.map((p) => [p.id, { nama: p.nama, desc: p.desc, jenis: p.jenis, contoh: p.contoh, maxInput: p.maxInput }] as [string, any]))

/** Prompt sistem servis AI — DIJANA dari PLUGIN_LIST (jangan edit di sini). */
const PROMPT_AI: Record<string, string> = Object.fromEntries(PLUGIN_LIST.filter((p) => p.ai).map((p) => [p.id, String(p.ai?.sistem || '')] as [string, string]))

const AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/google/gemma-2-9b-it',
  '@cf/meta/llama-3-8b-instruct'
]

// ---------------------------------------------------------------- utiliti

function b64(str: string): string {
  const bytes = new TextEncoder().encode(String(str))
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function unb64(s: string): string {
  const bin = atob(String(s))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function rndHex(n = 16): string {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

function rndRef(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return bs58.encode(b)
}

const tunggu = (ms: number) => new Promise((r) => setTimeout(r, ms))

function db(env: any): any {
  return env?.DB_INCOME || env?.DB || null
}

function wallet(env: any): string {
  return String(env?.AGENT_WALLET || env?.WALLET_ADDRESS || '').trim()
}

function devnet(env: any): boolean {
  return String(env?.SOL_NETWORK || 'mainnet').toLowerCase().includes('devnet')
}

function caip2(env: any): string {
  return devnet(env) ? CAIP2_DEVNET : CAIP2_MAINNET
}

function usdcMint(env: any): string {
  if (devnet(env)) return String(env?.USDC_DEVNET_MINT || USDC_DEVNET).trim()
  return USDC_MINT
}

// ---- x402 standard (v2) ----------------------------------------------------

/** USDC asli di Base (eip155:8453). */
const EVM_USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Dompet EVM penerima (Base). Kosong = aset EVM tidak ditawarkan. */
function evmWallet(env: any): string {
  return String(env?.AGENT_EVM_WALLET || '').trim()
}

/** Fasilitator: sahkan & selesaikan bayaran standard (kita tak perlu kunci). */
function facilitator(env: any): string {
  return String(env?.X402_FACILITATOR || 'https://facilitator.payai.network').trim().replace(/\/+$/, '')
}

/** feePayer fasilitator Solana — WAJIB dalam extra (klien guna untuk bina transaksi). */
function solFeePayer(env: any): string {
  return String(env?.SOLANA_FEE_PAYER || 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww').trim()
}

function rpcUrls(env: any): string[] {
  const senarai: string[] = []
  if (env?.SOLANA_RPC) senarai.push(String(env.SOLANA_RPC).trim())
  if (env?.SOL_RPC) senarai.push(String(env.SOL_RPC).trim())
  senarai.push(devnet(env) ? 'https://api.devnet.solana.com' : 'https://solana-rpc.publicnode.com')
  if (!devnet(env)) senarai.push('https://api.mainnet-beta.solana.com')
  return Array.from(new Set(senarai.filter(Boolean)))
}

async function rpc(env: any, method: string, params: any[]): Promise<any> {
  let lastErr: any = null
  for (const url of rpcUrls(env)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      const data = await res.json().catch(() => null)
      if (!data) { lastErr = new Error('jawapan RPC bukan JSON'); continue }
      if (data.error) throw new Error(data.error.message || 'RPC error')
      return data.result
    } catch (e: any) {
      lastErr = e
    }
  }
  throw lastErr || new Error('RPC gagal')
}

function harga(env: any, id: string): number {
  const lalai = HARGA_LALAI[id] || 0.005
  try {
    const ubah = env?.AGENT_PRICES ? JSON.parse(env.AGENT_PRICES) : null
    const v = Number(ubah?.[id])
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* guna lalai */ }
  return lalai
}

/** Kadar SOL/USD dari Jupiter (sumber yang sama kita jual) + simpan 60s. */
let kadarCache = { usd: 0, at: 0 }
async function solUsd(env: any): Promise<number> {
  const now = Date.now()
  if (kadarCache.usd && now - kadarCache.at < 60000) return kadarCache.usd
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { headers: { Accept: 'application/json' } })
    const data: any = await res.json().catch(() => null)
    const p = Number(data?.[SOL_MINT]?.usdPrice || 0)
    if (p > 1) { kadarCache = { usd: p, at: now }; return p }
  } catch { /* cuba sumber lain */ }
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { headers: { Accept: 'application/json' } })
    const data: any = await res.json().catch(() => null)
    const p = Number(data?.data?.amount || 0)
    if (p > 1) { kadarCache = { usd: p, at: now }; return p }
  } catch { /* guna lalai */ }
  return Number(env?.SOL_USD_FALLBACK || 150)
}

// ---------------------------------------------------------------- D1

async function ensureTable(env: any): Promise<void> {
  const d = db(env)
  if (!d) return
  await d.prepare(
    `CREATE TABLE IF NOT EXISTS agent_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge TEXT UNIQUE NOT NULL,
      ref TEXT DEFAULT '',
      service TEXT NOT NULL,
      price_usd REAL DEFAULT 0,
      asset TEXT DEFAULT '',
      amount TEXT DEFAULT '',
      network TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      tx_sig TEXT UNIQUE,
      payer TEXT DEFAULT '',
      payload TEXT DEFAULT '',
      result TEXT DEFAULT '',
      error TEXT DEFAULT '',
      ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      paid_at INTEGER DEFAULT 0
    )`
  ).run()
  await d.prepare('CREATE INDEX IF NOT EXISTS idx_agent_calls_ref ON agent_calls(ref)').run()
  await d.prepare('CREATE INDEX IF NOT EXISTS idx_agent_calls_status ON agent_calls(status)').run()
  await d.prepare('CREATE INDEX IF NOT EXISTS idx_agent_calls_created ON agent_calls(created_at)').run()
}

// ---------------------------------------------- AgentBazaar (saluran kedua, mod "push")
/*
 * AgentBazaar (agentbazaar.dev) = marketplace agen di Solana. Ia menghantar tugasan
 * ke endpoint kita (mod "push") dan membayar 97% hasil ke akaun agen kita.
 * Kontrak: POST { task, files, buyer, jobId } -> { result: "<teks>" } (< 30 saat).
 * TIADA x402 di laluan ini — bayaran diuruskan oleh platform.
 */

/** Jadual log tugasan AgentBazaar (berasingan daripada agent_calls supaya statistik x402 kekal bersih). */
async function ensureBazaar(env: any): Promise<void> {
  const d = db(env)
  if (!d) return
  await d.prepare(
    `CREATE TABLE IF NOT EXISTS bazaar_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT DEFAULT '',
      buyer TEXT DEFAULT '',
      servis TEXT DEFAULT '',
      input TEXT DEFAULT '',
      status TEXT DEFAULT 'ok',
      ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )`
  ).run()
  await d.prepare('CREATE INDEX IF NOT EXISTS idx_bazaar_created ON bazaar_tasks(created_at)').run()
}

/** Simbol token yang biasa disebut (selain SIMBOL teras). */
const KENAL_SIMBOL = new Set([
  'sol', 'usdc', 'usdt', 'bonk', 'jup', 'wif', 'popcat', 'pyth', 'jto', 'ray', 'orca',
  'mew', 'bome', 'trump', 'pengu', 'fartcoin', 'pump', 'jupiter', 'raydium', 'render',
  'ondo', 'hnt', 'mobile', 'wifhat', 'goat', 'ai16z', 'trumpcoin'
])

/**
 * Jadual niat: frasa (Melayu/Inggeris) -> id servis. Susunan = keutamaan.
 * Dipakai pada setiap tugasan AgentBazaar (push) dan /agentbazaar?task= (uji).
 */
const NIAT_BAZAAR: { id: string, re: RegExp }[] = [
  { id: 'saring-token', re: /(saring|honeypot|safe to buy|scam|rug ?pull|rug ?check|penipu|keselamatan token|token safety|selamat (ke|tak|untuk|kah)|adakah[^.]{0,25}selamat)/i },
  { id: 'imbas-kontrak', re: /(imbas.?kontrak|scan.?contract|contract scan|renounce?d?|smart.?contract|periksa.?kontrak|cek.?kontrak|contract check|0x[a-f0-9]{40})/i },
  { id: 'risiko', re: /\b(risiko|risk|authority|beku|freeze)\b/i },
  { id: 'periksa-dompet', re: /\b(dompet|wallet|portfolio|pegangan|holdings|audit wallet)\b/i },
  { id: 'tokens-baharu', re: /\b(token (baharu|baru|muda)|new tokens?|baru launch|just launched|early gem)\b/i },
  { id: 'trending', re: /\b(trending|panas|hot token|viral)\b/i },
  { id: 'peluang', re: /\b(peluang|arbitraj|arbitrage|spread)\b/i },
  { id: 'banding-token', re: /\b(banding|compare|perbandingan|vs)\b/i },
  { id: 'kadar-gas', re: /\b(kadar gas|gas price|gas fee|yuran gas|gas sekarang|eth gas|gwei|biaya gas)\b/i },
  { id: 'yuran-rangkaian', re: /\b(yuran|fee|fees|priority fee|kos urus)\b/i },
  { id: 'kikis-ringkas', re: /(ringkas|summari[sz]e|summary|rumus)[^.]{0,60}(url|link|laman|page|https?:\/\/)/i },
  { id: 'kikis-web', re: /\b(kikis|scrape|extract|ambil kandungan|crawl)\b/i },
  { id: 'yield-defi', re: /\b(apy|yield|stim ?defi|defi yield|hasil terbaik|best yield|yield ?farm|staking)\b/i },
  { id: 'fx-kadar', re: /\b(fx|forex|matawang|kadar tukar|kadar pertukaran|exchange rate|currency)\b/i },
  { id: 'util-kotak', re: /(base64|sha ?-? ?256|hash|uuid|guid|timestamp|unix|iso 8601|(masa|waktu|time)\s+(semasa|sekarang|kini|now|current)|current time|cuti|holiday)/i },
  { id: 'harga', re: /\b(harga|price|berapa|how much|worth)\b/i },
  { id: 'quote', re: /\b(quote|swap|tukar token)\b/i },
  { id: 'terjemah', re: /\b(terjemah|translate|translation|ke bahasa|in english|dalam melayu)\b/i },
  { id: 'sentimen', re: /\b(sentimen|sentiment)\b/i },
  { id: 'tulis', re: /\b(tulis|write|draf|draft|caption|skrip|script)\b/i },
  { id: 'json', re: /\b(json|skema|schema|extract field)\b/i },
  { id: 'ringkas', re: /\b(ringkas|summari[sz]e|summary|rumus)\b/i }
]

/** Alamat mint/base58 dalam teks (maks 5). */
function mintBazaar(teks: string): string[] {
  const out: string[] = []
  for (const m of String(teks).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []) {
    if (MINT_RE.test(m) && !out.includes(m)) out.push(m)
    if (out.length >= 5) break
  }
  return out
}

/** URL dalam teks (maks 3), tanda baca hujung dibuang. */
function urlBazaar(teks: string): string[] {
  return ((String(teks).match(/https?:\/\/[^\s"'<>)\]]+/g) || []) as string[])
    .map((u) => u.replace(/[.,;:)]+$/, ''))
    .slice(0, 3)
}

/** Simbol token yang dikenali dalam teks (maks 5). */
function simbolBazaar(teks: string): string[] {
  const kata = String(teks).toLowerCase().match(/[a-z0-9]{2,14}/g) || []
  const out: string[] = []
  for (const k of kata) {
    if ((SIMBOL[k] || KENAL_SIMBOL.has(k)) && !out.includes(k)) out.push(k)
    if (out.length >= 5) break
  }
  return out
}

/** Pilih servis daripada teks tugasan. */
function niatBazaar(teks: string): string {
  // "jawab ringkas / answer briefly" = arahan GAYA, bukan permintaan ringkasan.
  const t = String(teks).replace(/\b(jawab|answer|balas|reply)\s+(secara\s+)?(ringkas|pendek|short|brief(ly)?)\b/gi, ' ')
  for (const n of NIAT_BAZAAR) if (n.re.test(t)) return n.id
  return ''
}

/** Bina body JSON untuk servis dipilih daripada teks tugasan bebas. */
function argBazaar(id: string, teks: string): any {
  const mints = mintBazaar(teks)
  const urls = urlBazaar(teks)
  const simbol = simbolBazaar(teks)
  const tokenUtama = mints[0] || simbol[0] || 'sol'
  switch (id) {
    case 'harga':
      return { token: (mints.length ? mints : simbol).slice(0, 5).join(',') || 'sol' }
    case 'risiko':
    case 'saring-token':
      return { token: tokenUtama }
    case 'banding-token': {
      const senarai = (mints.length ? mints : simbol).slice(0, 5)
      while (senarai.length < 2) senarai.push(senarai.includes('bonk') ? 'jup' : 'bonk')
      return { token: senarai.join(',') }
    }
    case 'periksa-dompet':
      return { dompet: mints[0] || '' }
    case 'kikis-web':
      return { url: urls[0] || '', had: 12000 }
    case 'kikis-ringkas':
      return { url: urls[0] || '', arahan: teks }
    case 'yuran-rangkaian':
      return { akaun: mints.slice(0, 5).join(',') }
    case 'trending':
      return {
        tempoh: (/(5m|1h|6h|24h)/i.exec(teks)?.[1] || '24h').toLowerCase(),
        had: 10,
        jenis: /(baharu|baru|new|fresh)/i.test(teks) ? 'baharu' : 'organik'
      }
    case 'tokens-baharu':
    case 'peluang':
      return {}
    case 'quote':
      return {
        dari: mints[0] || simbol[0] || 'sol',
        ke: mints[1] || simbol[1] || 'usdc',
        jumlah: /(\d{4,})/.exec(teks)?.[1] || '100000000'
      }
    case 'terjemah': {
      const to = /(in ?english|to ?english|ke ?english)/i.test(teks) ? 'en'
        : /(in ?malay|ke ?melayu|dalam melayu|bahasa melayu)/i.test(teks) ? 'ms' : ''
      return { text: teks, to }
    }
    default:
      return { text: teks }
  }
}

/** Sistem prompt untuk tugasan yang tidak padan servis mana-mana (laluan AI umum). */
const SISTEM_BAZAAR = [
  'Anda "Myworker", agen Solana berbayar. Jawab ringkas, tepat, tanpa mukadimah.',
  'Anda boleh menjalankan tugasan ini: saring-token / risiko (keselamatan token), harga, quote,',
  'trending, tokens-baharu, peluang (arbitraj), banding-token, yuran-rangkaian, periksa-dompet,',
  'kikis-web / kikis-ringkas (kandungan laman), sentimen, terjemah, ringkas, tulis, json.',
  'Jika tugasan memerlukan data on-chain (harga, keselamatan token, dompet), minta alamat mint atau',
  'alamat dompet Solana dengan jelas dan sebut perkhidmatan mana yang sesuai.',
  'Jawab dalam bahasa yang sama dengan tugasan.'
].join(' ')

/** Bentuk jawapan akhir kepada AgentBazaar: teks markdown ringkas (had 12k aksara). */
function hasilBazaar(id: string, mentah: string): string {
  const p = PLUGIN[id]
  const teks = String(mentah || '').trim()
  if (!teks) return 'Maaf, servis tidak menghasilkan jawapan kali ini. Sila cuba lagi sebentar.'
  const kepala = p ? `**Myworker · ${p.nama}**\n\n` : ''
  // Jawapan AI umum (tiada servis padan): teks biasa, tiada kod fence JSON.
  if (id === 'ai-umum') return teks.slice(0, 12000)
  // Servis AI teks bebas: pulangkan terus. Servis data / AI berstruktur: JSON berkod untuk agen.
  if (p && p.jenis === 'ai' && !p.jsonOutput) return kepala + teks.slice(0, 12000)
  let cantik = teks
  try { cantik = JSON.stringify(JSON.parse(teks), null, 2) } catch { /* biar teks asal */ }
  return kepala + '```json\n' + cantik.slice(0, 12000) + '\n```'
}

/** Bisik pemilik di Telegram (tugasan AgentBazaar = peristiwa penting). */
async function bisikBazaar(env: any, teks: string): Promise<void> {
  const tok = String(env?.TELEGRAM_BOT_TOKEN || '')
  const chat = String(env?.TELEGRAM_CHAT_ID || '')
  if (!tok || !chat) return
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: teks.slice(0, 3800) })
    })
  } catch { /* notifikasi gagal tidak boleh menggagalkan tugasan */ }
}

/**
 * Laksana SATU tugasan AgentBazaar: pilih servis -> jalankan -> bentuk jawapan.
 * Pulangkan { servis, input, status, jawapan, ms }.
 */
async function laksanaBazaar(env: any, teks: string): Promise<{ servis: string, input: string, status: string, jawapan: string, ms: number }> {
  const t0 = Date.now()
  const pilih = niatBazaar(teks)
  let servis = pilih
  let jawapan = ''
  let status = 'ok'

  // Input wajib tidak dijumpai -> beri panduan (jangan buang masa pembeli).
  const bodyArg = pilih ? argBazaar(pilih, teks) : {}
  if (pilih === 'periksa-dompet' && !bodyArg.dompet) {
    return {
      servis: 'panduan', input: teks.slice(0, 300), status: 'bantuan', ms: Date.now() - t0,
      jawapan: 'Saya perlu **alamat dompet Solana** (base58) untuk memeriksa dompet. Contoh: "periksa dompet 3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E".'
    }
  }
  if ((pilih === 'kikis-web' || pilih === 'kikis-ringkas') && !bodyArg.url) {
    return {
      servis: 'panduan', input: teks.slice(0, 300), status: 'bantuan', ms: Date.now() - t0,
      jawapan: 'Saya perlu **URL penuh** untuk mengambil kandungan. Contoh: "ringkas https://example.com".'
    }
  }

  const input = pilih ? inputDariBody(pilih, bodyArg) : teks
  try {
    if (pilih) jawapan = await jalankanServis(env, pilih, input, bodyArg)
    else {
      // Tiada servis padan: jawab sebagai agen AI umum (Workers AI).
      const teksAi = await askAi(env, teks, SISTEM_BAZAAR, 700)
      servis = 'ai-umum'
      jawapan = teksAi || ''
      if (!jawapan) status = 'gagal'
    }
  } catch (e: any) {
    console.error('AgentBazaar servis gagal:', e?.message || e)
    status = 'ralat'
  }
  if (!jawapan && status === 'ok') status = 'gagal'
  return { servis, input: String(input).slice(0, 300), status, jawapan: hasilBazaar(pilih || 'ai-umum', jawapan), ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- servis crypto

// Cache quote 15s — batch /peluang menghantar banyak quote; cache memotong
// jumlah panggilan (dan elak 429) tanpa memberi harga lapuk.
const jupCache = new Map<string, { at: number, data: any }>()

// Throttle adaptif: elak 429 (had kadar lite-api.jup.ag). Satu 429 →
// semua panggilan berikutnya perlahan automatik (cooldown global).
let jupNext = 0
let jupCooldown = 0
async function jupThrottle(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, jupNext, jupCooldown)
  jupNext = at + 400
  const d = at - now
  if (d > 0) await tunggu(d)
}
function jupPause(ms: number) {
  jupCooldown = Math.max(jupCooldown, Date.now() + ms)
}

async function jupQuote(env: any, inputMint: string, outputMint: string, amount: number): Promise<any> {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`
  const ck = `${inputMint}:${outputMint}:${amount}`
  const hit = jupCache.get(ck)
  if (hit && Date.now() - hit.at < 15000) return hit.data
  for (let cubaan = 1; cubaan <= 5; cubaan++) {
    try {
      await jupThrottle()
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Myworker-Agent-API/1.0' }
      })
      const teks = await res.text()
      if (!teks) { jupPause(1200); if (cubaan === 5) return { error: true, message: 'respons kosong' }; await tunggu(500 * cubaan); continue }
      const data: any = JSON.parse(teks)
      if (!res.ok || data?.error) {
        jupPause(res.status === 429 ? 1800 : 800)
        if (cubaan === 5) return { error: true, message: data?.error || `HTTP ${res.status}` }
        await tunggu(500 * cubaan) // backoff: elak 429 bila burst
        continue
      }
      if (jupCache.size > 300) jupCache.clear()
      jupCache.set(ck, { at: Date.now(), data })
      return data
    } catch (e: any) {
      jupPause(900)
      if (cubaan === 5) return { error: true, message: e?.message || 'fetch gagal' }
      await tunggu(500 * cubaan)
    }
  }
  return { error: true, message: 'gagal selepas 5 cubaan' }
}

function mints(banyak: string): string[] {
  return String(banyak || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    // Hanya NAMA SIMBOL tidak sensitif huruf besar/kecil. Alamat mint (base58)
    // MESTI kekalkan huruf asal — jika tidak, mint jadi tak sah dan servis gagal.
    .map((s) => SIMBOL[s.toLowerCase()] || s)
}

async function servisHarga(env: any, input: string): Promise<any> {
  const ids = mints(input || 'sol')
  if (!ids.length) return { error: 'Berikan token. Contoh: {"token":"sol,bonk"}' }
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.join(',')}`, { headers: { Accept: 'application/json' } })
  const data: any = await res.json().catch(() => null)
  if (!data) return { error: 'Jupiter price tidak menjawab' }
  const keluar: any = {}
  for (const id of ids) {
    const d = data[id]
    keluar[id] = d
      ? { usd: d.usdPrice, desimal: d.decimals, kecairan_usd: d.liquidity, perubahan_24j_pct: d.priceChange24h, sejak: d.createdAt }
      : { usd: null, nota: 'tiada harga (token tak dikenali?)' }
  }
  return { sumber: 'jupiter-price-v3', masa: new Date().toISOString(), token: keluar }
}

async function servisQuote(env: any, input: string): Promise<any> {
  const bahagian = String(input || '').trim().split(/\s+/)
  const dari = bahagian[0] || 'sol'
  const ke = bahagian[1] || 'usdc'
  const jumlah = parseInt(bahagian[2] || '100000000', 10)
  if (!Number.isFinite(jumlah) || jumlah <= 0) return { error: 'jumlah mesti integer unit terkecil (cth 100000000 lamports)' }
  const inMint = SIMBOL[dari.toLowerCase()] || dari
  const outMint = SIMBOL[ke.toLowerCase()] || ke
  const q = await jupQuote(env, inMint, outMint, jumlah)
  if (q?.error) return { error: q.message }
  const keluar = parseInt(q.outAmount || '0', 10)
  return {
    sumber: 'jupiter-swap-v1',
    dari: inMint,
    ke: outMint,
    jumlah_masuk: String(jumlah),
    jumlah_keluar: String(keluar),
    kadar: jumlah ? Number((keluar / jumlah).toPrecision(10)) : 0,
    price_impact_pct: Number(q.priceImpactPct || 0),
    laluan: (q.routePlan || []).map((r: any) => r?.swapInfo?.label).filter(Boolean),
    slippage_bps: 50
  }
}

async function servisRisiko(env: any, input: string): Promise<any> {
  const mint = (mints(input || 'sol')[0]) || SOL_MINT
  const [info, pr] = await Promise.all([
    rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null),
    fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json()).catch(() => null)
  ])
  const parsed = info?.value?.data?.parsed?.info
  const p: any = (pr as any)?.[mint]
  if (!parsed && !p) return { error: 'Token tak dijumpai pada rantaian mahupun Jupiter', mint }
  const amaran: string[] = []
  if (parsed?.mintAuthority) amaran.push('mintAuthority MASIH AKTIF — pemilik boleh cetak token baharu (risiko inflasi/dump)')
  if (parsed?.freezeAuthority) amaran.push('freezeAuthority MASIH AKTIF — akaun boleh dibekukan')
  const liq = Number(p?.liquidity || 0)
  if (liq && liq < 50000) amaran.push('kecairan rendah (< $50k) — slippage besar, mudah dimanipulasi')
  if (!p) amaran.push('tiada harga di Jupiter — mungkin tiada pasaran langsung')
  const umurHari = p?.createdAt ? Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000) : null
  if (umurHari !== null && umurHari < 3) amaran.push('token baharu (< 3 hari) — risiko penipuan tinggi')
  const skor = amaran.length === 0 ? 'rendah' : amaran.length === 1 ? 'sederhana' : 'tinggi'
  return {
    mint,
    desimal: parsed?.decimals ?? p?.decimals ?? null,
    supply: parsed?.supply ? String(parsed.supply) : null,
    mint_authority: parsed?.mintAuthority || null,
    freeze_authority: parsed?.freezeAuthority || null,
    harga_usd: p?.usdPrice ?? null,
    kecairan_usd: liq || null,
    umur_hari: umurHari,
    risiko: skor,
    amaran,
    nota: 'Laporan automatik berdasarkan data rantaian + Jupiter. Bukan nasihat pelaburan.'
  }
}

/**
 * SARINGAN KESELAMATAN PENUH — satu panggilan, satu keputusan.
 *
 * Menggabungkan LIMA siasatan yang biasanya memerlukan 4-5 panggilan berasingan:
 *   1. kuasa mint/freeze (boleh cetak token baharu? boleh bekukan akaun?)
 *   2. tumpuan pemegang teratas (risiko dump)
 *   3. UJIAN JUAL — beli kemudian jual semula; tiada laluan jual = honeypot
 *   4. kedalaman kecairan pada 5 saiz (kesan harga sebenar, bukan anggaran)
 *   5. saiz urus niaga SELAMAT (saiz terbesar dengan kesan harga < 2%)
 *
 * Semua data dari Solana RPC + Jupiter (percuma) — tiada kunci pihak ketiga,
 * tiada API berbayar. Ini yang membezakannya daripada pembalut API percuma.
 */
/** Sama ada alamat nampak seperti mint Solana (base58, 32-44 aksara). */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Kelaskan skor 0-100 kepada 3 aras, untuk mengukur kesepakatan dua sumber. */
function arasSkor(v: number): number {
  return v <= 20 ? 0 : v <= 50 ? 1 : 2
}

/** Adakah dua sumber bebas bersetuju tentang tahap risiko? */
function sepakat(a: number, b: number): 'sepadan' | 'sebahagian' | 'berbeza' {
  const d = Math.abs(arasSkor(a) - arasSkor(b))
  return d === 0 ? 'sepadan' : d === 1 ? 'sebahagian' : 'berbeza'
}

/**
 * SUMBER KEDUA YANG BEBAS — laporan ringkas RugCheck (percuma, tiada kunci).
 *
 * Inilah yang membezakan `saring-token` daripada pembalut API tunggal: keputusan
 * akhir menggabungkan analisis pasaran langsung kita (Jupiter) dengan penilaian
 * risiko pihak ketiga yang berasingan. Jika RugCheck gagal/down, kita pulangkan
 * null dan keputusan Jupiter tetap sah — servis TIDAK pernah gagal kerana ini.
 */
async function rugcheck(mint: string): Promise<any> {
  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`,
      { headers: { Accept: 'application/json', 'User-Agent': 'myworker-agent-api/1.0' } }
    )
    if (!r.ok) return null
    const j: any = await r.json()
    if (!j || typeof j !== 'object') return null
    const risiko = Array.isArray(j.risks)
      ? j.risks.slice(0, 12).map((x: any) => ({
          nama: str(x?.name) || null,
          tahap: str(x?.level).toLowerCase() || null,   // warn | danger
          skor: Number(x?.score || 0) || null,
          keterangan: str(x?.description).slice(0, 240) || null
        }))
      : []
    const normal = Number(j.score_normalised)
    return {
      skor_mentah: Number(j.score || 0) || 0,
      skor_normal: Number.isFinite(normal) ? normal : null,
      lp_terkunci_pct: j.lpLockedPct === undefined || j.lpLockedPct === null ? null : Number(Number(j.lpLockedPct).toFixed(4)),
      program_token: str(j.tokenProgram) || null,
      jenis_token: str(j.tokenType) || null,
      risiko,
      sumber: 'rugcheck.xyz /tokens/{mint}/report/summary'
    }
  } catch {
    return null
  }
}

async function servisSaring(env: any, input: string, saizUsd: number = 100): Promise<any> {
  // --- 1. Metadata pasaran: SATU panggilan Jupiter tokens v2 yang sangat kaya
  //     (kuasa mint/freeze, tumpuan pemegang, pegangan dev, bilangan pemegang,
  //     skor organik, kecairan, umur, kelantangan beli/jual). Percuma, tiada kunci.
  const cari = str(input) || 'bonk'
  const q = mints(cari)[0] || cari
  const mentah: any = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .catch(() => null)
  const hasilCari: any[] = Array.isArray(mentah) ? mentah : (mentah?.data || [])
  let atas: any = hasilCari.find((x) => x?.id === q) || hasilCari[0] || null
  const mint = atas?.id || q

  // Sumber KEDUA (RugCheck) bermula di sini supaya ia berjalan SELARI dengan
  // ujian kedalaman + ujian jual Jupiter di bawah. Tanpa ini kita tunggu dua kali.
  const rcJanji: Promise<any> = MINT_RE.test(String(mint)) ? rugcheck(String(mint)) : Promise.resolve(null)

  // Harga SOL (USD) — untuk tukar saiz USD kepada lamports dalam ujian kedalaman/jual.
  const hargaSol = Number(
    await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((j: any) => j?.[SOL_MINT]?.usdPrice)
      .catch(() => null)
  ) || null

  // Sandaran: jika Jupiter tiada data, baca akaun mint terus dari rantaian.
  if (!atas) {
    const info = await rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null)
    const pi = info?.value?.data?.parsed?.info
    if (pi) atas = { id: mint, decimals: pi.decimals, circSupply: pi.supply, audit: { mintAuthorityDisabled: !pi.mintAuthority, freezeAuthorityDisabled: !pi.freezeAuthority } }
  }
  if (!atas) return { error: 'Token tak dijumpai di Jupiter mahupun rantaian', mint }

  const au = atas.audit || {}
  const s24 = atas.stats24h || {}
  const desimal = Number(atas.decimals ?? 9)
  const supplyUi = Number(atas.circSupply || atas.totalSupply || 0) || null
  const hargaUsd = Number(atas.usdPrice || 0) || null
  const kecairan = Number(atas.liquidity || 0) || null
  const holder = Number(atas.holderCount || 0) || null
  const umurHari = atas.createdAt ? Math.floor((Date.now() - new Date(atas.createdAt).getTime()) / 86400000) : null
  const top10 = au.topHoldersPercentage === undefined ? null : Number(au.topHoldersPercentage)
  const devPct = Number(au.devBalancePercentage || 0)
  const devMints = au.devMints === undefined ? null : Number(au.devMints)
  const organik = au.topHoldersPercentage === undefined && atas.organicScore === undefined ? null : Number(atas.organicScore)
  const amaran: string[] = []
  const kekuatan: string[] = []
  let skor = 0

  // --- kuasa (paling penting: boleh cetak token / boleh bekukan akaun?)
  if (au.mintAuthorityDisabled === false) { amaran.push('mintAuthority MASIH AKTIF — pemilik boleh cetak token baharu tanpa had'); skor += 30 }
  else if (au.mintAuthorityDisabled === true) kekuatan.push('kuasa cetak (mint authority) sudah dilumpuhkan')
  if (au.freezeAuthorityDisabled === false) { amaran.push('freezeAuthority MASIH AKTIF — akaun pemegang boleh dibekukan (tidak boleh jual)'); skor += 25 }
  else if (au.freezeAuthorityDisabled === true) kekuatan.push('kuasa beku (freeze authority) sudah dilumpuhkan')

  // --- tumpuan pemegang & pembangun
  if (top10 !== null && Number.isFinite(top10)) {
    if (top10 > 70) { amaran.push(`${top10.toFixed(1)}% bekalan dipegang 10 akaun teratas — sangat menumpu`); skor += 30 }
    else if (top10 > 50) { amaran.push(`${top10.toFixed(1)}% bekalan dipegang 10 akaun teratas`); skor += 20 }
    else if (top10 > 30) { amaran.push(`${top10.toFixed(1)}% bekalan dipegang 10 akaun teratas`); skor += 10 }
    else kekuatan.push(`tumpuan pemegang sihat (10 teratas = ${top10.toFixed(1)}%)`)
  }
  if (devPct > 5) { amaran.push(`dompet pembangun masih memegang ${devPct.toFixed(2)}% bekalan`); skor += 15 }
  if (devMints !== null && devMints > 50) { amaran.push(`pembangun telah melancarkan ${devMints} token — corak pelancar bersiri`); skor += 10 }

  // --- kecairan, umur, komuniti, kualiti aktiviti
  if (kecairan !== null && kecairan < 50000) { amaran.push(`kecairan rendah ($${Math.round(kecairan)}) — slippage besar dan mudah dimanipulasi`); skor += kecairan < 10000 ? 30 : 18 }
  else if (kecairan !== null && kecairan >= 250000) kekuatan.push(`kecairan kukuh ($${Math.round(kecairan)})`)
  if (umurHari !== null && umurHari < 3) { amaran.push(`token baharu (${umurHari} hari) — rekod terlalu pendek untuk dinilai`); skor += umurHari < 1 ? 25 : 15 }
  else if (umurHari !== null && umurHari > 180) kekuatan.push(`sudah wujud ${umurHari} hari`)
  if (holder !== null && holder < 500) { amaran.push(`hanya ${holder} pemegang — asas terlalu nipis`); skor += holder < 100 ? 20 : 10 }
  else if (holder !== null && holder > 10000) kekuatan.push(`${holder} pemegang`)
  if (organik !== null && Number.isFinite(organik) && organik < 20) { amaran.push(`skor organik rendah (${organik.toFixed(1)}) — banyak kelantangan mungkin bot/wash`); skor += 15 }
  else if (organik !== null && Number.isFinite(organik) && organik > 60) kekuatan.push(`aktiviti organik tinggi (${organik.toFixed(1)})`)
  if (atas.isVerified === false) { amaran.push('token tidak disahkan (unverified) di Jupiter'); skor += 5 }
  else if (atas.isVerified === true) kekuatan.push('disahkan (verified) di Jupiter')
  if (!hargaUsd) { amaran.push('tiada harga di Jupiter — mungkin tiada pasaran langsung'); skor += 20 }
  const jual24 = Number(s24.sellVolume || 0)
  const beli24 = Number(s24.buyVolume || 0)
  if (beli24 > 0 && jual24 > beli24 * 2) { amaran.push(`tekanan JUAL tinggi dalam 24j (jual $${Math.round(jual24)} vs beli $${Math.round(beli24)})`); skor += 10 }

  // --- 3 & 4 & 5. kedalaman kecairan, ujian jual, saiz selamat
  const kedalaman: any[] = []
  let ujianJual: any = null
  let saizSelamat: number | null = null
  const bolehUji = !!hargaSol && mint !== SOL_MINT && mint !== USDC_MINT

  if (bolehUji) {
    for (const usd of [100, 500, 1000, 5000, 10000]) {
      const lamports = Math.floor((usd / hargaSol!) * 1e9)
      const q = await jupQuote(env, SOL_MINT, mint, lamports)
      if (q?.error) { kedalaman.push({ saiz_usd: usd, status: 'TIADA_LALUAN' }); continue }
      const impact = Number(q.priceImpactPct || 0)
      kedalaman.push({
        saiz_usd: usd,
        keluar_token: Number((Number(q.outAmount || 0) / 10 ** desimal).toFixed(6)),
        price_impact_pct: Number(impact.toFixed(4)),
        laluan: (q.routePlan || []).map((r: any) => r?.swapInfo?.label).filter(Boolean)
      })
      if (impact < 2 && (saizSelamat === null || usd > saizSelamat)) saizSelamat = usd
    }

    // Ujian jual: beli pada saiz yang diminta, kemudian cuba jual semula.
    const masukLam = Math.floor((saizUsd / hargaSol!) * 1e9)
    const beli = await jupQuote(env, SOL_MINT, mint, masukLam)
    if (beli?.error) {
      ujianJual = { status: 'GAGAL_BELI', mesej: beli.message }
      amaran.push('tiada laluan BELI untuk token ini pada saiz diuji')
    } else {
      const jual = await jupQuote(env, mint, SOL_MINT, parseInt(beli.outAmount, 10))
      if (jual?.error) {
        ujianJual = { status: 'TIDAK_BOLEH_JUAL', mesej: jual.message, nota: 'Tiada laluan jual — petunjuk kuat honeypot.' }
        amaran.push('TIADA LALUAN JUAL — petunjuk KUAT honeypot / dana mungkin terperangkap')
        skor += 50
      } else {
        const kembaliLam = parseInt(jual.outAmount, 10)
        const susut = Number((((masukLam - kembaliLam) / masukLam) * 100).toFixed(2))
        ujianJual = {
          status: susut > 25 ? 'SUSUT_TERUK' : susut > 8 ? 'SUSUT_TINGGI' : 'NORMAL',
          saiz_ujian_usd: saizUsd,
          masuk_lamports: masukLam,
          kembali_lamports: kembaliLam,
          susut_pulang_balik_pct: susut,
          kesan_harga_beli_pct: Number(Number(beli.priceImpactPct || 0).toFixed(4)),
          kesan_harga_jual_pct: Number(Number(jual.priceImpactPct || 0).toFixed(4)),
          nota: 'Susut termasuk spread + fi + kesan harga. Token cair biasanya 1-3%.'
        }
        if (susut > 25) { amaran.push(`pulang-balik jual teruk: ${susut}% hilang pada saiz $${saizUsd}`); skor += 30 }
        else if (susut > 8) { amaran.push(`kos pulang-balik tinggi: ${susut}% pada saiz $${saizUsd}`); skor += 15 }
      }
    }
  }

  // --- Gabung dengan sumber kedua bebas (RugCheck) -------------------------
  // Kaedah berwajaran: 60% analisis pasaran langsung kita (Jupiter), 40%
  // penilaian risiko pihak ketiga (RugCheck). Kedua-duanya dipaparkan supaya
  // pembeli boleh menilai sendiri — dan tahu bila dua sumber TIDAK bersetuju.
  const rc = await rcJanji
  const skorJupiter = Math.max(0, Math.min(100, Math.round(skor)))
  let skorAkhir = skorJupiter
  let rcSkor: number | null = null
  if (rc) {
    rcSkor = typeof rc.skor_normal === 'number' ? rc.skor_normal : null
    for (const x of rc.risiko || []) {
      const tahap = String(x.tahap || '').toLowerCase()
      const nama = x.nama || 'risiko tanpa nama'
      if (tahap === 'danger') amaran.push(`[RugCheck] ${nama}${x.keterangan ? ' — ' + x.keterangan : ''} (risiko TINGGI)`)
      else amaran.push(`[RugCheck] ${nama}`)
    }
    if (rc.lp_terkunci_pct !== null) {
      if (rc.lp_terkunci_pct >= 90) kekuatan.push(`[RugCheck] ${rc.lp_terkunci_pct}% kecairan terkunci`)
      else if (rc.lp_terkunci_pct < 50) amaran.push(`[RugCheck] hanya ${rc.lp_terkunci_pct}% kecairan terkunci — pengeluar boleh tarik kecairan`)
    }
    if (rcSkor !== null) skorAkhir = Math.round(0.6 * skorJupiter + 0.4 * Math.min(100, rcSkor))
  }

  return {
    sumber: rc
      ? 'jupiter-tokens-v2 + jupiter-swap-v1 + rugcheck.xyz'
      : 'jupiter-tokens-v2 + jupiter-swap-v1 (RugCheck tidak tersedia)',
    masa: new Date().toISOString(),
    mint,
    simbol: atas.symbol || null,
    nama: atas.name || null,
    keputusan: skorAkhir <= 20 ? 'selamat' : skorAkhir <= 50 ? 'berhati-hati' : 'bahaya',
    skor_risiko: skorAkhir,
    skor: {
      jupiter: skorJupiter,
      rugcheck: rcSkor,
      gabungan: skorAkhir,
      kaedah: rcSkor === null ? 'jupiter sahaja (sumber kedua tidak tersedia)' : '0.6 × jupiter + 0.4 × rugcheck'
    },
    kesepakatan: rcSkor === null ? null : sepakat(skorJupiter, rcSkor),
    sumber_luar: { rugcheck: rc },
    sebab: amaran.length ? amaran : ['Tiada amaran besar dikesan pada masa ini.'],
    kekuatan,
    asas: {
      harga_usd: hargaUsd,
      kecairan_usd: kecairan,
      mcap_usd: Number(atas.mcap || 0) || null,
      fdv_usd: Number(atas.fdv || 0) || null,
      umur_hari: umurHari,
      desimal,
      bekalan_edaran: supplyUi,
      bilangan_pemegang: holder
    },
    kuasa: {
      mint_authority_aktif: au.mintAuthorityDisabled === undefined ? null : au.mintAuthorityDisabled === false,
      freeze_authority_aktif: au.freezeAuthorityDisabled === undefined ? null : au.freezeAuthorityDisabled === false
    },
    tumpuan: {
      top10_peratus: top10 !== null && Number.isFinite(top10) ? Number(top10.toFixed(2)) : null,
      dev_peratus: Number(devPct.toFixed(4)),
      dev_melancarkan_token: devMints
    },
    kualiti_pasaran: {
      skor_organik: organik !== null && Number.isFinite(organik) ? Number(organik.toFixed(2)) : null,
      label_organik: atas.organicScoreLabel || null,
      disahkan: atas.isVerified === true,
      tag: atas.tags || [],
      kelantangan_24j: {
        beli_usd: Math.round(beli24),
        jual_usd: Math.round(jual24),
        perubahan_harga_pct: Number.isFinite(Number(s24.priceChange)) ? Number(Number(s24.priceChange).toFixed(2)) : null,
        pedagang: Number(s24.numTraders || 0) || null,
        belian: Number(s24.numBuys || 0) || null,
        jualan: Number(s24.numSells || 0) || null
      }
    },
    kedalaman_kecairan: kedalaman,
    saiz_urus_niaga_selamat_usd: saizSelamat,
    ujian_jual: ujianJual,
    nota: 'Saringan automatik daripada DUA sumber awam bebas (Jupiter + RugCheck). Bukan nasihat pelaburan.'
  }
}

// Peluang arbitraj: 2-leg (SOL->USDC->SOL) berbilang saiz + 3-leg, ambil terbaik.
let peluangCache: { at: number, data: any } = { at: 0, data: null }
async function servisPeluang(env: any): Promise<any> {
  if (peluangCache.data && Date.now() - peluangCache.at < 30000) {
    return { ...peluangCache.data, cache: true }
  }
  const saiz = [10000000, 50000000, 100000000]
  const dua: any[] = []
  for (const amt of saiz) {
    const l1 = await jupQuote(env, SOL_MINT, USDC_MINT, amt)
    if (l1?.error) { dua.push({ saiz: amt, status: 'QUOTE_ERROR', detail: l1.message }); continue }
    const l2 = await jupQuote(env, USDC_MINT, SOL_MINT, parseInt(l1.outAmount, 10))
    if (l2?.error) { dua.push({ saiz: amt, status: 'QUOTE_ERROR', detail: l2.message }); continue }
    const keluar = parseInt(l2.outAmount, 10)
    const fi = 12000
    const untung = keluar - amt - fi
    dua.push({
      saiz: amt, keluar, untung_lamports: untung,
      untung_pct: Number(((untung / amt) * 100).toFixed(4)),
      impact_pct: Number((parseFloat(l1.priceImpactPct || '0') + parseFloat(l2.priceImpactPct || '0')).toFixed(4)),
      status: untung > 0 ? 'UNTUNG' : 'TIADA_UNTUNG'
    })
  }
  const tiga: any[] = []
  for (const laluan of [[SOL_MINT, USDC_MINT, BONK_MINT, SOL_MINT], [SOL_MINT, BONK_MINT, USDC_MINT, SOL_MINT]]) {
    let amt = 50000000
    let rosak = false
    let impact = 0
    for (let i = 0; i < laluan.length - 1; i++) {
      const q = await jupQuote(env, laluan[i], laluan[i + 1], amt)
      if (q?.error) { tiga.push({ laluan: laluan.join('->'), status: 'QUOTE_ERROR', detail: q.message }); rosak = true; break }
      amt = parseInt(q.outAmount, 10)
      impact = Math.max(impact, parseFloat(q.priceImpactPct || '0'))
    }
    if (rosak) continue
    const untung = amt - 50000000 - 18000
    tiga.push({
      laluan: laluan.join('->'), keluar: amt, untung_lamports: untung,
      untung_pct: Number(((untung / 50000000) * 100).toFixed(4)),
      impact_pct: Number(impact.toFixed(4)),
      status: untung > 0 ? 'UNTUNG' : 'TIADA_UNTUNG'
    })
  }
  const semua = [...dua, ...tiga].filter((x) => typeof x.untung_pct === 'number')
  semua.sort((a, b) => b.untung_pct - a.untung_pct)
  const terbaik = semua[0] || null
  const data = {
    sumber: 'jupiter-swap-v1',
    masa: new Date().toISOString(),
    terbaik,
    menguntungkan: semua.filter((x) => x.untung_pct > 0).length,
    dua_leg: dua,
    tiga_leg: tiga,
    nota: 'Untung sudah ditolak anggaran fi (~12k/18k lamports). Sahkan sebelum eksekusi.'
  }
  peluangCache = { at: Date.now(), data }
  return data
}

// ---------------------------------------------------------------- servis data

/** Ringkaskan satu token Jupiter jadi bentuk yang bot boleh guna terus. */
function ringkasToken(t: any, pangkat: number): any {
  const s24 = t?.stats24h || {}
  const umur = t?.createdAt ? Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86400000) : null
  const pc = Number(s24?.priceChange)
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null)
  return {
    pangkat,
    simbol: t?.symbol || null,
    nama: t?.name || null,
    mint: t?.id || null,
    harga_usd: num(t?.usdPrice),
    kecairan_usd: num(t?.liquidity) === null ? null : Math.round(Number(t.liquidity)),
    mcap_usd: num(t?.mcap) === null ? null : Math.round(Number(t.mcap)),
    perubahan_24j_pct: Number.isFinite(pc) ? Number(pc.toFixed(2)) : null,
    bilangan_pemegang: num(t?.holderCount),
    skor_organik: num(t?.organicScore),
    label_organik: t?.organicScoreLabel || null,
    disahkan: !!t?.isVerified,
    umur_hari: umur,
    tag: Array.isArray(t?.tags) ? t.tags.slice(0, 6) : []
  }
}

/** Token trending Solana (skor organik Jupiter) atau token paling baharu. */
async function servisTrending(env: any, input: string): Promise<any> {
  const b = String(input || '').split('|')
  const jenis = b[0] === 'baharu' ? 'baharu' : 'organik'
  const tempoh = ['5m', '1h', '6h', '24h'].includes(b[1]) ? b[1] : '24h'
  const had = Math.min(Math.max(parseInt(b[2] || '10', 10) || 10, 1), 50)
  const url = jenis === 'baharu'
    ? 'https://lite-api.jup.ag/tokens/v2/recent'
    : `https://lite-api.jup.ag/tokens/v2/toporganicscore/${tempoh}`
  const senarai: any = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Myworker-Agent-API/1.0' } })
    .then((r) => r.json()).catch(() => null)
  if (!Array.isArray(senarai)) return { error: 'Sumber trending tidak menjawab', sumber: 'jupiter-tokens-v2' }
  return {
    sumber: 'jupiter-tokens-v2',
    jenis,
    tempoh,
    masa: new Date().toISOString(),
    token: senarai.slice(0, had).map((t: any, i: number) => ringkasToken(t, i + 1)),
    nota: jenis === 'organik'
      ? 'Skor organik Jupiter menilai aktiviti dagangan sebenar (bukan bot) — lebih tinggi = lebih sihat.'
      : 'Token paling baharu didaftarkan. Risiko sangat tinggi — sahkan dahulu.'
  }
}

/** Semak dompet Solana: kewujudan, jenis akaun, aktiviti & amaran risiko. */
async function servisDompet(env: any, input: string): Promise<any> {
  const alamat = String(input || '').trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(alamat)) return { error: 'Alamat dompet tidak sah', dompet: alamat }
  const [info, sig] = await Promise.all([
    rpc(env, 'getAccountInfo', [alamat, { encoding: 'jsonParsed' }]).catch(() => null),
    rpc(env, 'getSignaturesForAddress', [alamat, { limit: 50 }]).catch(() => null)
  ])
  const nilai = info?.value
  const wujud = !!nilai
  const lamports = Number(nilai?.lamports || 0)
  const pemilik = nilai?.owner || null
  const bolehLaksana = !!nilai?.executable
  let saizData = 0
  const d: any = nilai?.data
  if (Array.isArray(d)) saizData = d[0] ? Math.floor(String(d[0]).length * 3 / 4) : 0
  else if (d && typeof d === 'object') saizData = Number(d.space || 0)
  let jenisAkaun = 'dompet sistem'
  if (bolehLaksana) jenisAkaun = 'program (boleh laksana)'
  else if (pemilik === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') jenisAkaun = 'akaun token SPL'
  else if (pemilik === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') jenisAkaun = 'akaun token-2022'
  else if (pemilik && pemilik !== '11111111111111111111111111111111') jenisAkaun = 'akaun data (bukan dompet biasa)'
  else if (saizData > 0) jenisAkaun = 'akaun data (bukan dompet biasa)'
  const senarai: any[] = Array.isArray(sig) ? sig : []
  const masa = senarai.map((s) => Number(s?.blockTime || 0)).filter((x) => x > 0)
  const terkini = masa.length ? Math.max(...masa) : null
  const terawal = masa.length ? Math.min(...masa) : null
  const amaran: string[] = []
  if (!wujud) amaran.push('Akaun tidak wujud pada rantaian (mungkin belum pernah dibiayai)')
  else if (lamports === 0) amaran.push('Baki 0 SOL')
  if (wujud && senarai.length === 0) amaran.push('Tiada aktiviti transaksi langsung')
  if (lamports > 0 && lamports < 1000000) amaran.push('Baki sangat kecil (< 0.001 SOL)')
  if (jenisAkaun !== 'dompet sistem') amaran.push('Bukan dompet biasa: ' + jenisAkaun)
  if (terkini && terawal && terkini - terawal < 86400) amaran.push('Semua aktiviti dalam < 1 hari — dompet mungkin sangat baharu')
  return {
    dompet: alamat,
    wujud,
    baki_sol: Number((lamports / LAMPORTS).toFixed(9)),
    jenis_akaun: jenisAkaun,
    program_pemilik: pemilik,
    boleh_laksana: bolehLaksana,
    saiz_data_bait: saizData,
    tx_dalam_sampel: senarai.length,
    ada_tx_lebih_lama: senarai.length === 50,
    aktiviti_terkini: terkini ? new Date(terkini * 1000).toISOString() : null,
    aktiviti_terawal_dalam_sampel: terawal ? new Date(terawal * 1000).toISOString() : null,
    amaran,
    nota: 'Berdasarkan sehingga 50 transaksi terakhir sahaja. Bukan nasihat pelaburan.'
  }
}

/** Tukar HTML jadi Markdown ringkas (tanpa pustaka luar). */
function htmlKeMarkdown(html: string): string {
  let s = String(html || '')
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
  s = s.replace(/<form[\s\S]*?<\/form>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  for (let i = 6; i >= 1; i--) {
    s = s.replace(new RegExp('<h' + i + '[^>]*>([\\s\\S]*?)</h' + i + '>', 'gi'), '\n\n' + '#'.repeat(i) + ' $1\n\n')
  }
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, teks) => {
    const t = String(teks).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return t ? '[' + t + '](' + href + ')' : href
  })
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt) => (alt ? '![' + alt + ']' : ''))
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_')
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n\n```\n$1\n```\n\n')
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|header|footer|tr|table|blockquote|h[1-6])>/gi, '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  s = s.replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&hellip;/gi, '…').replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
  s = s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)))
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/ ?\n ?/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  // Buang baris yang tinggal simbol markdown sahaja (cth "##" atau "**" kosong).
  s = s.replace(/^[#*_`>-]+\s*$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** Ambil URL, pulangkan kandungan sebagai Markdown bersih. */
async function servisKikis(env: any, input: string, body?: any): Promise<any> {
  const url = String(input || '').trim()
  if (!/^https?:\/\//i.test(url)) return { error: 'URL mesti bermula dengan http:// atau https://' }
  let u: any
  try { u = new URL(url) } catch { return { error: 'URL tidak sah' } }
  const host = String(u.hostname || '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { error: 'Hos dalaman tidak dibenarkan' }
  }
  const had = Math.min(Math.max(parseInt(String(body?.had ?? '12000'), 10) || 12000, 500), 40000)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MyworkerBot/1.0; +https://crypto-micro-agent.mykira.workers.dev)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
    },
    redirect: 'follow'
  }).catch(() => null)
  if (!res) return { error: 'Gagal mengambil URL', url }
  if (!res.ok) return { error: 'HTTP ' + res.status, url }
  const ctype = String(res.headers.get('content-type') || '')
  if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype)) return { error: 'Kandungan bukan HTML/teks (' + ctype + ')', url }
  const mentah = (await res.text()).slice(0, 600000)
  const tajuk = (mentah.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  const penuh = htmlKeMarkdown(mentah)
  const md = penuh.slice(0, had)
  return {
    url: String(res.url || url),
    tajuk: tajuk || null,
    markdown: md,
    panjang: md.length,
    panjang_asal: penuh.length,
    dipotong: penuh.length > md.length
  }
}

// ---------------------------------------------------------------- servis data (baharu)

/** Angka selamat -> number | null (null bila hilang / bukan nombor). */
const angka = (v: any): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))

/** Metadata PENUH satu token dari Jupiter search. null kalau tak dijumpai. */
async function tokenJup(q: string): Promise<any> {
  const r: any = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Myworker-Agent-API/1.0' }
  }).then((x) => x.json()).catch(() => null)
  if (!Array.isArray(r) || !r.length) return null
  const q2 = String(q).toLowerCase()
  return r.find((x: any) => String(x?.id) === q) ||
    r.find((x: any) => String(x?.symbol || '').toLowerCase() === q2) ||
    r[0] || null
}

/** Simbol pemenang satu metrik dalam senarai baris (null kalau tiada data). */
function pemenang(baris: any[], kunci: string, arah: 'tinggi' | 'rendah'): string | null {
  const ada = baris.filter((b) => typeof b?.[kunci] === 'number')
  if (!ada.length) return null
  const t = ada.reduce((a, b) => ((arah === 'tinggi') === (b[kunci] > a[kunci]) ? b : a))
  return t.simbol || t.mint || null
}

/**
 * BANDING 2-5 token bersebelahan + pemenang setiap metrik.
 * Satu panggilan ganti 5 panggilan — dan keputusan perbandingan dibuat dengan
 * kaedah yang SAMA setiap kali (bukan disuruh model, yang boleh berubah).
 */
async function servisBanding(env: any, input: string): Promise<any> {
  const diminta = String(input || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5)
  if (diminta.length < 2) return { error: 'Perlu 2 hingga 5 token dipisah koma, cth: sol,bonk,jup' }
  const dapat = await Promise.all(diminta.map((n) => tokenJup(n)))
  const baris = dapat.map((t, i) => (t ? ringkasToken(t, i + 1) : { pangkat: i + 1, diminta: diminta[i], ralat: 'tidak dijumpai' }))
  return {
    sumber: 'jupiter-tokens-v2 (search)',
    masa: new Date().toISOString(),
    bilangan: baris.length,
    token: baris,
    pemenang: {
      kecairan_tertinggi: pemenang(baris, 'kecairan_usd', 'tinggi'),
      pemegang_terbanyak: pemenang(baris, 'bilangan_pemegang', 'tinggi'),
      skor_organik_tertinggi: pemenang(baris, 'skor_organik', 'tinggi'),
      naik_24j_tertinggi: pemenang(baris, 'perubahan_24j_pct', 'tinggi'),
      turun_24j_paling_banyak: pemenang(baris, 'perubahan_24j_pct', 'rendah')
    },
    nota: 'Pemenang dikira daripada medan yang ADA sahaja. Kecairan & pemegang rendah = risiko lebih tinggi.'
  }
}

/**
 * TOKEN MUDA yang SUDAH ADA DAYA TARIKAN dan LULUS saringan keselamatan.
 *
 * Sumber lalai: senarai skor organik tertinggi 24j Jupiter — token yang sudah
 * ada dagangan sebenar. Kita tapis UMUR, kuasa cetak/beku, bekalan pembangun,
 * kecairan, bilangan pemegang dan tumpuan 10 pemegang teratas.
 *
 * Mod "baharu" memberi pelancaran TERKINI dengan saringan audit sahaja —
 * kecairan biasanya belum diindeks, dan itu DINYATAKAN dalam hasil (jujur).
 */
async function servisTokensBaharu(env: any, input: string): Promise<any> {
  const b = String(input || '').split('|')
  const jenis = b[0] === 'baharu' ? 'baharu' : 'organik'
  const had = Math.min(Math.max(parseInt(b[1] || '10', 10) || 10, 1), 25)
  const minKecairan = Math.max(parseInt(b[2] || '5000', 10) || 0, 0)
  const minPemegang = Math.max(parseInt(b[3] || '25', 10) || 0, 0)
  const top10Maks = Math.min(Math.max(parseInt(b[4] || '70', 10) || 70, 10), 100)
  const maksUmur = Math.min(Math.max(parseInt(b[5] || '7', 10) || 7, 1), 90)

  const url = jenis === 'baharu'
    ? 'https://lite-api.jup.ag/tokens/v2/recent'
    : 'https://lite-api.jup.ag/tokens/v2/toporganicscore/24h'
  const mentah: any = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Myworker-Agent-API/1.0' }
  }).then((r) => r.json()).catch(() => null)
  if (!Array.isArray(mentah)) return { error: 'Sumber token tidak menjawab', sumber: 'jupiter-tokens-v2' }

  const lulus: any[] = []
  const ditolak: any[] = []
  const tolak = (simbol: any, mint: any, sebab: string[]) => {
    if (ditolak.length < 8) ditolak.push({ simbol: simbol || null, mint: mint || null, sebab })
  }

  for (const t of mentah) {
    const a = t?.audit || {}
    const sebab: string[] = []
    if (a.mintAuthorityDisabled === false) sebab.push('kuasa cetak (mint authority) masih aktif')
    if (a.freezeAuthorityDisabled === false) sebab.push('kuasa beku (freeze authority) masih aktif')
    const devP = angka(a.devBalancePercentage)
    if (devP !== null && devP > 5) sebab.push('pembangun pegang ' + devP.toFixed(2) + '% bekalan')
    const devMints = angka(a.devMints)
    if (devMints !== null && devMints > 200) sebab.push('pembangun telah melancarkan ' + devMints + ' token')

    // Mod "baharu": sumber recent tiada kecairan/pemegang — ambil dari search.
    const penuh = jenis === 'baharu' && MINT_RE.test(String(t?.id || '')) ? await tokenJup(String(t.id)) : t
    const r = ringkasToken(penuh || t, 0)
    const top10 = angka((penuh || t)?.audit?.topHoldersPercentage)

    if (jenis === 'organik') {
      if (r.umur_hari === null || r.umur_hari > maksUmur) {
        sebab.push('umur ' + (r.umur_hari === null ? 'tidak diketahui' : r.umur_hari + ' hari') + ' melebihi had ' + maksUmur + ' hari')
      }
      if (r.kecairan_usd === null || r.kecairan_usd < minKecairan) {
        sebab.push('kecairan di bawah $' + minKecairan + ' (sebenar: ' + (r.kecairan_usd === null ? 'tiada data' : '$' + Math.round(r.kecairan_usd)) + ')')
      }
      if (r.bilangan_pemegang === null || r.bilangan_pemegang < minPemegang) {
        sebab.push('pemegang kurang daripada ' + minPemegang + ' (sebenar: ' + (r.bilangan_pemegang === null ? 'tiada data' : r.bilangan_pemegang) + ')')
      }
      if (top10 !== null && top10 > top10Maks) {
        sebab.push('10 pemegang teratas pegang ' + top10.toFixed(2) + '% (had ' + top10Maks + '%)')
      }
    }
    if (sebab.length) { tolak(r.simbol || t?.symbol, r.mint || t?.id, sebab); continue }

    lulus.push({
      ...r,
      pangkat: 0,
      tumpuan: { top10_peratus: top10, pembangun_peratus: devP },
      audit: { kuasa_cetak_dilumpuhkan: a.mintAuthorityDisabled === true, kuasa_beku_dilumpuhkan: a.freezeAuthorityDisabled === true },
      data_pasaran_lengkap: r.kecairan_usd !== null
    })
  }

  // Untuk mod organik, susun ikut skor organik (kualiti dagangan), bukan ikut kecairan mentah.
  if (jenis === 'organik') lulus.sort((x, y) => Number(y.skor_organik || 0) - Number(x.skor_organik || 0))
  const akhir = lulus.slice(0, had).map((x, i) => ({ ...x, pangkat: i + 1 }))

  return {
    sumber: jenis === 'baharu'
      ? 'jupiter-tokens-v2 (recent + search)'
      : 'jupiter-tokens-v2 (toporganicscore/24h)',
    jenis,
    masa: new Date().toISOString(),
    tapisan: {
      kuasa_cetak_dan_beku_mesti_dilumpuhkan: true,
      pembangun_maks_peratus: 5,
      maks_umur_hari: jenis === 'organik' ? maksUmur : null,
      min_kecairan_usd: jenis === 'organik' ? minKecairan : null,
      min_pemegang: jenis === 'organik' ? minPemegang : null,
      top10_maks_peratus: jenis === 'organik' ? top10Maks : null
    },
    dipindai: mentah.length,
    lulus: akhir.length,
    token: akhir,
    ditolak_contoh: ditolak,
    nota: jenis === 'organik'
      ? 'Senarai ini ialah token MUDA (dalam had umur) yang sudah ada kecairan & pemegang sebenar serta lulus saringan kuasa/bekalan. Risiko token muda tetap tinggi — sahkan semula sebelum urus niaga.'
      : 'Mod "baharu" memberi pelancaran TERKINI dengan saringan audit sahaja; medan kecairan/pemegang selalunya kosong kerana belum diindeks (lihat data_pasaran_lengkap). Risiko SANGAT tinggi.'
  }
}

/** URL -> Markdown -> ringkasan AI dalam SATU panggilan (jimat masa & token agen). */
async function servisKikisRingkas(env: any, input: string, body?: any): Promise<any> {
  const k = await servisKikis(env, input, body)
  if (k?.error) return k
  const arahan = str(body?.arahan ?? body?.soalan) || 'Ringkaskan halaman ini kepada poin utama yang padat.'
  const md = String(k.markdown || '').slice(0, 12000)
  const ringkasan = await askAi(env, `${arahan}\n\n---\n${md}`,
    'Anda penganalisis kandungan web. Jawab dalam Bahasa Melayu, padat dan tepat, tiada mukadimah. Guna poin bila sesuai.')
  return {
    url: k.url,
    tajuk: k.tajuk,
    arahan,
    ringkasan: ringkasan || null,
    markdown: k.markdown,
    panjang: k.panjang,
    dipotong: k.dipotong,
    nota: k.dipotong
      ? 'Markdown dipotong sebelum diringkaskan — bahagian hujung halaman mungkin tiada dalam ringkasan.'
      : 'Halaman penuh telah diringkaskan.'
  }
}

/** Analisis sentimen — pulangkan OBJEK berstruktur supaya agen boleh guna terus. */
export 
/**
 * Baca baki asas (chain read murah).
 * Menyokong Solana (SOL) dan Base (ETH/USDC).
 */
async function servisBacaBaki(env: any, input: string): Promise<any> {
  const bahagian = String(input || '').split(/[\s,]+/).filter(Boolean)
  const alamat = bahagian[0] || ''
  const rangkaian = (bahagian[1] || 'solana').toLowerCase()

  if (!alamat) return { error: 'Sila berikan alamat dompet. Contoh: {"alamat":"0x...","rangkaian":"base"}' }

  try {
    if (rangkaian === 'solana') {
      const rpcUrl = 'https://api.mainnet-beta.solana.com'
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [alamat] })
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      const lamports = data.result?.value || 0
      return { rangkaian: 'solana', alamat, baki_sol: lamports / 1e9, baki_lamports: lamports }
    } 
    
    if (rangkaian === 'base') {
      const rpcUrl = 'https://base-rpc.publicnode.com'
      // Semak ETH
      const resEth = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [alamat, 'latest'] })
      })
      const dataEth = await resEth.json()
      if (dataEth.error) throw new Error(dataEth.error.message)
      const wei = BigInt(dataEth.result || '0x0')
      const bakiEth = Number(wei) / 1e18

      // Semak USDC (kontrak 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
      const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      const dataHex = '0x70a08231000000000000000000000000' + alamat.replace('0x', '')
      const resUsdc = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdcAddress, data: dataHex }, 'latest'] })
      })
      const dataUsdc = await resUsdc.json()
      const usdcRaw = dataUsdc.result && dataUsdc.result !== '0x' ? BigInt(dataUsdc.result) : BigInt(0)
      const bakiUsdc = Number(usdcRaw) / 1e6

      return { rangkaian: 'base', alamat, baki_eth: bakiEth, baki_usdc: bakiUsdc }
    }

    return { error: 'Rangkaian tidak disokong. Guna "solana" atau "base".' }
  } catch (e: any) {
    return { error: e?.message || 'Gagal membaca baki' }
  }
}

async function servisSentimen(env: any, input: string): Promise<any> {
  const teks = str(input).slice(0, 6000)
  if (!teks) return { error: 'Teks kosong' }
  const keluar = await askAi(
    env,
    'Analisis sentimen teks di bawah. Pulangkan JSON SAHAJA (tiada kod fence, tiada penjelasan) dengan bentuk tepat:\n' +
      '{"sentimen":"positif|neutral|negatif","skor":<-1.0 hingga 1.0>,"keyakinan":<0.0 hingga 1.0>,"emosi":["..."],"sebab":["..."]}\n\nTeks:\n' + teks,
    'Anda penganalisis sentimen profesional. Jawab JSON sahaja.'
  )
  const bersih = String(keluar || '').replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim()
  let obj: any = null
  try { obj = JSON.parse(bersih) } catch { obj = null }
  // Patch: cuba ekstrak JSON dan retry sekali sebelum fallback
  if (!obj || typeof obj !== "object") {
    try { const m1 = bersih.match(/\{[\s\S]*\}/); if (m1) obj = JSON.parse(m1[0]); } catch {}
  }
  if (!obj || typeof obj !== "object") {
    const cuba2 = await askAi(env, "Ulangi analisis sentimen teks:" + teks, "Anda penganalisis sentimen profesional. Pulangkan JSON SAHAJA.", 500);
    const bersih2 = String(cuba2 || "").replace(/^\s*```[a-zA-Z]*\s*\n?/, "").replace(/\n?\s*```\s*$/ , "").trim();
    try { obj = JSON.parse(bersih2) } catch { const m2 = bersih2.match(/\{[\s\S]*\}/); if (m2) try { obj = JSON.parse(m2[0]) } catch {} }
  }
  if (!obj || typeof obj !== "object") {
    return { sentimen: null, skor: null, keyakinan: null, mentah: bersih.slice(0, 800), panjang_teks: teks.length, nota: 'Model tidak memulangkan JSON sah — guna medan "mentah".' }
  }
  const senarai = (v: any, had: number): string[] => (Array.isArray(v) ? v.slice(0, had).map((x: any) => str(x)).filter(Boolean) : [])
  return {
    sentimen: str(obj.sentimen) || null,
    skor: angka(obj.skor),
    keyakinan: angka(obj.keyakinan),
    emosi: senarai(obj.emosi, 8),
    sebab: senarai(obj.sebab, 5),
    panjang_teks: teks.length
  }
}

/** Dua akaun paling sibuk sebagai rujukan lalai untuk yuran keutamaan. */
const AKAUN_SIBUK = [SOL_MINT, USDC_MINT]

/**
 * Yuran rangkaian Solana semasa + taburan tip keutamaan.
 *
 * PENTING: yuran keutamaan dikira PER AKAUN yang boleh ditulis. Menghantar
 * senarai akaun KOSONG membuat RPC memulangkan sifar (menyesatkan), jadi kita
 * minta akaun daripada pemanggil dan NYATAKAN akaun mana yang disampel.
 */
async function servisYuran(env: any, input: string): Promise<any> {
  const diberi = String(input || '').split(',').map((s) => s.trim()).filter((s) => MINT_RE.test(s)).slice(0, 5)
  const akaun = diberi.length ? diberi : AKAUN_SIBUK
  const rate = await solUsd(env).catch(() => 0)
  // Berurutan (BUKAN selari): dua panggilan RPC serentak ke URL awam yang sama
  // mudah kena had kadar (429) → TPS jadi null. Berurutan lebih boleh dipercayai.
  const pf = await rpc(env, 'getRecentPrioritizationFees', [akaun]).catch(() => null)
  const ps = await rpc(env, 'getRecentPerformanceSamples', [3]).catch(() => null)
  const fees: number[] = (Array.isArray(pf) ? pf : [])
    .map((x: any) => Number(x?.prioritizationFee || 0))
    .filter((x: number) => Number.isFinite(x) && x >= 0)
    .sort((a: number, b: number) => a - b)
  const pct = (p: number): number | null =>
    fees.length ? fees[Math.min(fees.length - 1, Math.max(0, Math.round(p * (fees.length - 1))))] : null
  const med = pct(0.5)
  const cu = 200000
  const lamTip = med === null ? null : Math.ceil((med * cu) / 1e6)
  const jumlahLam = lamTip === null ? null : 5000 + lamTip
  const sampel = Array.isArray(ps) ? ps : []
  const tps = sampel.length
    ? Math.round(sampel.reduce((a: number, s: any) => a + Number(s?.numTransactions || 0) / Math.max(1, Number(s?.samplePeriodSecs || 1)), 0) / sampel.length)
    : null
  return {
    sumber: 'solana-rpc (getRecentPrioritizationFees, getRecentPerformanceSamples)',
    masa: new Date().toISOString(),
    akaun_disampel: akaun,
    akaun_lalai: diberi.length ? false : true,
    yuran_asas_lamports_setiap_tandatangan: 5000,
    keutamaan_mikro_lamport_setiap_unit: {
      minimum: fees.length ? fees[0] : null,
      median: pct(0.5),
      p75: pct(0.75),
      p90: pct(0.9),
      maksimum: fees.length ? fees[fees.length - 1] : null,
      bilangan_sampel: fees.length
    },
    contoh_anggaran_200k_unit_pengiraan: {
      lamports_yuran_asas: 5000,
      lamports_tip_pada_median: lamTip,
      jumlah_lamports: jumlahLam,
      jumlah_sol: jumlahLam === null ? null : Number((jumlahLam / LAMPORTS).toFixed(9)),
      jumlah_usd: jumlahLam === null || !rate ? null : Number(((jumlahLam / LAMPORTS) * rate).toFixed(6))
    },
    tps_rangkaian_anggaran: tps,
    nota: 'Yuran asas 5000 lamports setiap tandatangan. Tip keutamaan dikira PER AKAUN yang boleh ditulis — hantar "akaun" (alamat dipisah koma, maks 5) untuk anggaran tepat bagi urus niaga anda. Jika tidak, dua akaun paling sibuk (SOL & USDC) digunakan sebagai rujukan, jadi angka sebenar urus niaga anda boleh BERBEZA.'
  }
}

// ---------------------------------------------------------------- FX / utiliti / yield (19 Okt 2026)

// Sesetengah host (jsdelivr, exchangerate-api, frankfurter) memulangkan HTTP 404 kepada
// fetch Cloudflare Workers yang sama (UA "Cloudflare-Workers") walaupun URL sah — jadi
// hantar UA/Accept eksplisit. Nager & DefiLlama & Jupiter tiada masalah tanpa ini.
const KEPALA_JSON: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; MyworkerAgent/1.0; +https://crypto-micro-agent.mykira.workers.dev/agent)',
  'Accept': 'application/json'
}

/** Kadar FX semasa. Sumber 1: open.er-api.com (percuma, tiada kunci, merangkumi MYR). Sandaran: Frankfurter (ECB). */
async function servisFx(env: any, input: string, body?: any): Promise<any> {
  const dariRaw = String(body?.dari ?? body?.from ?? body?.matawang ?? input ?? 'USD')
  const keRaw = String(body?.ke ?? body?.to ?? '')
  // Sempadan perkataan \b WAJIB — tanpa itu, kata panjang (cth "KADAR") dipecah
  // menjadi cebisan 3 huruf palsu (KAD) dan menjadi base matawang tidak sah.
  const Kod3 = /\b[A-Z]{3}\b/g
  const kodDari = (dariRaw.toUpperCase().match(Kod3) || [])
  const asas = kodDari[0] || 'USD'
  let sasaran = (keRaw.toUpperCase().match(Kod3) || [])
  if (!sasaran.length) sasaran = kodDari.slice(1)
  sasaran = sasaran.filter((c) => c !== asas).slice(0, 6)
  if (!sasaran.length) sasaran = ['EUR', 'GBP', 'SGD', 'IDR']
  let percubaan: string[] = []
  // Sumber 1: currency-api (fawazahmed0) via jsdelivr — stabil, percuma, merangkumi MYR.
  try {
    const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${asas.toLowerCase()}.min.json`, { headers: KEPALA_JSON } as any)
    if (!r.ok) {
      let badan = ''
      try { badan = (await r.text()).slice(0, 120) } catch { }
      throw new Error(`HTTP ${r.status}: ${badan}`)
    }
    const j: any = await r.json()
    const kadarSumber = j?.[asas.toLowerCase()]
    if (kadarSumber) {
      const kadar: Record<string, number | null> = {}
      for (const c of sasaran) kadar[c] = Number.isFinite(Number(kadarSumber[c.toLowerCase()])) ? Number(kadarSumber[c.toLowerCase()]) : null
      return {
        sumber: `currency-api@${j.date || 'latest'} via jsdelivr`,
        asas,
        kadar,
        nota: `Nilai kadar = berapa ${sasaran.join('/')} untuk 1 ${asas}. Kadar rujukan pasaran harian — bank menambah spread. Kod tidak sah = null.`
      }
    }
    percubaan.push('jsdelivr-npm: HTTP ok tapi tiada objek')
  } catch (e: any) { percubaan.push(`jsdelivr-npm: ${e?.message || 'gagal'}`) }
  // Sumber 1b: currency-api via jsdelivr GH (susun atur lama, layan @1)
  try {
    const rg = await fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/${asas.toLowerCase()}.min.json`, { headers: KEPALA_JSON } as any)
    if (!rg.ok) throw new Error(`HTTP ${rg.status}`)
    const jg: any = await rg.json()
    const kadarGh = jg?.[asas.toLowerCase()]
    if (kadarGh) {
      const kadar: Record<string, number | null> = {}
      for (const c of sasaran) kadar[c] = Number.isFinite(Number(kadarGh[c.toLowerCase()])) ? Number(kadarGh[c.toLowerCase()]) : null
      return {
        sumber: `currency-api-gh@${jg.date || 'latest'} via jsdelivr`,
        asas,
        kadar,
        nota: `Nilai kadar = berapa ${sasaran.join('/')} untuk 1 ${asas}. Kadar rujukan pasaran harian — bank menambah spread. Kod tidak sah = null.`
      }
    }
    percubaan.push('jsdelivr-gh: HTTP ok tapi tiada objek')
  } catch (e: any) { percubaan.push(`jsdelivr-gh: ${e?.message || 'gagal'}`) }
  // Sumber 1c: api.exchangerate-api.com v4 (percuma, tanpa kunci) — format: {provider, date, rates}
  try {
    const re = await fetch(`https://api.exchangerate-api.com/v4/latest/${asas}`, { headers: KEPALA_JSON } as any)
    if (!re.ok) throw new Error(`HTTP ${re.status}`)
    const je: any = (await re.json()) as any
    if (je?.rates) {
      const kadar: Record<string, number | null> = {}
      for (const c of sasaran) kadar[c] = Number.isFinite(Number(je.rates[c])) ? Number(je.rates[c]) : null
      return {
        sumber: 'exchangerate-api.com v4',
        diemas: je.date || null,
        asas,
        kadar,
        percubaan,
        nota: `Nilai kadar = berapa ${sasaran.join('/')} untuk 1 ${asas}. Kadar rujukan pasaran — bank menambah spread. Kod tidak sah = null.`
      }
    }
    percubaan.push(`exchangerate-api: format/${String(je?.provider || 'n/a')}`)
  } catch (e: any) { percubaan.push(`exchangerate-api: ${e?.message || 'gagal'}`) }
  // Sumber 2: open.er-api.com — format: {result:"success", time_last_update_utc, rates}
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${asas}`, { headers: KEPALA_JSON } as any)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j: any = await r.json()
    if (j?.result === 'success' && j?.rates) {
      const kadar: Record<string, number | null> = {}
      for (const c of sasaran) kadar[c] = Number.isFinite(Number(j.rates[c])) ? Number(j.rates[c]) : null
      return {
        sumber: 'open.er-api.com',
        diemas: j.time_last_update_utc || null,
        asas,
        kadar,
        percubaan,
        nota: `Nilai kadar = berapa ${sasaran.join('/')} untuk 1 ${asas}. Kadar rujukan pasaran — bank menambah spread. Kod tidak sah = null.`
      }
    }
    percubaan.push(`er-api: format/${String(j?.result || 'n/a')}`)
  } catch (e: any) { percubaan.push(`er-api: ${e?.message || 'gagal'}`) }
  // Sandaran: Frankfurter (ECB; tiada MYR) — domain baharu frankfurter.dev
  try {
    const r2 = await fetch(`https://api.frankfurter.dev/v1/latest?base=${asas}&symbols=${sasaran.join(',')}`, { headers: KEPALA_JSON } as any)
    if (!r2.ok) throw new Error(`HTTP ${r2.status}`)
    const j2: any = await r2.json()
    if (j2?.rates) {
      return {
        sumber: 'frankfurter.dev (ECB)',
        diemas: j2.date || null,
        asas,
        kadar: j2.rates,
        percubaan,
        nota: 'ECB — sesetengah matawang (cth MYR) tiada; null.'
      }
    }
  } catch (e: any) { percubaan.push(`frankfurter: ${e?.message || 'gagal'}`) }
  return { ralat: 'Semua sumber FX gagal — cuba lagi nanti.', percubaan }
}
/** Kotak alat deterministik untuk agent. */
async function servisUtil(env: any, input: string, body?: any): Promise<any> {
  const teks = str(body?.text ?? body?.input ?? body?.prompt ?? '')
  const inp = String(input || '').trim()
  const PemetaanOp: Record<string, string> = {
    encode64: 'encode64', 'base64-encode': 'encode64', base64: 'encode64', b64encode: 'encode64', encode: 'encode64',
    decode64: 'decode64', 'base64-decode': 'decode64', b64decode: 'decode64', decode: 'decode64',
    sha256: 'sha256', 'sha-256': 'sha256', hash: 'sha256',
    uuid: 'uuid', guid: 'uuid', uuidv4: 'uuid',
    masa: 'masa', waktu: 'masa', time: 'masa', timestamp: 'masa', date: 'masa',
    cuti: 'cuti', holiday: 'cuti', holidays: 'cuti'
  }
  let op = PemetaanOp[String(body?.op ?? body?.mode ?? '').trim().toLowerCase().replace(/[ _]/g, '')] || ''
  if (!op) op = PemetaanOp[(inp.split(/\s+/)[0] || '').toLowerCase().replace(/[ _]/g, '')] || ''
  if (!op) {
    // Imbas SEMUA perkataan input — "jana uuid untuk id" -> kata ke-2 "uuid".
    for (const k of inp.split(/\s+/)) {
      const v = PemetaanOp[k.toLowerCase().replace(/[^a-z0-9-/]/g, '')] || ''
      if (v) { op = v; break }
    }
  }
  // Input "base64 decode ..." mengumpil "base64" dahulu — semak kehadiran 'decode'
  // supaya diarahkan dengan betul.
  if (op === 'encode64' && /decod/i.test(inp + ' ' + String(body?.text ?? ''))) op = 'decode64'
  if (!op) {
    return {
      ralat: 'op tidak dikenali — hantar "op"',
      op_tersedia: ['encode64 (text)', 'decode64 (text)', 'sha256 (text)', 'uuid', 'masa', 'cuti (tahun, negara)'],
      contoh: 'Cuba {"op":"sha256","text":"hello"} atau {"op":"cuti","tahun":2027,"negara":"MY"}'
    }
  }
  const formatskan = (s: string): string =>
    s.replace(/^\s*(?:base64\s*(?:encode|decode)?\d*\s*|encode64\s+|decode64\s+|b64\s*(?:encode|decode)?\s*|sha[- ]?256\s+|hash\s+)/i, '').trim()
  const dataTeks = formatskan(teks) || formatskan(inp)
  if (op === 'encode64') return { op, panjang_masukan: dataTeks.length, hasil_b64: b64(dataTeks) }
  if (op === 'decode64') {
    try { return { op, hasil_teks: unb64(dataTeks), bait: atob(dataTeks).length }
    } catch { return { op, ralat: 'bukan base64 sah — hantar {text:"..."}' } }
  }
  if (op === 'sha256') {
    const bytes = new TextEncoder().encode(dataTeks)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('')
    return { op, panjang_masukan: dataTeks.length, sha256_hex: hex, sha256_bait: 32 }
  }
  if (op === 'uuid') return { op, uuid: crypto.randomUUID(), nota: 'UUID v4 rawak.'
  }
  if (op === 'masa') {
    const d = new Date()
    return { op, unix_detik: Math.floor(d.getTime() / 1000), iso_utc: d.toISOString(), zon: 'UTC', ms_epoch: d.getTime() }
  }
  if (op === 'cuti') {
    const tahun = Number(body?.tahun ?? inp.match(/20\d\d/)?.[0] ?? new Date().getUTCFullYear())
    const SinonimNegara: Record<string, string> = {
      MY: 'MY', SINGAPURA: 'SG', SINGAPORE: 'SG', SG: 'SG', INDONESIA: 'ID', ID: 'ID',
      MALAYSIA: 'MY', AMERIKA: 'US', 'U S A': 'US', USA: 'US', US: 'US', AEB: 'AE', UK: 'GB',
      BRUNEI: 'BN', BN: 'BN' , THAILAND: 'TH', TH: 'TH'
    }
    const kodNegeri = (String(body?.negara ?? '').toUpperCase().match(/\b[A-Z]{2}\b/) || [])[0]
    const namaNegara = inp.toUpperCase().match(/\b(MALAYSIA|SINGAP(URA|ORE)|INDONESIA|AMERIKA|USA|BRUNEI|THAILAND|UK|U S A)\b/)?.[1]
    const negara = kodNegeri || SinonimNegara[String(body?.negara ?? '').trim().toUpperCase()] || SinonimNegara[namaNegara || ''] || 'US'
    // Nager.memulangkan 204 bila kombinasi negara/tahun tidak dihargai — cuba tahun lurus (t-1, t..t+1).
    for (const t of [tahun, tahun - 1, tahun + 1]) {
      try {
        const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${t}/${negara}`, { headers: KEPALA_JSON } as any)
        if (r.status === 204 || !r.ok) continue
        const j: any = await r.json()
        if (Array.isArray(j) && j.length) {
          const had = j.slice(0, 20).map((h: any) => ({ tarikh: h.date, nama: h.name, nama_tempatan: h.localName, jenis: (h.types || []).join('/') }))
          return { op, tahun: t, negara, jumlah: j.length, nota: `Data tahun ${t}${t === tahun ? '' : ' (tahun diminta tiada data, dipulangkan terdekat)'}; maks 20 dipaparkan; senarai penuh di date.nager.at.`, cuti: had }
        }
      } catch { /* cuba tahun lain */ }
    }
    return { op, tahun, negara, ralat: `Tiada cuti ${negara} di date.nager.at untuk tahun ${tahun - 1}–${tahun + 1} (204 = sumber tak ada data). Kod negara ISO 2, cth US, SG, ID, GB.` }
  }
  return { op, ralat: 'op tidak dikenali' }
}

/** Cache melori top-yield (10 min) — /pools DefiLlama besar, jangan ambil setiap kali. */
let YIELD_CACHE: { masa: number, atas: any[], atas_stabil: any[] } | null = null

async function servisYield(env: any, input: string, body?: any): Promise<any> {
  const jumlah = Math.min(10, Math.max(1, Number(body?.jumlah ?? body?.n ?? (String(input).match(/\b(\d+)\b/)?.[1]) ?? 5)))
  const stabil = /stabil|stable/i.test(String(input) + ' ' + String(body?.stabil ?? ''))
  const sekarang = Date.now()
  if (!YIELD_CACHE || sekarang - YIELD_CACHE.masa > 10 * 60 * 1000) {
    const r = await fetch('https://yields.llama.fi/pools', { headers: KEPALA_JSON } as any)
    const j: any = await r.json()
    const semua: any[] = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : [])
    const layak = semua.filter((p: any) => Number(p?.tvlUsd) >= 10_000_000 && Number.isFinite(Number(p?.apy)) && Number(p?.apy) > 0)
    const susun = (stabilSahaja: boolean) => layak
      .filter((p: any) => (stabilSahaja ? p.stablecoin === true : true))
      .sort((a: any, b: any) => Number(b.apy) - Number(a.apy))
      .slice(0, 20)
      .map((p: any) => ({
        projek: p.project,
        simpbol: p.symbol,
        rangkaian: p.chain,
        apy_peratus: Number(Number(p.apy).toFixed(2)),
        apy_asas_peratus: p.apyBase == null ? null : Number(Number(p.apyBase).toFixed(2)),
        apy_bonus_peratus: p.apyReward ? Number(Number(p.apyReward).toFixed(2)) : null,
        tvl_usd: Math.round(p.tvlUsd),
        stabil: p.stablecoin === true
      }))
    YIELD_CACHE = { masa: sekarang, atas: susun(false), atas_stabil: susun(true) }
  }
  const penuai = stabil ? YIELD_CACHE.atas_stabil : YIELD_CACHE.atas
  return {
    sumber: 'defillama-yields (yields.llama.fi)',
    cache_minit: Math.max(0, Math.round((10 * 60 * 1000 - (sekarang - YIELD_CACHE.masa)) / 60000)),
    disungi_tvl_usd: 10000000,
    jumlah_diminta: jumlah,
    tapis_stabil: stabil,
    hasil: penuai.slice(0, jumlah),
    nota: 'APY pasaran — boleh berubah setiap hari dan bonus rewards sering tidak malar. TVL disungi ≥ $10 juta.'
  }
}

// ---------------------------------------------------------------- Imbas kontrak (Base) & kadar-gas (19 Okt malam)

/** Panggil RPC EVM dengan failover merentas senarai URL; pulang result atau null. */
async function panggilEvm(rpcs: string[], kaedah: string, params: any[]): Promise<any> {
  for (const url of rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { ...KEPALA_JSON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: kaedah, params })
      } as any)
      if (!r.ok) continue
      const j: any = await r.json()
      if (j?.result !== undefined) return j.result
    } catch { /* cuba RPC seterusnya */ }
  }
  return null
}

/** Decode eth_call pulang string ABI-dynamic (offset|len|bait) → teks UTF-8. */
function dekodStr(h: string): string | null {
  if (!h || h === '0x') return null
  const x = h.replace(/^0x/, '')
  if (x.length < 128) return null
  const offset = parseInt(x.slice(0, 64), 16)
  const len = parseInt(x.slice(offset * 2, offset * 2 + 64), 16)
  if (!Number.isFinite(offset) || !Number.isFinite(len) || len <= 0 || len > 1024) return null
  const raw = x.slice(offset * 2 + 64, offset * 2 + 64 + len * 2)
  const bajt = new Uint8Array(len)
  for (let i = 0; i < len; i++) bajt[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16) || 0
  return new TextDecoder().decode(bajt).replace(/[\0\s]+$/, '') || null
}

/** Imbas kontrak ERC-20 di Base: heuristik statik (kod, slot proxy EIP-1967, selector). */
async function servisKontrak(env: any, input: string, body?: any): Promise<any> {
  const sasaran = String(body?.token ?? body?.kontrak ?? body?.alamat ?? input ?? '')
  const alamat = (sasaran.match(/0x[a-fA-F0-9]{40}/) || [])[0]
  if (!alamat) {
    const solanaAdeka = /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(sasaran)
    return {
      ok: false,
      ralat: 'Alamat kontrak EVM (0x… 40 aksara hex) diperlukan — rangkaian Base.',
      nota: solanaAdeka ? 'Nampak alamat Solana dalam input — untuk token Solana guna servis "risiko" atau "saring-token".' : `Contoh (USDC Base): {"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}`
    }
  }
  const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-mainnet.public.blastapi.io']
  const panggil = (m: string, p: any[]) => panggilEvm(RPCS, m, p)
  const kod = String(await panggil('eth_getCode', [alamat, 'latest']) ?? '')
  if (!kod || kod === '0x') {
    return { ok: true, servis: 'imbas-kontrak', rangkaian: 'Base', alamat, kontrak: false, rumusan_risiko: ['Tiada kod kontrak — ini dompet biasa (EOA), bukan token.'] }
  }
  const saizKod = Math.floor((kod.length - 2) / 2)
  const panggilData = async (sel: string): Promise<string> => String(await panggil('eth_call', [{ to: alamat, data: sel }, 'latest']) ?? '')
  let proxy: boolean | null = null
  try {
    const adm = String(await panggil('eth_getStorageAt', [alamat, '0x360894a13ba1a3210667c828492db98dca26e940b693d7a3219226208303312c', 'latest']) ?? '')
    if (adm && adm !== '0x') {
      const hex = adm.toLowerCase().replace(/^0x/, '').replace(/^0+|0+$/g, '')
      proxy = hex ? true : false
    }
  } catch { proxy = null }
  const simbol = dekodStr(await panggilData('0x95d89b41'))
  const nama = dekodStr(await panggilData('0x06fdde03'))
  const desH = await panggilData('0x313ce567')
  const desimal = parseInt(String(desH).replace(/^0x/, ''), 16)
  const bekH = await panggilData('0x18160ddd')
  let bekalan: any = null
  if (bekH && bekH !== '0x' && Number.isFinite(desimal)) {
    // Sebahagian RPC pulang hex TANPA awalan 0x — paksa awalan sebelum BigInt (silap = "Cannot convert").
    const raw = BigInt('0x' + String(bekH).toLowerCase().replace(/^0x/, ''))
    bekalan = { raw: raw.toString(10), paparan: (Number(raw) / Math.pow(10, desimal)).toFixed(4).replace(/\.?0+$/, '') }
  }
  const pilih: Record<string, string> = { mint_std: '40c10f19', renounce_own: '715018a6', blacklist: '42966c68', pause: '8456cb59' }
  const dikesan: Record<string, boolean> = {}
  for (const k of Object.keys(pilih)) dikesan[k] = kod.includes(pilih[k])
  const risiko: string[] = []
  if (proxy) risiko.push('Kontrak proxy upgradeable (EIP-1967) — logik boleh ditukar pemegang admin.')
  if (dikesan.mint_std) risiko.push('Selector mint() standard dikesan — bekalan boleh diterbitkan semula.')
  if (saizKod < 2000) risiko.push(`Kod kecil (${saizKod} bait) — fungsi terhad, nilai semula dengan teliti.`)
  return {
    ok: true,
    servis: 'imbas-kontrak',
    rangkaian: 'Base',
    alamat,
    kontrak: true,
    saiz_kod_bait: saizKod,
    erc20: { nama: nama || null, simbol: simbol || null, desimal: Number.isFinite(desimal) ? desimal : null, bekalan },
    proxy_upgradeable: proxy,
    selector_dikesan: dikesan,
    rumusan_risiko: risiko,
    nota: 'Pengimbasan heuristik statik — BUKAN audit keselamatan penuh; simulasi jual-beli honeypot tidak dilakukan.'
  }
}

/** Gas live EVM (eth_gasPrice) + tip keutamaan Solana — RPC awam percuma. */
async function servisGas(env: any, input: string, body?: any): Promise<any> {
  const SoRang = String(body?.rangkaian ?? body?.chain ?? input ?? '').toLowerCase()
  const SRT: Record<string, string> = {
    ethereum: 'https://ethereum-rpc.publicnode.com',
    base: 'https://base-rpc.publicnode.com',
    arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
    optimism: 'https://optimism-rpc.publicnode.com'
  }
  const dipilih = Object.keys(SRT).filter((k) => SoRang.includes(k))
  const senarai = dipilih.length ? dipilih : Object.keys(SRT)
  let ethUsd: number | null = null
  try {
    const j: any = await (await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { headers: { Accept: 'application/json' } } as any)).json()
    ethUsd = Number(j?.data?.amount) || null
  } catch { ethUsd = null }
  const hasil: Record<string, any> = {}
  for (const k of senarai) {
    const g = await panggilEvm([SRT[k]], 'eth_gasPrice', [])
    if (g != null) {
      // Hex RPC kadang-kadang tanpa awalan 0x — normalisasi selepas BigInt() gagal.
      const wei = BigInt('0x' + String(g).toLowerCase().replace(/^0x/, ''))
      const gwei = Number(wei) / 1e9
      hasil[k] = {
        wei: wei.toString(),
        gwei: Number(gwei.toFixed(6)),
        anggaran_usd_transfer_21k: ethUsd ? Number((gwei * 1e-9 * 21000 * ethUsd).toFixed(5)) : null
      }
    } else hasil[k] = { ralat: 'RPC tidak sedia seketika — cuba lagi' }
  }
  let solana: any = null
  if (!dipilih.length || SoRang.includes('sol')) {
    try {
      const r = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { ...KEPALA_JSON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [] })
      } as any)
      const j: any = await r.json()
      const fees = ((j?.result || []) as any[]).map((x) => Number(x?.prioritizationFee) || 0)
      fees.sort((a, b) => a - b)
      const median = fees.length ? fees[Math.floor(fees.length / 2)] : 0
      solana = {
        tip_keutamaan_median_mikrolamport: median,
        contoh_100k_cu_lamport: Math.round((median / 1e6) * 100000),
        yuran_asas_lamport: 5000
      }
    } catch { solana = { ralat: 'RPC Solana tidak sedia — untuk butiran penuh guna servis "yuran-rangkaian"' } }
  }
  return {
    ok: true,
    servis: 'kadar-gas',
    masa: new Date().toISOString(),
    harga_eth_usd: ethUsd,
    rangkaian: hasil,
    ...(solana ? { solana } : {}),
    nota: 'eth_gasPrice = kadar sekejap; anggaran transfer stack 21,000 unit gas (EIP-1559: patut simpan +/- 20% margin). Solana: yuran asas 5000 lamport + tip keutamaan (pilihan).'
  }
}

// ---------------------------------------------------------------- AI

async function askAi(env, text, system, maxTokens = 900) {
  for (const model of AI_MODELS) {
    try {
      const r = await env?.AI?.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: text }], max_tokens: maxTokens });
      const out = r?.response;
      if (out && typeof out === "object") {
        const s = JSON.stringify(out);
        if (s && s !== "{}" && s !== "[object Object]") return s;
        continue;
      }
      if (out && typeof out === "string") {
        const s = out.trim();
        if (s && s !== "[object Object]" && s !== "undefined" && s !== "null") return s;
        continue;
      }
      if (r && typeof r === "object" && typeof r.response === "string") {
        const s = r.response.trim();
        if (s && s !== "[object Object]") return s;
      }
    } catch {}
  }
  return "";
}

function promptAi(env: any, id: string, input: string, body?: any): string {
  const p = PLUGIN[id]
  return p?.ai?.prompt ? p.ai.prompt(input, body) : input
}

/** Pelaksana servis AI (dikongsi semua plugin AI). id = kunci plugin AI. */
async function aiJalankan(env: any, id: string, input: string, body?: any): Promise<string> {
  const p = PLUGIN[id]
  let out = await askAi(env, p?.ai?.prompt ? p.ai.prompt(input, body) : input, p?.ai?.sistem || '')
  // Servis 'json' dijanjikan JSON SAHAJA — model kadang degil dan bungkus dalam
  // kod fence markdown. Buang supaya klien boleh parse terus.
  if (out && id === 'json') {
    out = out.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim()
  }
  return out || ''
}

/** Jalankan servis melalui registry plugin. input = teks (AI) atau argumen (crypto). */
export async function jalankanServis(env: any, id: string, input: string, body?: any): Promise<string> {
  const p = PLUGIN[id]
  if (!p) return ''
  return p.jalankan(env, input, body)
}

/** Ambil "input" dari body JSON permintaan (melalui registry plugin). */
function inputDariBody(id: string, body: any): string {
  const p = PLUGIN[id]
  return p ? String(p.input(body) || '') : ''
}

// ---------------------------------------------------------------- bayaran on-chain

function proof(c: any): { tx: string, ref: string, challenge: string } {
  const out = { tx: '', ref: '', challenge: '' }
  const ps = c.req.header('payment-signature') || c.req.header('x-payment')
  if (ps) {
    try {
      const j = JSON.parse(unb64(ps))
      out.tx = String(j.tx || j.signature || j.transaction || '')
      out.ref = String(j.reference || j.ref || '')
      out.challenge = String(j.challenge || '')
    } catch { out.tx = String(ps).trim() }
  }
  out.tx = out.tx || c.req.header('x-payment-tx') || c.req.query('tx') || ''
  out.ref = out.ref || c.req.header('x-payment-ref') || c.req.query('ref') || ''
  out.challenge = out.challenge || c.req.header('x-challenge') || c.req.query('challenge') || ''
  return out
}

/** Sahkan satu transaksi: beza baki dompet kita mesti cukup. */
async function checkTx(env: any, priceUsd: number, txSig: string, expectRef: string): Promise<any> {
  const w = wallet(env)
  const mint = usdcMint(env)
  const rate = await solUsd(env)
  const perluUsdc = Math.round(Number(priceUsd) * 1e6)
  const perluLamports = Math.max(Math.round((Number(priceUsd) / rate) * LAMPORTS), 50000)

  const tx = await rpc(env, 'getTransaction', [txSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
  if (!tx) return { ok: false, reason: 'transaksi tak dijumpai' }
  if (tx.meta?.err) return { ok: false, reason: 'transaksi gagal di rantaian' }
  const nowSec = Math.floor(Date.now() / 1000)
  if (tx.blockTime && nowSec - tx.blockTime > 1800) return { ok: false, reason: 'transaksi lebih 30 minit' }

  const keys: string[] = (tx.transaction?.message?.accountKeys || []).map((k: any) => (typeof k === 'string' ? k : k.pubkey))
  if (!keys.includes(w)) return { ok: false, reason: 'dompet kita tiada dalam transaksi' }
  if (expectRef && !keys.includes(expectRef)) return { ok: false, reason: 'reference tidak sepadan' }
  const payer = keys[0] || ''

  const idx = keys.indexOf(w)
  const dSol = Number((tx.meta?.postBalances?.[idx] || 0) - (tx.meta?.preBalances?.[idx] || 0))
  if (dSol >= perluLamports) {
    return { ok: true, asset: 'sol', amount: String(perluLamports), dibayar: String(dSol), payer, txSig }
  }
  let dUsdc = 0
  for (const post of tx.meta?.postTokenBalances || []) {
    if (post.mint !== mint || post.owner !== w) continue
    const before = (tx.meta?.preTokenBalances || []).find((p: any) => p.accountIndex === post.accountIndex)
    dUsdc += Number(post.uiTokenAmount?.amount || 0) - Number(before?.uiTokenAmount?.amount || 0)
  }
  if (dUsdc >= perluUsdc) {
    return { ok: true, asset: 'usdc', amount: String(perluUsdc), dibayar: String(dUsdc), payer, txSig }
  }
  return { ok: false, reason: `jumlah tak cukup (SOL ${dSol} lamports / USDC ${dUsdc} unit)` }
}

/** Cipta cabaran bayaran baharu (dipakai oleh HTTP & Telegram). */
export async function cabaranBaru(env: any, servis: string, payload = ''): Promise<any> {
  await ensureTable(env)
  const rate = await solUsd(env)
  const usd = harga(env, servis)
  const lamports = Math.max(Math.round((usd / rate) * LAMPORTS), 50000)
  const challenge = rndHex(16)
  const ref = rndRef()
  await db(env).prepare(
    'INSERT OR IGNORE INTO agent_calls (challenge, ref, service, price_usd, network, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(challenge, ref, servis, usd, caip2(env), String(payload || '').slice(0, 6000), Date.now()).run()
  return { challenge, ref, usd, lamports, rate, wallet: wallet(env) }
}

/** Teras: sahkan bayaran + jalankan servis. Dikongsi HTTP & Telegram. */
export async function settleAgent(env: any, servis: string, input: string, p: { tx?: string, ref?: string, challenge?: string }, body?: any): Promise<any> {
  const d = db(env)
  if (!d) return { ok: false, reason: 'D1 (DB_INCOME) tidak terikat' }
  let row: any = null
  if (p.challenge) row = (await d.prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind(p.challenge).run())?.results?.[0] || null
  if (!row && p.ref) row = (await d.prepare('SELECT * FROM agent_calls WHERE ref = ? ORDER BY id DESC LIMIT 1').bind(p.ref).run())?.results?.[0] || null
  if (!row) return { ok: false, reason: 'Cabaran tak dikenali — minta cabaran baharu.' }
  if (row.service !== servis) return { ok: false, reason: 'Cabaran ini untuk servis lain.' }

  if (row.status === 'paid' && row.result) {
    return { ok: true, hasil: row.result, tx: row.tx_sig, asset: row.asset, amount: row.amount, cached: true, row }
  }

  let txSig = String(p.tx || '')
  let rpcErr = ''
  if (!txSig && (p.ref || row.ref)) {
    const cari = p.ref || row.ref
    const sigs = await rpc(env, 'getSignaturesForAddress', [cari, { limit: 5, commitment: 'confirmed' }])
      .catch((e: any) => { rpcErr = e?.message || String(e); return null })
    txSig = ((sigs || []).find((s: any) => s && !s.err) || {}).signature || ''
  }
  if (!txSig) {
    return {
      ok: false,
      reason: 'Bayaran belum dikesan pada rantaian. Cuba lagi sebentar.' + (rpcErr ? ` (RPC: ${rpcErr})` : ''),
      row
    }
  }

  // Jika pembeli beri signature transaksi terus, "reference" tidak wajib —
  // kebanyakan wallet (Brave, Phantom biasa) tak boleh letak akaun tambahan.
  // Keselamatan tetap terjamin: tx mesti wujud, tidak gagal, < 30 minit,
  // dompet kita mesti penerima, jumlah cukup, dan setiap tx hanya boleh
  // digunakan sekali (tx_sig UNIQUE pada agent_calls).
  const expectRef = p.tx ? '' : (p.ref || row.ref)
  const check = await checkTx(env, row.price_usd, txSig, expectRef)
  if (!check.ok) return { ok: false, reason: 'Bayaran tak sah: ' + check.reason, row }

  const guna = (await d.prepare('SELECT id FROM agent_calls WHERE tx_sig = ?').bind(txSig).run())?.results?.[0]
  if (guna && guna.id !== row.id) return { ok: false, reason: 'Bayaran ini sudah digunakan.', row }

  const t0 = Date.now()
  let hasil = ''
  try {
    hasil = await jalankanServis(env, servis, input || row.payload || '', body)
  } catch (e: any) {
    console.error('Agent servis gagal:', e?.message || e)
  }
  const ms = Date.now() - t0
  if (!hasil) return { ok: false, reason: 'Servis gagal dijalankan (bayaran tidak digunakan). Cuba lagi.', row }

  await d.prepare(
    'UPDATE agent_calls SET status = ?, tx_sig = ?, payer = ?, asset = ?, amount = ?, paid_at = ?, result = ?, ms = ? WHERE id = ?'
  ).bind('paid', txSig, check.payer, check.asset, check.amount, Date.now(), hasil.slice(0, 20000), ms, row.id).run()

  // Rekod sebagai pendapatan (dilihat oleh /analytics & /status)
  try {
    await d.prepare(
      'INSERT OR IGNORE INTO transactions (type, amount, token_symbol, tx_hash, status, meta, sender_address) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('agent_api_call', Number(row.price_usd), servis, txSig, 'PAID',
      JSON.stringify({ asset: check.asset, ms }), check.payer).run()
  } catch (e: any) { console.error('rekod income gagal:', e?.message || e) }

  return { ok: true, hasil, tx: txSig, asset: check.asset, amount: check.amount, payer: check.payer, ms, row }
}

// ---------------------------------------------------------------- HTTP

let statCache: { at: number, data: Record<string, any> } = { at: 0, data: {} }

/**
 * Statistik SEBENAR setiap servis dari D1: bilangan panggilan, kadar berjaya,
 * masa laksana purata. Di-cache 10 minit (satu pertanyaan sahaja untuk 12 servis).
 * Ini nilai jualan: pembeli tahu apa yang dia bayar, bukan janji kosong.
 */
async function statServis(env: any): Promise<Record<string, any>> {
  if (Date.now() - statCache.at < 600000 && Object.keys(statCache.data).length) return statCache.data
  const out: Record<string, any> = {}
  try {
    const d = db(env)
    if (d) {
      const r: any = await d.prepare(
        `SELECT service,
                COUNT(*) AS jumlah,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS dibayar,
                CAST(AVG(CASE WHEN ms > 0 THEN ms END) AS INTEGER) AS ms_purata
           FROM agent_calls GROUP BY service`
      ).run()
      for (const x of (r?.results || [])) {
        const n = Number(x.jumlah || 0)
        const p = Number(x.dibayar || 0)
        out[String(x.service || '')] = {
          jumlah_panggilan: n,
          dibayar: p,
          kadar_dibayar_pct: n ? Number(((p / n) * 100).toFixed(1)) : null,
          ms_purata: x.ms_purata === null || x.ms_purata === undefined ? null : Number(x.ms_purata)
        }
      }
      statCache = { at: Date.now(), data: out }
    }
  } catch (e: any) {
    console.error('statServis gagal:', e?.message || e)
  }
  return out
}

/**
 * SAMPUL SERAGAM untuk setiap jawapan BERJAYA.
 *
 * Semua 12 servis memulangkan bentuk meta yang SAMA, jadi agen pembeli boleh
 * mengendalikan mana-mana servis dengan SATU parser:
 *   { ok, servis, hasil, meta: { dijana_pada, sumber[], had[], harga_usd, protokol }, cache, bayaran, ms }
 *
 * `sumber[]` = dari mana data datang (boleh diaudit). `had[]` = apa yang
 * jawapan ini TIDAK boleh dipercayai sepenuhnya. Kejujuran ini yang menaikkan
 * nilai di mata pembeli — bukan menurunkannya.
 */
function sampul(env: any, servis: string, hasil: any, tambah: any = {}): any {
  const p = PLUGIN[servis]
  return {
    ok: true,
    servis,
    hasil,
    meta: {
      dijana_pada: new Date().toISOString(),
      sumber: p?.sumber || ['dalaman'],
      had: p?.had || [],
      harga_usd: harga(env, servis),
      protokol: 'x402 v2'
    },
    ...tambah
  }
}

/** Skema input setiap servis — DIJANA dari registry plugin. */
function skemaInput(id: string): any {
  return PLUGIN[id]?.skema?.() || { type: 'object', properties: {} }
}

/** Contoh output — DIJANA dari registry plugin (dibaca @agentcash/discovery). */
function contohOutput(id: string): any {
  return PLUGIN[id]?.outputContoh?.() || { ok: true, servis: id }
}

/**
 * Ekstensi Bazaar dalam bentuk yang DIAUDIT oleh @agentcash/discovery:
 *   extensions.bazaar.schema.properties.input.properties.body      <- skema input (JSON Schema)
 *   extensions.bazaar.schema.properties.output.properties.example  <- contoh output
 * (queryParams disertakan juga untuk endpoint GET)
 */
function ekstensiBazaar(id: string, kaedahIn: string = 'POST'): any {
  const kaedah = String(kaedahIn || 'POST').toUpperCase()
  const m = kaedah === 'GET' || kaedah === 'HEAD' ? 'GET' : 'POST'
  const medan: any = skemaInput(id)
  const contoh: any = medan.example || {}
  // info.input memegang CONTOH nilai; schema memegang skema JSON sebenar medan.
  const input: any = { type: 'http', method: m }
  if (m === 'GET') input.queryParams = contoh
  else {
    input.bodyType = 'json'
    input.body = contoh
  }
  const inputProps: any = {
    type: { type: 'string', const: 'http' },
    method: { type: 'string', enum: m === 'GET' ? ['GET', 'HEAD', 'DELETE'] : ['POST', 'PUT', 'PATCH'] }
  }
  if (m === 'GET') inputProps.queryParams = medan
  else {
    inputProps.bodyType = { type: 'string', enum: ['json', 'form-data', 'text'] }
    inputProps.body = medan
  }
  return {
    bazaar: {
      info: { input, output: { type: 'json', example: contohOutput(id) } },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: inputProps,
            required: m === 'GET' ? ['type', 'method'] : ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false
          },
          output: {
            type: 'object',
            properties: { type: { type: 'string' }, example: { type: 'object' } },
            required: ['type']
          }
        },
        required: ['input']
      }
    }
  }
}

/**
 * Bukti pemilikan asal (x402scan ownership proof): tandatangan atas URL asal
 * (cth "https://crypto-micro-agent.mykira.workers.dev").
 *   - EVM   : EIP-191 personal_sign (viem recoverMessageAddress)
 *   - Solana: tandatangan Ed25519 (base58)
 * Ditandatangani di LUAR Worker (VPS). Worker hanya menyimpan tanda tangan,
 * bukan kunci peribadi. Kosong = medan ditinggalkan (tidak mengganggu apa-apa).
 */
function ownershipProofs(env: any): string[] {
  const out: string[] = []
  const evm = String(env?.OWNERSHIP_SIG_EVM || '').trim()
  const sol = String(env?.OWNERSHIP_SIG_SOLANA || '').trim()
  if (evm) out.push(evm)
  if (sol) out.push(sol)
  return out
}

/** PaymentRequirements standard x402 v2 untuk satu servis: USDC di Solana + USDC di Base. */
function acceptsUntuk(env: any, servis: string, origin: string, usd: number): any[] {
  // Skema v2 rasmi: hanya scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra.
  const asas = { scheme: 'exact', maxTimeoutSeconds: 120 }
  const unit = String(Math.round(usd * 1e6))
  const out: any[] = []
  // ORDER PENTING: Base DAHULU. 85% daripada aliran dana x402 berlaku di Base
  // (purata ~$0.31/tx berbanding ~$0.03 di Solana), jadi katalog & klien melihat
  // Base sebagai rangkaian utama kita. Solana kekal sebagai pilihan kedua.
  const evm = evmWallet(env)
  if (evm) {
    out.push({
      ...asas,
      network: 'eip155:8453',
      payTo: evm,
      asset: EVM_USDC_BASE,
      amount: unit,
      // Domain EIP-712 USDC di Base (disemak on-chain: name()=USD Coin, version()=2).
      extra: { name: 'USD Coin', version: '2', decimals: 6 }
    })
  }
  out.push({
    ...asas,
    network: caip2(env),
    payTo: wallet(env),
    asset: usdcMint(env),
    amount: unit,
    // feePayer = fasilitator (dia tandatangan & hantar; kita tiada kunci peribadi).
    extra: { feePayer: solFeePayer(env), decimals: 6 }
  })
  return out
}

/** Kunci idempotensi bagi satu PaymentPayload (dua cubaan bayaran sama = kunci sama). */
async function idemBayaran(payload: any): Promise<string> {
  const p = payload?.payload || {}
  const tx = String(p.transaction || '').trim()
  const asas = tx ? 'svm:' + tx : (String(p?.authorization?.nonce || '').trim() ? 'evm:' + String(p.authorization.nonce) : '')
  if (!asas) return ''
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(asas))
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return asas.slice(0, 100)
  }
}

/** Nama rangkaian gaya x402 v1 → CAIP-2 (v2). */
const NAMA_V1: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
}

function rangkaianNormal(n: any): string {
  const s = String(n || '').trim()
  return NAMA_V1[s.toLowerCase()] || s
}

/** Tukar PaymentRequirements v2 kita kepada bentuk v1 (klien lama). */
function reqV1(req: any): any {
  const songsang: Record<string, string> = {
    'eip155:8453': 'base',
    'eip155:84532': 'base-sepolia',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet'
  }
  return {
    scheme: req.scheme,
    network: songsang[req.network] || req.network,
    maxAmountRequired: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    resource: req.resource,
    description: req.description,
    mimeType: req.mimeType,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra
  }
}

/** Panggil fasilitator (/verify atau /settle). Kita tidak simpan kunci peribadi. */
async function fasilitatorPanggil(env: any, laluan: string, payload: any, req: any, version = 2): Promise<any> {
  const body = JSON.stringify({ x402Version: version, paymentPayload: payload, paymentRequirements: req })
  try {
    const r = await fetch(facilitator(env) + laluan, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Myworker-Agent-API/1.0' },
      body
    })
    return { status: r.status, j: await r.json().catch(() => null) }
  } catch (e: any) {
    return { status: 0, j: null, ralat: e?.message || String(e) }
  }
}

/** Sahkan bayaran standard (read-only) sebelum menjalankan servis. Sokong v1 & v2. */
async function sahkanStandard(env: any, servis: string, payload: any, origin: string): Promise<any> {
  const version = Number(payload?.x402Version || 2) === 1 ? 1 : 2
  const usd = harga(env, servis)
  // v2: payload.accepted. v1: scheme/network/... di peringkat atas.
  const minta = payload?.accepted || {
    scheme: payload?.scheme,
    network: payload?.network,
    amount: payload?.amount ?? payload?.maxAmountRequired,
    asset: payload?.asset,
    payTo: payload?.payTo
  }
  const netMinta = rangkaianNormal(minta?.network)
  const padan = acceptsUntuk(env, servis, origin, usd).find(
    (a) => a.network === netMinta &&
      String(a.asset).toLowerCase() === String(minta?.asset || '').toLowerCase() &&
      String(a.payTo).toLowerCase() === String(minta?.payTo || '').toLowerCase()
  )
  const tolak = (reason: string) => ({
    ok: false,
    reason,
    resp: { success: false, errorReason: reason, transaction: '', network: netMinta, payer: '' }
  })
  if (!padan) return tolak('invalid_payment_requirements')
  let cukup = false
  try { cukup = BigInt(String(minta.amount ?? '0')) >= BigInt(padan.amount) } catch { cukup = false }
  if (!cukup) return tolak('invalid_exact_payload_amount_mismatch')
  const req = version === 1 ? reqV1(padan) : padan
  const v = await fasilitatorPanggil(env, '/verify', payload, req, version)
  if (!v.j?.isValid) return tolak(String(v.j?.invalidReason || v.ralat || 'unexpected_verify_error'))
  return { ok: true, req, version, usd, payer: String(v.j?.payer || '') }
}

/** Selesaikan bayaran standard melalui fasilitator (fasilitator uruskan fi & hantar). */
async function selesaikanStandard(env: any, payload: any, req: any, version = 2): Promise<any> {
  const s = await fasilitatorPanggil(env, '/settle', payload, req, version)
  const tx = String(s.j?.transaction || '')
  const payer = String(s.j?.payer || '')
  const net = rangkaianNormal(req?.network)
  if (!s.j?.success) {
    const sebab = String(s.j?.errorReason || s.ralat || 'unexpected_settle_error')
    return { ok: false, reason: sebab, resp: { success: false, errorReason: sebab, transaction: tx, network: net, payer } }
  }
  return {
    ok: true,
    tx,
    payer,
    network: net,
    resp: { success: true, transaction: tx, network: net, payer, amount: String(s.j?.amount || req.amount) }
  }
}

async function cabaranJSON(c: any, servis: string, opt: any = {}): Promise<Response> {
  const env = c.env
  const w = wallet(env)
  const origin = new URL(c.req.url).origin
  const rate = await solUsd(env)
  const usd = opt.usd ?? harga(env, servis)
  const lamports = opt.lamports ?? Math.max(Math.round((usd / rate) * LAMPORTS), 50000)
  let challenge = opt.challenge || ''
  let ref = opt.ref || ''
  if (!challenge || !ref) {
    const baru = await cabaranBaru(env, servis, opt.payload || '')
    challenge = baru.challenge
    ref = baru.ref
  }
  // accepts standard x402 v2: USDC di Solana (feePayer = fasilitator) + USDC di Base.
  // SOL asli tidak dimasukkan di sini (bukan skema standard) — ada di cara_bayar di bawah.
  const accepts = acceptsUntuk(env, servis, origin, usd)
  const label = encodeURIComponent('Myworker Agent API')
  const mesej = encodeURIComponent('agent:' + servis)
  const kaedah = String(c.req.method || 'POST').toUpperCase()
  const payloadHeader = {
    x402Version: 2,
    error: opt.error || 'Payment Required',
    resource: {
      url: `${origin}/api/agent/${servis}`,
      description: SERVIS[servis]?.desc || '',
      mimeType: 'application/json',
      serviceName: 'Myworker Agent API',
      tags: ['x402', 'solana', 'base', SERVIS[servis]?.jenis || 'data'],
      iconUrl: `${origin}/favicon.svg`
    },
    accepts,
    // Deklarasi Bazaar (x402 v2) — membolehkan fasilitator mengkatalogkan servis ini
    // supaya bot/agen boleh menemuinya melalui /discovery/resources.
    extensions: ekstensiBazaar(servis, kaedah)
  }
  return c.json({
    ok: false,
    code: 402,
    error: opt.error || 'Bayaran diperlukan',
    servis,
    challenge,
    reference: ref,
    wallet: w,
    network: caip2(env),
    harga_usd: usd,
    jumlah_usdc: usd,
    jumlah_sol: Number((lamports / LAMPORTS).toFixed(9)),
    expires_at: Math.floor(Date.now() / 1000) + TTL_CABARAN,
    accepts,
    // Disertakan dalam badan juga (bukan hanya header) supaya mana-mana parser indeks jumpa.
    extensions: payloadHeader.extensions,
    x402Version: 2,
    resource: payloadHeader.resource,
    cara_bayar: {
      usdc: `solana:${w}?amount=${usd.toFixed(6)}&spl-token=${usdcMint(env)}&reference=${ref}&label=${label}&message=${mesej}`,
      sol: `solana:${w}?amount=${(lamports / LAMPORTS).toFixed(9)}&reference=${ref}&label=${label}&message=${mesej}`,
      langkah: [
        '1. Bayar jumlah di atas ke dompet (USDC atau SOL). Masukkan "reference" sebagai akaun tambahan dalam transaksi.',
        '2. Panggil semula endpoint sama dengan header "X-Payment-Ref: <reference>" (atau "X-Payment-Tx: <signature>").',
        '3. Worker sahkan on-chain lalu pulangkan hasil. Status: GET /api/agent/status?challenge=<challenge>'
      ]
    }
  }, 402, { 'PAYMENT-REQUIRED': b64(JSON.stringify(payloadHeader)) })
}

/** Daftarkan semua route Agent API pada app Hono. */
export function registerAgent(app: any): void {
  const handler = async (c: any) => {
    try {
      const servis = String(c.req.param('servis') || '').toLowerCase().trim()
      const meta = SERVIS[servis]
      if (!meta) {
        return c.json({ ok: false, error: 'Servis tak dikenali', servis_tersedia: Object.keys(SERVIS) }, 404)
      }
      await ensureTable(c.env)
      const body: any = (await c.req.json().catch(() => ({}))) || {}
      // Sokongan GET: kalau tiada badan JSON, ambil input dari query string.
      if (!Object.keys(body).length) {
        for (const [k, v] of new URL(c.req.url).searchParams) body[k] = v
      }
      let input = inputDariBody(servis, body)
      if (!input && c.req.query('text')) input = String(c.req.query('text'))
      const origin = new URL(c.req.url).origin

      // ---- Laluan STANDARD x402 v2: klien hantar 'PAYMENT-SIGNATURE' (base64 PaymentPayload).
      // Kita sahkan & selesaikan melalui fasilitator — tiada kunci peribadi di sini.
      const sigHdr = c.req.header('payment-signature') || c.req.header('x-payment') || c.req.header('x-payment-signature')
      let stdP: any = null
      if (sigHdr) { try { stdP = JSON.parse(unb64(sigHdr)) } catch { stdP = null } }

      if (stdP && stdP.payload && (stdP.accepted || (stdP.scheme && stdP.network))) {
        if (!input && (meta.jenis === 'ai' || servis === 'periksa-dompet' || servis === 'kikis-web' || servis === 'kikis-ringkas' || servis === 'banding-token')) {
          return c.json({ ok: false, error: meta.jenis === 'ai' ? 'Medan "text" diperlukan' : 'Medan input diperlukan (dompet / url)' }, 400)
        }
        const v = await sahkanStandard(c.env, servis, stdP, origin)
        if (!v.ok) {
          return c.json({ ok: false, error: v.reason, code: 402 }, 402, { 'PAYMENT-RESPONSE': b64(JSON.stringify(v.resp)) })
        }

        // Idempotensi: satu bayaran = satu baris. Replay → keputusan sama, bukan caj berganda.
        const kunci = await idemBayaran(stdP)
        const d = db(c.env)
        let barisID = 0
        if (d && kunci) {
          const ins: any = await d.prepare(
            'INSERT OR IGNORE INTO agent_calls (challenge, ref, service, price_usd, asset, amount, network, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind('std:' + kunci, '', servis, v.usd, v.req.asset, v.req.amount, v.req.network, 'processing', Date.now()).run()
          const dicipta = Number(ins?.meta?.changes || 0) > 0
          const ada: any = (await d.prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind('std:' + kunci).run())?.results?.[0] || null
          barisID = ada?.id || 0
          if (!dicipta) {
            if (ada?.status === 'paid' && ada?.result) {
              let dah: any = ada.result
              if (meta.jenis !== 'ai' || PLUGIN[servis]?.jsonOutput) { try { dah = JSON.parse(ada.result) } catch { /* biar teks */ } }
              return c.json(sampul(c.env, servis, dah, {
                cache: true,
                bayaran: { wallet: v.req.payTo, asset: v.req.asset, jumlah: v.req.amount, dari: ada.payer, tx: ada.tx_sig },
                ms: ada.ms || 0
              }), 200, {
                'PAYMENT-RESPONSE': b64(JSON.stringify({ success: true, transaction: ada.tx_sig, network: v.req.network, payer: ada.payer }))
              })
            }
            const dup = { success: false, errorReason: 'duplicate_settlement', transaction: String(ada?.tx_sig || ''), network: v.req.network, payer: String(ada?.payer || '') }
            return c.json({ ok: false, error: 'Bayaran ini sedang/sudah diproses.', code: 402 }, 402, { 'PAYMENT-RESPONSE': b64(JSON.stringify(dup)) })
          }
        }

        const t0 = Date.now()
        let hasilMentah = ''
        try { hasilMentah = await jalankanServis(c.env, servis, input, body) } catch (e: any) { console.error('Agent servis gagal:', e?.message || e) }
        if (!hasilMentah) {
          if (d && barisID) await d.prepare('UPDATE agent_calls SET status = ?, error = ? WHERE id = ?').bind('failed', 'servis gagal', barisID).run()
          return c.json({ ok: false, error: 'Servis gagal dijalankan — bayaran TIDAK diselesaikan. Cuba lagi.' }, 503)
        }

        const s = await selesaikanStandard(c.env, stdP, v.req, v.version)
        if (!s.ok) {
          if (d && barisID) await d.prepare('UPDATE agent_calls SET status = ?, error = ? WHERE id = ?').bind('failed', s.reason, barisID).run()
          return c.json({ ok: false, error: s.reason, code: 402 }, 402, { 'PAYMENT-RESPONSE': b64(JSON.stringify(s.resp)) })
        }

        const ms = Date.now() - t0
        if (d && barisID) {
          await d.prepare(
            'UPDATE agent_calls SET status = ?, tx_sig = ?, payer = ?, asset = ?, amount = ?, paid_at = ?, result = ?, ms = ? WHERE id = ?'
          ).bind('paid', s.tx, s.payer || v.payer, v.req.asset, v.req.amount, Date.now(), hasilMentah.slice(0, 20000), ms, barisID).run()
          try {
            await d.prepare(
              'INSERT OR IGNORE INTO transactions (type, amount, token_symbol, tx_hash, status, meta, sender_address) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind('agent_api_call', Number(v.usd), servis, s.tx, 'PAID',
              JSON.stringify({ asset: v.req.asset, network: v.req.network, ms, aliran: 'standard' }), s.payer || v.payer).run()
          } catch (e: any) { console.error('rekod income gagal:', e?.message || e) }
        }

        let hasilStd: any = hasilMentah
        if (meta.jenis !== 'ai' || PLUGIN[servis]?.jsonOutput) { try { hasilStd = JSON.parse(hasilMentah) } catch { /* biar teks */ } }
        return c.json(sampul(c.env, servis, hasilStd, {
          cache: false,
          bayaran: { wallet: v.req.payTo, asset: v.req.asset, jumlah: v.req.amount, dari: s.payer || v.payer, tx: s.tx },
          ms
        }), 200, { 'PAYMENT-RESPONSE': b64(JSON.stringify(s.resp)) })
      }

      const p = proof(c)

      if (p.tx || p.ref || p.challenge) {
        if (!input && (meta.jenis === 'ai' || servis === 'periksa-dompet' || servis === 'kikis-web' || servis === 'kikis-ringkas' || servis === 'banding-token')) {
          return c.json({ ok: false, error: meta.jenis === 'ai' ? 'Medan "text" diperlukan' : 'Medan input diperlukan (dompet / url)' }, 400)
        }
        const r = await settleAgent(c.env, servis, input, p, body)
        if (r.ok) {
          let hasil: any = r.hasil
          if (meta.jenis !== 'ai' || PLUGIN[servis]?.jsonOutput) { try { hasil = JSON.parse(r.hasil) } catch { /* biar teks */ } }
          return c.json(sampul(c.env, servis, hasil, {
            cache: r.cached || false,
            bayaran: { wallet: wallet(c.env), asset: r.asset, jumlah: r.amount, dari: r.payer, tx: r.tx },
            ms: r.ms || 0
          }), 200, { 'PAYMENT-RESPONSE': b64(JSON.stringify({ success: true, tx: r.tx, network: caip2(c.env) })) })
        }
        return cabaranJSON(c, servis, r.row
          ? { error: r.reason, challenge: r.row.challenge, ref: r.row.ref, usd: r.row.price_usd }
          : { error: r.reason })
      }
      return cabaranJSON(c, servis, { payload: meta.jenis === 'ai' ? input : input })
    } catch (e: any) {
      console.error('Agent API ralat:', e?.message || e)
      return c.json({ ok: false, error: 'Ralat dalaman' }, 500)
    }
  }

  // Katalog servis (JSON)
  app.get('/api/agent', async (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    const rate = await solUsd(env)
    return c.json({
      ok: true,
      nama: 'Myworker Agent API',
      protokol: 'x402 v2 (standard: header PAYMENT-SIGNATURE + fasilitator) dan lean (bayar dahulu + reference)',
      version: 2,
      network: caip2(env),
      pay_to: wallet(env),
      aset: { usdc_solana: usdcMint(env), usdc_base: evmWallet(env) ? EVM_USDC_BASE : null, sol: 'native' },
      rangkaian: evmWallet(env) ? [caip2(env), 'eip155:8453'] : [caip2(env)],
      pay_to_evm: evmWallet(env) || null,
      fasilitator: facilitator(env),
      fee_payer_solana: solFeePayer(env),
      kadar_sol_usd: rate,
      manifest: `${origin}/.well-known/x402.json`,
      manifest_mesin: `${origin}/api/agent/katalog.json`,
      halaman: `${origin}/agent`,
      stats: `${origin}/api/agent/stats?key=…`,
      jenis: ['crypto (Jupiter + RPC Solana)', 'ai (Workers AI)', 'data (trending/dompet/web)'],
      servis: Object.entries(SERVIS).map(([id, s]) => {
        const usd = harga(env, id)
        return {
          id, nama: s.nama, jenis: s.jenis, keterangan: s.desc,
          endpoint: `${origin}/api/agent/${id}`,
          method: 'POST',
          contoh: s.contoh,
          harga_usd: usd,
          harga_usdc: usd,
          harga_sol: Number((usd / rate).toFixed(9)),
          sumber: PLUGIN[id]?.sumber || [],
          had: PLUGIN[id]?.had || []
        }
      })
    })
  })

  /**
   * MANIFEST MESIN — SATU panggilan untuk agen membina integrasi sendiri.
   * GET /api/agent/katalog.json
   *
   * Menggabungkan skema input, contoh output, harga, sumber data, had, DAN
   * statistik sebenar (kadar berjaya + masa laksana dari D1), supaya pembeli
   * tahu apa yang dia bayar sebelum membayar.
   */
  app.get('/api/agent/katalog.json', async (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    const rate = await solUsd(env)
    const stat = await statServis(env)
    const servis = Object.entries(SERVIS).map(([id, s]) => {
      const usd = harga(env, id)
      const p = PLUGIN[id]
      const st = stat[id] || {}
      const medan = skemaInput(id)
      return {
        id,
        nama: s.nama,
        jenis: s.jenis,
        keterangan: s.desc,
        endpoint: `${origin}/api/agent/${id}`,
        method: 'POST',
        harga_usd: usd,
        harga_usdc: usd.toFixed(6),
        harga_sol: Number((usd / rate).toFixed(9)),
        max_input_aksara: s.maxInput || null,
        input: { skema: medan, contoh: medan?.example || {} },
        output: { contoh: contohOutput(id) },
        sumber: p?.sumber || [],
        had: p?.had || [],
        statistik: {
          cabaran_dikeluarkan: st.jumlah_panggilan ?? null,
          berjaya_dibayar: st.dibayar ?? null,
          kadar_dibayar_pct: st.kadar_dibayar_pct ?? null,
          masa_laksana_purata_ms: st.ms_purata ?? null,
          nota: 'Cabaran termasuk probe/imbas crawler katalog, jadi kadar dibayar yang rendah adalah NORMAL. "masa_laksana" dikira daripada panggilan yang benar-benar dibayar.'
        }
      }
    })
    return c.json({
      ok: true,
      nama: 'Myworker Agent API',
      versi_manifest: 1,
      protokol: {
        nama: 'x402',
        versi: 2,
        header_permintaan: 'PAYMENT-SIGNATURE (base64 PaymentPayload)',
        header_respons: 'PAYMENT-RESPONSE (base64 SettlementResponse)',
        header_402: 'PAYMENT-REQUIRED (base64 PaymentRequired)',
        fasilitator: facilitator(env)
      },
      rangkaian: evmWallet(env) ? [caip2(env), 'eip155:8453'] : [caip2(env)],
      aset: { usdc_solana: usdcMint(env), usdc_base: evmWallet(env) ? EVM_USDC_BASE : null, sol: 'native' },
      terima_ke: { solana: wallet(env), base: evmWallet(env) || null },
      halaman: { manusia: `${origin}/agent`, llms_txt: `${origin}/llms.txt`, openapi: `${origin}/openapi.json` },
      mula_cepat: {
        langkah: [
          `1. POST ${origin}/api/agent/<id> dengan badan JSON mengikut "input.skema".`,
          '2. Terima HTTP 402 + header PAYMENT-REQUIRED (base64) + medan accepts[].',
          '3. Bina bayaran ikut x402 v2, hantar semula endpoint SAMA dengan header PAYMENT-SIGNATURE: <base64 PaymentPayload>.',
          '4. Terima hasil + header PAYMENT-RESPONSE. Tiada akaun, tiada API key, tiada langganan.'
        ],
        contoh_curl: `curl -sS -X POST ${origin}/api/agent/saring-token -H 'content-type: application/json' -d '{"token":"bonk"}'`
      },
      servis,
      nota: 'Statistik adalah daripada panggilan sebenar yang direkodkan (termasuk ujian kami sendiri). Di-cache 5 minit.'
    }, 200, { 'Cache-Control': 'public, max-age=300' })
  })

  // Penemuan #1 (paling disyorkan oleh x402scan): OpenAPI
  app.get('/openapi.json', async (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    const paths: any = {}
    for (const [id, s] of Object.entries(SERVIS)) {
      const usd = harga(env, id)
      paths[`/api/agent/${id}`] = {
        post: {
          operationId: `agent_${id}`,
          summary: s.nama,
          description: `${s.desc} — Bayaran x402: $${usd.toFixed(4)} USDC (atau padanan SOL) setiap panggilan, terus ke dompet Solana penerbit.`,
          tags: [s.jenis],
          security: [{ x402: [] }],
          // Selaras spec x402scan DISCOVERY.md: protocols + price {mode,currency,amount}
          'x-payment-info': {
            protocols: [{ x402: {} }],
            price: { mode: 'fixed', currency: 'USD', amount: usd.toFixed(4) },
            minPrice: usd.toFixed(4),
            maxPrice: usd.toFixed(4),
            scheme: 'exact',
            asset: usdcMint(env),
            network: caip2(env),
            payTo: wallet(env),
            extra: {
              asset_symbol: 'USDC',
              decimals: 6,
              also_accepts: 'native SOL (aliran lean)',
              also_networks: evmWallet(env) ? ['solana (USDC SPL)', 'eip155:8453 / Base (USDC)'] : ['solana (USDC SPL)'],
              standard: 'x402 v2 — header PAYMENT-SIGNATURE + fasilitator',
              facilitator: facilitator(env),
              feePayer_solana: solFeePayer(env)
            }
          },
          // Skema input/output (dibaca oleh @agentcash/discovery)
          extensions: ekstensiBazaar(id),
          requestBody: { required: s.jenis === 'ai', content: { 'application/json': { schema: skemaInput(id) } } },
          responses: {
            '402': { description: 'Bayaran diperlukan — cabaran x402 dikembalikan (header PAYMENT-REQUIRED + medan accepts)' },
            '200': { description: 'Berjaya — hasil servis', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, servis: { type: 'string' }, hasil: {} } } } } }
          }
        }
      }
    }
    return c.json({
      openapi: '3.1.0',
      info: {
        title: 'Myworker Agent API',
        version: '1.0.0',
        description: 'Servis berbayar untuk bot/agen (x402): data pasaran Solana via Jupiter + RPC, dan servis AI via Workers AI. Bayar per panggilan dengan USDC di Solana, USDC di Base, atau SOL.',
        contact: { url: `${origin}/agent`, name: 'Myworker (bot pekerja @Mypekerja1_bot)', email: 'ag.azaman78+myworker@gmail.com' },
        'x-guidance':
          'DUA ALIRAN. (A) STANDARD x402 v2 (disyorkan untuk bot autonomi): POST endpoint tanpa bayaran -> HTTP 402 + header PAYMENT-REQUIRED (base64 PaymentRequired) dengan accepts[] mengandungi USDC di Solana (extra.feePayer) dan USDC di Base (eip155:8453). Bina bayaran mengikut spesifikasi x402 v2, hantar semula dengan header PAYMENT-SIGNATURE: <base64 PaymentPayload>. Pelayan sahkan & selesaikan melalui fasilitator, pulangkan hasil + header PAYMENT-RESPONSE. ' +
          '(B) LEAN: bayar dahulu ke payTo (USDC SPL atau SOL asli) dengan "reference" sebagai akaun tambahan, kemudian panggil semula dengan X-Payment-Ref: <reference> atau X-Payment-Tx: <signature>. ' +
          'Satu bayaran = satu panggilan (replay dilindungi).'
      },
      servers: [{ url: origin }],
      // Spec x402scan DISCOVERY.md §"Auth requirements": skema keselamatan x402
      // yang diisytiharkan jelas + x-payment-info per operasi => authMode "paid".
      components: {
        securitySchemes: {
          x402: {
            type: 'http',
            scheme: 'x402',
            description:
              'Bayaran mikro x402 v2 (USDC di Solana/Base atau SOL). Panggil tanpa bayaran -> HTTP 402 + header PAYMENT-REQUIRED (base64 PaymentRequired) dengan accepts[]. Bina PaymentPayload ikut x402 v2 dan hantar semula dengan header PAYMENT-SIGNATURE: <base64 PaymentPayload>. Tiada akaun, tiada API key.'
          }
        }
      },
      security: [{ x402: [] }],
      'x-agentcash-guidance': { llmsTxtUrl: `${origin}/llms.txt` },
      ...(ownershipProofs(env).length ? { 'x-discovery': { ownershipProofs: ownershipProofs(env) } } : {}),
      paths
    })
  })

  // Panduan ringkas untuk agen (llms.txt) — dirujuk oleh x-agentcash-guidance
  app.get('/llms.txt', async (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    const rate = await solUsd(env)
    const senarai = Object.entries(SERVIS)
      .map(([id, s]) => `- POST ${origin}/api/agent/${id} — ${s.nama} (${s.jenis}) — $${harga(env, id).toFixed(4)} USDC:\n  ${s.desc}`)
      .join('\n')
    return c.text(
      `# Myworker Agent API (x402)\n\n` +
        `Servis berbayar untuk bot/agen: data pasaran Solana + servis teks AI + utiliti web.\n` +
        `Dompet Solana: ${wallet(env)}${evmWallet(env) ? ` | Dompet Base (EVM): ${evmWallet(env)}` : ''}. Kadar rujukan: 1 SOL ≈ $${rate.toFixed(2)} USD.\n\n` +
        `## Servis\n${senarai}\n\n` +
        `## Cara bayar A — STANDARD x402 v2 (disyorkan untuk bot autonomi)\n` +
        `1. POST /api/agent/<servis> tanpa bayaran -> HTTP 402 + header PAYMENT-REQUIRED (base64 PaymentRequired).\n` +
        `   accepts[] mengandungi: USDC di Solana (${usdcMint(env)}, extra.feePayer = ${solFeePayer(env)}) dan USDC di Base (eip155:8453, asset ${EVM_USDC_BASE}).\n` +
        `2. Bina bayaran ikut spesifikasi x402 v2 dan hantar semula endpoint yang sama dengan header PAYMENT-SIGNATURE: <base64 PaymentPayload>.\n` +
        `3. Pelayan sahkan (/verify) & selesaikan (/settle) melalui fasilitator ${facilitator(env)} — bayaran diselesaikan SELEPAS servis berjaya.\n` +
        `4. Hasil dipulangkan bersama header PAYMENT-RESPONSE (base64 SettlementResponse). Kunci peribadi tidak pernah disimpan di pelayan ini.\n\n` +
        `## Cara bayar B — LEAN (semua wallet, termasuk yang tiada sokongan x402)\n` +
        `1. POST /api/agent/<servis> tanpa bayaran -> 402 dengan reference + jumlah (USDC SPL atau SOL asli).\n` +
        `2. Bayar ke payTo dan masukkan "reference" sebagai akaun tambahan dalam transaksi.\n` +
        `3. Panggil semula dengan header "X-Payment-Ref: <reference>" (atau "X-Payment-Tx: <signature>").\n` +
        `4. Pelayan mengesahkan on-chain dan memulangkan JSON hasil. Satu transaksi = satu panggilan (anti-replay).\n\n` +
        `## Nota\n` +
        `- Cabaran tamat tempoh 15 minit; panggil semula endpoint untuk cabaran baharu.\n` +
        `- Semak status: GET /api/agent/status?challenge=<challenge>.\n` +
        `- Katalog penuh: GET /api/agent · Manifest mesin (skema + contoh + statistik): GET /api/agent/katalog.json · OpenAPI: GET /openapi.json · ai.txt: /.well-known/ai.txt · Halaman: GET /agent\n`,
      200,
      { 'Content-Type': 'text/plain; charset=utf-8' }
    )
  })

  // Favicon (kesopanan + lulus audit penemuan)
  const FAVICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0f19"/><text x="32" y="44" font-size="34" font-family="system-ui,sans-serif" text-anchor="middle" fill="#22d3ee">M</text></svg>'
  for (const p of ['/favicon.svg', '/favicon.ico']) {
    app.get(p, (c: any) => c.body(FAVICON, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }))
  }

  // Peta laman (penemuan #4): halaman awam + dokumen mesin.
  app.get('/sitemap.xml', (c: any) => {
    const origin = new URL(c.req.url).origin
    const laluan = [
      { p: '/', pr: '1.0' },
      { p: '/agent', pr: '1.0' },
      { p: '/api/agent', pr: '0.9' },
      { p: '/api/agent/katalog.json', pr: '0.9' },
      { p: '/llms.txt', pr: '0.8' },
      { p: '/openapi.json', pr: '0.8' },
      { p: '/.well-known/x402.json', pr: '0.8' },
      { p: '/.well-known/x402', pr: '0.8' },
      { p: '/.well-known/ai.txt', pr: '0.7' }
    ]
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      laluan.map((l) => `  <url><loc>${origin}${l.p}</loc><priority>${l.pr}</priority></url>`).join('\n') +
      '\n</urlset>\n'
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
  })

  // Penemuan #2 (keserasian): /.well-known/x402 — format minimum x402scan
  app.get('/.well-known/x402', async (c: any) => {
    const origin = new URL(c.req.url).origin
    return c.json({
      version: 1,
      resources: Object.keys(SERVIS).map((id) => `${origin}/api/agent/${id}`),
      ...(ownershipProofs(c.env).length ? { ownershipProofs: ownershipProofs(c.env) } : {}),
      instructions:
        'Setiap endpoint memulangkan HTTP 402 bersama cabaran x402 (header PAYMENT-REQUIRED). ' +
        'Bayar jumlah dalam medan accepts (USDC SPL di Solana atau SOL asli) ke payTo, masukkan "reference" ' +
        'sebagai akaun tambahan dalam transaksi, kemudian panggil semula dengan header X-Payment-Ref: <reference> ' +
        '(atau X-Payment-Tx: <signature>). Pengesahan dibuat on-chain oleh pelayan ini sendiri.'
    })
  })

  // Penemuan #3: ai.txt — dibaca oleh pengimbas direktori (cth x402-relay).
  const aiTxtBody = async (origin: string, env: any): Promise<string> => {
    const baris = [
      '# ai.txt — Myworker Agent API',
      '# Servis berbayar (x402) untuk bot & agen AI. Tiada akaun, tiada API key.',
      '',
      'name: Myworker Agent API',
      'description: Data pasaran Solana (harga, quote swap Jupiter, semak risiko token, peluang arbitraj, token trending, periksa dompet) dan servis AI (ringkas, terjemah, tulis, ekstrak JSON, kikis laman web jadi Markdown). Bayar per panggilan dengan USDC atau SOL.',
      `x402-endpoint: ${origin}/api/agent`,
      `x402-network: ${caip2(env)}`,
      `x402-asset: ${usdcMint(env)}`,
      ...(evmWallet(env) ? [`x402-network-2: eip155:8453`, `x402-asset-2: ${EVM_USDC_BASE}`, `x402-pay-to-2: ${evmWallet(env)}`] : []),
      'x402-also-accepts: native SOL (lamports, aliran lean)',
      'x402-protocol: v2 — header PAYMENT-SIGNATURE (base64 PaymentPayload) + fasilitator',
      `x402-facilitator: ${facilitator(env)}`,
      `x402-fee-payer-solana: ${solFeePayer(env)}`,
      'x402-price: 0.002-0.02',
      `x402-pay-to: ${wallet(env)}`,
      `x402-manifest: ${origin}/.well-known/x402.json`,
      `openapi: ${origin}/openapi.json`,
      `llms-txt: ${origin}/llms.txt`,
      `catalog: ${origin}/api/agent`,
      `catalog-machine: ${origin}/api/agent/katalog.json`,
      `catalog-human: ${origin}/agent`,
      'contact: ag.azaman78+myworker@gmail.com',
      '',
      '# Servis (POST, bayar per panggilan):'
    ]
    for (const [id, s] of Object.entries(SERVIS)) {
      baris.push(`#   ${id.padEnd(16)} $${harga(env, id).toFixed(4).padEnd(7)} ${origin}/api/agent/${id} — ${s.nama}`)
    }
    baris.push(
      '',
      '# Cara bayar A — STANDARD x402 v2 (disyorkan):',
      '# 1) POST endpoint tanpa bayaran -> HTTP 402 + header PAYMENT-REQUIRED (base64 PaymentRequired).',
      '# 2) Bina bayaran ikut x402 v2, hantar semula dengan header PAYMENT-SIGNATURE: <base64 PaymentPayload>.',
      '# 3) Pelayan sahkan & selesaikan melalui fasilitator, pulangkan hasil + header PAYMENT-RESPONSE.',
      '',
      '# Cara bayar B — LEAN (semua wallet):',
      '# 1) POST endpoint tanpa bayaran -> HTTP 402 + medan "reference" dan jumlah.',
      '# 2) Bayar jumlah ke x402-pay-to (USDC SPL atau SOL asli); masukkan "reference" sebagai akaun tambahan.',
      '# 3) Panggil semula endpoint sama dengan X-Payment-Ref: <reference> (atau X-Payment-Tx: <signature>).',
      '#    Pengesahan dibuat on-chain oleh pelayan ini sendiri; replay dilindungi.',
      ''
    )
    return baris.join('\n')
  }
  for (const p of ['/.well-known/ai.txt', '/ai.txt']) {
    app.get(p, async (c: any) => {
      const origin = new URL(c.req.url).origin
      return c.body(await aiTxtBody(origin, c.env), 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      })
    })
  }

  // Manifest penuh (manusia + agen)
  app.get('/.well-known/x402.json', async (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    const w = wallet(env)
    const rate = await solUsd(env)
    return c.json({
      x402Version: 2,
      name: 'Myworker Agent API',
      description: 'Servis berbayar untuk bot/agen: data pasaran Solana (harga, quote swap Jupiter, semak risiko token, peluang arbitraj, token trending, periksa dompet) dan utiliti AI/web (ringkas, terjemah, tulis, ekstrak JSON, kikis laman jadi Markdown). Bayar per panggilan dengan USDC di Solana, USDC di Base, atau SOL.',
      network: caip2(env),
      payTo: w,
      payToEvm: evmWallet(env) || null,
      networks: evmWallet(env) ? [caip2(env), 'eip155:8453'] : [caip2(env)],
      facilitator: facilitator(env),
      feePayer: solFeePayer(env),
      kadar_sol_usd: rate,
      provider: { name: 'Myworker', url: origin },
      resources: Object.entries(SERVIS).map(([id, s]) => {
        return {
          resource: `${origin}/api/agent/${id}`,
          method: 'POST',
          description: `${s.nama} — ${s.desc}`,
          mimeType: 'application/json',
          accepts: acceptsUntuk(env, id, origin, harga(env, id))
        }
      })
    })
  })

  // Status satu cabaran
  app.get('/api/agent/status', async (c: any) => {
    try {
      await ensureTable(c.env)
      const challenge = String(c.req.query('challenge') || '')
      const ref = String(c.req.query('ref') || '')
      if (!challenge && !ref) return c.json({ ok: false, error: 'Beri ?challenge= atau ?ref=' }, 400)
      const d = db(c.env)
      const row = challenge
        ? (await d.prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind(challenge).run())?.results?.[0]
        : (await d.prepare('SELECT * FROM agent_calls WHERE ref = ? ORDER BY id DESC LIMIT 1').bind(ref).run())?.results?.[0]
      if (!row) return c.json({ ok: false, error: 'Cabaran tak dijumpai' }, 404)
      return c.json({
        ok: true, challenge: row.challenge, servis: row.service, status: row.status,
        harga_usd: row.price_usd, asset: row.asset || null, tx: row.tx_sig || null,
        hasil: row.status === 'paid' ? row.result : null,
        created_at: row.created_at, paid_at: row.paid_at || null
      })
    } catch {
      return c.json({ ok: false, error: 'Ralat DB' }, 500)
    }
  })

  // Hasil/pendapatan Agent API — owner sahaja
  app.get('/api/agent/stats', async (c: any) => {
    try {
      const jangka = String(c.env.AGENT_STATS_KEY || '')
      if (!jangka) return c.json({ ok: false, error: 'Stats dimatikan (AGENT_STATS_KEY kosong)' }, 404)
      const kunci = String(c.req.query('key') || c.req.header('x-key') || '')
      if (kunci !== jangka) return c.json({ ok: false, error: 'Kunci salah' }, 403)
      await ensureTable(c.env)
      const d = db(c.env)
      const q = async (sql: string) => (await d.prepare(sql).run())?.results || []
      const [r] = await q("SELECT COUNT(*) AS jumlah, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS dibayar, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, COALESCE(SUM(CASE WHEN status = 'paid' THEN price_usd ELSE 0 END),0) AS hasil_usd FROM agent_calls")
      return c.json({
        ok: true,
        jumlah_cabaran: r?.jumlah || 0,
        dibayar: r?.dibayar || 0,
        belum_dibayar: r?.pending || 0,
        hasil_usd: Number(r?.hasil_usd || 0),
        harian: await q("SELECT date(paid_at/1000, 'unixepoch') AS tarikh, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY tarikh ORDER BY tarikh DESC LIMIT 14"),
        per_servis: await q("SELECT service, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY service ORDER BY n DESC"),
        pembayar: await q("SELECT payer, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY payer ORDER BY n DESC LIMIT 10"),
        terkini: await q("SELECT service, status, price_usd, asset, payer, created_at FROM agent_calls ORDER BY id DESC LIMIT 20")
      })
    } catch {
      return c.json({ ok: false, error: 'Ralat DB' }, 500)
    }
  })

  // Lejar pembayaran (satu baris = satu pembayaran) — owner sahaja.
  // Dipakai oleh papan pemuka Google Sheet supaya angka di sana TEPAT:
  // membezakan ujian kita sendiri (AGENT_UJIAN_PAYERS) daripada pembeli sebenar.
  app.get('/api/agent/lejar', async (c: any) => {
    try {
      const jangka = String(c.env.AGENT_STATS_KEY || '')
      if (!jangka) return c.json({ ok: false, error: 'Lejar dimatikan (AGENT_STATS_KEY kosong)' }, 404)
      const kunci = String(c.req.query('key') || c.req.header('x-key') || '')
      if (kunci !== jangka) return c.json({ ok: false, error: 'Kunci salah' }, 403)
      await ensureTable(c.env)
      const d = db(c.env)
      const had = Math.min(Math.max(parseInt(String(c.req.query('had') || '500'), 10) || 500, 1), 2000)

      // Dompet ujian kita sendiri + dompet penerima: bayaran dari sini BUKAN hasil sebenar.
      const ujian = new Set(
        [String(c.env.AGENT_UJIAN_PAYERS || ''), wallet(c.env), evmWallet(c.env)]
          .join(',')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )

      const namaRangkaian = (n: string): string => {
        const s = String(n || '')
        if (s === 'eip155:8453') return 'Base'
        if (s === 'eip155:84532') return 'Base Sepolia'
        if (s.startsWith('solana:')) return s.includes('devnet') ? 'Solana Devnet' : 'Solana'
        return s || '(tiada)'
      }

      const baris = ((await d.prepare(
        "SELECT id, service, price_usd, asset, network, payer, tx_sig, created_at, paid_at, ms FROM agent_calls WHERE status = 'paid' ORDER BY id DESC LIMIT ?"
      ).bind(had).run())?.results || []).map((r: any) => {
        const ts = Number(r.paid_at || r.created_at || 0)
        const payer = String(r.payer || '')
        return {
          id: Number(r.id || 0),
          masa: ts ? new Date(ts).toISOString() : '',
          hari: ts ? new Date(ts).toISOString().slice(0, 10) : '',
          rangkaian: namaRangkaian(String(r.network || '')),
          rangkaian_penuh: String(r.network || ''),
          servis: String(r.service || ''),
          endpoint: '/api/agent/' + String(r.service || ''),
          jumlah_usd: Number(r.price_usd || 0),
          aset: String(r.asset || ''),
          tx: String(r.tx_sig || ''),
          payer,
          jenis: payer && ujian.has(payer.toLowerCase()) ? 'ujian-sendiri' : 'pembeli-luar',
          ms: Number(r.ms || 0)
        }
      })

      const hasilUjian = baris.filter((b: any) => b.jenis === 'ujian-sendiri').reduce((a: number, b: any) => a + Number(b.jumlah_usd || 0), 0)
      const hasilLuar = baris.filter((b: any) => b.jenis === 'pembeli-luar').reduce((a: number, b: any) => a + Number(b.jumlah_usd || 0), 0)
      const [agg] = (await d.prepare(
        "SELECT COUNT(*) AS jumlah, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS dibayar, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, COALESCE(SUM(CASE WHEN status = 'paid' THEN price_usd ELSE 0 END),0) AS hasil_usd FROM agent_calls"
      ).run())?.results || []

      // ?katalog=1 → status penyenaraian setiap servis dalam katalog fasilitator.
      let katalog: any = null
      if (String(c.req.query('katalog') || '') === '1') {
        const origin = new URL(c.req.url).origin
        katalog = await Promise.all(Object.keys(SERVIS).map(async (id) => {
          try {
            const r = await fetch(`${facilitator(c.env)}/discovery/listing-status?resource=${encodeURIComponent(origin + '/api/agent/' + id)}`, { headers: { accept: 'application/json' } })
            const j: any = await r.json().catch(() => null)
            return { servis: id, tersenarai: !!j?.listed, probe: j?.lastProbe?.status || '', http: j?.lastProbe?.httpStatus ?? null, sumber: j?.lastWrite?.source || '', dikemas_pada: j?.lastUpdated || '' }
          } catch {
            return { servis: id, tersenarai: null, ralat: 'gagal hubungi fasilitator' }
          }
        }))
      }

      return c.json({
        ok: true,
        dijana_pada: new Date().toISOString(),
        rangkaian: new URL(c.req.url).origin,
        ringkasan: {
          jumlah_cabaran: Number(agg?.jumlah || 0),
          dibayar: Number(agg?.dibayar || 0),
          belum_dibayar: Number(agg?.pending || 0),
          hasil_kasar_usd: Number(Number(agg?.hasil_usd || 0).toFixed(6)),
          hasil_pembeli_luar_usd: Number(hasilLuar.toFixed(6)),
          hasil_ujian_usd: Number(hasilUjian.toFixed(6)),
          nota: 'hasil_pembeli_luar_usd = pendapatan SEBENAR. Baris "ujian-sendiri" ialah ujian teknikal kita sendiri.'
        },
        ...(katalog ? { katalog } : {}),
        had,
        baris
      })
    } catch {
      return c.json({ ok: false, error: 'Ralat DB' }, 500)
    }
  })

  // Diagnostik: sahkan token bot yang terikat TANPA mendedahkan nilainya.
  // (username + id bot adalah maklumat awam; token tidak pernah dipulangkan)
  app.get('/api/agent/whoami', async (c: any) => {
    const jangka = String(c.env.AGENT_STATS_KEY || '')
    const kunci = String(c.req.query('key') || c.req.header('x-key') || '')
    if (!jangka || kunci !== jangka) return c.json({ ok: false, error: 'Kunci salah' }, 403)
    const tok = String(c.env.TELEGRAM_BOT_TOKEN || '')
    if (!tok) return c.json({ ok: false, telegram: 'TIADA token terikat', wallet: wallet(c.env) })
    try {
      const r: any = await (await fetch(`https://api.telegram.org/bot${tok}/getMe`)).json()
      const w: any = await (await fetch(`https://api.telegram.org/bot${tok}/getWebhookInfo`)).json()
      return c.json({
        ok: !!r?.ok,
        telegram: r?.ok ? `@${r.result.username}` : 'token TIDAK SAH',
        bot_id: r?.result?.id || null,
        nama_bot: r?.result?.first_name || null,
        webhook: w?.result?.url || '',
        menunggu: w?.result?.pending_update_count ?? null,
        ralat_terakhir: w?.result?.last_error_message || null,
        wallet: wallet(c.env)
      })
    } catch (e: any) {
      return c.json({ ok: false, telegram: 'ralat', ralat: e?.message })
    }
  })

  // Halaman manusia
  app.get('/agent', async (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    const w = wallet(env)
    const rate = await solUsd(env)
    const baris = Object.entries(SERVIS).map(([id, s]) => {
      const usd = harga(env, id)
      const sol = Math.max(Math.round((usd / rate) * LAMPORTS), 50000) / LAMPORTS
      const tag = s.jenis === 'crypto' ? '<span class="tag crypto">crypto</span>' : s.jenis === 'data' ? '<span class="tag data">data</span>' : '<span class="tag ai">AI</span>'
      return `<tr><td><code>${id}</code> ${tag}</td><td><strong>$${usd.toFixed(4)}</strong> USDC<br><span class="dim">${sol.toFixed(6)} SOL</span></td><td class="dim"><strong>${s.nama}</strong><br>${s.desc}</td></tr>`
    }).join('')
    return c.html(`<!doctype html><html lang="ms"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>Myworker Agent API — servis berbayar untuk bot</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; background:#0b0f19; color:#e5e7eb; font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:32px 20px }
  .wrap { max-width: 900px; margin: 0 auto }
  h1 { font-size: 26px; margin: 0 0 6px; color:#7dd3fc }
  p.lead { color:#94a3b8; margin:0 0 22px }
  table { width:100%; border-collapse: collapse; margin: 14px 0 26px; font-size:14px }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid #1f2937; vertical-align:top }
  th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em }
  code { background:#111827; border:1px solid #1f2937; border-radius:6px; padding:1px 6px; font-size:13px; color:#7dd3fc }
  pre { background:#111827; border:1px solid #1f2937; border-radius:10px; padding:14px; overflow-x:auto; font-size:12.5px; color:#e2e8f0 }
  .card { background:#0f1523; border:1px solid #1f2937; border-radius:14px; padding:18px 20px; margin-bottom:18px }
  .dim { color:#94a3b8; font-size:12.5px }
  .tag { display:inline-block; border-radius:999px; padding:1px 8px; font-size:11px; border:1px solid }
  .tag.crypto { background:#052e2b; color:#5eead4; border-color:#115e59 }
  .tag.ai { background:#1e1b4b; color:#c4b5fd; border-color:#3730a3 }
.tag.data { background:#3b2606; color:#fcd34d; border-color:#92400e }
  a { color:#7dd3fc }
</style></head><body><div class="wrap">
<h1>Myworker Agent API</h1>
<p class="lead">Servis berbayar untuk <strong>bot &amp; agen</strong> — bayar per panggilan dengan <strong>USDC</strong> di Solana atau Base, atau SOL di Solana. Tiada akaun, tiada API key. <span class="tag ai">x402 v2</span></p>
<div class="card">
  <div class="dim">Dompet penerima (Solana)</div>
  <div><code>${w}</code></div>
  <div class="dim" style="margin-top:8px">Rangkaian: <code>${caip2(env)}</code> · Kadar rujukan: 1 SOL ≈ $${rate.toFixed(2)}</div>
  ${evmWallet(env) ? `<div class="dim" style="margin-top:8px">Dompet penerima (Base / EVM): <code>${evmWallet(env)}</code> · Rangkaian: <code>eip155:8453</code> (USDC asli)</div>` : ''}
  <div class="dim" style="margin-top:8px">Fasilitator x402: <code>${facilitator(env)}</code></div>
</div>
<table>
  <thead><tr><th>Servis</th><th>Harga</th><th>Keterangan</th></tr></thead>
  <tbody>${baris}</tbody>
</table>
<div class="card">
  <strong>Cara guna A — standard x402 v2 (disyorkan untuk bot autonomi)</strong>
  <pre># 1. Panggil tanpa bayaran -> 402 + header PAYMENT-REQUIRED (base64)
curl -s -i ${origin}/api/agent/quote

# 2. Hantar semula dengan bayaran yang ditandatangani:
curl -s ${origin}/api/agent/quote \\
  -H 'PAYMENT-SIGNATURE: &lt;base64 PaymentPayload&gt;'</pre>
  <div class="dim">Klien rasmi: <code>@x402/fetch</code> (+ <code>@x402/svm</code> atau <code>@x402/evm</code>) menyelesaikan langkah ini secara automatik. <code>accepts[]</code> mengandungi USDC di Solana serta USDC di Base.</div>
</div>
<div class="card">
  <strong>Cara guna B — lean (tanpa sokongan x402)</strong>
  <pre># 1. Panggil tanpa bayaran -> dapat harga + reference
curl -s -X POST ${origin}/api/agent/quote \\
  -H 'content-type: application/json' \\
  -d '{"dari":"sol","ke":"usdc","jumlah":100000000}'

# 2. Bayar ke dompet (masukkan reference sebagai akaun tambahan), kemudian hantar bukti:
curl -s -X POST ${origin}/api/agent/quote \\
  -H 'content-type: application/json' \\
  -H 'X-Payment-Ref: &lt;reference&gt;' \\
  -d '{"dari":"sol","ke":"usdc","jumlah":100000000}'</pre>
  <div class="dim">GET juga disokong (input dari query string): <code>curl -s '${origin}/api/agent/harga?token=sol'</code></div>
  <div class="dim">Manifest: <a href="/.well-known/x402.json">/.well-known/x402.json</a> · Katalog JSON: <a href="/api/agent">/api/agent</a> · Panduan agen: <a href="/llms.txt">/llms.txt</a></div>
</div>
</div></body></html>`)
  })

  // ------------------------------------------------- AgentBazaar (agentbazaar.dev)
  // Info awam + penerima tugasan mod "push". Bayaran diurus AgentBazaar (97% ke kita).
  app.get('/agentbazaar', (c: any) => {
    const env = c.env
    const origin = new URL(c.req.url).origin
    return c.json({
      ok: true,
      nama: 'Myworker Agent',
      platform: 'AgentBazaar (agentbazaar.dev) — marketplace agen di Solana',
      mod: 'push',
      endpoint: `${origin}/agentbazaar`,
      kontrak: 'POST { task, files, buyer, jobId } -> { result: "<teks>" }',
      contoh: { task: 'Adakah token bonk selamat?', jobId: '1234', buyer: '7xKQ…' },
      servis: Object.keys(SERVIS).map((id) => ({
        id,
        nama: SERVIS[id].nama,
        jenis: SERVIS[id].jenis,
        harga_usd: harga(env, id),
        keterangan: SERVIS[id].desc
      })),
      nota: 'Tugasan bebas dihurai mengikut niat (Melayu/Inggeris). Tanpa jobId, hanya info ini dipulangkan.'
    })
  })

  app.post('/agentbazaar', async (c: any) => {
    const env = c.env
    let body: any = {}
    try { body = (await c.req.json()) || {} } catch { body = {} }
    const teks = str(body.task ?? body.message ?? body.text ?? '')
    const jobId = str(body.jobId ?? body.job_id ?? '')
    const buyer = str(body.buyer ?? '')
    const kunci = c.req.header('x-bazaar-key') || ''
    const rahsia = str(env.AGENT_BAZAAR_SECRET)
    // Tanpa jobId (tugasan rasmi platform) atau kunci ujian kita -> tidak laksana apa-apa.
    if (!jobId && !(rahsia && kunci === rahsia)) {
      return c.json({ ok: false, error: 'jobId diperlukan (tugasan rasmi AgentBazaar).', info: new URL(c.req.url).origin + '/agentbazaar' }, 400)
    }
    if (!teks) return c.json({ result: 'Sila berikan tugasan. Contoh: "saring-token bonk" atau "harga sol".' })

    await ensureBazaar(env)
    const r = await laksanaBazaar(env, teks)
    const d = db(env)
    if (d) {
      try {
        await d.prepare(
          'INSERT INTO bazaar_tasks (job_id, buyer, servis, input, status, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(jobId, buyer, r.servis, r.input, r.status, r.ms, Date.now()).run()
      } catch (e: any) { console.error('log bazaar gagal:', e?.message || e) }
    }
    await bisikBazaar(env, [
      '🔔 AgentBazaar: tugasan baharu',
      `Servis: ${r.servis} (${r.status})`,
      `Tugasan: ${teks.slice(0, 240)}`,
      `Pembeli: ${buyer || '-'} · Job: ${jobId || '-'}`,
      `Masa: ${r.ms} ms`
    ].join('\n'))

    // Jika servis benar-benar gagal -> 503 (platform tandakan gagal, tiada caj penuh).
    if (r.status === 'ralat' || r.status === 'gagal') {
      return c.json({ ok: false, error: 'Servis gagal dijalankan', servis: r.servis }, 503)
    }
    return c.json({ result: r.jawapan })
  })

  // Log tugasan AgentBazaar untuk pemilik (key sama seperti /api/agent/stats).
  app.get('/api/agent/bazaar', async (c: any) => {
    const env = c.env
    const kunci = str(env.AGENT_STATS_KEY)
    if (!kunci || c.req.query('key') !== kunci) return c.json({ ok: false, error: 'key tak sah' }, 401)
    const d = db(env)
    if (!d) return c.json({ ok: false, error: 'DB tiada' }, 500)
    await ensureBazaar(env)
    const had = Math.min(100, Math.max(1, Number(c.req.query('had') || 20)))
    const jumlah: any = (await d.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS terakhir FROM bazaar_tasks').run())?.results?.[0] || {}
    const perServis: any = (await d.prepare('SELECT servis, COUNT(*) AS n FROM bazaar_tasks GROUP BY servis ORDER BY n DESC').run())?.results || []
    const terkini: any = (await d.prepare('SELECT job_id, buyer, servis, status, ms, created_at FROM bazaar_tasks ORDER BY id DESC LIMIT ?').bind(had).run())?.results || []
    return c.json({ ok: true, jumlah_tugasan: Number(jumlah?.n || 0), terakhir: jumlah?.terakhir || 0, per_servis: perServis, terkini })
  })

  // DEBUG (berpassword): status sebenar setiap sumber FX dari dalam Worker.
  // (wajib sebelum laluan umum :servis, else kena tangkap generic handler)
  app.get('/api/agent/fx-debug', async (c: any) => {
    const env = c.env
    const kunci = str(env.AGENT_STATS_KEY)
    if (!kunci || c.req.query('key') !== kunci) return c.json({ ok: false, error: 'key tak sah' }, 401)
    const cuba = async (nama: string, url: string, withHeaders: boolean) => {
      try {
        const r = await fetch(url, withHeaders ? { headers: KEPALA_JSON } : ({} as any))
        const teks = await r.text()
        return { nama, status: r.status, kaedah: withHeaders ? 'dgn-UA' : 'tanpa-UA', bait: teks.length, mula: teks.slice(0, 60) }
      } catch (e: any) { return { nama, kaedah: withHeaders ? 'dgn-UA' : 'tanpa-UA', ralat: String(e?.message || e) } }
    }
    const hasil = [
      await cuba('jsdelivr', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json', true),
      await cuba('jsdelivr-tanpaUA', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json', false),
      await cuba('exchangerate-api', 'https://api.exchangerate-api.com/v4/latest/USD', true),
      await cuba('frankfurter-dev', 'https://api.frankfurter.dev/v1/latest?base=USD', true),
      await cuba('ler-api', 'https://open.er-api.com/v6/latest/USD', true),
      await cuba('nager', 'https://date.nager.at/api/v3/PublicHolidays/2027/US', true),
      await cuba('yields', 'https://yields.llama.fi/pools', true)
    ]
    return c.json({ ok: true, dikaji_pada: new Date().toISOString(), hasil })
  })

  app.post('/api/agent/:servis', handler)
  app.get('/api/agent/:servis', handler)
  // HEAD: probe baca-sahaja daripada fasilitator/katalog (bot & penemuan).
  app.on('HEAD', '/api/agent/:servis', handler)
}

// ---------------------------------------------------------------- Telegram

export function senaraiServis(env: any): string {
  return Object.entries(SERVIS).map(([id, s], i) => {
    const usd = harga(env, id)
    return `${i + 1}. /beli ${id} <argumen>\n   ${s.nama} — $${usd.toFixed(4)} USDC\n   contoh: ${s.contoh}`
  }).join('\n\n')
}

/**
 * Kendalikan arahan Telegram untuk bot pekerja.
 * Pulangkan true kalau arahan ini diuruskan di sini.
 */
export async function handleAgentCommand(c: any, text: string, send: (m: string) => Promise<void>, isAdmin: boolean): Promise<boolean> {
  const env = c.env
  const origin = new URL(c.req.url).origin
  const bahagian = String(text || '').trim().split(/\s+/)
  const cmd = String(bahagian[0] || '').toLowerCase().replace(/@\w+$/, '')

  if (cmd === '/servis' || cmd === '/service') {
    await send(`🧰 Servis berbayar (Agent API)\n\n${senaraiServis(env)}\n\nBeli: /beli <id> <argumen>\nSemak: /semak <challenge>\nDaftar penuh: ${origin}/agent`)
    return true
  }

  if (cmd === '/start' || cmd === '/help' || cmd === '/bantuan') {
    await send(
      `👷 Myworker — bot pekerja yang menjual servis kepada bot & manusia.\n\n` +
      `${senaraiServis(env)}\n\n` +
      `— Cara beli —\n/beli <id> <argumen>  → dapat harga + reference\nbayar USDC/SOL ke dompet → /semak <challenge>\n\n` +
      `— Arahan lain —\n/wallet · /paper · /analytics${isAdmin ? ' · /hasil' : ''}\n\n` +
      `Untuk bot lain (HTTP/x402): ${origin}/api/agent`
    )
    return true
  }

  if (cmd === '/beli') {
    const id = String(bahagian[1] || '').toLowerCase()
    const meta = SERVIS[id]
    if (!meta) {
      await send(`Servis tak dikenali. Pilih salah satu:\n\n${senaraiServis(env)}`)
      return true
    }
    const arg = bahagian.slice(2).join(' ').trim()
    if (meta.jenis === 'ai' && !arg) {
      await send(`Sertakan teks. Contoh:\n/beli ${id} Ringkaskan teks ini…`)
      return true
    }
    const ch = await cabaranBaru(env, id, arg)
    await send(
      `🧾 Pesanan: ${meta.nama}\nHarga: $${ch.usd.toFixed(4)} USDC (~${(ch.lamports / LAMPORTS).toFixed(6)} SOL)\n\n` +
      `BAYAR ke dompet:\n${ch.wallet}\n\n` +
      `USDC: ${origin}/pay\n` +
      `🔑 reference (masukkan dalam transaksi):\n${ch.ref}\n\n` +
      `Selepas bayar, hantar:\n/semak ${ch.challenge}`
    )
    return true
  }

  if (cmd === '/semak') {
    const challenge = String(bahagian[1] || '').trim()
    if (!challenge) { await send('Format: /semak <challenge>'); return true }
    await ensureTable(env)
    const row = (await db(env).prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind(challenge).run())?.results?.[0]
    if (!row) { await send('Cabaran tak dijumpai.'); return true }
    if (row.status === 'paid' && row.result) { await send(`✅ Sudah dibayar.\n\n${row.result}`); return true }
    const r = await settleAgent(env, row.service, row.payload || '', { challenge })
    await send(r.ok ? `✅ Bayaran diterima!\n\n${r.hasil}` : `⏳ ${r.reason}`)
    return true
  }

  if (cmd === '/hasil') {
    if (!isAdmin) { await send('Akses pemilik sahaja.'); return true }
    await ensureTable(env)
    const d = db(env)
    const [r] = (await d.prepare("SELECT COUNT(*) AS jumlah, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS dibayar, COALESCE(SUM(CASE WHEN status = 'paid' THEN price_usd ELSE 0 END),0) AS usd FROM agent_calls").run())?.results || []
    const per = (await d.prepare("SELECT service, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY service ORDER BY n DESC").run())?.results || []
    await send(
      `💰 Hasil Agent API\n• Cabaran: ${r?.jumlah || 0}\n• Dibayar: ${r?.dibayar || 0}\n• Hasil: $${Number(r?.usd || 0).toFixed(4)}` +
      (per.length ? '\n\nPer servis:\n' + per.map((p: any) => `• ${p.service}: ${p.n} ($ ${Number(p.usd).toFixed(4)})`).join('\n') : '')
    )
    return true
  }

  return false
}

// ---------------------------------------------------------------- MCP (Model Context Protocol)
// TAMBAHAN 19 Okt — additive sahaja:
//  * TIADA satu pun kod servis sedia ada diubah: katalog BACA SAHAJA daripada
//    registry PLUGIN_LIST (nama, desc, skema, harga(env,id)).
//  * tools/call TIDAK melaksanakan servis — memandu pembeli ke laluan REST x402
//    yang berbayar (prinsip: tiada laluan guna-percuma baru).
//  Pengangkutan: Streamable HTTP (JSON-RPC 2.0) pada POST /mcp; GET /mcp = info.

const MCP_PROTOKOL = '2025-06-18'

export function registerMcp(app: any): void {
  app.get('/mcp', (c: any) => {
    const env = c.env
    const n = PLUGIN_LIST.length
    return c.json({
      ok: true,
      nama: 'Myworker MCP server',
      protokol: MCP_PROTOKOL,
      pengangkutan: 'Streamable HTTP — POST /mcp (JSON-RPC 2.0)',
      jumlah_alat: n,
      alat: PLUGIN_LIST.map((p) => ({ id: p.id, harga_usd: Number(harga(env, p.id).toFixed(4)) })),
      kaedah_disokong: ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'],
      nota_bayaran: 'tools/call tidak melaksanakan servis; ia mengembalikan panduan bayar x402. Pelaksanaan melalui POST /api/agent/<id> dengan pembayaran x402 (USDC, Base atau Solana).'
    })
  })

  app.post('/mcp', async (c: any) => {
    const env = c.env
    let body: any = null
    try { body = await c.req.json() } catch { /* bukan JSON */ }
    if (!body || String(body?.jsonrpc || '') !== '2.0') {
      return c.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Permintaan tidak sah — jsonrpc:"2.0" diperlukan' } }, 400)
    }
    const kaedah = String(body?.method || '')
    const id = body?.id ?? null

    if (kaedah === 'ping') {
      return c.json({ jsonrpc: '2.0', id, result: {} })
    }

    if (kaedah === 'initialize') {
      return c.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOKOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'myworker', title: 'Myworker — 20 API micro crypto/AI (x402)', version: '1.0.0' },
          instructions: `Katalog ${PLUGIN_LIST.length} micro-servis crypto & AI. Gunakan tools/list untuk senarai penuh beserta harga. Pelaksanaan alat dibayar per panggilan (USDC, protokol x402) melalui https://${new URL(c.req.url).host}/api/agent/<id>.`
        }
      })
    }

    if (kaedah === 'notifications/initialized') {
      return c.body(null, 202)
    }

    if (kaedah === 'tools/list') {
      const asas = `https://${new URL(c.req.url).host}/api/agent/`
      const tools = PLUGIN_LIST.map((p) => ({
        name: p.id,
        title: p.nama,
        description: `${p.desc} || HARGA: $${Number(harga(env, p.id)).toFixed(4)} USDC per panggilan. Pelaksanaan: POST ${asas}${p.id} (x402; ${p.jenis === 'ai' ? 'AI berstruktur' : 'data/langsung'}).`,
        inputSchema: p.skema()
      }))
      return c.json({ jsonrpc: '2.0', id, result: { tools } })
    }

    if (kaedah === 'tools/call') {
      const nama = String(body?.params?.name || '')
      const p = PLUGIN[nama as string]
      if (!p) {
        return c.json({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: `Alat "${nama}" tidak dijumpai. Gunakan tools/list untuk senarai ${PLUGIN_LIST.length} alat.` }],
            isError: true
          }
        })
      }
      const h = Number(harga(env, p.id))
      return c.json({
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: (
              `Alat "${nama}" (${p.nama}) bernilai $${h.toFixed(4)} USDC per panggilan.\n\n` +
              `PELAKSANAAN (REST x402, automatik untuk agen):\n` +
              `1. POST https://${new URL(c.req.url).host}/api/agent/${nama}\n` +
              `   → respons 402 membawa PAYMENT-REQUIRED (quote harga, base64 UTF-8)\n` +
              `2. Bayar mengikut quote (USDC di Base/Solana, protokol x402)\n` +
              `3. Ulang POST yang sama — hasil diterima + pembayaran selesai on-chain\n\n` +
              `Output yang dijanjikan (contoh rupa): ${JSON.stringify(p.outputContoh())}`
            )
          }],
          isError: false
        }
      })
    }

    return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Kaedah "${kaedah}" tidak dijumpai` } })
  })
}
