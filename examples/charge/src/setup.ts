// Buffer must be available globally BEFORE @solana/web3.js is imported.
// ES module imports are hoisted, so we can't polyfill inline in client.ts.
// This file sets up Buffer first, then dynamically imports the client.
import { Buffer } from 'buffer'
globalThis.Buffer = Buffer

await import('./client.js')
