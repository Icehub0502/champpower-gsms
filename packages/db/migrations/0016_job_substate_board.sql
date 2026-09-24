-- =============================================================================
-- 0016_job_substate_board.sql — the kanban's sub-states, the public board's
--                                token, and the timing both boards read
--
-- WHAT:     1. jobs.sub_state — a nullable enum of the seven card labels that
--              are real, countable states (DECISION-job-status.md §4).
--           2. shops.public_board_token — an unguessable handle for the
--              unauthenticated waiting-room screen, backfilled for every shop
--              and DEFAULTed for every shop created from now on.
--           3. New view job_board_state — per job: when it entered its current
--              status, when it first left 'received', the current repair
--              window, and whether it belongs on a board at all.
--           4. queue_board replaced, keeping its 20 columns in order and
--              appending nine; its jobs half now reads on_board from (3).
-- WHY:      docs/WORK-ORDERS/DECISION-job-status.md (22 Sep 2026) and
--           docs/UI-SPEC-FIGMA.md §2: two screens over one set of jobs — the
--           authenticated /today kanban and the public /board.
--
--           (1) The owner's question is "how many cars are stuck waiting for
--           parts right now". Free text can never answer it; an enum can. Only
--           the VALUE LIST is a constraint here. Which (status, sub_state)
--           pairs make sense is isValidSubState() in packages/domain — a
--           business judgement that must be changeable without a migration.
--
--           (2) CLAUDE.md §8 rule 7: a public page names its shop with a token
--           nobody can guess, never an id or a slug a person chose. The column
--           carries a DEFAULT on purpose. seed_document_series() lived in one
--           script and every shop created any other way could not open a job
--           (that is what 0014 had to clean up); a token that existed only for
--           shops present when this file ran would repeat that defect, and a
--           shop without a token has no public board. The DEFAULT makes every
--           creation path correct without anyone having to remember.
--
--           (3)+(4) Two corrections the kanban exposed in 0013's view:
--
--           DELIVERED CARS NEVER LEFT THE BOARD. 0013's jobs half excluded
--           only 'carout' and 'rejected'. 'delivered' is the terminal status
--           of MAIN_PATH — nothing ever moves a job on from it — so every car
--           the shop has ever handed back would have stacked up in kanban
--           column 4 forever, and the public screen would list last year's
--           customers. on_board keeps a delivered car for the Bangkok calendar
--           day it was delivered (the public screen fades it out) and drops it
--           after.
--
--           THIS IS NOT A DATE FILTER ON CARS IN THE WORKSHOP, and must never
--           become one. WO-003-ANSWERS.md §a stands exactly as written: a car
--           that arrived yesterday and is still on a lift stays on the board
--           at midnight. The only rows the date touches are cars that have
--           already been driven away.
--
--           THE SLA CLOCK NEEDS TIMES THE VIEW DID NOT HAVE. The countdown in
--           packages/domain/src/rules/eta.ts runs from the LAST 'repairing'
--           to the first finish after it. /api/jobs/today reads queue_board
--           and nothing else (CLAUDE.md §5.8 rule 4), so the times it needs
--           have to be in the view. job_board_state computes them once, and
--           both queue_board and the public board read that one definition, so
--           the two screens cannot disagree about when a job started or
--           whether it belongs on a board.
--
--           job_board_state carries NO personal data — ids and timestamps
--           only — which is what lets the public board read it without going
--           anywhere near queue_board's customer_name and phone.
-- ROLLBACK: Runnable in one transaction as the owning role.
--
--           BEGIN;
--             -- queue_board cannot shed columns through CREATE OR REPLACE, so
--             -- it is dropped and recreated from 0013_queue_board.sql section
--             -- 5 VERBATIM (copy that CREATE VIEW block; do not retype it).
--             DROP VIEW queue_board;
--             -- <0013 CREATE VIEW queue_board ... here>
--             DROP VIEW job_board_state;
--             ALTER TABLE shops DROP CONSTRAINT uq_shops_public_board_token;
--             ALTER TABLE shops DROP COLUMN public_board_token;
--             ALTER TABLE jobs DROP COLUMN sub_state;
--           COMMIT;
--
--           Data lost on rollback: every jobs.sub_state value (the labels
--           staff set on cards), and every public_board_token. Losing the
--           tokens breaks every waiting-room screen URL already set up on a
--           TV; running this migration again issues NEW tokens, so each shop's
--           screen has to be re-pointed. Export both columns first if the
--           shops are live.
-- LOCKS:    ALTER TABLE jobs ADD COLUMN sub_state (no default) is catalogue-
--           only. The CHECK is added as a normal validated constraint, which
--           scans jobs once under ACCESS EXCLUSIVE; every existing row has a
--           NULL sub_state, which passes, so on a populated table this is a
--           read of every row but never a failure.
--           ALTER TABLE shops ADD COLUMN ... DEFAULT <volatile> REWRITES shops
--           — a volatile default is evaluated per row, which is exactly what
--           gives each shop a distinct token. shops holds 6 rows; instant.
--           The UNIQUE constraint builds an index over those 6 rows.
--           CREATE VIEW / CREATE OR REPLACE VIEW take ACCESS EXCLUSIVE on the
--           view only, never on the tables underneath.
-- ROWS:     jobs: 0 rows, so the new column and CHECK touch nothing.
--           shops: 6 rows, each receiving one generated token.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. jobs.sub_state
-- -----------------------------------------------------------------------------
-- The seven values from DECISION-job-status.md §4, and only those. Display
-- text lives in packages/domain (SUB_STATE_LABEL), not here: the database
-- stores what a card IS, the domain decides what it SAYS.
ALTER TABLE jobs ADD COLUMN sub_state text;
ALTER TABLE jobs ADD CONSTRAINT ck_jobs_sub_state CHECK (sub_state IN (
  'waiting_customer',   -- รอลูกค้า
  'call_customer',      -- ต้องโทร
  'quote_sent',         -- ส่งราคาแล้ว  (NOT "ส่งแล้ว" — that is the delivered status)
  'waiting_parts',      -- กำลังรออะไหล่
  'waiting_qc',         -- รอตรวจ QC
  'waiting_wash',       -- รอล้างรถ
  'paid'                -- ชำระแล้ว
));
-- Deliberately NOT here: any rule tying a sub_state to a status. See the WHY
-- block above and isValidSubState() in packages/domain/src/rules/kanban.ts.


