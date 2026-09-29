/**
 * zod's per-field failures, as the `fields` map of an `invalid_request` body —
 * WITHOUT echoing anything the caller sent.
 *
 * A refusal never repeats the submitted input back (code review, 29 Sep 2026).
 * zod's DEFAULT messages do: an enum failure reads "Invalid enum value. Expected
 * 'page' | 'line' | …, received 'whatever-you-typed'", so building `fields` from
 * `issue.message` put the caller's own value into the response. That is a
 * reflection channel — whatever lands in a customer field (a phone number, a
 * name, a script) comes straight back — and it is the wrong thing for the
 * screen anyway, which needs a fixed code it can map to its own Thai text.
 *
 * So each entry is built from `issue.code`, a fixed, value-free string per kind
 * of failure. The one exception is a message WE wrote on the schema
 * (packages/contracts: 'invalid_phone', 'invalid_date', …). Those are always
 * snake_case tokens, and a snake_case token is used as-is; zod's own defaults
 * are English sentences, never match, and are never forwarded. Anyone adding a
 * custom message must keep it a value-free token for exactly this reason.
 */
import type { ZodError, ZodIssue } from 'zod'

/** A message we wrote on a schema: a snake_case token, which cannot carry input. */
const OWN_TOKEN = /^[a-z][a-z0-9_]*$/

function codeOf(issue: ZodIssue): string {
  if (OWN_TOKEN.test(issue.message)) return issue.message
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' ? 'required' : 'invalid_type'
    case 'invalid_enum_value':
    case 'invalid_literal':
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return 'invalid_value'
    case 'invalid_string':
      return 'invalid_format'
    case 'too_small':
      return 'too_small'
    case 'too_big':
      return 'too_big'
    case 'unrecognized_keys':
      return 'unrecognized_keys'
    default:
      return 'invalid'
  }
}

export function fieldErrorsOf(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of error.issues) {
    // The top-level field name. A path is made of schema keys and array
    // indexes — never of submitted values — so naming it echoes nothing.
    const field = issue.path.length > 0 ? String(issue.path[0]) : '_'
    const code = codeOf(issue)
    const list = out[field] ?? (out[field] = [])
    if (!list.includes(code)) list.push(code)
  }
  return out
}
