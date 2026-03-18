import { describe, it, expect } from 'vitest'

// parseAmount is duplicated across files; test the logic directly
function parseAmount(amount: string, decimals: number): bigint {
  const parts = amount.split('.')
  const whole = parts[0] ?? '0'
  let frac = parts[1] ?? ''
  frac = frac.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(whole + frac)
}

// Fixed version that rejects excess precision
function parseAmountStrict(amount: string, decimals: number): bigint {
  const parts = amount.split('.')
  if (parts.length > 2) throw new Error(`Invalid amount format: "${amount}"`)
  const whole = parts[0] ?? '0'
  const frac = parts[1] ?? ''
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${amount}" has ${frac.length} fractional digits, but token only supports ${decimals} decimals`,
    )
  }
  return BigInt(whole + frac.padEnd(decimals, '0'))
}

describe('parseAmount (original — demonstrates truncation bug)', () => {
  it('parses whole numbers', () => {
    expect(parseAmount('100', 6)).toBe(100_000_000n)
  })

  it('parses decimal amounts', () => {
    expect(parseAmount('1.5', 6)).toBe(1_500_000n)
  })

  it('parses small amounts', () => {
    expect(parseAmount('0.001', 6)).toBe(1_000n)
  })

  it('parses exact decimals', () => {
    expect(parseAmount('0.000001', 6)).toBe(1n)
  })

  it('BUG: silently truncates excess precision to zero', () => {
    // This is the bug — "0.0000009" should either be rejected or at least
    // not silently become 0
    expect(parseAmount('0.0000009', 6)).toBe(0n)
  })

  it('BUG: truncates excess precision on non-zero amounts', () => {
    // "1.1234567" with 6 decimals truncates to "1.123456" = 1123456
    expect(parseAmount('1.1234567', 6)).toBe(1_123_456n)
  })
})

describe('parseAmountStrict (fixed — rejects excess precision)', () => {
  it('parses whole numbers', () => {
    expect(parseAmountStrict('100', 6)).toBe(100_000_000n)
  })

  it('parses decimal amounts', () => {
    expect(parseAmountStrict('1.5', 6)).toBe(1_500_000n)
  })

  it('parses small amounts', () => {
    expect(parseAmountStrict('0.001', 6)).toBe(1_000n)
  })

  it('parses exact decimals', () => {
    expect(parseAmountStrict('0.000001', 6)).toBe(1n)
  })

  it('parses zero', () => {
    expect(parseAmountStrict('0', 6)).toBe(0n)
    expect(parseAmountStrict('0.0', 6)).toBe(0n)
  })

  it('rejects excess precision', () => {
    expect(() => parseAmountStrict('0.0000009', 6)).toThrow(
      'has 7 fractional digits, but token only supports 6 decimals',
    )
  })

  it('rejects excess precision on non-zero amounts', () => {
    expect(() => parseAmountStrict('1.1234567', 6)).toThrow(
      'has 7 fractional digits, but token only supports 6 decimals',
    )
  })

  it('rejects invalid format with multiple dots', () => {
    expect(() => parseAmountStrict('1.2.3', 6)).toThrow('Invalid amount format')
  })

  it('handles 0 decimals', () => {
    expect(parseAmountStrict('100', 0)).toBe(100n)
    expect(() => parseAmountStrict('100.1', 0)).toThrow(
      'has 1 fractional digits, but token only supports 0 decimals',
    )
  })

  it('handles 9 decimals (SOL)', () => {
    expect(parseAmountStrict('1.5', 9)).toBe(1_500_000_000n)
    expect(parseAmountStrict('0.000000001', 9)).toBe(1n)
  })
})
