import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import type { ParsedTransactionWithMeta } from '@solana/web3.js'

// Inline the verify logic to test without needing a live connection
function verifyReferenceKey(
  tx: ParsedTransactionWithMeta,
  reference: PublicKey,
): void {
  const accountKeys = tx.transaction.message.accountKeys
  const found = accountKeys.some((key) => key.pubkey.equals(reference))
  if (!found) {
    throw new Error(`Reference key ${reference.toBase58()} not found in transaction accounts`)
  }
}

function verifyTokenTransfer(
  tx: ParsedTransactionWithMeta,
  expectedRecipient: PublicKey,
  expectedMint: PublicKey,
  expectedAmount: bigint,
): void {
  const preBalances = tx.meta?.preTokenBalances ?? []
  const postBalances = tx.meta?.postTokenBalances ?? []

  let recipientDelta = BigInt(0)
  const mintStr = expectedMint.toBase58()
  const recipientStr = expectedRecipient.toBase58()

  const accountKeys = tx.transaction.message.accountKeys

  for (const post of postBalances) {
    if (post.mint !== mintStr) continue

    const accountKey = accountKeys[post.accountIndex]?.pubkey?.toBase58()
    const isRecipient =
      post.owner === recipientStr || accountKey === recipientStr

    if (!isRecipient) continue

    const postAmount = BigInt(post.uiTokenAmount.amount)
    const pre = preBalances.find(
      (b) => b.accountIndex === post.accountIndex && b.mint === mintStr,
    )
    const preAmount = pre ? BigInt(pre.uiTokenAmount.amount) : BigInt(0)
    recipientDelta += postAmount - preAmount
  }

  if (recipientDelta < expectedAmount) {
    throw new Error(
      `Insufficient transfer: expected ${expectedAmount}, got ${recipientDelta}`,
    )
  }
}

// Helper to build a minimal mock ParsedTransactionWithMeta
function makeMockTx(options: {
  accountKeys: { pubkey: PublicKey; signer: boolean }[]
  preTokenBalances?: Array<{
    accountIndex: number
    mint: string
    owner: string
    uiTokenAmount: { amount: string; decimals: number; uiAmount: number }
  }>
  postTokenBalances?: Array<{
    accountIndex: number
    mint: string
    owner: string
    uiTokenAmount: { amount: string; decimals: number; uiAmount: number }
  }>
  err?: object | null
}): ParsedTransactionWithMeta {
  return {
    slot: 12345,
    transaction: {
      message: {
        accountKeys: options.accountKeys.map((k) => ({
          pubkey: k.pubkey,
          signer: k.signer,
          writable: true,
          source: 'transaction' as const,
        })),
      },
      signatures: ['fakesig123'],
    },
    meta: {
      err: options.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: options.preTokenBalances ?? [],
      postTokenBalances: options.postTokenBalances ?? [],
      innerInstructions: [],
      logMessages: [],
    },
  } as unknown as ParsedTransactionWithMeta
}

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const RECIPIENT = PublicKey.unique()
const SENDER = PublicKey.unique()
const REFERENCE = PublicKey.unique()

describe('verifyReferenceKey', () => {
  it('passes when reference key is in account keys', () => {
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: RECIPIENT, signer: false },
        { pubkey: REFERENCE, signer: false },
      ],
    })
    expect(() => verifyReferenceKey(tx, REFERENCE)).not.toThrow()
  })

  it('throws when reference key is missing', () => {
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: RECIPIENT, signer: false },
      ],
    })
    expect(() => verifyReferenceKey(tx, REFERENCE)).toThrow('not found in transaction accounts')
  })
})

describe('verifyTokenTransfer', () => {
  it('passes when transfer amount meets expected amount', () => {
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: RECIPIENT, signer: false },
      ],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT.toBase58(),
          owner: RECIPIENT.toBase58(),
          uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT.toBase58(),
          owner: RECIPIENT.toBase58(),
          uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
        },
      ],
    })

    expect(() =>
      verifyTokenTransfer(tx, RECIPIENT, USDC_MINT, 1_000_000n),
    ).not.toThrow()
  })

  it('passes when transfer exceeds expected amount', () => {
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: RECIPIENT, signer: false },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT.toBase58(),
          owner: RECIPIENT.toBase58(),
          uiTokenAmount: { amount: '2000000', decimals: 6, uiAmount: 2 },
        },
      ],
    })

    expect(() =>
      verifyTokenTransfer(tx, RECIPIENT, USDC_MINT, 1_000_000n),
    ).not.toThrow()
  })

  it('throws when transfer is insufficient', () => {
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: RECIPIENT, signer: false },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT.toBase58(),
          owner: RECIPIENT.toBase58(),
          uiTokenAmount: { amount: '500000', decimals: 6, uiAmount: 0.5 },
        },
      ],
    })

    expect(() =>
      verifyTokenTransfer(tx, RECIPIENT, USDC_MINT, 1_000_000n),
    ).toThrow('Insufficient transfer: expected 1000000, got 500000')
  })

  it('throws when no matching mint in balances', () => {
    const otherMint = PublicKey.unique()
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: RECIPIENT, signer: false },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: otherMint.toBase58(),
          owner: RECIPIENT.toBase58(),
          uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
        },
      ],
    })

    expect(() =>
      verifyTokenTransfer(tx, RECIPIENT, USDC_MINT, 1_000_000n),
    ).toThrow('Insufficient transfer')
  })

  it('throws when transfer goes to wrong recipient', () => {
    const wrongRecipient = PublicKey.unique()
    const tx = makeMockTx({
      accountKeys: [
        { pubkey: SENDER, signer: true },
        { pubkey: wrongRecipient, signer: false },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT.toBase58(),
          owner: wrongRecipient.toBase58(),
          uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
        },
      ],
    })

    expect(() =>
      verifyTokenTransfer(tx, RECIPIENT, USDC_MINT, 1_000_000n),
    ).toThrow('Insufficient transfer')
  })
})
