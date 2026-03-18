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

interface ActiveSession {
  sessionId: string
  bearer: string
}

export namespace session {
  export interface Parameters {
    wallet: WalletLike | (() => WalletLike | Promise<WalletLike>)
    network?: SolanaNetwork
    connection?: Connection
    /** Priority fee in microlamports per compute unit (default: 1000) */
    priorityFee?: number
  }
}

export function session(parameters: session.Parameters) {
  const { network = 'mainnet-beta', priorityFee = 1000 } = parameters

  const connection =
    parameters.connection ?? new Connection(clusterUrls[network], 'confirmed')

  let walletInstance: WalletLike | undefined
  let activeSession: ActiveSession | null = null
  let pendingTopUp = false
  let pendingClose = false

  async function getWallet(): Promise<WalletLike> {
    if (walletInstance) return walletInstance
    const w = parameters.wallet
    walletInstance = typeof w === 'function' ? await w() : w
    return walletInstance
  }

  const method = Method.toClient(Methods.session, {
    async createCredential({ challenge }) {
      const wallet = await getWallet()
      const { methodDetails } = challenge.request

      // Close action
      if (pendingClose && activeSession) {
        const payload = {
          action: 'close' as const,
          sessionId: activeSession.sessionId,
          bearer: activeSession.bearer,
        }
        pendingClose = false
        const result = Credential.serialize({ challenge, payload })
        activeSession = null
        return result
      }

      // Top-up action
      if (pendingTopUp && activeSession) {
        const topUpSignature = await sendTransfer(
          connection,
          wallet,
          methodDetails,
          challenge.request.amount,
          priorityFee,
        )
        const payload = {
          action: 'topUp' as const,
          sessionId: activeSession.sessionId,
          topUpSignature,
        }
        pendingTopUp = false
        return Credential.serialize({ challenge, payload })
      }

      // Bearer action (existing session)
      if (activeSession) {
        return Credential.serialize({
          challenge,
          payload: {
            action: 'bearer' as const,
            sessionId: activeSession.sessionId,
            bearer: activeSession.bearer,
          },
        })
      }

      // Open action (new session)
      const depositAmount = challenge.request.depositAmount ?? challenge.request.amount
      const depositSignature = await sendTransfer(
        connection,
        wallet,
        methodDetails,
        depositAmount,
        priorityFee,
      )

      const payload = {
        action: 'open' as const,
        depositSignature,
        refundAddress: wallet.publicKey.toBase58(),
      }

      // The deposit tx signature is the bearer secret
      activeSession = {
        sessionId: '', // will be populated from server response
        bearer: depositSignature,
      }

      return Credential.serialize({ challenge, payload })
    },
  })

  function topUp(): void {
    pendingTopUp = true
  }

  function close(): void {
    pendingClose = true
  }

  function getSession(): ActiveSession | null {
    return activeSession ? { ...activeSession } : null
  }

  function setSessionId(sessionId: string): void {
    if (activeSession) {
      activeSession.sessionId = sessionId
    }
  }

  function resetSession(): void {
    activeSession = null
    pendingTopUp = false
    pendingClose = false
  }

  function cleanup(): void {
    resetSession()
    walletInstance = undefined
  }

  return Object.assign(method, {
    topUp,
    close,
    getSession,
    setSessionId,
    resetSession,
    cleanup,
  })
}

async function sendTransfer(
  connection: Connection,
  wallet: WalletLike,
  methodDetails: { recipient: string; mint: string; decimals: number; reference: string },
  amount: string,
  priorityFee: number,
): Promise<string> {
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

  return signature
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
