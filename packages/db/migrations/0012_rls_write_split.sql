-- =============================================================================
-- 0012_rls_write_split.sql — split tenant RLS into per-command policies,
--                            and add refresh-token rotation columns
--
-- WHAT:     1. Redefines apply_tenant_rls() so every shop-scoped table carries
--              four policies (SELECT / INSERT / UPDATE / DELETE) instead of one
--              FOR ALL policy.
--           2. Retrofits every table that already has the old single policy,
--              found by scanning pg_policy rather than from a hand-written list.
--           3. Adds sessions.replaced_by and sessions.last_used_at for refresh
--              token rotation and reuse detection (WO-001 item 9).
--
-- WHY:      WO-001 item 3. The 0001 policy read:
--
--                USING (shop_id = current_shop_id()
--                       OR shop_id = ANY (current_shop_ids()))
--                WITH CHECK (shop_id = current_shop_id())
--
--              and the comment beside it claimed writes could not span shops.
--              That is true for INSERT and for the NEW row of an UPDATE, which
--              are what WITH CHECK governs. It is NOT true for DELETE, which
--              PostgreSQL governs with USING alone, nor for the row-selection
--              half of an UPDATE. So any transaction that had set
--              app.current_shop_ids — the owner's group-level read path — could
--              DELETE rows in every shop in that list, on all 55 tables that
--              call apply_tenant_rls across 0001-0011.
--
--              withShops now also issues SET TRANSACTION READ ONLY, which is the
--              other half of the fix. That is application discipline expressed in
--              one function; this migration makes the database itself refuse,
--              so a future read-write group path cannot quietly reopen the hole.
--
-- DEPLOY:   THIS MIGRATION RUNS BEFORE THE NEW API IS DEPLOYED. Not after, not
--           at the same time. The new API writes columns that only exist once
--           this file has run:
--
--             issueSession()  INSERTs sessions.last_used_at   -> every /login
--             revokeSession() UPDATEs sessions.replaced_by    -> /logout, admin
--                                                                revoke, and the
--                                                                /refresh rotate
--             touchSession()  UPDATEs sessions.last_used_at   -> /refresh
--
--           Deploy the API first and every one of those fails with PostgreSQL
--           42703 undefined_column. That is not a degraded feature: /login is on
--           the list, so nobody can get in at all, owner included, until the
--           migration catches up. The failure also arrives as a 500 on the very
--           first request after deploy, which is the worst possible moment to be
--           reading a stack trace.
--
--           The other order is safe. Old API + new schema works fine: the two
--           new columns are nullable so the old INSERTs still satisfy the table,
--           and the policy split only removes a cross-shop DELETE that no code
--           path in the old API performs (withShops is READ ONLY). So there is
--           no rush between the two steps and no required simultaneity — run the
--           migration, confirm it, then deploy.
--
--           Rolling back reverses the order for the same reason: API first, then
--           the database. See ROLLBACK.
--
-- ROLLBACK: Runnable, as the owning role, in one transaction. It restores the
--           EXACT pre-0012 state.
--
--           *** READ THIS BEFORE RUNNING THE ROLLBACK ***
--           Rolling this migration back REOPENS A KNOWN CROSS-TENANT DELETE
--           VULNERABILITY (WO-001 item 3). The restored 0001 policy gates DELETE
--           with USING alone, and that USING includes current_shop_ids(), so any
--           transaction holding a group-level shop list can DELETE rows in every
--           shop on that list, on all 55 shop-scoped tables. Group A's owner can
--           delete group A's other branches' data; the READ ONLY guard in
--           withShops is then the ONLY thing standing in the way, in application
--           code, one function deep.
--           That is a decision to take deliberately, with the trade-off in front
--           of you, not something to discover the next morning. If you are
--           rolling back at 2am because /refresh is throwing, prefer rolling
--           back the API alone and leaving this migration applied — the new
--           schema is backward compatible with the old API (see DEPLOY), so in
--           almost every incident the database does not need to move at all.
--
--           BEGIN;
--           SET LOCAL lock_timeout = '3s';
--           SET LOCAL statement_timeout = '60s';
--
--           -- (a) put the 0001 procedure back
--           CREATE OR REPLACE PROCEDURE apply_tenant_rls(tbl regclass) AS $r$
--           BEGIN
--             EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
--             EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
--             EXECUTE format($f$
--               CREATE POLICY tenant_isolation ON %s
--                 USING (shop_id = current_shop_id()
--                        OR shop_id = ANY (current_shop_ids()))
--                 WITH CHECK (shop_id = current_shop_id())
--             $f$, tbl);
--           END;
--           $r$ LANGUAGE plpgsql;
--
--           -- (b) swap the four policies back for the one, table by table.
--           --     Guarded and counted: a rollback that silently converts 3 of
--           --     55 tables leaves the database in a state that is neither the
--           --     old shape nor the new one, and nothing downstream would say so.
--           DO $r$
--           DECLARE
--             t    regclass;
--             n    integer;
--             done integer := 0;
--           BEGIN
--             SELECT count(*) INTO n
--             FROM pg_policy p
--             JOIN pg_class c ON c.oid = p.polrelid
--             JOIN pg_namespace ns ON ns.oid = c.relnamespace
--             WHERE ns.nspname = 'public' AND p.polname = 'tenant_select';
--
--             IF n < 55 THEN
--               RAISE EXCEPTION
--                 'Found % tenant_select policies, expected at least 55. This is '
--                 'not the database 0012 was applied to - refusing to roll back '
--                 'a schema I do not recognise.', n;
--             END IF;
--
--             FOR t IN
--               SELECT p.polrelid::regclass
--               FROM pg_policy p
--               JOIN pg_class c ON c.oid = p.polrelid
--               JOIN pg_namespace ns ON ns.oid = c.relnamespace
--               WHERE ns.nspname = 'public' AND p.polname = 'tenant_select'
--               ORDER BY p.polrelid::regclass::text
--             LOOP
--               EXECUTE format('DROP POLICY tenant_select ON %s', t);
--               EXECUTE format('DROP POLICY tenant_insert ON %s', t);
--               EXECUTE format('DROP POLICY tenant_update ON %s', t);
--               EXECUTE format('DROP POLICY tenant_delete ON %s', t);
--               CALL apply_tenant_rls(t);
--               done := done + 1;
--             END LOOP;
--
--             IF done <> n THEN
--               RAISE EXCEPTION 'reverted % of % tables - aborting', done, n;
--             END IF;
--             RAISE NOTICE 'reverted % table(s) to the single tenant_isolation policy', done;
--           END
--           $r$;
--
--           -- (c) undo the sessions changes
--           DROP INDEX IF EXISTS idx_sessions_replaced_by;
--           ALTER TABLE sessions
--             DROP CONSTRAINT IF EXISTS ck_sessions_replaced_implies_revoked,
--             DROP COLUMN IF EXISTS replaced_by,
--             DROP COLUMN IF EXISTS last_used_at;
--
--           -- (d) prove the rollback landed, before committing it. Same
--           --     reasoning as section 3 of the forward migration: a half-applied
--           --     RLS change is invisible from the outside, so the transaction
--           --     checks its own work and aborts rather than commit a shape it
--           --     cannot vouch for.
--           DO $r$
--           DECLARE leftover text; bad text;
--           BEGIN
--             -- (d1) no split policy may survive anywhere
--             SELECT string_agg(DISTINCT p.polrelid::regclass::text, ', ')
--               INTO leftover
--             FROM pg_policy p
--             JOIN pg_class c ON c.oid = p.polrelid
--             JOIN pg_namespace ns ON ns.oid = c.relnamespace
--             WHERE ns.nspname = 'public'
--               AND p.polname IN ('tenant_select','tenant_insert',
--                                 'tenant_update','tenant_delete');
--             IF leftover IS NOT NULL THEN
--               RAISE EXCEPTION 'split policies still present on: %', leftover;
--             END IF;
--
--             -- (d2) every shop_id table except the named exemption is back on
--             --      exactly one FOR ALL policy called tenant_isolation
--             SELECT string_agg(x.name || ' [' || coalesce(x.sig,'no policies') || ']', ', '
--                               ORDER BY x.name)
--               INTO bad
--             FROM (
--               SELECT c.relname::text AS name,
--                      (SELECT string_agg(p.polname || ':' || p.polcmd::text, ',' ORDER BY p.polname)
--                         FROM pg_policy p WHERE p.polrelid = c.oid) AS sig
--               FROM pg_class c
--               JOIN pg_namespace ns ON ns.oid = c.relnamespace
--               WHERE ns.nspname = 'public'
--                 AND c.relkind IN ('r','p')
--                 AND c.relname::text <> ALL (ARRAY['shop_memberships'])
--                 AND EXISTS (SELECT 1 FROM pg_attribute a
--                             WHERE a.attrelid = c.oid AND a.attname = 'shop_id'
--                               AND a.attnum > 0 AND NOT a.attisdropped)
--             ) x
--             WHERE x.sig IS DISTINCT FROM 'tenant_isolation:*';
--             IF bad IS NOT NULL THEN
--               RAISE EXCEPTION 'not back on the 0001 policy: %', bad;
--             END IF;
--
--             -- (d3) the sessions columns are actually gone
--             IF EXISTS (SELECT 1 FROM pg_attribute
--                        WHERE attrelid = 'sessions'::regclass
--                          AND attname IN ('replaced_by','last_used_at')
--                          AND attnum > 0 AND NOT attisdropped) THEN
--               RAISE EXCEPTION 'sessions still carries the 0012 columns';
--             END IF;
--
--             RAISE NOTICE 'rollback verified: pre-0012 shape restored';
--           END
--           $r$;
--
--           DELETE FROM schema_migrations WHERE filename = '0012_rls_write_split.sql';
--           COMMIT;
--
--           ROLL BACK THE API FIRST. The new API cannot run against the old
--           schema — see DEPLOY above for the exact list. It is not only
--           /refresh: issueSession() writes last_used_at on INSERT, so with
--           these columns dropped LOGIN ITSELF fails, and so do /logout and the
--           admin revoke-sessions endpoint, which write replaced_by. Dropping
--           the columns under a running new API takes the whole auth surface
--           down, not one endpoint. Order: stop API -> deploy previous API
--           build -> run this rollback.
--
--           What the rollback restores: the schema, exactly. What it does NOT
--           restore: (i) rows deleted across shops while the hole was open —
--           nothing here can bring those back, only a backup can; (ii) the
--           rotation chain — dropping replaced_by/last_used_at discards every
--           value written since this migration ran, so any session rotated after
--           0012 loses its link to its predecessor and reuse detection goes
--           blind for those rows. Every session is best treated as suspect
--           afterwards: revoke them all and make everyone sign in again, which
--           is cheap compared to keeping a chain you can no longer reason about.
--
-- LOCKS:    HEAVY. Not safe to run live. Needs a maintenance window.
--
--           CREATE POLICY and DROP POLICY each take ACCESS EXCLUSIVE on their
--           table — the strongest lock there is. It blocks everything, including
--           plain SELECT, and it queues behind any statement already running on
--           that table. Worse, this migration is one transaction (the runner
--           wraps every file in BEGIN/COMMIT), so locks are NOT released table
--           by table: by the last statement it holds ACCESS EXCLUSIVE on all 55
--           shop-scoped tables at once, until COMMIT.
--
--           On an idle database the POLICY work is catalogue-only — no table is
--           rewritten, no row is read — so that half finishes in well under a
--           second. (The sessions half is not catalogue-only; see the sessions
--           note further down.) On a live database the wall-clock time was
--           unbounded before the timeouts below: it is however long the longest
--           in-flight query holds its lock, during which every new query on
--           every already-locked table piles up behind it. That is how a 200 ms
--           migration takes the shop down for a minute.
--
--           The two timeouts at the top bound that, in different dimensions,
--           and both are needed:
--
--             lock_timeout     = '3s'   how long any ONE statement will queue
--                                       for any ONE table before giving up
--             statement_timeout = '60s' how long any ONE statement may run in
--                                       total, lock waiting included
--
--           lock_timeout alone is not enough, and this is the part that was
--           wrong before. It is per lock acquisition, not per migration: the
--           retrofit loop touches 55 tables, so at 5s each the old file could
--           spend 55 x 5s = 275s creeping forward one table at a time, holding
--           ACCESS EXCLUSIVE on everything it had already reached, and never
--           trip a single timeout. Nearly five minutes of a frozen shop, with no
--           error to show for it.
--
--           statement_timeout closes that, because the retrofit loop is ONE
--           statement — a single DO block — so all 55 tables are locked inside
--           its 60s budget. Whichever limit is hit first, the transaction aborts
--           and PG 16 rolls the whole thing back untouched.
--
--           NEW WORST CASE, stated plainly:
--             - busy table, the common failure: aborts after 3s. Nothing
--               changed, run it again when the shop is closed.
--             - the retrofit DO block: hard ceiling 60s.
--             - the three sessions statements after it: <= 3s lock wait each,
--               plus work measured in milliseconds at today's table size.
--             - practical ceiling for the whole file: about 70s, down from 275s+
--               and unbounded.
--             - what you will actually see on a stopped API: under a second.
--
--           Pedantically: PostgreSQL has no per-TRANSACTION timeout, so the
--           arithmetic ceiling is 60s x ~10 statements. That number is not worth
--           planning around — only the retrofit block can approach 60s — but do
--           not read "statement_timeout = 60s" as "this file cannot exceed 60s".
--           It cannot, per statement.
--
--           Run it with the API stopped. Not "at a quiet moment" — stopped.
--
--           The sessions table specifically. Three statements, and they are NOT
--           all catalogue-only — the original note here was incomplete:
--
--           (i)   ALTER TABLE ... ADD COLUMN x2. Both columns are nullable with
--                 no default, so PG 16 only writes the catalogue — no table
--                 rewrite. ACCESS EXCLUSIVE, but brief.
--
--           (ii)  The same statement adds a self-referencing FOREIGN KEY
--                 (replaced_by -> sessions.id). A new FK is VALIDATED, which is
--                 a scan, not a catalogue edit: PostgreSQL runs the RI check
--                 over existing rows and takes SHARE ROW EXCLUSIVE on the
--                 referenced table — which here is sessions itself, already held
--                 at ACCESS EXCLUSIVE, so no extra table is involved. Every
--                 existing row has replaced_by NULL and NULL is trivially
--                 satisfied, so nothing can fail; it still reads the table.
--                 PostgreSQL may recognise that a column added in the same
--                 statement is entirely NULL and skip the scan — do not count on
--                 it, assume one seq scan of sessions.
--                 The CHECK constraint on the next statement is validated the
--                 same way, with the same argument for why it passes.
--
--           (iii) CREATE INDEX (non-concurrent) takes SHARE on the table. On its
--                 own that is not a full block — SELECT still runs — but SHARE
--                 blocks INSERT, UPDATE and DELETE, and on THIS table that is
--                 every login (INSERT sessions), every refresh (INSERT + UPDATE)
--                 and every logout (UPDATE). An index build on sessions is an
--                 auth outage for its duration, which is why it belongs in the
--                 window and not in a "quick one while nobody's looking".
--                 In this file it is moot in the narrow sense: the transaction
--                 has held ACCESS EXCLUSIVE on sessions since statement (i), so
--                 sessions is already fully locked, reads included, from the
--                 first ALTER through to COMMIT. That is the honest window.
--
--           Durations: sessions holds tens of rows today (pre-cutover), so all
--           three finish in single-digit milliseconds. At a million sessions the
--           validation scan and the index build are a few seconds each — still
--           inside the 60s budget, but no longer free, and worth re-reading this
--           note before running anything like it on a live table later.
--
-- ROWS:     0 rows changed. Policies and two nullable columns only. No backfill.
-- =============================================================================

