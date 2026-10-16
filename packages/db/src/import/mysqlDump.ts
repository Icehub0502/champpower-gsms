/**
 * A deliberately tiny reader for mysqldump output (WO-004).
 *
 * It extracts ONLY the tables it is asked for: the line scanner discards every
 * other line without parsing it, so customer rows in the same file are never
 * decoded, held, or printed. It understands exactly what mysqldump emits for
 * those tables -- `CREATE TABLE` column lists and single-line
 * `INSERT INTO ... VALUES (...),(...);` -- and refuses anything else rather
 * than guessing.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'

/** One decoded cell. Numbers stay as their source text; NULL is null. */
export type Cell = string | null
export type DumpRow = Record<string, Cell>

const ESCAPES: Record<string, string> = {
  '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a',
  "'": "'", '"': '"', '\\': '\\',
}

/**
 * Parse the part of an INSERT statement after `VALUES` into tuples of cells.
 * Throws on anything malformed: a half-parsed catalog is worse than none.
 */
export function parseValuesTuples(text: string): Cell[][] {
  const rows: Cell[][] = []
  let i = 0
  const n = text.length
  const fail = (msg: string): never => {
    throw new Error(`dump parse error at offset ${i}: ${msg}`)
  }
  const skipWs = () => { while (i < n && /\s/.test(text[i]!)) i++ }

  skipWs()
  while (i < n) {
    if (text[i] === ';') break
    if (text[i] !== '(') fail(`expected "(" but found ${JSON.stringify(text[i])}`)
    i++
    const row: Cell[] = []
    for (;;) {
      skipWs()
      if (text[i] === "'") {
        i++
        let out = ''
        for (;;) {
          if (i >= n) fail('unterminated string')
          const c = text[i]!
          if (c === '\\') {
            const e = text[i + 1]
            if (e === undefined) fail('dangling backslash')
            // MySQL: an unknown escape drops the backslash and keeps the char.
            out += ESCAPES[e!] ?? e
            i += 2
          } else if (c === "'") {
            if (text[i + 1] === "'") { out += "'"; i += 2 } else { i++; break }
          } else { out += c; i++ }
        }
        row.push(out)
      } else {
        let j = i
        while (j < n && text[j] !== ',' && text[j] !== ')') j++
        const raw = text.slice(i, j).trim()
        if (raw === '') fail('empty value')
        if (raw === 'NULL') row.push(null)
        else if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) row.push(raw)
        else fail(`unsupported literal ${JSON.stringify(raw.slice(0, 20))}`)
        i = j
      }
      skipWs()
      if (text[i] === ',') { i++; continue }
      if (text[i] === ')') { i++; break }
      fail('expected "," or ")"')
    }
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
 * Every table asked for must have a CREATE TABLE and at least one INSERT line
 * in the dump, or this throws -- a silently empty table would read as "nothing
 * to import" instead of "wrong file".
 */
export async function extractTables(
  lines: AsyncIterable<string> | Iterable<string>,
  wanted: readonly string[],
  /** Per table, the only columns kept. Every other cell is dropped as soon as the tuple is tokenised; it never reaches a row object. */
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
      if (name && want.has(name)) { inCreate = name; createBuf = [] }
      continue
    }
    if (line.startsWith('INSERT INTO `')) {
      const m = /^INSERT INTO `([^`]+)` VALUES /.exec(line)
      if (!m || !want.has(m[1]!)) continue
      const table = m[1]!
      const cols = columns.get(table)
      if (!cols) throw new Error(`INSERT for ${table} appears before its CREATE TABLE`)
      seenInsert.add(table)
      for (const cells of parseValuesTuples(line.slice(m[0].length))) {
        if (cells.length !== cols.length) {
          throw new Error(`${table}: row has ${cells.length} cells, CREATE TABLE has ${cols.length} columns`)
        }
        const keep = keepColumns[table]
        result[table]!.push(Object.fromEntries(cols.flatMap((c, k) => (!keep || keep.includes(c) ? [[c, cells[k]!] as const] : []))))
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
