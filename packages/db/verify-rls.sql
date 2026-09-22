-- packages/db/verify-rls.sql
--
-- WHEN TO RUN: after applying any migration that touches an RLS policy
-- (CREATE POLICY / DROP POLICY / apply_tenant_rls / ALTER TABLE ... ROW LEVEL
-- SECURITY on any table). Run it again after a rollback of such a migration.
-- It is read-only — safe to run against a live database.
--
--   psql -U postgres -d gsms -f packages/db/verify-rls.sql
--
-- Connect as postgres (or another role that can read pg_policy/pg_class for
-- every table) so the query itself is not blocked by RLS. This script checks
-- the policies, it does not test them as gsms_app would experience them —
-- that is what apps/api/src/lib/rls.integration.test.ts is for.
--
-- English only, on purpose: a Thai string in \echo hits the console's WIN874
-- codepage against this file's UTF-8 encoding and prints garbage or errors,
-- depending on the terminal. Keep every \echo and comment in this file
-- English even when everything else in the repo is Thai.
--
-- CORRECT RESULT — every check below must come back empty (0 rows) except
-- check 1, which must show exactly four rows: SELECT, INSERT, UPDATE, DELETE,
-- each with the SAME table count (56 as of migration 0015, which added the
-- tenant table match_blocklist; update this number in this comment, and
-- nowhere else, the next time a migration adds
-- or removes a tenant table). Any row under any other check, or a row naming
-- 'ALL' / 'NOT CONVERTED' under check 1, means a table can be read or
-- written across shop boundaries. Stop and fix it before doing anything else
-- with this database — do not deploy on top of a red result here.
--
-- This file replaces verify-0012.sql and verify2.sql, which were ad-hoc
-- scratch queries written while migration 0012 was under review and covered
-- overlapping ground. Check 1 below is their shared "policies per command"
-- query, kept once rather than twice.

\echo '=== 1. Policies per command (expect exactly 4 rows: SELECT/INSERT/UPDATE/DELETE, same table count each) ==='
SELECT CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                     WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                     WHEN '*' THEN '*** ALL - NOT CONVERTED ***' END AS command,
       count(*) AS tables
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 GROUP BY p.polcmd ORDER BY 1;

\echo ''
\echo '=== 2. Tables whose DELETE/UPDATE/INSERT policy still allows cross-shop access (expect 0 rows) ==='
SELECT c.relname AS table_name,
       pg_get_expr(p.polqual, p.polrelid) AS using_clause
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND p.polcmd IN ('d','w','a','*')
   AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_shop_ids%'
 ORDER BY 1;

\echo ''
\echo '=== 3. Tables with a shop_id column but no RLS policy at all (an open cross-shop hole; expect 0 rows) ==='
-- shop_memberships is excluded on purpose, not because it is safe to ignore:
-- it is read on the pre-authentication path (login, refresh) before any shop
-- is known, so RLS there would lock everyone out, owner included. This is
-- the SAME exemption migration 0012 section 3 applies, for the SAME reason
-- recorded in section 5, and in docs/WORK-ORDERS/WO-002-identity-rls-DEFERRED.md.
-- If that exemption is ever lifted, remove it here in the same commit that
-- removes it from 0012 — an exemption in only one of the two places is a
-- hole (if only here) or a permanently red check (if only in 0012).
SELECT c.relname AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'shop_id' AND a.attnum > 0
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname NOT IN ('shop_memberships')
   AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
 ORDER BY 1;

\echo ''
\echo '=== 4. Tables with RLS enabled but not FORCED (the table owner could bypass it; expect 0 rows) ==='
SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
   AND NOT c.relforcerowsecurity
 ORDER BY 1;

\echo ''
\echo '=== 5. Views without security_invoker set (they would bypass the RLS of the tables underneath; expect 0 rows) ==='
SELECT c.relname AS view_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'v'
   AND coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                  WHERE option_name = 'security_invoker'), 'false') <> 'true'
 ORDER BY 1;

\echo ''
\echo '=== 6. Tables not carrying exactly the four split policies tenant_delete/tenant_insert/tenant_select/tenant_update (expect 0 rows) ==='
SELECT c.relname AS table_name,
       string_agg(p.polname, ', ' ORDER BY p.polname) AS policies
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 GROUP BY c.relname
HAVING string_agg(p.polname, ',' ORDER BY p.polname)
       <> 'tenant_delete,tenant_insert,tenant_select,tenant_update'
 ORDER BY 1;