-- Fail fast rather than forming a queue behind a lock we cannot get. An aborted
-- migration leaves the database untouched (PG rolls back DDL); a lock queue on
-- 55 tables leaves the shop unable to work.
--
-- Both limits, because they bound different things: lock_timeout is per lock
-- acquisition and statement_timeout is per statement. The retrofit loop is one
-- statement covering all 55 tables, so statement_timeout is what actually caps
-- this migration's total blocking time. See the LOCKS section above for the
-- worst-case arithmetic.
--
-- SET LOCAL, not SET: the runner wraps every file in BEGIN/COMMIT (see
-- packages/db/src/migrate.ts), so these revert at COMMIT and cannot leak onto
-- the connection and quietly change the behaviour of whatever runs next.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';


-- -----------------------------------------------------------------------------
-- 1. The new policy shape
-- -----------------------------------------------------------------------------
-- Four policies, one per command, instead of one FOR ALL policy. The asymmetry
-- 0001 intended is now actually enforced:
--
--   SELECT  may span the shops of an explicit group-level read.
--   INSERT  / UPDATE / DELETE name exactly one shop — the active one — on both
--           the existing-row side (USING) and the new-row side (WITH CHECK).
--
-- Why separate policies rather than one FOR ALL with a cleverer expression:
-- a FOR ALL policy has a single USING expression that every command shares, so
-- it is impossible to let SELECT see the group while DELETE sees one shop. The
-- command split is the only way to express the difference.
--
-- One consequence worth knowing: PostgreSQL applies the UPDATE policy's USING
-- clause to SELECT ... FOR UPDATE / FOR SHARE as well as the SELECT policy's.
-- Inside withShop both expressions are identical, so the stock ledger's
-- SELECT ... FOR UPDATE on stock_balances (CLAUDE.md 6.4) behaves exactly as
-- before. Inside a group-level read a locking SELECT now narrows to the active
-- shop — which is moot, because that transaction is READ ONLY.
CREATE OR REPLACE PROCEDURE apply_tenant_rls(tbl regclass) AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  -- FORCE so the policy applies to the table owner too. Without it, anything
  -- connecting as the owner silently sees every shop.
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

  EXECUTE format($f$
    CREATE POLICY tenant_select ON %s FOR SELECT
      USING (shop_id = current_shop_id() OR shop_id = ANY (current_shop_ids()))
  $f$, tbl);

  EXECUTE format($f$
    CREATE POLICY tenant_insert ON %s FOR INSERT
      WITH CHECK (shop_id = current_shop_id())
  $f$, tbl);

  -- USING picks which rows may be updated at all; WITH CHECK vets the row that
  -- results. Both must name the active shop, or an UPDATE could move a row from
  -- one shop to another, or edit a row it should not have been able to see.
  EXECUTE format($f$
    CREATE POLICY tenant_update ON %s FOR UPDATE
      USING (shop_id = current_shop_id())
      WITH CHECK (shop_id = current_shop_id())
  $f$, tbl);

  -- The bug. DELETE has no WITH CHECK to fall back on: USING is the only gate,
  -- so USING is where the group-wide clause must never appear.
  EXECUTE format($f$
    CREATE POLICY tenant_delete ON %s FOR DELETE
      USING (shop_id = current_shop_id())
  $f$, tbl);
