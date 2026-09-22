-- =============================================================================
-- 0013_queue_board.sql — the queue board reads real cars, not a stale name
--
-- WHAT:     1. jobs.job_date (the Thailand-local day the car was received),
--              backfilled from created_at, with a Bangkok-local default.
--           2. jobs.queue_no text -> integer, unique per (shop_id, job_date).
--           3. Drops jobs.mileage_in (superseded by mileage_in_km, 0010).
--           4. Widens files.kind for check-in photos and their thumbnails.
--           5. Replaces the view queue_today (0011) with queue_board: the
--              jobs half drops its status-only filter's date assumption
--              entirely (a car still in the shop never falls off the board
--              at midnight), the bookings half exposes `at` raw so the API
--              applies the today..+7 window, and both halves gain every
--              column the board screen needs (queue_no, brand, model, color,
--              thumb_file_id, assigned_technician_id, assigned_team_id,
--              job_type).
-- WHY:      docs/WORK-ORDERS/WO-003-ANSWERS.md, sections ก/ค/ง (15 Sep 2026).
--           ก: "queue_today" as a name implies a date filter, and the review
--           that produced these answers found the ORIGINAL work order asked
--           for one. A car checked in yesterday and still mid-repair must
--           stay on the board — the board exists so staff can see "what is
--           in the shop right now", not "what arrived today" — so this
--           migration makes the no-date-filter behaviour the documented,
--           tested contract instead of something that happens to fall out of
--           0011's WHERE clause.
--           ค: queue_no was free text with no uniqueness, so two cars could
--           share a queue number and both answer when it was called out
--           across the shop floor. job_date exists because "the day this
--           queue number belongs to" is a fact entered at check-in (staff can
--           key a job in against an earlier day — same reasoning as
--           warranties.expires_at in 0010, generation from created_at is not
--           enough because created_at is UTC and does not track a
--           deliberately backdated entry), not something derivable from when
--           the row was physically inserted.
--           ง.4: jobs.mileage_in (free text, MySQL era) and mileage_in_km
--           (integer, added in 0010) were two places for the same fact to
--           disagree; 0010 deprecated mileage_in in a comment and this
--           migration finishes the job.
-- ROLLBACK: Runnable in one transaction as the owning role.
--
--           BEGIN;
--             DROP VIEW queue_board;
--
--             ALTER TABLE files DROP CONSTRAINT files_kind_check;
--             ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN (
--               'part_photo', 'signature', 'deposit_slip', 'document_pdf', 'other'));
--
--             -- mileage_in's VALUES ARE NOT RECOVERABLE. Dropping a column
--             -- discards its data and this migration does not archive it
--             -- anywhere first. This ADD COLUMN restores an empty column of
--             -- the right name and type only. If production ever holds a job
--             -- where mileage_in was populated and mileage_in_km was not
--             -- separately backfilled from it before this migration ran, the
--             -- only way back is a restore from a backup taken before this
--             -- migration ran — not this rollback.
--             ALTER TABLE jobs ADD COLUMN mileage_in text;
--
--             ALTER TABLE jobs DROP CONSTRAINT uq_queue_no;
--             ALTER TABLE jobs ALTER COLUMN queue_no TYPE text USING queue_no::text;
--
--             ALTER TABLE jobs ALTER COLUMN job_date DROP NOT NULL;
--             ALTER TABLE jobs ALTER COLUMN job_date DROP DEFAULT;
--             ALTER TABLE jobs DROP COLUMN job_date;
--
--             -- The exact 0011 definition, reproduced verbatim so nobody has
--             -- to go spelunking in git history mid-incident to restore it.
--             CREATE VIEW queue_today WITH (security_invoker = true) AS
--               SELECT b.shop_id,
--                      'booking'::text            AS kind,
--                      b.id                       AS ref_id,
--                      b.bay_id,
--                      b.slot_start               AS at,
--                      b.status,
--                      b.source,
--                      coalesce(c.name, b.contact_name)   AS customer_name,
--                      coalesce(c.phone, b.contact_phone) AS phone,
--                      v.plate,
--                      NULL::uuid                 AS job_id,
--                      b.note
--                FROM bookings b
--                LEFT JOIN customers c ON c.id = b.customer_id
--                LEFT JOIN vehicles  v ON v.id = b.vehicle_id
--               WHERE b.status IN ('booked', 'confirmed')
--                 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.booking_id = b.id)
--               UNION ALL
--               SELECT j.shop_id,
--                      'job'::text                AS kind,
--                      j.id                       AS ref_id,
--                      j.bay_id,
--                      j.created_at               AS at,
--                      j.status,
--                      CASE WHEN j.booking_id IS NULL THEN 'walk_in' ELSE 'booked' END AS source,
--                      c.name                     AS customer_name,
--                      c.phone,
--                      v.plate,
--                      j.id                       AS job_id,
--                      NULL::text                 AS note
--                FROM jobs j
--                LEFT JOIN customers c ON c.id = j.customer_id
--                LEFT JOIN vehicles  v ON v.id = j.vehicle_id
--               WHERE j.status NOT IN ('carout', 'rejected')
--                 AND j.deleted_at IS NULL;
--           COMMIT;
--
-- LOCKS:    ACCESS EXCLUSIVE on jobs for the ADD COLUMN / backfill / TYPE
--           change / ADD CONSTRAINT / DROP COLUMN sequence, and on files for
--           the CHECK swap, and briefly on bookings/jobs/customers/vehicles
--           while the old and new views are dropped/created (view DDL takes
--           ACCESS EXCLUSIVE on the view, not on the underlying tables, so
--           that part is cheap regardless of table size).
--
--           jobs holds 0 rows and files holds 0 rows as this file is written
--           (see ROWS), so every statement below is instant on THIS database.
--           The notes below are for whoever replays this file against a
--           database that already has jobs in it — which will happen, since
--           this is the schema the shop's real intake data lands in next:
--             - ADD COLUMN job_date ... DEFAULT ...   is catalogue-only in
--               PG 11+ (the default is applied on read, not written out) —
--               fast regardless of row count.
--             - UPDATE jobs SET job_date = ...         IS a rewrite: one new
--               row version per existing row that had job_date NULL. Budget
--               real time against row count before running this migration
--               against a populated jobs table.
--             - ALTER COLUMN queue_no TYPE integer USING ...  rewrites the
--               whole table (a type change always does, even with USING).
--               Same caveat as the UPDATE above.
--             - ADD CONSTRAINT uq_queue_no UNIQUE (...)  builds an index over
--               the whole table; on a non-empty jobs this is comparable cost
--               to the type change above, and it is where a genuine data
--               problem (two existing rows already sharing shop_id+job_date+
--               queue_no) will actually surface, as a hard failure with the
--               table listed in the error.
--             - DROP COLUMN mileage_in                  is catalogue-only.
--             - files CHECK swap                        is catalogue-only:
--               the new constraint is not validated against existing rows
--               because it can only ADD allowed values, never remove one, so
--               no existing row can violate it.
--           None of this needs a maintenance window at today's row count.
--           It will, once jobs has real rows in it — plan one then, and read
--           0012's LOCKS section first for how lock_timeout/statement_timeout
--           bound a migration like that.
-- ROWS:     0 rows in jobs, 0 rows in files, 0 rows in bookings as of this
--           migration (npm run db:seed has not been run against this
--           database — packages/db/README.md: seed refuses once any document
--           exists, and none do). Every backfill, conversion and constraint
--           below is real SQL that runs for real against this database, but
--           it touches zero existing rows here. The statements are written to
--           be correct against a populated jobs table too, because this file
--           will be replayed against one.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. jobs.job_date — the Thailand-local day the car was received
-- -----------------------------------------------------------------------------
-- Not a generated column from created_at: created_at is UTC (the shop is
-- UTC+7, CLAUDE.md §11 / 0002's header), so `created_at::date` is the wrong
-- calendar day for anything received in the second half of the Thai day. It
-- also cannot be generated even from `created_at AT TIME ZONE 'Asia/Bangkok'`,
-- because the prototype lets staff key a job in against an earlier day
-- (WO-003-ANSWERS.md ค — "ต้นแบบคีย์ย้อนหลังได้ ต้องรองรับ"), so job_date is a
-- fact entered at check-in, independent of when the row happened to be
-- inserted, the same reasoning 0010 used for warranties.expires_at needing a
-- trigger instead of a generated column.
ALTER TABLE jobs ADD COLUMN job_date date;

-- Backfill BEFORE the NOT NULL — CLAUDE.md §11 and packages/db/README.md: a
-- NOT NULL added ahead of a completed backfill is refused on any table that
-- already has rows. jobs has none today (see ROWS above), so this UPDATE
-- affects 0 rows on this run; it stays real SQL, run for real, because this
-- is the statement that has to be correct the day jobs is not empty.
UPDATE jobs SET job_date = (created_at AT TIME ZONE 'Asia/Bangkok')::date
 WHERE job_date IS NULL;

-- The default is Bangkok-local too, so an INSERT that does not name job_date
-- explicitly still lands on the Thai calendar day, not the UTC one.
ALTER TABLE jobs ALTER COLUMN job_date SET DEFAULT
  ((now() AT TIME ZONE 'Asia/Bangkok')::date);
ALTER TABLE jobs ALTER COLUMN job_date SET NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. jobs.queue_no — text -> integer, unique per (shop, day)
-- -----------------------------------------------------------------------------
-- A bare `ALTER COLUMN queue_no TYPE integer USING queue_no::integer` aborts
-- the ENTIRE migration transaction the moment it reaches one row that is not
-- a clean integer (blank string, 'A1', a stray space, NULL is fine) — and
-- queue_no came from the prototype as free text, so that is not hypothetical.
-- This DO block counts how many existing rows would not survive a clean cast,
-- BEFORE the ALTER runs, and reports it with RAISE NOTICE so a human sees the
-- number in the migration output rather than discovering it silently as a
-- pile of NULLs afterwards. On this database it is 0 (jobs is empty — ROWS).
DO $$
DECLARE unconverted integer;
BEGIN
  SELECT count(*) INTO unconverted
    FROM jobs
   WHERE queue_no IS NOT NULL AND queue_no !~ '^[0-9]+$';
  IF unconverted > 0 THEN
    RAISE NOTICE '0013_queue_board: % job(s) had a non-numeric queue_no and will '
      'become NULL (no queue number) after this migration. Look at them before '
      'relying on the board today: SELECT id, job_number, queue_no FROM jobs '
      'WHERE queue_no IS NOT NULL AND queue_no !~ ''^[0-9]+$''.', unconverted;
  ELSE
    RAISE NOTICE '0013_queue_board: 0 jobs had a non-numeric queue_no.';
  END IF;
END
$$;

-- The guarded conversion itself: anything that is not one-or-more ASCII
-- digits becomes NULL instead of aborting the transaction. NULL here means
-- "no queue number assigned" — exactly the state a job in the 'received'
-- status has before a number is called out, so this is not data loss, it is
-- the honest representation of what free text never actually promised.
ALTER TABLE jobs ALTER COLUMN queue_no TYPE integer USING (
  CASE WHEN queue_no ~ '^[0-9]+$' THEN queue_no::integer END
);

-- NULL is "no number yet", and PostgreSQL UNIQUE treats every NULL as
-- distinct from every other NULL, so any number of jobs may sit at NULL at
-- once — only two REAL numbers colliding on the same (shop, day) is refused.
-- That is exactly the rule from WO-003-ANSWERS.md ค: the database is the
-- thing that stops two cars both answering to "5", not a check in
-- application code that two requests could both pass before either writes.
-- This constraint's own index (shop_id, job_date, queue_no) already serves
-- "what is the highest queue_no today for this shop" via a backward index
-- scan, so no separate supporting index is added — see the LOCKS-adjacent
-- note in the report on confirming this with EXPLAIN against this database.
ALTER TABLE jobs ADD CONSTRAINT uq_queue_no UNIQUE (shop_id, job_date, queue_no);


-- -----------------------------------------------------------------------------
-- 3. Drop the deprecated free-text mileage_in
-- -----------------------------------------------------------------------------
-- mileage_in_km (integer, 0010) is what warranty arithmetic and KPI actually
-- read; mileage_in (free text, MySQL era) has been a second, disagreeing copy
-- of the same fact since 0010 marked it DEPRECATED. The only code anywhere in
-- the repo that still reads or writes mileage_in is apps/api/src/db/jobs.ts
-- and the two route files that import it (apps/api/src/routes/jobs.ts,
-- apps/api/src/routes/public.ts) — all three are MySQL-era holdovers that
-- apps/api/src/app.ts never mounts (app.ts wires up only authRouter,
-- adminRouter and healthRouter). Confirmed dead by grep across apps/ and
-- packages/ on 2026-09-15, not a reason to keep a column two writers could
-- disagree about.
ALTER TABLE jobs DROP COLUMN mileage_in;


-- -----------------------------------------------------------------------------
-- 4. files.kind — room for check-in photos
-- -----------------------------------------------------------------------------
-- Two new kinds, not one: the board card needs a small thumbnail distinct
-- from the full check-in photo, the same split jobs.thumb_file_id / job_photos
-- already makes for repair photos, so a full check-in photo and its board
-- thumbnail have to be told apart by kind rather than by convention (a
-- convention is exactly the kind of rule that survives until someone forgets
-- it). Swapped via DROP/ADD on the real constraint name (files_kind_check,
-- looked up in pg_constraint rather than guessed) because CHECK constraints
-- cannot be ALTERed in place.
ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN (
  'part_photo', 'signature', 'deposit_slip', 'document_pdf', 'other',
  'checkin_photo', 'checkin_thumb'));


