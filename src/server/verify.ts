import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js'

export interface VerifyTransferParams {
  reference: PublicKey
  expectedRecipient: PublicKey
  expectedMint: PublicKey
  expectedAmount: bigint
  clientSignature?: string
}

export interface VerifyTransferResult {
  signature: string
  slot: number
}

const POLL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_RPC_RETRIES = 3
const RPC_RETRY_DELAY_MS = 1_000

function isTransientError(error: Error): boolean {
  return (
    error.message.includes('503') ||
    error.message.includes('429') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ECONNRESET') ||
    error.message.includes('fetch failed')
  )
}

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RPC_RETRIES): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const isLastAttempt = attempt === retries
      if (isLastAttempt || !(error instanceof Error) || !isTransientError(error)) throw error
      await sleep(RPC_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw new Error('Unreachable')
}

export async function findAndVerifyTransfer(
  connection: Connection,
  params: VerifyTransferParams,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VerifyTransferResult> {
  const { reference, expectedRecipient, expectedMint, expectedAmount, clientSignature } = params

  const signature = clientSignature ?? await pollForSignature(connection, reference, timeoutMs)

  const tx = await withRetry(() =>
    connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
  )

  if (!tx) {
    throw new Error(`Transaction not found: ${signature}`)
  }

  if (tx.meta?.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(tx.meta.err)}`)
  }

  verifyReferenceKey(tx, reference)
  verifyTokenTransfer(tx, expectedRecipient, expectedMint, expectedAmount)

  return { signature, slot: tx.slot }
}

async function pollForSignature(
  connection: Connection,
  reference: PublicKey,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs

  let lastError: Error | undefined
  while (Date.now() < deadline) {
    try {
      const signatures = await connection.getSignaturesForAddress(reference, { limit: 1 }, 'confirmed')
      if (signatures.length > 0) {
        return signatures[0].signature
      }
      lastError = undefined
    } catch (error) {
      if (error instanceof Error && isTransientError(error)) {
        lastError = error
      } else {
        throw error
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (lastError) {
    throw new Error(`Timed out polling for transaction (last error: ${lastError.message})`)
  }

  throw new Error(`Timed out waiting for transaction referencing ${reference.toBase58()}`)
}

function verifyReferenceKey(
  tx: ParsedTransactionWithMeta,
  reference: PublicKey,
): void {
  const accountKeys = tx.transaction.message.accountKeys
  const found = accountKeys.some(
    (key) => key.pubkey.equals(reference),
  )
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