END;
$$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- 2. Retrofit every table that already carries the old policy
-- -----------------------------------------------------------------------------
-- Enumerated from pg_policy, not typed out. A hand-written list of 55 table
-- names is exactly how one table gets left behind, and the one left behind is
-- the hole. Whatever the catalogue says has the old policy, gets the new one.

CREATE TEMP TABLE _rls_retrofit ON COMMIT DROP AS
  SELECT p.polrelid::regclass AS tbl
  FROM pg_policy p
  JOIN pg_class c     ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND p.polname = 'tenant_isolation';

DO $do$
DECLARE
  t regclass;
  n integer;
BEGIN
  SELECT count(*) INTO n FROM _rls_retrofit;

  -- Migrations 0001-0011 call apply_tenant_rls on exactly 55 distinct tables
  -- (counted from the files, not from memory). Fewer than that means this is
  -- not the database this migration was written against — missing migrations,
  -- a policy dropped by hand, or the wrong server. Stop and let a human look.
  -- More than 55 is fine: an extra shop-scoped table simply gets retrofitted
  -- too, which is the entire point of enumerating instead of hand-listing.
  IF n < 55 THEN
    RAISE EXCEPTION
      'Found % tenant_isolation policies, expected at least 55 from migrations '
      '0001-0011. Refusing to continue against an unexpected schema.', n;
  END IF;
  IF n > 55 THEN
    RAISE NOTICE 'found % tenant_isolation policies (expected 55) - retrofitting all of them', n;
  END IF;
  RAISE NOTICE 'retrofitting % table(s) from tenant_isolation to the four-policy split', n;

  FOR t IN SELECT tbl FROM _rls_retrofit ORDER BY tbl::text LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %s', t);
    -- ENABLE/FORCE inside the procedure are no-ops here; they are already on.
    CALL apply_tenant_rls(t);
  END LOOP;
