/**
 * A deliberately tiny reader for mysqldump output (WO-004).
 *
 * It extracts ONLY the tables it is asked for: the line scanner discards every
 * other line without parsing it. Within a wanted table, cells outside the
 * caller's `keepColumns` are advanced over by a scanner that builds no string
 * and keeps no value, so (for example) a customer-linked table can be asked for
 * two columns and nothing else is ever decoded. It understands exactly what
 * mysqldump emits -- `CREATE TABLE` column lists and single-line
 * `INSERT INTO ... VALUES (...),(...);` -- and refuses anything else.
 *
 * Error messages carry the table, tuple number, column index and offset only.
 * They never echo source text: a parse error must not be able to put a
 * customer's data into a log.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'

/** One decoded cell. Numbers stay as their source text; NULL is null. */
export type Cell = string | null
export type DumpRow = Record<string, Cell>

// MySQL string escapes. \% and \_ are the odd ones: MySQL keeps the backslash
// (they exist for LIKE patterns). Any other unknown escape drops the backslash
// and keeps the character.
const ESCAPES: Record<string, string> = {
  '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a',
  "'": "'", '"': '"', '\\': '\\', '%': '\\%', _: '\\_',
}

export interface TupleOptions {
  /** Column indexes to decode; others are skipped without being decoded. Default: all. */
  keep?: ReadonlySet<number>
  /** Expected cells per tuple; a mismatch throws. */
  columns?: number
  /** Table name for error messages. */
  label?: string
}

/**
 * Parse the part of an INSERT statement after `VALUES` into tuples of cells.
 * With `keep`, each tuple holds only the kept cells, in column order.
 * Throws on anything malformed: a half-parsed catalog is worse than none.
 */
export function parseValuesTuples(text: string, opts: TupleOptions = {}): Cell[][] {
  const rows: Cell[][] = []
  const { keep, columns, label = 'dump' } = opts
  let i = 0
  let tuple = 0
  let col = 0
  const n = text.length
  const fail = (msg: string): never => {
    throw new Error(`${label}: parse error in tuple ${tuple}, column ${col}, offset ${i}: ${msg}`)
  }
  const isWs = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t'
  const skipWs = () => { while (i < n && isWs(text[i])) i++ }

  skipWs()
  while (i < n) {
    if (text[i] === ';') break
    tuple++
    col = 0
    if (text[i] !== '(') fail('expected "("')
    i++
    const row: Cell[] = []
    for (;;) {
      skipWs()
      const wanted = !keep || keep.has(col)
      if (text[i] === "'") {
        i++
        let out = ''
        for (;;) {
          if (i >= n) fail('unterminated string')
          const c = text[i]!
          if (c === '\\') {
            const e = text[i + 1]
            if (e === undefined) fail('dangling backslash')
            if (wanted) out += ESCAPES[e!] ?? e
            i += 2
          } else if (c === "'") {
            if (text[i + 1] === "'") { if (wanted) out += "'"; i += 2 } else { i++; break }
          } else { if (wanted) out += c; i++ }
        }
        if (wanted) row.push(out)
      } else {
        let j = i
        while (j < n && text[j] !== ',' && text[j] !== ')') j++
        if (wanted) {
          const raw = text.slice(i, j).trim()
          if (raw === '') fail('empty value')
          if (raw === 'NULL') row.push(null)
          else if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) row.push(raw)
          else fail('unsupported literal')
        } else if (j === i) fail('empty value')
        i = j
      }
      col++
      skipWs()
      if (text[i] === ',') { i++; continue }
      if (text[i] === ')') { i++; break }
      fail('expected "," or ")"')
    }
    if (columns !== undefined && col !== columns) fail(`tuple has ${col} cells, expected ${columns}`)
    rows.push(row)
    skipWs()
    if (text[i] === ',') { i++; skipWs() }
  }
  return rows
}

/** Column names, in order, from a `CREATE TABLE` block's body lines. */
export function parseCreateColumns(createLines: string[]): string[] {
  const cols: string[] = []
  for (const line of createLines) {
    const m = /^\s*`([^`]+)`\s/.exec(line)
    if (m) cols.push(m[1]!)
  }
  return cols
}

/**
 * Scan a dump (as lines) and return the rows of the wanted tables only.
 * Every table asked for must have exactly one CREATE TABLE and at least one
 * INSERT line, or this throws -- a silently empty table would read as "nothing
 * to import" instead of "wrong file".
 */
export async function extractTables(
  lines: AsyncIterable<string> | Iterable<string>,
  wanted: readonly string[],
  /** Per table, the only columns kept. Other cells are skipped, never decoded. */
  keepColumns: Readonly<Record<string, readonly string[]>> = {},
): Promise<Record<string, DumpRow[]>> {
  const want = new Set(wanted)
  const columns = new Map<string, string[]>()
  const result: Record<string, DumpRow[]> = Object.fromEntries(wanted.map((t) => [t, []]))
  const seenInsert = new Set<string>()
  let inCreate: string | null = null
  let createBuf: string[] = []

  for await (const line of lines) {
    if (inCreate) {
      if (line.startsWith(')')) {
        columns.set(inCreate, parseCreateColumns(createBuf))
        inCreate = null
        createBuf = []
      } else createBuf.push(line)
      continue
    }
    // Cheap prefix tests first: every line of an unwanted table is dropped
    // here without any further work.
    if (line.startsWith('CREATE TABLE `')) {
      const name = /^CREATE TABLE `([^`]+)`/.exec(line)?.[1]
      if (name && want.has(name)) {
        if (columns.has(name)) throw new Error(`table ${name} has more than one CREATE TABLE in the dump`)
        inCreate = name
        createBuf = []
      }
      continue
    }
    if (line.startsWith('INSERT INTO `')) {
      const m = /^INSERT INTO `([^`]+)` VALUES /.exec(line)
      if (!m || !want.has(m[1]!)) continue
      const table = m[1]!
      const cols = columns.get(table)
      if (!cols) throw new Error(`INSERT for ${table} appears before its CREATE TABLE`)
      seenInsert.add(table)
      const keepNames = keepColumns[table]
      const keepIdx = keepNames ? cols.flatMap((c, k) => (keepNames.includes(c) ? [k] : [])) : undefined
      if (keepNames && keepIdx!.length !== keepNames.length) {
        throw new Error(`${table}: a requested column is not in CREATE TABLE`)
      }
      const outNames = keepIdx ? keepIdx.map((k) => cols[k]!) : cols
      const tuples = parseValuesTuples(line.slice(m[0].length), {
        keep: keepIdx ? new Set(keepIdx) : undefined, columns: cols.length, label: table,
      })
      for (const cells of tuples) {
        result[table]!.push(Object.fromEntries(outNames.map((c, k) => [c, cells[k]!])))
      }
    }
  }
  for (const t of wanted) {
    if (!columns.has(t)) throw new Error(`table ${t} not found in dump`)
    if (!seenInsert.has(t)) throw new Error(`table ${t} has no INSERT statement in dump`)
  }
  return result
}

/** Stream a .sql.gz (or plain .sql) file line by line. */
export function linesOfFile(path: string): AsyncIterable<string> {
  const raw = createReadStream(path)
  const input = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
  return createInterface({ input, crlfDelay: Infinity })
}
