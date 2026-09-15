/**
 * Seed.
 *
 * Two purposes, and the second is the important one:
 *
 *   1. Give a fresh database enough to log into.
 *   2. Be the fixture the tenant-isolation tests run against. Those tests need
 *      TWO owner groups that must never see each other, so the seed creates
 *      both even though only Samut Prakan goes live on 1 Nov. An isolation test
 *      with one tenant proves nothing.
 *
 * Idempotent: safe to re-run. Every insert is ON CONFLICT DO NOTHING and no row
 * is ever updated, so running this against a database with real work in it
 * cannot damage anything.
 */
import pg from 'pg'
import { hash } from 'bcryptjs'

type Client = pg.Client

const GROUPS = [
  { slug: 'champpower-a', name: 'กลุ่ม A' },
  { slug: 'champpower-b', name: 'กลุ่ม B' },
]

const SHOPS = [
  // Live first. doc_code feeds the {SHOP} token in number patterns.
  { group: 'champpower-b', slug: 'samut-prakan', name: 'แชมป์เพาเวอร์ สมุทรปราการ', code: 'SPK', mode: 'none' },
  { group: 'champpower-b', slug: 'phetkasem',    name: 'แชมป์เพาเวอร์ เพชรเกษม',    code: 'PK',  mode: 'none' },
  // Group A: not going live in this release, present so isolation is testable.
  { group: 'champpower-a', slug: 'don-mueang',    name: 'แชมป์เพาเวอร์ ดอนเมือง',   code: 'DM',  mode: 'team' },
  { group: 'champpower-a', slug: 'pracha-uthit',  name: 'แชมป์เพาเวอร์ ประชาอุทิศ', code: 'PU',  mode: 'team' },
  { group: 'champpower-a', slug: 'wongwian-yai',  name: 'แชมป์เพาเวอร์ วงเวียนใหญ่', code: 'WY', mode: 'team' },
  { group: 'champpower-a', slug: 'ayutthaya',     name: 'แชมป์เพาเวอร์ อยุธยา',     code: 'AY',  mode: 'team' },
]

// Three roles for the 1 Nov release; the other four exist in the role matrix
// and can be seeded when their screens exist. Seeding a role nobody can use
// yet only creates accounts that go stale.
const USERS = [
  { login: 'owner.b@champpower.local',   name: 'เจ้าของ กลุ่ม B', role: 'owner',   shops: ['samut-prakan', 'phetkasem'] },
  { login: 'manager.spk@champpower.local', name: 'ผู้จัดการ สมุทรปราการ', role: 'manager', shops: ['samut-prakan'] },
  { login: 'office.spk@champpower.local',  name: 'ออฟฟิศ สมุทรปราการ',   role: 'advisor', shops: ['samut-prakan'] },
  // Group A, so the isolation test has someone on the other side of the fence.
  { login: 'owner.a@champpower.local',   name: 'เจ้าของ กลุ่ม A', role: 'owner',   shops: ['don-mueang', 'pracha-uthit', 'wongwian-yai', 'ayutthaya'] },
]

async function seedGroupsAndShops(c: Client) {
  for (const g of GROUPS) {
    await c.query(
      `INSERT INTO owner_groups (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING`, [g.slug, g.name])
  }
  for (const s of SHOPS) {
    await c.query(
      `INSERT INTO shops (owner_group_id, slug, name, doc_code, assignment_mode)
       SELECT id, $2, $3, $4, $5 FROM owner_groups WHERE slug = $1
       ON CONFLICT (slug) DO NOTHING`,
      [s.group, s.slug, s.name, s.code, s.mode])

    // Every shop gets the default number patterns. Samut Prakan's are the
    // formats its customers already read (JB-260820-001, IV260630001); a new
    // branch edits them in settings without a deploy.
    await c.query(
      `SELECT seed_document_series(id) FROM shops WHERE slug = $1`, [s.slug])
  }
}

async function seedUsers(c: Client) {
  // Development password only. The seed refuses to run against anything that
  // looks like production, below.
  const pw = await hash('champpower', 10)
  for (const u of USERS) {
    await c.query(
      // The unique index is on lower(login_id), so the conflict target has to
      // be the expression, not the column.
      `INSERT INTO users (login_id, name, password_hash)
       VALUES ($1, $2, $3) ON CONFLICT (lower(login_id)) DO NOTHING`,
      [u.login, u.name, pw])
    for (const shop of u.shops) {
      await c.query(
        `INSERT INTO shop_memberships (user_id, shop_id, role)
         SELECT u.id, s.id, $3 FROM users u, shops s
          WHERE u.login_id = $1 AND s.slug = $2
         ON CONFLICT (user_id, shop_id) DO NOTHING`,
        [u.login, shop, u.role])
    }
  }
}

export async function seed(connectionString: string) {
  const c = new pg.Client({ connectionString })
  await c.connect()
  try {
    // A seed that plants test accounts with a known password into a live
    // database is a security incident, not a convenience. Refuse loudly.
    const { rows } = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM documents')
    if (Number(rows[0].n) > 0 && process.env.SEED_FORCE !== 'yes') {
      throw new Error(
        'this database already has documents in it — refusing to seed.\n' +
        'Set SEED_FORCE=yes only if you are certain this is not the shop\'s database.')
    }

    await c.query('BEGIN')
    await seedGroupsAndShops(c)
    await seedUsers(c)
    await c.query('COMMIT')

    console.log(`seeded ${GROUPS.length} groups, ${SHOPS.length} shops, ${USERS.length} users`)
    console.log('login: owner.b@champpower.local / champpower')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await c.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1) }
  seed(url).catch(err => { console.error(err.message); process.exit(1) })
}