END
$do$;


-- -----------------------------------------------------------------------------
-- 3. Prove it, inside this transaction, before anyone can rely on it
-- -----------------------------------------------------------------------------
-- A half-applied RLS change is a silent cross-tenant hole, so the migration
-- checks its own work and aborts rather than committing something it cannot
-- vouch for. PG 16 rolls DDL back, so an abort here leaves the database exactly
-- as it was.
DO $do$
DECLARE
  expected constant text :=
    'tenant_delete:d,tenant_insert:a,tenant_select:r,tenant_update:w';

  -- Tables that carry a shop_id column and are deliberately NOT under tenant
  -- RLS. Named one at a time, each with a reason, because the whole value of
  -- check (b) is that it fails on a table nobody thought about. Loosening the
  -- predicate instead — "tables that already have a policy must have four", or
  -- dropping the check — would make it pass here and go on passing for the next
  -- table someone forgets, which is the failure this check exists to catch. A
  -- named exception is auditable; a loose predicate is a hole with a comment.
  --
  --   shop_memberships — the login path reads it before any shop is known, so a
  --     policy keyed on current_shop_id() would match zero rows and NOBODY could
  --     log in, owner included. Full reasoning, and what a correct policy would
  --     need instead, in SECTION 5 AT THE BOTTOM OF THIS FILE. This is the one
  --     table in the schema that has shop_id and no RLS, and it is intentional.
  --
  -- Adding a name here is a security decision. Write the reason next to it.
  exempt constant text[] := ARRAY['shop_memberships'];

  leftover text;
  bad      text;
  missing  text;
