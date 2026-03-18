import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

export interface WalletLike {
  publicKey: PublicKey
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}

export type { SolanaNetwork } from './constants.js'