-- -----------------------------------------------------------------------------
-- 2. shops.public_board_token
-- -----------------------------------------------------------------------------
-- 32 random bytes from pgcrypto, base64url without padding: 43 characters,
-- 256 bits. Unguessable, and safe to put in a URL path without escaping.
--
-- ADD COLUMN with a VOLATILE default evaluates the expression once per
-- existing row, so this single statement is also the backfill — every shop
-- that exists now gets its own token, and every shop inserted later gets one
-- from the same DEFAULT.
ALTER TABLE shops ADD COLUMN public_board_token text NOT NULL
  DEFAULT rtrim(translate(encode(gen_random_bytes(32), 'base64'), '+/', '-_'), '=');

-- Unique, because a collision would show one shop's cars on another shop's
-- television. At 256 bits a collision will not happen by chance; the
-- constraint is here so that if a token is ever SET by hand (rotation, a
-- restore), a duplicate is refused rather than silently shared.
ALTER TABLE shops ADD CONSTRAINT uq_shops_public_board_token UNIQUE (public_board_token);
-- shops has no shop_id and no RLS (it is an identity table, like users). The
-- token is resolved there, unauthenticated, before any shop scope exists —
-- which is correct and is why the public route reads shops through unscoped()
-- and everything after it through withShop().


-- -----------------------------------------------------------------------------
-- 3. job_board_state — timing, and "does this job belong on a board"
-- -----------------------------------------------------------------------------
-- security_invoker so jobs' and job_status_history's RLS apply to the caller
-- (packages/db/README.md; verify-rls.sql check 5).
--
-- The status lists below MIRROR packages/domain/src/rules/eta.ts:
--   repair start = the LAST 'repairing' entry          (repairCycle, startIdx)
--   repair end   = the first of WORK_DONE_STATUSES      (ready, delivered,
--                  after that start                      carout)
-- If eta.ts's WORK_DONE_STATUSES changes, this view must change with it. The
-- one rule NOT mirrored here is eta.ts's "a job back in a pre-repair status has
-- no clock at all": that stays in TypeScript, where repairCycle() applies it
-- to whatever times this view hands over. One home per rule.
--
-- Every subquery is served by idx_status_history_job (job_id, changed_at).
CREATE VIEW job_board_state WITH (security_invoker = true) AS
SELECT s.job_id,
       s.shop_id,
       s.status_changed_at,
       s.left_received_at,
       s.repair_started_at,
       s.repair_ended_at,
       -- The board membership rule, written ONCE. queue_board's jobs half and
       -- the public board both filter on this column, so the kanban and the
       -- waiting-room screen can never disagree about which cars exist.
       --
       -- 'carout' and 'rejected' are gone (unchanged from 0011/0013).
       -- 'delivered' stays only on the Bangkok calendar day it happened.
       -- Everything else — every car still in the workshop — stays, however
       -- long ago it arrived.
       (s.status NOT IN ('carout', 'rejected')
        AND (s.status <> 'delivered'
             OR (s.status_changed_at AT TIME ZONE 'Asia/Bangkok')::date
                = (now() AT TIME ZONE 'Asia/Bangkok')::date)) AS on_board
  FROM (
    SELECT j.id        AS job_id,
           j.shop_id,
           j.status,
           -- When the job entered the status it is in NOW: the latest history
           -- row for that status. A job that went quoted -> approved -> quoted
           -- has been in 'quoted' since the SECOND time, which is what the
           -- card's "waiting N minutes" has to count from. Falls back to
           -- created_at, because opening a job writes no history row.
           coalesce(
             (SELECT max(h.changed_at) FROM job_status_history h
               WHERE h.job_id = j.id AND h.status = j.status),
             j.created_at)                                    AS status_changed_at,
           -- The first time the car moved on from 'received' — the end of the
           -- wait for inspection. NULL while it is still waiting.
           (SELECT min(h.changed_at) FROM job_status_history h
             WHERE h.job_id = j.id AND h.status <> 'received') AS left_received_at,
           r.repair_started_at,
           (SELECT min(h.changed_at) FROM job_status_history h
             WHERE h.job_id = j.id
               AND h.status IN ('ready', 'delivered', 'carout')
               AND h.changed_at > r.repair_started_at)          AS repair_ended_at
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT max(h.changed_at) AS repair_started_at
          FROM job_status_history h
         WHERE h.job_id = j.id AND h.status = 'repairing'
      ) r ON true
     WHERE j.deleted_at IS NULL
  ) s;