BEGIN
  -- (a) Nothing may still be on the old single policy.
  SELECT string_agg(p.polrelid::regclass::text, ', ' ORDER BY p.polrelid::regclass::text)
    INTO leftover
  FROM pg_policy p
  JOIN pg_class c     ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation';

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_isolation still present on: %', leftover;
  END IF;

  -- (b) EVERY public table with a shop_id column, except the names listed in
  --     `exempt` above, must now have RLS enabled, forced, and exactly these
  --     four policies and nothing else.
  --
  --     Deliberately wider than "the tables we just touched": this also catches
  --     a table that has a shop_id and never had tenant isolation at all — a
  --     pre-existing hole nobody noticed. suppliers, stock_transfers and
  --     stock_transfer_lines are keyed on owner_group_id, not shop_id, and so
  --     never appear here at all. users, sessions, shops and owner_groups have
  --     no shop_id column and likewise never appear.
  --
  --     shop_memberships DOES have a shop_id column and DOES appear, which is
  --     why it has to be exempted by name — see the declaration above and
  --     section 5. Without that exemption this check fails on every run, 100%
  --     of the time, and the migration can never be applied at all.
  --
  --     Guard the exemption list itself first: if a listed table does not
  --     exist, the name is stale or misspelled and the exemption is silently
  --     doing nothing.
  SELECT string_agg(e, ', ' ORDER BY e) INTO missing
  FROM unnest(exempt) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname::text = e);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS exemption list names table(s) that do not exist: %. Renamed or '
      'misspelled - fix the list rather than leaving a dead exemption.', missing;
  END IF;

  SELECT string_agg(x.name || ' [' || coalesce(x.sig, 'no policies') || ']', E'\n  '
                    ORDER BY x.name)
    INTO bad
  FROM (
    SELECT c.relname::text AS name,
           (SELECT string_agg(p.polname || ':' || p.polcmd::text, ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = c.oid) AS sig,
           c.relrowsecurity,
           c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname::text <> ALL (exempt)
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'shop_id'
          AND a.attnum > 0 AND NOT a.attisdropped)
  ) x
  WHERE x.sig IS DISTINCT FROM expected
     OR NOT x.relrowsecurity
     OR NOT x.relforcerowsecurity;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION E'Tables with shop_id that are not correctly protected:\n  %', bad;
  END IF;

  -- Say out loud what was skipped, so the exemption appears in the migration
  -- output and in whatever log captures it, rather than only in this file.
  RAISE NOTICE 'exempt from tenant RLS by name (see section 5): %',
    array_to_string(exempt, ', ');

  -- (c) Everything we set out to change, changed.
  IF EXISTS (
    SELECT 1 FROM _rls_retrofit r
    WHERE (SELECT string_agg(p.polname || ':' || p.polcmd::text, ',' ORDER BY p.polname)
             FROM pg_policy p WHERE p.polrelid = r.tbl) IS DISTINCT FROM expected
  ) THEN
    RAISE EXCEPTION 'A retrofitted table did not end up with the four policies';
  END IF;

  RAISE NOTICE 'verified: % table(s) on the four-policy split, 0 on the old one',
    (SELECT count(*) FROM _rls_retrofit);
