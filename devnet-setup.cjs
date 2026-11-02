/** Sediakan token SPL ujian di Solana DEVNET (percuma) untuk ujian x402 standard. */
const fs = require('fs'), os = require('os'), path = require('path')
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js')
const { createMint, getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token')

const RPC = process.env.DEVNET_RPC || 'https://api.devnet.solana.com'
const PAYTO = '3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E'

;(async () => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agent-test-wallet.json'), 'utf8'))))
  const conn = new Connection(RPC, 'confirmed')
  let bal = await conn.getBalance(kp.publicKey)
  console.log('Dompet ujian :', kp.publicKey.toBase58())
  console.log('Baki devnet  :', bal / LAMPORTS_PER_SOL, 'SOL')
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    console.log('  -> minta airdrop 1 SOL devnet...')
    for (let i = 0; i < 3; i++) {
      try {
        const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL)
        await conn.confirmTransaction(sig, 'confirmed')
        bal = await conn.getBalance(kp.publicKey)
        console.log('  -> berjaya. Baki:', bal / LAMPORTS_PER_SOL, 'SOL')
        break
      } catch (e) { console.log('  -> cubaan', i + 1, 'gagal:', String(e.message).slice(0, 120)); await new Promise((r) => setTimeout(r, 4000)) }
    }
  }
  const f = path.join(os.homedir(), '.devnet-test-mint.json')
  let mint
  if (fs.existsSync(f)) {
    mint = new PublicKey(JSON.parse(fs.readFileSync(f, 'utf8')).mint)
    console.log('Mint sedia ada:', mint.toBase58())
  } else {
    mint = await createMint(conn, kp, kp.publicKey, null, 6)
    fs.writeFileSync(f, JSON.stringify({ mint: mint.toBase58(), decimals: 6, by: kp.publicKey.toBase58() }))
    console.log('MINT BAHARU  :', mint.toBase58())
  }
  const aUjian = await getOrCreateAssociatedTokenAccount(conn, kp, mint, kp.publicKey)
  const aPay = await getOrCreateAssociatedTokenAccount(conn, kp, mint, new PublicKey(PAYTO))
  console.log('ATA pembeli  :', aUjian.address.toBase58(), '| baki', Number(aUjian.amount))
  console.log('ATA payTo    :', aPay.address.toBase58(), '| baki', Number(aPay.amount))
  if (Number(aUjian.amount) < 5_000_000) {
    const s = await mintTo(conn, kp, mint, aUjian.address, kp, 100_000_000)
    console.log('  -> mint 100.000000 unit. tx:', s)
  }
  console.log('SIAP')
})().catch((e) => { console.error('RALAT:', e.message); process.exit(1) })
