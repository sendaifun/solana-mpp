import { Mppx, Store } from 'solana-mpp/server'
import { solana } from 'solana-mpp/server'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js'
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token'

// ---------------------------------------------------------------------------
// Localnet setup
// ---------------------------------------------------------------------------

const connection = new Connection('http://localhost:8899', 'confirmed')

const mintAuthority = Keypair.generate()
const recipient = Keypair.generate()
const serverKeypair = recipient // same key for receiving and signing refunds

let mint: PublicKey = null!
const DECIMALS = 6

async function setup() {
  console.log('[server] Setting up localnet...')

  await Promise.all([
    airdrop(mintAuthority.publicKey, 2),
    airdrop(recipient.publicKey, 2),
  ])

  mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    DECIMALS,
  )

  // Create the recipient's ATA so clients can transfer to it
  await getOrCreateAssociatedTokenAccount(
    connection,
    mintAuthority,
    mint,
    recipient.publicKey,
  )

  console.log(`[server] Mint: ${mint.toBase58()}`)
  console.log(`[server] Recipient: ${recipient.publicKey.toBase58()}`)
  console.log('[server] Setup complete')
}

async function airdrop(pubkey: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL)
  await connection.confirmTransaction(sig, 'confirmed')
}

// ---------------------------------------------------------------------------
// Payment handler
// ---------------------------------------------------------------------------

await setup()

const store = Store.memory()

const sessionMethod = solana.session({
  recipient: recipient.publicKey,
  mint,
  decimals: DECIMALS,
  serverKeypair,
  network: 'localnet',
  connection,
  store,
})

const mppx = Mppx.create({
  methods: [sessionMethod],
  secretKey: 'solana-mpp-session-example-secret',
})

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Free: health check
  if (url.pathname === '/api/health') {
    return Response.json({ status: 'ok' })
  }

  // Free: faucet
  if (url.pathname === '/api/faucet') {
    const address = url.searchParams.get('address')
    if (!address) return Response.json({ error: 'address required' }, { status: 400 })

    try {
      const pubkey = new PublicKey(address)
      await airdrop(pubkey, 2)

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        mintAuthority,
        mint,
        pubkey,
      )
      await mintTo(
        connection,
        mintAuthority,
        mint,
        ata.address,
        mintAuthority,
        1_000n * BigInt(10 ** DECIMALS),
      )

      console.log(`[server] Funded ${address}`)
      return Response.json({
        address,
        mint: mint.toBase58(),
        decimals: DECIMALS,
        funded: true,
      })
    } catch (err) {
      console.error('[server] Faucet error:', err)
      return Response.json({ error: String(err) }, { status: 500 })
    }
  }

  // Paid: data endpoint (session-gated)
  if (url.pathname === '/api/data') {
    const page = url.searchParams.get('page') ?? '1'

    const result = await mppx.session({
      amount: '0.01',
      depositAmount: '0.1',
      unitType: 'page',
    })(request)

    if (result.status === 402) return result.challenge

    const data = {
      page: Number(page),
      content: `Data for page ${page}: ${generateContent(Number(page))}`,
      timestamp: new Date().toISOString(),
    }

    return result.withReceipt(Response.json(data))
  }

  return null
}

function generateContent(page: number): string {
  const topics = [
    'Solana processes 65,000 TPS with 400ms block times.',
    'SPL tokens use Associated Token Accounts for ownership.',
    'The Solana Pay reference key pattern enables tx discovery.',
    'Proof of History provides a cryptographic clock for Solana.',
    'Solana programs are stateless and store data in accounts.',
    'Transaction fees on Solana average $0.00025 per transaction.',
    'Solana uses Tower BFT for consensus among validators.',
    'Turbine is Solana\'s block propagation protocol.',
    'Gulf Stream forwards transactions to the next leader.',
    'Sealevel enables parallel smart contract execution on Solana.',
  ]
  return topics[(page - 1) % topics.length]!
}