END
$do$;


-- -----------------------------------------------------------------------------
-- 4. Refresh-token rotation and reuse detection (WO-001 item 9)
-- -----------------------------------------------------------------------------
-- Today a refresh token is valid, unchanged, for 30 days from anywhere. A copy
-- of it is indistinguishable from the original. Rotation fixes that by making
-- each refresh mint a new session and retire the old one; the retired row keeps
-- a pointer to its successor, and that pointer is the signal:
--
--   a refresh token arrives -> its session is revoked AND replaced_by is set
--   -> the holder is presenting a token that was already rotated away.
--      Either it was stolen, or the original holder's copy was. Revoke the whole
--      chain for that user and write it to the audit log.
--
-- A revoked row with replaced_by NULL is an ordinary logout and means nothing.
-- The distinction only exists because the column does.

-- ON DELETE NO ACTION, chosen over three alternatives. This is a security
-- decision disguised as a referential one, so the reasoning lives here.
--
-- What the column is: evidence. `A.replaced_by = B` means "session A was
-- rotated away in favour of B". If that value is ever lost, A stops looking
-- like a rotated session and starts looking like an ordinary logout — and an
-- ordinary logout is exactly the case reuse detection is meant to ignore. The
-- loss is silent and it inverts the meaning of the row.
--
--   ON DELETE SET NULL (what this migration originally had) — REJECTED.
--     A DELETE elsewhere in the schema rewrites security evidence in place, with
--     no trace. The first cleanup job anyone writes deletes expired sessions,
--     i.e. the OLDEST rows, which are precisely the ones with the longest
--     exposure and the highest chance of having been stolen. It would erase the
--     strongest evidence first and report success.
--
--   ON DELETE RESTRICT — REJECTED, though it is the right instinct.
--     RESTRICT is checked immediately and fires even when the referencing row is
--     being deleted by the very same statement. sessions.user_id is
--     REFERENCES users(id) ON DELETE CASCADE, so deleting a user cascades into
--     all of that user's sessions in one statement — and RESTRICT would abort
--     it the moment the chain is more than one link long. Same for any bulk
--     cleanup that deletes a whole chain at once. It would make rotated
--     sessions effectively undeletable without a manual pre-step, and a
--     constraint that has to be worked around is a constraint that gets dropped.
--
--   No foreign key at all — REJECTED, but it was close.
--     It does preserve the evidence verbatim, and a dangling pointer is still
--     evidence that rotation happened. But it permits the pointer to name a row
--     that no longer exists with nothing saying so, and it removes the only
--     reason the index below exists. Integrity here is cheap; we can have both.
--
--   ON DELETE NO ACTION — CHOSEN.
--     Same refusal as RESTRICT, but checked at the END of the statement, which
--     is exactly the distinction that matters: delete a whole chain in one
--     statement and it succeeds, because by the time the check runs, nothing
--     points at anything. Delete only part of one and it refuses. The user
--     CASCADE above keeps working unchanged.
--
-- What this means for the cleanup job that does not exist yet — this migration
-- is choosing its rules in advance, so write them down:
--   - deleting expired sessions OLDEST FIRST always works. A is old and points
--     forward at its newer successor B; nothing points at A once its own
--     predecessor is gone.
--   - deleting a newer session while its predecessor survives is REFUSED. That
--     is the case that would have destroyed the evidence, and now the database
--     stops it instead of the code remembering to.
--   - so: delete whole chains, or delete from the oldest end. If the cleanup
--     job hits a foreign key violation here, the job is wrong, not the
--     constraint. Do not "fix" it by switching this back to SET NULL.
ALTER TABLE sessions
  ADD COLUMN replaced_by   uuid REFERENCES sessions(id) ON DELETE NO ACTION,
  ADD COLUMN last_used_at  timestamptz;