-- -----------------------------------------------------------------------------
-- 5. queue_board — the one view the queue screen reads
-- -----------------------------------------------------------------------------
-- Replaces queue_today (0011). Same shape of idea — one UNION ALL so the
-- board can never ask two sources and concatenate them in the browser, which
-- is the bug CLAUDE.md §5.8 and 0011 both describe — corrected per
-- WO-003-ANSWERS.md ก: the jobs half never filters by date at all (a car
-- still in the shop is still in the shop, whatever day it arrived), and the
-- bookings half exposes `at` = slot_start raw so the API applies the
-- today..+7 default window instead of the view guessing a range that would
-- hide next month's bookings one way and hide today's overnight cars the
-- other.
--
-- security_invoker so the base tables' RLS applies to the caller — without it
-- the view runs as its owner and every shop would see every shop
-- (packages/db/README.md).
DROP VIEW queue_today;

CREATE VIEW queue_board WITH (security_invoker = true) AS

  -- Cars expected but not yet here. No date filter here either: the API does
  -- the range filtering (default today..+7), which is why `at` is exposed
  -- raw instead of being pre-filtered in the view.
  SELECT b.shop_id,
         'booking'::text                     AS kind,
         b.id                                 AS ref_id,
         b.bay_id,
         b.slot_start                         AS at,
         b.status,
         b.source,
         coalesce(c.name, b.contact_name)     AS customer_name,
         coalesce(c.phone, b.contact_phone)   AS phone,
         v.plate,
         v.brand,
         v.model,
         v.color,
         NULL::integer                        AS queue_no,
         NULL::uuid                           AS job_id,
         NULL::text                           AS job_type,
         NULL::uuid                           AS thumb_file_id,
         NULL::uuid                           AS assigned_technician_id,
         NULL::uuid                           AS assigned_team_id,
         b.note
    FROM bookings b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN vehicles  v ON v.id = b.vehicle_id
   WHERE b.status IN ('booked', 'confirmed')
     -- The whole point, unchanged from 0011: a booking that has become a job
     -- leaves this list on its own the moment jobs.booking_id is set, with
     -- nobody having to remember to remove anything.
     AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.booking_id = b.id)

  UNION ALL

  -- Cars that are here. Deliberately no date predicate of any kind: "today's
  -- queue" means cars still in the workshop right now, not cars that were
  -- checked in today. A car that came in yesterday and is still mid-repair
  -- must not vanish from the board at midnight — that disappearing-car bug is
  -- the whole reason WO-003-ANSWERS.md ก renamed this view.
  SELECT j.shop_id,
         'job'::text                          AS kind,
         j.id                                  AS ref_id,
         j.bay_id,
         j.created_at                          AS at,
         j.status,
         CASE WHEN j.booking_id IS NULL THEN 'walk_in' ELSE 'booked' END AS source,
         c.name                                AS customer_name,
         c.phone,
         v.plate,
         v.brand,
         v.model,
         v.color,
         j.queue_no,
         j.id                                  AS job_id,
         j.job_type,
         j.thumb_file_id,
         j.assigned_technician_id,
         j.assigned_team_id,
         NULL::text                            AS note
    FROM jobs j
    LEFT JOIN customers c ON c.id = j.customer_id
    LEFT JOIN vehicles  v ON v.id = j.vehicle_id
   -- 'carout' is the car leaving; 'rejected' is the customer declining
   -- everything. Neither belongs on the board any more, at any date.
   WHERE j.status NOT IN ('carout', 'rejected')
     AND j.deleted_at IS NULL;

-- No new index added for this view. idx_jobs_status (shop_id, status) WHERE
-- deleted_at IS NULL and idx_bookings_pending (shop_id, slot_start) WHERE
-- status IN ('booked','confirmed') — both already in place, from 0002 and
-- 0008 respectively — already carry exactly the predicates this view filters
-- on. Confirmed with EXPLAIN against this database rather than assumed; see
-- the migration report for the actual plans. CLAUDE.md §11: index what a
-- query actually needs, measured, not guessed.


-- =============================================================================
-- ROLLBACK — see the ROLLBACK section in the header comment above for the
-- runnable SQL. Summary: DROP VIEW queue_board, restore files_kind_check to
-- its five original values, re-add mileage_in as an EMPTY text column (its
-- prior values are not recoverable from this rollback — see the header),
-- drop uq_queue_no and cast queue_no back to text, drop job_date, and
-- recreate queue_today verbatim from 0011.
-- =============================================================================
