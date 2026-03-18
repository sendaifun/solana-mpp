# solana-mpp Examples

Standalone, runnable examples demonstrating the Solana MPP HTTP 402 payment flow.

## Prerequisites

1. Install [Solana CLI tools](https://docs.solanalabs.com/cli/install)
2. Start a local validator:

```bash
solana-test-validator
```

## Examples

| Example | Description |
|---------|-------------|
| [charge](./charge/) | Payment-gated joke API with browser frontend |
| [session](./session/) | Prepaid session with multi-fetch CLI client |

## Running

```bash
cd examples/charge   # or examples/session
npm install
npm run dev
```

The charge example opens a browser UI at `http://localhost:5173`.
The session example starts the Vite server, then run `npm run client` in a separate terminal.