COMMENT ON COLUMN sessions.replaced_by IS 'The session that superseded this one during refresh-token rotation. Set together with revoked_at. A token whose session has this set, presented again, is a replay: revoke the whole chain.';
COMMENT ON COLUMN sessions.last_used_at IS 'Last time this refresh token was exchanged. Written on /refresh only, never per request, so it costs one row update per rotation rather than one per API call.';

-- Rotation is two facts about one event, and they must not be able to come
-- apart: a session marked as superseded whose revoked_at is still NULL is a
-- token that was rotated away and still works, which is rotation that does
-- nothing. The database can hold this, so it holds it.
-- NOTE FOR THE BACKEND: set revoked_at and replaced_by in the SAME UPDATE.
--
-- What this constraint CANNOT do, so nobody assumes it does: it cannot stop an
-- UPDATE that clears an already-set replaced_by back to NULL. NULL passes the
-- CHECK trivially, which is the same evidence loss the FK above refuses on the
-- DELETE side, arriving through the UPDATE door instead. A row-level trigger
-- could hold it; that is a deliberate non-goal here, because the fix belongs
-- where the write is (revokeSession() in apps/api/src/services/sessions.ts
-- passes replaced_by unconditionally, so a plain revoke overwrites a rotation
-- link with NULL — WO-001 review finding 8, owned by the backend). This
-- migration's job is to make the column exist and to make the two facts
-- inseparable; keeping a set value set is the caller's job for now.
ALTER TABLE sessions
  ADD CONSTRAINT ck_sessions_replaced_implies_revoked
  CHECK (replaced_by IS NULL OR revoked_at IS NOT NULL);

