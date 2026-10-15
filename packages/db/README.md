# @gsms/db

Schema, migration runner and seed.

## One-time setup

```bash
# 1. create the database and the application role
psql -U postgres -c "CREATE DATABASE gsms"
psql -U postgres -d gsms -f setup-role.sql   # asks for a password, see the file

# 2. apply the schema
npm run migrate -w packages/db

# 3. seed (refuses to run if the database already holds documents)
npm run seed -w packages/db
```

## Test database (`gsms_test`)

The API integration tests (Tier 2) insert and delete rows, so they must never
run against the dev database `gsms`. They use a dedicated `gsms_test`.

```bash
# 1. copy and fill in (gitignored). gsms_app has the same password as in .env;
#    TEST_DATABASE_ADMIN_URL is the postgres superuser, database gsms_test.
cp .env.test.example .env.test

# 2. create gsms_test if missing, make sure gsms_app exists, grant, migrate 0001..latest
npm run test-db:setup -w packages/db

# 3. run the tests
npm test -w apps/api
```

- `test-db:setup` is idempotent. It reads `TEST_DATABASE_ADMIN_URL` only (never
  `DATABASE_ADMIN_URL`), and refuses a database named `gsms`, `postgres`, or the
  one in `DATABASE_URL`. After adding a migration, re-run it to bring
  `gsms_test` up to date. `npm run migrate` still targets dev, unchanged.
- Roles are cluster-wide, so `gsms_app` is shared with dev. If it is missing the
  script creates it `NOLOGIN` and tells you to set the password yourself.
  Grants and default privileges are per database, so the script applies them.
- Tests connect as `gsms_app` (not the owner), so RLS applies. A guard test
  asserts `current_database()` is not the dev DB and the role is a non-superuser.
- No `TEST_DATABASE_URL` means Tier 2 is SKIPPED with a loud warning. It never
  falls back to `DATABASE_URL`. If the test database name equals the one in
  `DATABASE_URL`, vitest aborts at startup. `TEST_DATABASE_ADMIN_URL` is what
  the admin-gated suites receive as `DATABASE_ADMIN_URL`; the dev admin URL is
  never passed to tests.

## Rules

- **Migrations are append-only.** The runner stores a checksum of every applied
  file and refuses to run if one has changed. To alter something a migration
  created, add a new file.
- Every file runs inside its own transaction. A failure rolls back completely —
  the database is left exactly as it was, so never start repairing by hand.
- `lower()`, `\s`, and POSIX classes like `[[:space:]]` are collation/ctype
  aware — deterministic on the authoring machine, silently different on a
  cluster with another locale, and never usable inside an `IMMUTABLE`
  function (0020's `price_key()` was NO-GO over exactly this: `lower('Ü')` is
  a no-op under `Thai_Thailand.874`). Fold case with `translate()` naming the
  exact characters, and strip characters by building the class from
  `chr(<decimal code point>)`, never a `\uXXXX` escape in the pattern.
  Two reasons, not one: it is deterministic on every cluster, AND a literal
  `\uXXXX` (or `\n`, `\t`, …) sitting in a tool call, an editor macro, or any
  JSON-shaped pipe between where you typed it and the file on disk is a known
  trap — some layer along the way may decode it as a real escape before it
  reaches the file, silently turning your regex source into literal control
  characters. `chr(9)` cannot be misread that way; `\u0009` can. Always
  re-read the file after writing a pattern like this and verify the bytes.
- Every table carrying `shop_id` must call `apply_tenant_rls('<table>')` in the
  same migration. A table that forgets is a cross-branch data leak.
- Every view must be declared `WITH (security_invoker = true)`. Without it the
  view runs as its owner and the row-level security of the tables it reads is
  skipped entirely.
- **Every migration that touches an RLS policy must be verified by running
  `psql -U postgres -d gsms -f packages/db/verify-rls.sql`, with the output
  attached to the PR/report.** A migration that changes RLS without this
  attached is not done — see `CLAUDE.md` §11 and `docs/WORK-ORDERS/WO-001-auth-hardening.md`
  for what a missed policy split costs.

## Rolling back a migration — checklist

Follow these steps in order, every one of them. Each migration's header has a
ROLLBACK block, but that block only undoes the schema; everything else below is
what it does NOT do for you. This lives here, not in the migration files,
because an applied migration can never be edited — a warning added to 0015
today would change its checksum and the runner would refuse to start.

### Who runs this: `postgres`, and never `gsms_app`

**Every SQL step below runs as `postgres`** — the superuser in
`DATABASE_ADMIN_URL`, the same role that runs migrations and `verify-rls.sql`:

```
psql -U postgres -d gsms
```

- **Never as `gsms_app`** (the role in `DATABASE_URL`). It has no DDL rights, so
  a ROLLBACK block run as `gsms_app` fails part-way through.
- **Never export as `gsms_app` or any non-superuser**, even the tables' owner.
  The tenant tables are `FORCE ROW LEVEL SECURITY` (0012), so without a shop
  set, a read returns **zero rows and no error**. Measured on this database:
  `SELECT count(*) FROM match_blocklist` returns 30 as `postgres` and **0** as
  `gsms_app`. An operator who exports as the wrong role gets an empty file that
  looks like a successful export, then drops the real data.

### 0. Take a full backup, and check it is not empty

CLAUDE.md §11: nothing is rolled back without a backup first.

```
pg_dump -U postgres -Fc gsms > pre-rollback-YYYY-MM-DD.dump
pg_restore --list pre-rollback-YYYY-MM-DD.dump | head
```

The file must be well over a few kilobytes, and `pg_restore --list` must list
the tables (`jobs`, `customers`, `match_blocklist` …). An empty or tiny file
means the dump failed — stop here.

