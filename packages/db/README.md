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

## Rules

- **Migrations are append-only.** The runner stores a checksum of every applied
  file and refuses to run if one has changed. To alter something a migration
  created, add a new file.
- Every file runs inside its own transaction. A failure rolls back completely —
  the database is left exactly as it was, so never start repairing by hand.
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
