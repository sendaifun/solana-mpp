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

// Server-side keypairs
const mintAuthority = Keypair.generate()
const recipient = Keypair.generate()

let mint: PublicKey = null!
const DECIMALS = 6

async function setup() {
  console.log('[server] Setting up localnet...')

  // Airdrop SOL to mint authority and recipient
  await Promise.all([
    airdrop(mintAuthority.publicKey, 2),
    airdrop(recipient.publicKey, 1),
  ])

  // Create the test SPL token mint
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

const mppx = Mppx.create({
  methods: [
    solana.charge({
      recipient: recipient.publicKey,
      mint,
      decimals: DECIMALS,
      network: 'localnet',
      connection,
      store,
    }),
  ],
  secretKey: 'solana-mpp-example-secret',
})

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'There are only 10 types of people in the world: those who understand binary and those who don\'t.',
  'A SQL query walks into a bar, sees two tables, and asks... "Can I JOIN you?"',
  'Why do Java developers wear glasses? Because they can\'t C#.',
  'What\'s a pirate\'s favorite programming language? R!',
  '!false — it\'s funny because it\'s true.',
  'How many programmers does it take to change a light bulb? None, that\'s a hardware problem.',
  'Why was the developer unhappy at their job? They wanted arrays.',
  'What\'s the object-oriented way to become wealthy? Inheritance.',
  'Why do blockchain devs never get lost? They always follow the chain.',
]

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Free: health check
  if (url.pathname === '/api/health') {
    return Response.json({ status: 'ok' })
  }

  // Free: faucet — airdrop SOL and mint test tokens to a client address
  if (url.pathname === '/api/faucet') {
    const address = url.searchParams.get('address')
    if (!address) return Response.json({ error: 'address required' }, { status: 400 })

    try {
      const pubkey = new PublicKey(address)

      // Airdrop 1 SOL for fees
      await airdrop(pubkey, 1)

      // Mint 1000 test tokens
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

  // Paid: get a joke
  if (url.pathname === '/api/joke') {
    const result = await mppx.charge({
      amount: '0.001',
      description: 'A programming joke',
    })(request)

    if (result.status === 402) return result.challenge

    const joke = jokes[Math.floor(Math.random() * jokes.length)]!
    return result.withReceipt(Response.json({ joke }))
  }

  return null
}
