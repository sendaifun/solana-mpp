/**
 * Parse a human-readable decimal amount string into raw token units (bigint).
 * Throws if the amount has more fractional digits than the token's decimals,
 * preventing silent truncation that could misprice payments.
 */
export function parseAmount(amount: string, decimals: number): bigint {
  const parts = amount.split('.')
  if (parts.length > 2) {
    throw new Error(`Invalid amount format: "${amount}"`)
  }
  const whole = parts[0] ?? '0'
  const frac = parts[1] ?? ''

  if (frac.length > decimals) {
    throw new Error(
      `Amount "${amount}" has ${frac.length} fractional digits, but token only supports ${decimals} decimals`,
    )
  }

  const paddedFrac = frac.padEnd(decimals, '0')
  return BigInt(whole + paddedFrac)
}
