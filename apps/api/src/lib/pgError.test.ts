import { describe, expect, it } from 'vitest'
import { DocumentFrozenError, DocumentLineFrozenError } from '@gsms/contracts/index.js'
import { mapPgError } from './pgError.js'

// Tier 1: GS002 (migration 0022) is mapped on err.code, with err.table choosing
// the body. The message text is deliberately unrelated, to prove it is not read.
describe('mapPgError GS002', () => {
  it('document_lines -> 409 document_line_frozen', () => {
    const m = mapPgError({ code: 'GS002', table: 'document_lines', message: 'unrelated words' })
    expect(m?.status).toBe(409)
    expect(DocumentLineFrozenError.parse(m?.body).error).toBe('document_line_frozen')
  })
  it('documents -> 409 document_frozen', () => {
    const m = mapPgError({ code: 'GS002', table: 'documents', message: 'closed to further change' })
    expect(m?.status).toBe(409)
    expect(DocumentFrozenError.parse(m?.body).error).toBe('document_frozen')
  })
  it('does not match on the message when the code differs', () => {
    expect(mapPgError({ code: 'P0001', table: 'documents', message: 'GS002 cannot be modified' })).toBeNull()
  })
})