-- -----------------------------------------------------------------------------
-- 4. queue_board — same 20 columns, same order, nine appended
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW can only APPEND columns: the first twenty are 0013's,
-- byte-for-byte in name, order and type, because /api/queue and anything else
-- reading them positionally must not notice. The bookings half is unchanged
-- apart from typed NULLs for the new columns.
CREATE OR REPLACE VIEW queue_board WITH (security_invoker = true) AS

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
         b.note,
         -- ---- appended in 0016 ----
         NULL::text                           AS job_number,
         NULL::text                           AS sub_state,
         NULL::timestamptz                    AS booking_slot_start,
         NULL::numeric                        AS est_value,
         NULL::text                           AS est_unit,
         NULL::timestamptz                    AS status_changed_at,
         NULL::timestamptz                    AS left_received_at,
         NULL::timestamptz                    AS repair_started_at,
         NULL::timestamptz                    AS repair_ended_at
    FROM bookings b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN vehicles  v ON v.id = b.vehicle_id
   WHERE b.status IN ('booked', 'confirmed')
     -- Unchanged from 0011/0013: a booking that has become a job leaves this
     -- list the moment jobs.booking_id is set, with nobody deleting anything.
     AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.booking_id = b.id)

  UNION ALL

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
         NULL::text                            AS note,
         -- ---- appended in 0016 ----
         j.job_number,
         j.sub_state,
         -- The "นัด HH:MM" card label: the slot the car was booked for, when
         -- it came through a booking. NULL for a walk-in.
         bk.slot_start                         AS booking_slot_start,
         j.est_value,
         j.est_unit,
         t.status_changed_at,
         t.left_received_at,
         t.repair_started_at,
         t.repair_ended_at
    FROM jobs j
    JOIN job_board_state t ON t.job_id = j.id
    LEFT JOIN customers c  ON c.id = j.customer_id
    LEFT JOIN vehicles  v  ON v.id = j.vehicle_id
    LEFT JOIN bookings  bk ON bk.id = j.booking_id
   -- The single board-membership rule from job_board_state. NO other date
   -- predicate belongs here — see the WHY block at the top of this file.
   WHERE t.on_board
     AND j.deleted_at IS NULL;


-- =============================================================================
-- ROLLBACK — see the header.
-- =============================================================================
