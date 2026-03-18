import { Method, Credential } from 'mppx'
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import * as Methods from '../Methods.js'
import { clusterUrls, type SolanaNetwork } from '../constants.js'
import type { WalletLike } from '../types.js'

export namespace charge {
  export interface Parameters {
    wallet: WalletLike | (() => WalletLike | Promise<WalletLike>)
    network?: SolanaNetwork
    connection?: Connection
    /** Priority fee in microlamports per compute unit (default: 1000) */
    priorityFee?: number
  }
}

export function charge(parameters: charge.Parameters) {
  const { network = 'mainnet-beta', priorityFee = 1000 } = parameters

  const connection =
    parameters.connection ?? new Connection(clusterUrls[network], 'confirmed')

  let walletInstance: WalletLike | undefined

  async function getWallet(): Promise<WalletLike> {
    if (walletInstance) return walletInstance
    const w = parameters.wallet
    walletInstance = typeof w === 'function' ? await w() : w
    return walletInstance
  }

  return Method.toClient(Methods.charge, {
    async createCredential({ challenge }) {
      const wallet = await getWallet()
      const { amount, methodDetails } = challenge.request

      const recipientAta = new PublicKey(methodDetails.recipient)
      const mint = new PublicKey(methodDetails.mint)
      const reference = new PublicKey(methodDetails.reference)
      const decimals = methodDetails.decimals

      const senderAta = await getAssociatedTokenAddress(mint, wallet.publicKey)

      const amountRaw = parseAmount(amount, decimals)

      const tx = new Transaction()

      // Add priority fee for congestion resilience
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFee,
        }),
      )

      // Ensure sender ATA exists (idempotent — no-op if already created)
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          senderAta,
          wallet.publicKey,
          mint,
        ),
      )

      const transferIx = createTransferCheckedInstruction(
        senderAta,
        mint,
        recipientAta,
        wallet.publicKey,
        amountRaw,
        decimals,
      )

      // Append reference key as a non-signer account for Solana Pay discovery
      transferIx.keys.push({
        pubkey: reference,
        isSigner: false,
        isWritable: false,
      })

      tx.add(transferIx)

      const latestBlockhash = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = latestBlockhash.blockhash
      tx.feePayer = wallet.publicKey

      const signed = await wallet.signTransaction(tx)
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      })

      await connection.confirmTransaction(
        { signature, ...latestBlockhash },
        'confirmed',
      )

      return Credential.serialize({ challenge, payload: { signature } })
    },
  })
}

function parseAmount(amount: string, decimals: number): bigint {
  const parts = amount.split('.')
  if (parts.length > 2) throw new Error(`Invalid amount format: "${amount}"`)
  const whole = parts[0] ?? '0'
  const frac = parts[1] ?? ''
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${amount}" has ${frac.length} fractional digits, but token only supports ${decimals} decimals`,
    )
  }
  return BigInt(whole + frac.padEnd(decimals, '0'))
}
