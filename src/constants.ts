export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'

export const clusterUrls: Record<SolanaNetwork, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://localhost:8899',
}
