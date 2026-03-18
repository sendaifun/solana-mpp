import { Mppx } from 'solana-mpp/client'
import { solana } from 'solana-mpp/client'
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token'
import type { WalletLike } from 'solana-mpp'

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const setupEl = document.getElementById('setup')!
const readyEl = document.getElementById('ready')!
const balanceEl = document.getElementById('balance')!
const buttonEl = document.getElementById('button') as HTMLButtonElement
const outputEl = document.getElementById('output')!
const logEl = document.getElementById('log')!

function log(msg: string) {
  logEl.textContent += `${logEl.textContent ? '\n' : ''}${msg}`
}

// ---------------------------------------------------------------------------
// Wallet setup
// ---------------------------------------------------------------------------

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

let mintAddress: PublicKey
let mintDecimals: number

async function updateBalance() {
  try {
    const ata = await getAssociatedTokenAddress(mintAddress, keypair.publicKey)
    const account = await getAccount(connection, ata)
    const balance = Number(account.amount) / 10 ** mintDecimals
    balanceEl.textContent = balance.toFixed(mintDecimals)
  } catch {
    balanceEl.textContent = '0'
  }
}

// ---------------------------------------------------------------------------
// Fund via server faucet, then set up Mppx
// ---------------------------------------------------------------------------

let mppx: ReturnType<typeof Mppx.create>

try {
  log(`Wallet: ${keypair.publicKey.toBase58()}`)
  log('Requesting faucet...')

  const res = await fetch(`/api/faucet?address=${keypair.publicKey.toBase58()}`)
  const data = (await res.json()) as {
    mint: string
    decimals: number
    funded: boolean
    error?: string
  }

  if (!data.funded) throw new Error(data.error ?? 'Faucet failed')

  mintAddress = new PublicKey(data.mint)
  mintDecimals = data.decimals

  log(`Mint: ${data.mint}`)
  log('Funded!')

  // Create the payment client
  mppx = Mppx.create({
    methods: [
      solana.charge({
        wallet,
        network: 'localnet',
        connection,
      }),
    ],
    polyfill: false,
  })

  await updateBalance()
  setupEl.style.display = 'none'
  readyEl.style.display = 'block'
} catch (err) {
  setupEl.textContent = `Setup failed: ${err}`
  log(`Error: ${err}`)
}

// ---------------------------------------------------------------------------
// Pay-per-joke
// ---------------------------------------------------------------------------

buttonEl.addEventListener('click', async () => {
  buttonEl.disabled = true
  outputEl.textContent = ''
  outputEl.className = ''

  try {
    log('GET /api/joke')
    const res = await mppx.fetch('/api/joke')
    log(`HTTP ${res.status}`)

    if (!res.ok) {
      const body = await res.text()
      log(`Body: ${body}`)
      throw new Error(`Request failed: ${res.status}`)
    }

    const { joke } = (await res.json()) as { joke: string }
    outputEl.textContent = joke
    await updateBalance()
  } catch (err) {
    outputEl.textContent = String(err)
    outputEl.className = 'error'
    log(`Error: ${err}`)
  } finally {
    buttonEl.disabled = false
  }
})