-- Why this index, specifically.
--
-- It is NOT for the reuse-detection read. That lookup is
--   SELECT ... FROM sessions WHERE jti = $1
-- and then reads revoked_at/replaced_by off the row it already has — served by
-- the existing uq_sessions_jti. No new index needed for it.
--
-- It IS for the foreign key. replaced_by references sessions(id), and
-- PostgreSQL does not index the referencing side of a foreign key. Every DELETE
-- of a session row makes the RI trigger run `WHERE replaced_by = <that id>` to
-- decide whether to refuse; with no index that is a sequential scan of
-- sessions, once per deleted row. Sessions are deleted in bulk in two places:
-- ON DELETE CASCADE when a user row goes, and any expired-session cleanup.
-- Those are exactly the cases where a per-row seq scan turns into O(n^2).
--
-- Note this index is needed MORE under NO ACTION than it would have been under
-- SET NULL, not less: the check still runs on every deleted row, and now it
-- runs at end-of-statement for the whole batch at once.
--
-- Partial because only superseded sessions carry a value; the overwhelming
-- majority of rows are NULL and a NULL can never match the RI probe, so they
-- have no business being in the index. The planner can prove
-- `replaced_by = $1` implies `replaced_by IS NOT NULL`, so the partial index is
-- still used.
--
-- Not indexed, on purpose: last_used_at. Nothing queries by it. An admin
-- "active sessions" list filters by user_id first and is served by the existing
-- idx_sessions_user_live. Add one when a plan shows it is needed, not before.
-- Likewise expires_at: if a cleanup job appears and EXPLAIN shows a seq scan,
-- index it then.
CREATE INDEX idx_sessions_replaced_by ON sessions (replaced_by)
  WHERE replaced_by IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 5. WO-001 item 12, RLS half: ASSESSED AND DEFERRED — do not add it blind
-- -----------------------------------------------------------------------------
-- The work order asks for RLS on users, sessions, shops, shop_memberships and
-- owner_groups. This migration deliberately does NOT add it. The reason, so the
-- next person does not have to rediscover it:
--
-- All five tables are read on the PRE-AUTHENTICATION path, when no shop and no
-- user are known yet, so there is no session variable a policy could key on.
-- From apps/api/src/routes/auth.ts as it stands:
--
--   /login    SELECT ... FROM users WHERE lower(login_id) = $1
--             -- by definition before the identity is established: the row has
--             -- to be read to verify the password against it.
--             then membershipsOf(): shop_memberships JOIN shops, for ALL of the
--             user's shops, to choose one. No shop is active yet.
--   /refresh  SELECT ... FROM sessions WHERE jti = $1, again before any shop or
--             user is known, then membershipsOf() a second time.
--   /me       membershipsOf() must return EVERY shop the user belongs to, or the
--             branch switcher has nothing to switch to.
--
-- CALL apply_tenant_rls('shop_memberships') would make every one of those
-- return zero rows, because app.current_shop_id is unset at that moment. The
-- result at cutover is not a degraded feature. It is nobody can log in, owner
-- included, and the way back in is a superuser psql session. On 1 Nov, in a
-- working garage, that is the worst outcome available.
--
-- THIS IS WHY shop_memberships IS NAMED IN THE `exempt` LIST IN SECTION 3.
-- It is the only table in the schema that carries a shop_id column and has no
-- tenant RLS, so it is the only table check (b) has to be told about. The two
-- places have to be read together: an exemption without this reasoning is a
-- hole, and this reasoning without the exemption is a migration that raises an
-- exception and aborts on every single run. If the deferred work below is ever
-- done, the policy and the exemption come off in the SAME migration.
--
-- A user-keyed policy (`user_id = current_setting('app.current_user_id')`) does
-- not rescue it either: that GUC does not exist yet, nothing sets it, and it
-- could not be set on the login path anyway for the same reason — the user is
-- not known until after users has been read.
--
-- What a correct design needs, as its own change with its own tests:
--   1. a SECURITY DEFINER function for the login lookup, returning only
--      id/password_hash/is_active/name for one login_id, so the one genuinely
--      pre-auth read is a narrow, auditable hole instead of an open table;
--   2. an app.current_user_id GUC set by the same middleware that sets
--      app.current_shop_id, on every authenticated transaction;
--   3. policies keyed on that GUC, plus a shop-scoped read so a manager can
--      list their branch's staff;
--   4. an integration test that logs in from a cold connection pool with no GUC
--      set, before any of it is enabled anywhere.
--
-- None of that can be written blind, in parallel with the API changes, against
-- a machine with no PostgreSQL on it. WO-001 permits items 7-15 to be deferred
-- with a recorded reason; this is the record. The TypeScript half of item 12 —
-- branding ScopedTx / GroupTx / UnscopedTx so unscoped() cannot be handed to a
-- shop-scoped repository — is already done in packages/db/src/client.ts and is
-- what actually closes the reported bug. The RLS half is defence in depth on
-- top of it, and is worth doing properly rather than quickly.
