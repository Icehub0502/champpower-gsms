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

  it('blocks 0993333333 by shape — the regression this rule exists for', () => {
    // This test used to assert FALSE, on the theory that the per-shop table
    // would carry this value. It could not: 0015's seed reached only shops that
    // existed when it ran, and production creates its shops afterwards, so the
    // real shop's table is empty. With the floor silent, the first person keyed
    // as 0993333333 became a customer and every later stranger was matched to
    // them — never a second customer, so the auto-block threshold never fired.
    expect(isPlaceholderKey('phone', '0993333333')).toBe(true)
  })

  it('blocks the variants another shop\'s staff will invent', () => {
    expect(isPlaceholderKey('phone', '0995555555')).toBe(true)
    expect(isPlaceholderKey('phone', '0811111111')).toBe(true)
    expect(isPlaceholderKey('phone', '021111111')).toBe(true)
  })

  it('accepts the cost: a genuine vanity number is not used as a key', () => {
    // Deliberate. A duplicate record a person can merge beats a fusion nobody
    // can unpick. The number is still stored; it just never FINDS a customer.
    expect(isPlaceholderKey('phone', '0812222222')).toBe(true)
  })

  it('leaves a real number with a short repeated tail alone', () => {
    expect(isPlaceholderKey('phone', '0812345666')).toBe(false)
    expect(isPlaceholderKey('phone', '0812340000')).toBe(false)
    // Six identical digits is one short of the threshold.
    expect(isPlaceholderKey('phone', '0891222222')).toBe(false)
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

describe('the floor covers everything the 0015 seed covers', () => {
  // The guard against this defect coming back. Migration 0015 seeds these
  // five values into match_blocklist, but only for shops that existed when it
  // ran — production's shops are created later and have NONE of these rows.
  // Every value the seed knows about must therefore be caught by the pure
  // floor on its own. If someone adds a value to a future seed, add it here;
  // if this test then fails, the floor has to grow, not the seed.
  const SEEDED_BY_0015 = [
    ['phone', '0999999999'],
    ['phone', '0993333333'],
    ['phone', '0000000000'],
    ['plate', '1กอ2222'],
    ['plate', '1กก1111'],
  ] as const

  for (const [kind, key] of SEEDED_BY_0015) {
    it(`${kind} ${key} is blocked with an empty table`, () => {
      expect(isPlaceholderKey(kind, key)).toBe(true)
    })
  }
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
