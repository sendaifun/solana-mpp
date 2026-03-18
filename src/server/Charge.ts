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

  const pendingReferences = new Map<string, Keypair>()

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

      pendingReferences.set(referenceKey, referenceKeypair)

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

      if (store) {
        const consumedKey = `solana-charge:consumed:${signature}`
        if (await store.get(consumedKey)) {
          throw new Error('Transaction signature already consumed')
        }
        await store.put(consumedKey, true)
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

      pendingReferences.delete(referenceKey)

      return Receipt.from({
        method: 'solana',
        reference: signature,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
}

