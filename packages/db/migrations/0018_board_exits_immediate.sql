-- =============================================================================
-- 0018_board_exits_immediate.sql — a job that has ended leaves the boards at once
--
-- WHAT:     CREATE OR REPLACE VIEW job_board_state with the same seven columns
--           in the same order and types; ONLY the on_board expression changes:
--             on_board = status NOT IN ('delivered', 'rejected', 'carout')
--           The Bangkok-calendar-day rule for 'delivered' (0016) is removed.
--           Nothing else: no table, no policy, no function. queue_board is NOT
--           recreated — it filters on job_board_state.on_board by reference,
--           so it follows the new definition as it stands (checked in pg_depend:
--           queue_board is the only view that depends on job_board_state).
-- WHY:      docs/WORK-ORDERS/DECISION-carout.md (owner, 30 Sep 2026), which
--           overrides DECISION-job-status.md §2 (column 4 = ready + delivered),
--           DECISION-7-today.md §6 and UI-SPEC-FIGMA.md (the "ส่งแล้ว" card
--           fading out at the end of the day).
--
--           A job has THREE independent exits — delivered (from ready),
--           rejected (from quoted), carout (from received/inspecting, before
--           any quotation) — and each one takes the card off the /today kanban
--           and the public waiting-room screen THE MOMENT it is pressed.
--           Kanban column 4 is now `ready` only (packages/domain
--           rules/kanban.ts kanbanColumnOf); this view is the same rule written
--           for the database, and both boards read it, so /today and the TV
--           cannot disagree about which cars exist.
--
--           THIS STILL IS NOT A DATE FILTER ON CARS IN THE WORKSHOP
--           (WO-003-ANSWERS.md §a): every car that has not exited stays on the
--           board however long ago it arrived. The one dated predicate this
--           view had is the one being removed.
--
--           An undone delivery (delivered -> ready) puts the car straight back:
--           on_board reads the job's CURRENT status, not a history of it.
-- ROLLBACK: Runnable in one transaction as postgres (packages/db/README.md,
--           "Rolling back a migration — checklist"). Restores 0016's on_board
--           exactly; the rest of the view is unchanged by this file.
--
--           BEGIN;
--             CREATE OR REPLACE VIEW job_board_state WITH (security_invoker = true) AS
--             -- <0016_job_substate_board.sql section 3, the SELECT of
--             --  CREATE VIEW job_board_state, VERBATIM — copy it; do not retype>
--             ;
--             DELETE FROM schema_migrations WHERE filename = '0018_board_exits_immediate.sql';
--           COMMIT;
--
--           Loses no data (a view holds none). Roll back the application
--           first: the domain after this change has no column for 'delivered',
--           so under the old view /api/jobs/today would receive delivered rows
--           it cannot place (it logs and skips them — no crash, but the TV
--           would still show them for the rest of the day).
-- LOCKS:    CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on job_board_state
--           only — never on jobs or job_status_history — for the instant of the
--           catalogue update. Readers of queue_board wait for that instant.
-- ROWS:     None written. jobs: 0 rows on the dev database as this file is
--           written (0 with status carout, 0 delivered).
-- =============================================================================


-- security_invoker restated on purpose: CREATE OR REPLACE VIEW sets the view's
-- options to exactly those given, so leaving it out would turn it off and the
-- view would run as its owner, skipping jobs' RLS (verify-rls.sql check 5).
--
-- Column list, order and types are 0016's, unchanged — CREATE OR REPLACE VIEW
-- refuses anything else, and queue_board / the public board read them by name.
-- The subquery is 0016's, unchanged; see that file for why each time is
-- computed the way it is (it mirrors packages/domain rules/eta.ts).
CREATE OR REPLACE VIEW job_board_state WITH (security_invoker = true) AS
SELECT s.job_id,
       s.shop_id,
       s.status_changed_at,
       s.left_received_at,
       s.repair_started_at,
       s.repair_ended_at,
       -- The board membership rule, written ONCE for both boards. The three
       -- exits (packages/domain EXIT_STATUSES) are off; every other status —
       -- every car still in the workshop — is on, whenever it arrived.
       (s.status NOT IN ('delivered', 'rejected', 'carout')) AS on_board
  FROM (
    SELECT j.id        AS job_id,
           j.shop_id,
           j.status,
           coalesce(
             (SELECT max(h.changed_at) FROM job_status_history h
               WHERE h.job_id = j.id AND h.status = j.status),
             j.created_at)                                    AS status_changed_at,
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
