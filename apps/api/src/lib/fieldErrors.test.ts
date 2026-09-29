/**
 * fieldErrorsOf never echoes a submitted value (code review, 29 Sep 2026).
 *
 * TIER 1 — no database. The reviewer proved that zod's default enum message
 * quoted the received value, so a caller's input came back in
 * invalid_request.fields. These tests feed deliberately recognisable junk into
 * the real contract schemas and assert that none of it appears in the result.
 */
import { describe, expect, it } from 'vitest'
import { ArriveInput, CheckInInput } from '@gsms/contracts/index.js'
import { fieldErrorsOf } from './fieldErrors.js'

const required = { plate: 'บบ 1234', customerName: 'ชื่อ', brand: 'Toyota', model: 'Vios' }

function fieldsFor(schema: typeof CheckInInput | typeof ArriveInput, input: unknown) {
  const r = schema.safeParse(input)
  expect(r.success, 'expected the input to fail validation').toBe(false)
  if (r.success) throw new Error('unreachable')
  return fieldErrorsOf(r.error)
}

describe('fieldErrorsOf', () => {
  it('a bad enum value is not echoed back', () => {
    const junk = 'tiktok-ECHO-CANARY-1'
    const fields = fieldsFor(CheckInInput, { ...required, leadSource: junk })
    expect(JSON.stringify(fields)).not.toContain(junk)
    expect(fields.leadSource).toEqual(['invalid_value'])
  })

  it('a bad phone is not echoed back — only our own token', () => {
    const junk = '12ab-ECHO-CANARY-2'
    const fields = fieldsFor(CheckInInput, { ...required, customerPhone: junk })
    expect(JSON.stringify(fields)).not.toContain(junk)
    expect(fields.customerPhone).toEqual(['invalid_phone'])
  })

  it('a missing required field says "required"', () => {
    const fields = fieldsFor(CheckInInput, { plate: 'บบ 1234', customerName: 'ชื่อ' })
    expect(fields.brand).toEqual(['required'])
    expect(fields.model).toEqual(['required'])
  })

  it('a wrong type is named without the value', () => {
    const fields = fieldsFor(ArriveInput, { mileageInKm: 'ECHO-CANARY-3' })
    expect(JSON.stringify(fields)).not.toContain('ECHO-CANARY-3')
    expect(fields.mileageInKm).toEqual(['invalid_type'])
  })

  it('never forwards a zod default sentence, only fixed codes', () => {
    const fields = fieldsFor(CheckInInput, {
      ...required, leadSource: 'x', customerPhone: 'y', jobDate: 'z', bayId: 'not-a-uuid',
    })
    for (const codes of Object.values(fields)) {
      for (const c of codes) expect(c, `"${c}" is not a value-free code`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
