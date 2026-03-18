import { Method, Receipt, Store } from 'mppx'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js'
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as Methods from '../Methods.js'
import { clusterUrls, type SolanaNetwork } from '../constants.js'
import { parseAmount } from '../utils.js'
import { findAndVerifyTransfer } from './verify.js'

interface SessionState {
  sessionId: string
  bearerHash: string
  depositAmount: bigint
  spent: bigint
  refundAddress: string
  mint: string
  decimals: number
  status: 'active' | 'closed'
}

export namespace session {
  export interface Parameters {
    recipient: PublicKey
    mint: PublicKey
    decimals: number
    serverKeypair: Keypair
    network?: SolanaNetwork
    connection?: Connection
    store: Store.Store
    verifyTimeout?: number
  }
}

export function session(parameters: session.Parameters) {
  const {
    recipient,
    mint,
    decimals,
    serverKeypair,
    network = 'mainnet-beta',
    store,
    verifyTimeout,
  } = parameters

  const connection =
    parameters.connection ?? new Connection(clusterUrls[network], 'confirmed')

  const method = Method.toServer(Methods.session, {
    defaults: {
      currency: mint.toBase58(),
      depositAmount: '0',
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
      const recipientAta = await getAssociatedTokenAddress(mint, recipient)

      return {
        ...request,
        methodDetails: {
          recipient: recipientAta.toBase58(),
          mint: mint.toBase58(),
          decimals,
          reference: referenceKeypair.publicKey.toBase58(),
          network,
        },
      }
    },

    async verify({ credential }) {
      const { payload } = credential
      const { methodDetails } = credential.challenge.request

      switch (payload.action) {
        case 'open':
          return handleOpen(payload, methodDetails, credential.challenge.request)
        case 'bearer':
          return handleBearer(payload, credential.challenge.request)
        case 'topUp':
          return handleTopUp(payload, methodDetails)
        case 'close':
          return handleClose(payload)
        default:
          throw new Error(`Unknown session action: ${(payload as { action: string }).action}`)
      }
    },

    async respond({ credential, receipt }) {
      const { payload } = credential

      if (payload.action === 'topUp' || payload.action === 'close') {
        return new Response(JSON.stringify(receipt), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return undefined
    },
  })

  async function handleOpen(
    payload: { depositSignature: string; refundAddress: string },
    methodDetails: { recipient: string; mint: string; decimals: number; reference: string },
    request: { amount: string; depositAmount?: string },
  ): Promise<ReturnType<typeof Receipt.from>> {
    const { depositSignature, refundAddress } = payload

    const reference = new PublicKey(methodDetails.reference)
    const expectedRecipient = new PublicKey(methodDetails.recipient)
    const expectedMint = new PublicKey(methodDetails.mint)

    const depositAmountStr = request.depositAmount ?? request.amount
    const expectedAmount = parseAmount(depositAmountStr, methodDetails.decimals)

    await findAndVerifyTransfer(
      connection,
      {
        reference,
        expectedRecipient,
        expectedMint,
        expectedAmount,
        clientSignature: depositSignature,
      },
      verifyTimeout,
    )

    const bearerHash = bytesToHex(sha256(new TextEncoder().encode(depositSignature)))
    const sessionId = crypto.randomUUID()

    // Deduct the first request's cost from the deposit
    const chargeAmount = parseAmount(request.amount, methodDetails.decimals)

    const state: SessionState = {
      sessionId,
      bearerHash,
      depositAmount: expectedAmount,
      spent: chargeAmount,
      refundAddress,
      mint: methodDetails.mint,
      decimals: methodDetails.decimals,
      status: 'active',
    }

    await store.put(`solana-session:${sessionId}`, serializeState(state))

    return Receipt.from({
      method: 'solana',
      reference: sessionId,
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function handleBearer(
    payload: { sessionId: string; bearer: string },
    request: { amount: string; methodDetails: { decimals: number } },
  ): Promise<ReturnType<typeof Receipt.from>> {
    const state = await loadSession(payload.sessionId)
    verifyBearer(state, payload.bearer)

    const chargeAmount = parseAmount(request.amount, request.methodDetails.decimals)
    const remaining = state.depositAmount - state.spent
    if (chargeAmount > remaining) {
      throw new Error(`Insufficient session balance: ${remaining} < ${chargeAmount}`)
    }
    state.spent += chargeAmount
    await store.put(`solana-session:${state.sessionId}`, serializeState(state))

    return Receipt.from({
      method: 'solana',
      reference: state.sessionId,
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function handleTopUp(
    payload: { sessionId: string; topUpSignature: string },
    methodDetails: { recipient: string; mint: string; decimals: number; reference: string },
  ): Promise<ReturnType<typeof Receipt.from>> {
    const state = await loadSession(payload.sessionId)

    const reference = new PublicKey(methodDetails.reference)
    const expectedRecipient = new PublicKey(methodDetails.recipient)
    const expectedMint = new PublicKey(methodDetails.mint)

    const tx = await connection.getParsedTransaction(payload.topUpSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (!tx) throw new Error('Top-up transaction not found')

    const topUpAmount = computeTransferDelta(tx, expectedRecipient.toBase58(), expectedMint.toBase58())

    state.depositAmount += topUpAmount
    await store.put(`solana-session:${state.sessionId}`, serializeState(state))

    return Receipt.from({
      method: 'solana',
      reference: state.sessionId,
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function handleClose(
    payload: { sessionId: string; bearer: string },
  ): Promise<ReturnType<typeof Receipt.from>> {
    const state = await loadSession(payload.sessionId)
    verifyBearer(state, payload.bearer)

    const refundAmount = state.depositAmount - state.spent
    if (refundAmount > BigInt(0)) {
      await sendRefund(state, refundAmount)
    }

    state.status = 'closed'
    await store.put(`solana-session:${state.sessionId}`, serializeState(state))

    return Receipt.from({
      method: 'solana',
      reference: state.sessionId,
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function loadSession(sessionId: string): Promise<SessionState> {
    const raw = await store.get<ReturnType<typeof serializeState>>(`solana-session:${sessionId}`)
    if (!raw) throw new Error(`Session not found: ${sessionId}`)
    return deserializeState(raw)
  }

  function verifyBearer(state: SessionState, bearer: string): void {
    if (state.status !== 'active') {
      throw new Error(`Session ${state.sessionId} is ${state.status}`)
    }
    const hash = bytesToHex(sha256(new TextEncoder().encode(bearer)))
    if (hash !== state.bearerHash) {
      throw new Error('Invalid bearer')
    }
  }

  async function sendRefund(state: SessionState, refundAmount: bigint): Promise<void> {
    const refundMint = new PublicKey(state.mint)
    const serverAta = await getAssociatedTokenAddress(refundMint, serverKeypair.publicKey)
    const refundAta = await getAssociatedTokenAddress(refundMint, new PublicKey(state.refundAddress))

    const tx = new Transaction().add(
      createTransferCheckedInstruction(
        serverAta,
        refundMint,
        refundAta,
        serverKeypair.publicKey,
        refundAmount,
        state.decimals,
      ),
    )

    const latestBlockhash = await connection.getLatestBlockhash('confirmed')
    tx.recentBlockhash = latestBlockhash.blockhash
    tx.feePayer = serverKeypair.publicKey
    tx.sign(serverKeypair)

    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
  }

  async function deduct(sessionId: string, amount: bigint): Promise<void> {
    const state = await loadSession(sessionId)
    if (state.status !== 'active') {
      throw new Error(`Session ${sessionId} is ${state.status}`)
    }
    const remaining = state.depositAmount - state.spent
    if (amount > remaining) {
      throw new Error(`Insufficient balance: ${remaining} < ${amount}`)
    }
    state.spent += amount
    await store.put(`solana-session:${sessionId}`, serializeState(state))
  }

  async function waitForTopUp(
    sessionId: string,
    timeoutMs: number = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const initial = await loadSession(sessionId)
    const initialDeposit = initial.depositAmount

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000))
      const current = await loadSession(sessionId)
      if (current.depositAmount > initialDeposit) return
    }

    throw new Error(`Timed out waiting for top-up on session ${sessionId}`)
  }

  return Object.assign(method, { deduct, waitForTopUp })
}

function computeTransferDelta(
  tx: ParsedTransactionWithMeta,
  recipientStr: string,
  mintStr: string,
): bigint {
  const pre = tx.meta?.preTokenBalances ?? []
  const post = tx.meta?.postTokenBalances ?? []
  const accountKeys = tx.transaction.message.accountKeys
  let delta = BigInt(0)

  for (const p of post) {
    if (p.mint !== mintStr) continue

    const accountKey = accountKeys[p.accountIndex]?.pubkey?.toBase58()
    const isRecipient =
      p.owner === recipientStr || accountKey === recipientStr

    if (!isRecipient) continue

    const postAmt = BigInt(p.uiTokenAmount.amount)
    const preEntry = pre.find(
      (b) => b.accountIndex === p.accountIndex && b.mint === mintStr,
    )
    const preAmt = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : BigInt(0)
    delta += postAmt - preAmt
  }

  return delta
}

interface SerializedSessionState {
  sessionId: string
  bearerHash: string
  depositAmount: string
  spent: string
  refundAddress: string
  mint: string
  decimals: number
  status: 'active' | 'closed'
}

function serializeState(state: SessionState): SerializedSessionState {
  return {
    ...state,
    depositAmount: state.depositAmount.toString(),
    spent: state.spent.toString(),
  }
}

function deserializeState(raw: SerializedSessionState): SessionState {
  return {
    ...raw,
    depositAmount: BigInt(raw.depositAmount),
    spent: BigInt(raw.spent),
  }
}