### 1. List the migrations to undo, highest number first

Roll back one migration at a time, newest to oldest, and finish each one
(steps 3–7) before starting the next. Later migrations build on earlier ones —
0016 replaces the `queue_board` view that 0013 created — so undoing an older
one while a newer one still depends on it either fails or leaves the newer one
broken.

### 2. Put the WHOLE release back first — the one from before the LOWEST migration you are undoing

Not just `apps/api`: the whole monorepo release — `apps/api`, `packages/domain`,
`packages/contracts` and `packages/db`, built together from one commit. The
API is written against the schema the moment it ships: undo 0015 alone with its
code still running and `findByPhone` loses `match_blocklist`, so EVERY check-in
in the shop fails; undo 0016 alone and `/api/jobs/today` and the public board
break.

If you are undoing 0016 and 0015, the release must be from before **0015** (the
lowest), not before 0016. Find that commit with:

```
git log --diff-filter=A --format='%h %ad %s' --date=short -- packages/db/migrations/0015_*.sql
```

The running release must be built from a commit OLDER than that one.

Then confirm nothing is still using the objects you are about to drop. Run this
a few times over a minute (idle connections show their last query):

```sql
SELECT pid, usename, application_name, state, query_start, left(query, 120) AS query
  FROM pg_stat_activity
 WHERE datname = 'gsms'
   AND pid <> pg_backend_pid()
   AND query ILIKE '%match_blocklist%';   -- the table or view this migration created
```

It must come back empty every time. If a `gsms_app` session is still touching the
table, the new code is still running somewhere — stop and find it.

### 3. Export the data the rollback will destroy — with `\copy`, not a bare `SELECT`

Read the migration's ROLLBACK block and its "Data lost on rollback" note. A
ROLLBACK drops columns and tables, and whatever staff put in them is gone. Export
each one to a file as `postgres`:

```
\copy (SELECT id, sub_state FROM jobs WHERE sub_state IS NOT NULL) TO 'rollback-0016-sub_state.csv' CSV HEADER
```

| Migration | What the rollback destroys | Export query |
|---|---|---|
| 0016 | `jobs.sub_state` — every label staff set on a card | `SELECT id, sub_state FROM jobs WHERE sub_state IS NOT NULL` |
| 0016 | `shops.public_board_token` — **every waiting-room TV URL** | `SELECT id, public_board_token FROM shops` |
| 0015 | `match_blocklist` rows with `source` of `'manual'` or `'auto'` — decisions a person or the threshold rule made; re-applying 0015 only puts back its own five seed rows | `SELECT * FROM match_blocklist WHERE source <> 'seed'` |
| 0013 | `jobs.mileage_in` — already unrecoverable; see its header | (only a backup from before 0013 has it) |

**The tokens:** re-applying 0016 later GENERATES NEW TOKENS. Every TV in every
shop's waiting room then shows a 404 until it is re-pointed to its new URL.
Either put the exported tokens back after re-applying
(`UPDATE shops SET public_board_token = '<old>' WHERE id = '<id>'`) or plan to
visit every TV.

### 4. Check each export has the right number of rows before going on

For each export, run the same query as a count, and compare:

```sql
SELECT count(*) FROM jobs WHERE sub_state IS NOT NULL;   -- say this prints 42
```

`\copy` itself prints `COPY 42`. **The two numbers must match.** Compare against
that `COPY n` line, not `wc -l` on the file — a text field containing a newline
makes the line count wrong. If the count is 0 and you did not expect 0, check
first that you are connected as `postgres` (`SELECT current_user`); a
zero-row export as the wrong role is the failure this step exists to catch. Do
not continue until every export matches.

### 5. Run the ROLLBACK statements and delete the `schema_migrations` row — one transaction, run by psql

Always both, always together, and **never by pasting into an open psql session**.

**Copy only the statements BETWEEN the header's `BEGIN;` and `COMMIT;`** — not
the `BEGIN;` and `COMMIT;` lines themselves — into a file, and add the DELETE
at the end:

```sql
-- rollback-0016.sql — the statements between BEGIN and COMMIT in 0016's header:
DROP VIEW queue_board;
-- ... every other statement from the block ...
DELETE FROM schema_migrations WHERE filename = '0016_job_substate_board.sql';
```

Then run it exactly like this:

```
psql -v ON_ERROR_STOP=1 --single-transaction -U postgres -d gsms -f rollback-0016.sql
```

- `--single-transaction` wraps the whole file in ONE transaction for you. That
  is why the file must not contain its own `BEGIN`/`COMMIT`: PostgreSQL does
  not nest transactions, so an inner `COMMIT` would end the outer transaction
  early — and if a statement then failed, the `DELETE FROM schema_migrations`
  could still commit on its own, recording a rollback that did not happen.
  That is the opposite of what this step exists to guarantee.
- `-v ON_ERROR_STOP=1` makes psql stop at the FIRST error instead of carrying
  on with the next statement. Together with `--single-transaction`, any error
  rolls back everything, including the DELETE.
- Check the exit code: `0` means every statement ran and committed. Anything
  else means NOTHING changed — the database is exactly as it was. Find the
  error, fix the file, and run it again.

Skip the DELETE and the runner still thinks the migration is applied: the next
deploy — the one meant to put things right — skips the file, never recreates
what you dropped, and the system breaks again.

### 6. Check it

```
psql -U postgres -d gsms -f packages/db/verify-rls.sql
```

The table count in its header changes if a tenant table went away. Then confirm
the older release starts and can check a car in.

### 7. Next migration

Go back to step 3 for the next-lower migration on your list, if there is one.
