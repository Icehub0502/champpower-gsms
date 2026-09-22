import { describe, expect, it } from 'vitest'
import { isPlaceholderKey } from './matchKeys.js'

describe('isPlaceholderKey — phones', () => {
  // The values that actually appear in the production dump
  // (docs/WORK-ORDERS/IMPORT-FINDINGS.md §4). 0999999999 is shared by eight
  // unrelated customers; these are the cases that matter.
  it('blocks a zero followed by one repeated digit', () => {
    expect(isPlaceholderKey('phone', '0999999999')).toBe(true)
    expect(isPlaceholderKey('phone', '0888888888')).toBe(true)
    expect(isPlaceholderKey('phone', '0111111111')).toBe(true)
  })

  it('blocks a number that is one digit repeated', () => {
    expect(isPlaceholderKey('phone', '0000000000')).toBe(true)
    expect(isPlaceholderKey('phone', '9999999999')).toBe(true)
  })

  it('leaves real numbers alone', () => {
    expect(isPlaceholderKey('phone', '0812345678')).toBe(false)
    expect(isPlaceholderKey('phone', '0865551234')).toBe(false)
    expect(isPlaceholderKey('phone', '021234567')).toBe(false)
    // Repetition inside a real number is not a pattern.
    expect(isPlaceholderKey('phone', '0899999123')).toBe(false)
  })

  it('does not classify 0993333333, which is why the table exists', () => {
    // A placeholder by convention at this shop, not by shape: zero, then two
    // nines, then sevens threes. No pattern can know it — match_blocklist
    // carries it per shop, on top of this floor.
    expect(isPlaceholderKey('phone', '0993333333')).toBe(false)
  })

  it('expects an already-normalised key and does not guess', () => {
    // Separators mean the caller forgot to normalise. Returning false is the
    // honest answer; the fix is at the call site, not a second normaliser
    // here that would drift from customersRepo.normalisePhone.
    expect(isPlaceholderKey('phone', '099-999-9999')).toBe(false)
  })

  it('ignores anything too short to judge', () => {
    expect(isPlaceholderKey('phone', '')).toBe(false)
    expect(isPlaceholderKey('phone', '000')).toBe(false)
  })
})

describe('isPlaceholderKey — plates', () => {
  it('blocks the test plates from the dump', () => {
    expect(isPlaceholderKey('plate', '1กก1111')).toBe(true)
    // The leading 1 is why the rule reads the TRAILING run rather than every
    // digit in the string: "all digits identical" would miss this one.
    expect(isPlaceholderKey('plate', '1กอ2222')).toBe(true)
  })

  it('blocks a repeated run with no leading digit', () => {
    expect(isPlaceholderKey('plate', 'กก1111')).toBe(true)
    expect(isPlaceholderKey('plate', 'ขข999')).toBe(true)
  })

  it('leaves real plates alone', () => {
    expect(isPlaceholderKey('plate', 'กก1234')).toBe(false)
    expect(isPlaceholderKey('plate', 'กท1325')).toBe(false)
    expect(isPlaceholderKey('plate', '2ฒษ4181')).toBe(false)
    expect(isPlaceholderKey('plate', 'งง9876')).toBe(false)
  })

  it('does not block a two-digit repeat, which is common and real', () => {
    expect(isPlaceholderKey('plate', 'กก11')).toBe(false)
    expect(isPlaceholderKey('plate', '1กก22')).toBe(false)
  })

  it('ignores a plate with no trailing digits', () => {
    expect(isPlaceholderKey('plate', 'กกกก')).toBe(false)
    expect(isPlaceholderKey('plate', '')).toBe(false)
  })
})
