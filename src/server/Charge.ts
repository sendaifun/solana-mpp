import { Method, Receipt, Store } from 'mppx'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress } from '@solana/spl-token'
import * as Methods from '../Methods.js'
import { clusterUrls, type SolanaNetwork } from '../constants.js'
import { parseAmount } from '../utils.js'
import { findAndVerifyTransfer } from './verify.js'

export namespace charge {
  export interface Parameters {
    recipient: PublicKey
    mint: PublicKey
    decimals: number
    network?: SolanaNetwork
    connection?: Connection
    store?: Store.Store
    verifyTimeout?: number
  }
}

export function charge(parameters: charge.Parameters) {
  const {
    recipient,
    mint,
    decimals,
    network = 'mainnet-beta',
    store,
    verifyTimeout,
  } = parameters

  const connection =
    parameters.connection ?? new Connection(clusterUrls[network], 'confirmed')

  // Per-signature mutex to prevent concurrent duplicate verification
  const signatureLocks = new Map<string, Promise<void>>()

  async function withSignatureLock<T>(sig: string, fn: () => Promise<T>): Promise<T> {
    const existing = signatureLocks.get(sig) ?? Promise.resolve()
    let resolve: () => void
    const next = new Promise<void>((r) => { resolve = r })
    signatureLocks.set(sig, next)
    try {
      await existing
      return await fn()
    } finally {
      resolve!()
      if (signatureLocks.get(sig) === next) {
        signatureLocks.delete(sig)
      }
    }
  }

  return Method.toServer(Methods.charge, {
    defaults: {
      currency: mint.toBase58(),
      methodDetails: {
        recipient: '',
        mint: '',
        decimals: 0,
        reference: '',
        network,
      },
    },

    async request({ credential, request }) {
      if (credential) {
        return credential.challenge.request as typeof request
      }

      const referenceKeypair = Keypair.generate()
      const referenceKey = referenceKeypair.publicKey.toBase58()

      const recipientAta = await getAssociatedTokenAddress(mint, recipient)

      return {
        ...request,
        methodDetails: {
          recipient: recipientAta.toBase58(),
          mint: mint.toBase58(),
          decimals,
          reference: referenceKey,
          network,
        },
      }
    },

    async verify({ credential }) {
      const { signature } = credential.payload
      const { methodDetails } = credential.challenge.request

      const referenceKey = methodDetails.reference

      return withSignatureLock(signature, async () => {
        // Replay check inside lock to prevent concurrent duplicates
        if (store) {
          const consumedKey = `solana-charge:consumed:${signature}`
          if (await store.get(consumedKey)) {
            throw new Error('Transaction signature already consumed')
          }
        }

        const reference = new PublicKey(referenceKey)
        const expectedRecipient = new PublicKey(methodDetails.recipient)
        const expectedMint = new PublicKey(methodDetails.mint)

        const amount = credential.challenge.request.amount
        const expectedAmount = parseAmount(amount, methodDetails.decimals)

        await findAndVerifyTransfer(
          connection,
          {
            reference,
            expectedRecipient,
            expectedMint,
            expectedAmount,
            clientSignature: signature,
          },
          verifyTimeout,
        )

        // Mark consumed only after successful on-chain verification
        if (store) {
          const consumedKey = `solana-charge:consumed:${signature}`
          await store.put(consumedKey, true)
        }

        return Receipt.from({
          method: 'solana',
          reference: signature,
          status: 'success',
          timestamp: new Date().toISOString(),
        })
      })
    },
  })
}

