# Solana Payment Integration for MPP

## Overview

The `solana-mpp` package enables **SPL token payments** within the [Machine Payments Protocol](https://www.mppx.dev/) (MPP) framework. It brings Solana's high-throughput, low-cost token transfers to MPP's HTTP `402 Payment Required` standard — letting any API accept SPL tokens as payment with a few lines of code.

## Why Solana for Machine Payments?

- **Speed**: ~400ms block times with instant finality — payments settle before the HTTP request times out
- **Cost**: Transaction fees average $0.00025 — viable even for micropayments
- **Token Flexibility**: Pay with any SPL token (USDC, USDT, custom tokens) — not locked to a single currency
- **Ecosystem**: Access to Solana's deep DeFi liquidity and wallet infrastructure
- **Programmability**: On-chain verification via reference keys eliminates the need for external payment processors

## How Payment Works

```
Client                              Server
  │                                    │
  ├── GET /api/resource ──────────────►│
  │                                    │
  │◄── 402 Payment Required ──────────┤
  │    (amount, recipient ATA,         │
  │     mint, reference key)           │
  │                                    │
  │  Signs & submits SPL token         │
  │  transfer on-chain                 │
  │                                    │
  ├── GET /api/resource ──────────────►│
  │    + payment credential            │
  │    (tx signature)                  │
  │                                    │
  │    Server verifies on-chain:       │
  │    ✓ reference key in tx           │
  │    ✓ correct mint & amount         │
  │    ✓ transfer to recipient ATA     │
  │                                    │
  │◄── 200 OK + receipt ──────────────┤
  │    (resource data)                 │
  │                                    │
```

All verification happens on-chain. The server reads the transaction from Solana and confirms the token transfer — no external payment processor, no webhooks, no polling third-party APIs.

## Payment Intents

### Charge (One-Time Payment)

A single payment per request. The client pays the exact amount and gets access to the resource. Simple, stateless, and ideal for:

- Pay-per-call APIs
- One-time data access
- File downloads
- Single inference calls

### Session (Prepaid Account)

A client deposits tokens upfront and makes multiple requests against the balance. The server tracks usage and refunds unused tokens when the session closes. Ideal for:

- Metered API usage (pay per page, per query, per minute)
- Streaming data feeds
- Multi-step agent workflows
- Any use case where per-request payment overhead matters

**Session lifecycle:**
1. **Open** — Client deposits tokens, server creates session with bearer token
2. **Use** — Client sends bearer token on each request, server deducts from balance
3. **Top-up** — Client can add more tokens if balance runs low
4. **Close** — Client ends session, server refunds remaining balance on-chain

## Installation

```bash
npm install solana-mpp mppx @solana/web3.js @solana/spl-token
```

`@solana/web3.js` and `@solana/spl-token` are peer dependencies — you likely already have them if you're building on Solana.

## Quick Start

### Server: Accept Payments

```typescript
import { Mppx, Store } from 'solana-mpp/server'
import { solana } from 'solana-mpp/server'
import { Connection, PublicKey } from '@solana/web3.js'

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed')

const mppx = Mppx.create({
  methods: [
    solana.charge({
      recipient: new PublicKey('YOUR_WALLET_ADDRESS'),
      mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
      decimals: 6,
      connection,
      store: Store.memory(), // replay protection
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
})

// In your HTTP handler:
async function handler(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === '/api/data') {
    const result = await mppx.charge({
      amount: '0.01',           // 0.01 USDC per request
      description: 'API call',
    })(request)

    if (result.status === 402) return result.challenge

    return result.withReceipt(
      Response.json({ data: 'your paid content here' })
    )
  }

  return new Response('Not found', { status: 404 })
}
```

### Client: Make Payments

```typescript
import { Mppx } from 'solana-mpp/client'
import { solana } from 'solana-mpp/client'

const mppx = Mppx.create({
  methods: [
    solana.charge({
      wallet,   // any object with { publicKey, signTransaction }
    }),
  ],
})

// Payments happen automatically on 402 responses
const response = await mppx.fetch('https://api.example.com/api/data')
const data = await response.json()
```

That's it. The client automatically intercepts `402` responses, signs and submits the SPL token transfer, and retries the request with the payment proof.

## Server API

### `solana.charge(parameters)`

Creates a one-time payment method for the server.

```typescript
import { solana } from 'solana-mpp/server'

solana.charge({
  recipient: PublicKey,        // your wallet address (token recipient)
  mint: PublicKey,             // SPL token mint (e.g. USDC)
  decimals: number,            // token decimals (e.g. 6 for USDC)
  network?: SolanaNetwork,     // 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'
  connection?: Connection,     // custom RPC connection (optional)
  store?: Store.Store,         // for replay protection (recommended)
  verifyTimeout?: number,      // tx verification timeout in ms (default: 60000)
})
```

**Usage in route handler:**

```typescript
const result = await mppx.charge({
  amount: '0.50',               // 0.50 tokens
  description: 'Premium data',  // shown to client
})(request)

if (result.status === 402) return result.challenge  // payment needed
return result.withReceipt(Response.json({ ... }))   // payment verified
```

### `solana.session(parameters)`

Creates a prepaid session method for the server. Requires a `store` for session state and a `serverKeypair` for signing refund transactions.

```typescript
import { solana } from 'solana-mpp/server'

const sessionMethod = solana.session({
  recipient: PublicKey,        // your wallet address
  mint: PublicKey,             // SPL token mint
  decimals: number,            // token decimals
  serverKeypair: Keypair,      // signs refund transactions on close
  store: Store.Store,          // required — stores session state
  network?: SolanaNetwork,
  connection?: Connection,
  verifyTimeout?: number,
})
```

**Usage in route handler:**

```typescript
const result = await mppx.session({
  amount: '0.01',               // per-request cost
  depositAmount: '1.00',        // initial deposit (optional)
  unitType: 'request',          // label for metering
})(request)

if (result.status === 402) return result.challenge
return result.withReceipt(Response.json({ ... }))
```

**Extended server methods:**

```typescript
// Deduct from a session's balance programmatically
await sessionMethod.deduct(sessionId, 500_000n) // raw token units

// Wait for a client to top up their session
await sessionMethod.waitForTopUp(sessionId, 30_000) // timeout in ms
```

### Server Exports

```typescript
import { Mppx, Store, Expires } from 'solana-mpp/server'
```

- `Mppx` — Server-side MPP handler (from `mppx/server`)
- `Store` — Pluggable storage interface (`Store.memory()` for dev, bring your own for production)
- `Expires` — TTL helper for store entries

## Client API

### `solana.charge(parameters)`

Creates a one-time payment method for the client.

```typescript
import { solana } from 'solana-mpp/client'

solana.charge({
  wallet: WalletLike | (() => WalletLike | Promise<WalletLike>),
  network?: SolanaNetwork,     // default: 'mainnet-beta'
  connection?: Connection,     // custom RPC connection
})
```

### `solana.session(parameters)`

Creates a prepaid session method for the client.

```typescript
import { solana } from 'solana-mpp/client'

const sessionMethod = solana.session({
  wallet: WalletLike | (() => WalletLike | Promise<WalletLike>),
  network?: SolanaNetwork,
  connection?: Connection,
})
```

**Session lifecycle methods:**

```typescript
sessionMethod.close()              // signal close on next request
sessionMethod.topUp()              // signal top-up on next request
sessionMethod.getSession()         // { sessionId, bearer } | null
sessionMethod.setSessionId(id)     // update sessionId from receipt
sessionMethod.resetSession()       // clear session state
sessionMethod.cleanup()            // release wallet reference
```

### `WalletLike`

Any object that implements this interface works — compatible with `@solana/wallet-adapter`, Phantom, or a raw `Keypair`:

```typescript
interface WalletLike {
  publicKey: PublicKey
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}
```

**From a Keypair:**

```typescript
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'

const keypair = Keypair.generate()

const wallet: WalletLike = {
  publicKey: keypair.publicKey,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T) {
    if ('partialSign' in tx) {
      (tx as Transaction).partialSign(keypair)
    }
    return tx
  },
}
```

### Client Exports

```typescript
import { Mppx } from 'solana-mpp/client'
```

- `Mppx` — Client-side payment handler with `fetch()` that auto-handles 402 flows

## Full Examples

### Example 1: Pay-Per-Joke API (Charge)

A payment-gated joke API with a browser frontend.

**Server:**

```typescript
import { Mppx, Store } from 'solana-mpp/server'
import { solana } from 'solana-mpp/server'
import { Connection, PublicKey } from '@solana/web3.js'

const connection = new Connection('http://localhost:8899', 'confirmed')
const store = Store.memory()

const mppx = Mppx.create({
  methods: [
    solana.charge({
      recipient: new PublicKey('...'),
      mint: new PublicKey('...'),
      decimals: 6,
      network: 'localnet',
      connection,
      store,
    }),
  ],
  secretKey: 'my-secret-key',
})

// Free endpoint
if (url.pathname === '/api/health') {
  return Response.json({ status: 'ok' })
}

// Paid endpoint — 0.001 tokens per joke
if (url.pathname === '/api/joke') {
  const result = await mppx.charge({
    amount: '0.001',
    description: 'A programming joke',
  })(request)

  if (result.status === 402) return result.challenge

  const joke = jokes[Math.floor(Math.random() * jokes.length)]
  return result.withReceipt(Response.json({ joke }))
}
```

**Client:**

```typescript
import { Mppx } from 'solana-mpp/client'
import { solana } from 'solana-mpp/client'

const mppx = Mppx.create({
  methods: [
    solana.charge({
      wallet,
      network: 'localnet',
      connection,
    }),
  ],
  polyfill: false,
})

const response = await mppx.fetch('/api/joke')
const { joke } = await response.json()
console.log(joke)
```

### Example 2: Metered Data API (Session)

A session-gated API where clients deposit once and fetch multiple pages.

**Server:**

```typescript
import { Mppx, Store } from 'solana-mpp/server'
import { solana } from 'solana-mpp/server'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

const connection = new Connection('http://localhost:8899', 'confirmed')
const store = Store.memory()
const serverKeypair = Keypair.generate() // for signing refund transactions

const mppx = Mppx.create({
  methods: [
    solana.session({
      recipient: serverKeypair.publicKey,
      mint: new PublicKey('...'),
      decimals: 6,
      serverKeypair,
      network: 'localnet',
      connection,
      store,
    }),
  ],
  secretKey: 'my-secret-key',
})

// 0.01 tokens per page, 0.1 token initial deposit
if (url.pathname === '/api/data') {
  const result = await mppx.session({
    amount: '0.01',
    depositAmount: '0.1',
    unitType: 'page',
  })(request)

  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ page: 1, content: '...' }))
}
```

**Client:**

```typescript
import { Mppx } from 'solana-mpp/client'
import { solana } from 'solana-mpp/client'

const sessionMethod = solana.session({
  wallet,
  network: 'localnet',
  connection,
})

const mppx = Mppx.create({
  methods: [sessionMethod],
  polyfill: false,
})

// First request opens the session (deposits 0.1 tokens)
const res1 = await mppx.fetch('http://localhost:5173/api/data?page=1')

// Extract sessionId from the receipt header
const receipt = JSON.parse(
  Buffer.from(res1.headers.get('payment-receipt')!, 'base64').toString()
)
sessionMethod.setSessionId(receipt.reference)

// Subsequent requests use the bearer token (no new on-chain tx)
const res2 = await mppx.fetch('http://localhost:5173/api/data?page=2')
const res3 = await mppx.fetch('http://localhost:5173/api/data?page=3')

// Close the session — server refunds unused balance
sessionMethod.close()
await mppx.fetch('http://localhost:5173/api/data?page=close')
```

## Running the Examples

Both examples run against a local Solana validator.

### Prerequisites

```bash
# Install Solana CLI tools
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Start a local validator
solana-test-validator
```

### Charge Example

```bash
cd examples/charge
npm install
npm run dev
# Opens http://localhost:5173
```

Click "Get a Joke" — the browser wallet pays 0.001 tokens per joke, with the balance updating after each request.

### Session Example

```bash
cd examples/session
npm install
npm run dev          # Start server (terminal 1)
npm run client       # Run CLI client (terminal 2)
```

The client deposits 0.1 tokens, fetches 5 pages at 0.01 tokens each, closes the session, and prints a summary showing the refunded balance.

## Networks

| Network        | RPC Endpoint                          | Use Case         |
|----------------|---------------------------------------|------------------|
| `mainnet-beta` | `https://api.mainnet-beta.solana.com` | Production       |
| `devnet`       | `https://api.devnet.solana.com`       | Testing          |
| `testnet`      | `https://api.testnet.solana.com`      | Testing          |
| `localnet`     | `http://localhost:8899`               | Local development|

Pass a custom `Connection` for private RPC endpoints:

```typescript
import { Connection } from '@solana/web3.js'

const connection = new Connection('https://your-rpc.example.com', 'confirmed')

solana.charge({
  // ...
  connection,
})
```

## Architecture

```
solana-mpp
├── src/
│   ├── index.ts              # Root exports
│   ├── Methods.ts            # Zod schemas for charge & session protocols
│   ├── types.ts              # WalletLike interface, SolanaNetwork type
│   ├── constants.ts          # RPC endpoint URLs
│   ├── client/
│   │   ├── Charge.ts         # Signs & submits token transfers
│   │   ├── Session.ts        # Manages session lifecycle (open/bearer/topUp/close)
│   │   └── Methods.ts        # Client-side solana namespace
│   └── server/
│       ├── Charge.ts         # Verifies one-time payments on-chain
│       ├── Session.ts        # Manages session state, balance tracking, refunds
│       ├── verify.ts         # Core on-chain transaction verification
│       └── Methods.ts        # Server-side solana namespace
└── examples/
    ├── charge/               # Browser-based pay-per-joke demo
    └── session/              # CLI-based session lifecycle demo
```

## How Verification Works

Payment verification is fully on-chain with no external dependencies:

1. **Reference Key** — Each payment challenge includes a unique reference public key. The client appends this key as a non-signer account in the SPL transfer transaction (following the [Solana Pay](https://docs.solanapay.com/) pattern).

2. **Transaction Discovery** — The server finds the payment transaction by calling `getSignaturesForAddress` on the reference key, or uses the client-provided signature directly.

3. **Transfer Validation** — The server parses the transaction and verifies:
   - The reference key is present in the transaction's account list
   - An SPL token transfer occurred to the recipient's Associated Token Account
   - The transferred amount matches or exceeds the requested amount
   - The correct token mint was used
   - The transaction succeeded (no errors)

4. **Replay Protection** — Transaction signatures are stored and checked to prevent double-spending the same payment.

## Standards

This implementation follows the [MPP specification](https://www.mppx.dev/) for HTTP `402 Payment Required` payment flows, extending it with Solana SPL token transfers as the payment rail. It is compatible with any server framework that uses Web-standard `Request`/`Response` objects (Node.js, Bun, Deno, Cloudflare Workers, Next.js, etc).

## License

ISC
