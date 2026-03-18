// Session client — CLI script demonstrating the full session lifecycle:
//   1. Fund wallet via faucet
//   2. Open a session (on-chain deposit)
//   3. Make multiple paid requests using the bearer token
//   4. Close the session (on-chain refund of unused balance)

import { Mppx } from 'solana-mpp/client'
import { solana } from 'solana-mpp/client'
import { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type { WalletLike } from 'solana-mpp'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const connection = new Connection('http://localhost:8899', 'confirmed')
const keypair = Keypair.generate()

const wallet: WalletLike = {
  publicKey: keypair.publicKey,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    // Use duck typing instead of instanceof to avoid cross-module class mismatch
    if ('partialSign' in tx) {
      ;(tx as Transaction).partialSign(keypair)
    }
    return tx
  },
}

console.log(`Client wallet: ${keypair.publicKey.toBase58()}`)

// ---------------------------------------------------------------------------
// Step 1: Fund wallet
// ---------------------------------------------------------------------------

console.log('\n--- Funding ---')
console.log('Requesting faucet...')

const faucetRes = await fetch(`${BASE_URL}/api/faucet?address=${keypair.publicKey.toBase58()}`)
const faucetData = (await faucetRes.json()) as {
  mint: string
  decimals: number
  funded: boolean
}

if (!faucetData.funded) {
  console.error('Faucet failed')
  process.exit(1)
}

const mintAddress = new PublicKey(faucetData.mint)
const decimals = faucetData.decimals

async function getBalance(): Promise<bigint> {
  try {
    const ata = await getAssociatedTokenAddress(mintAddress, keypair.publicKey)
    const account = await getAccount(connection, ata)
    return account.amount
  } catch {
    return 0n
  }
}

const fmt = (raw: bigint) => `${(Number(raw) / 10 ** decimals).toFixed(decimals)} tokens`

const balanceBefore = await getBalance()
console.log(`Balance: ${fmt(balanceBefore)}`)
console.log(`Mint: ${faucetData.mint}`)

// ---------------------------------------------------------------------------
// Step 2: Create session and make requests
// ---------------------------------------------------------------------------

const sessionMethod = solana.session({
  wallet,
  network: 'localnet',
  connection,
})

const mppx = Mppx.create({
  methods: [sessionMethod],
  polyfill: false,
})

const PAGE_COUNT = 5

console.log(`\n--- Session: fetching ${PAGE_COUNT} pages ---`)

for (let i = 1; i <= PAGE_COUNT; i++) {
  const url = `${BASE_URL}/api/data?page=${i}`
  console.log(`  GET ${url}`)

  const response = await mppx.fetch(url)

  if (!response.ok) {
    console.error(`  Error: HTTP ${response.status}`)
    const text = await response.text()
    console.error(`  ${text}`)
    break
  }

  const data = (await response.json()) as { page: number; content: string }
  console.log(`  Page ${data.page}: ${data.content.slice(0, 60)}...`)

  // After the first request, the session should be open.
  // Update the sessionId from the receipt.
  const receiptHeader = response.headers.get('payment-receipt')
  if (receiptHeader && i === 1) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString())
      if (receipt.reference) {
        sessionMethod.setSessionId(receipt.reference)
        console.log(`  Session opened: ${receipt.reference}`)
      }
    } catch {
      // Receipt parsing is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Close session
// ---------------------------------------------------------------------------

console.log('\n--- Closing session ---')
sessionMethod.close()

const closeRes = await mppx.fetch(`${BASE_URL}/api/data?page=close`)
if (closeRes.ok) {
  console.log('  Session closed successfully')
} else {
  console.log(`  Close response: HTTP ${closeRes.status}`)
}

// ---------------------------------------------------------------------------
// Step 4: Summary
// ---------------------------------------------------------------------------

// Wait for refund tx to settle
await new Promise((r) => setTimeout(r, 2_000))

const balanceAfter = await getBalance()
const spent = balanceBefore - balanceAfter

console.log('\n--- Summary ---')
console.log(`  Pages fetched:  ${PAGE_COUNT}`)
console.log(`  Balance before: ${fmt(balanceBefore)}`)
console.log(`  Balance after:  ${fmt(balanceAfter)}`)
console.log(`  Total spent:    ${fmt(spent)}`)
