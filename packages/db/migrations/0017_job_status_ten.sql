-- =============================================================================
-- 0017_job_status_ten.sql — a job has ten statuses; "scheduled" is not one
--
-- WHAT:     Replaces the jobs.status CHECK (jobs_status_check, declared inline in
--           0002) with the same list minus 'scheduled'. Nothing else: no view,
--           no function and no other table changes.
-- WHY:      docs/WORK-ORDERS/DECISION-7-today.md §6 (owner, 24 Sep 2026).
--           นัดมาทำ — an appointment — is a status of a BOOKING, never of a JOB.
--           A car that has not arrived must have no jobs row at all; the
--           booking statuses 'booked' / 'confirmed' ARE the appointment, and
--           nothing is added to bookings for this. Letting "appointment" be a
--           job status is precisely how the prototype made two job rows for one
--           car: the booking turned into a job too early, and when the car
--           really arrived a second job was opened beside it — the duplicate-
--           queue bug CLAUDE.md §5.8 exists to prevent.
--
--           'rejected' and 'carout' STAY, as terminal statuses, and stay
--           DISTINCT: 'rejected' is the customer declining at the quote and
--           feeds the decline-reason report (CLAUDE.md §5.7); 'carout' is the
--           customer taking the car back part-way through. Merging them would
--           corrupt that report. The transitions between the ten statuses live
--           in packages/domain/src/workflow/transitions.ts, not here.
--
--           THE GUARD. If any job still has status 'scheduled', this migration
--           RAISES and the whole file rolls back. It does not guess where those
--           rows belong: each one is a car the prototype believed was coming
--           back, and whether it becomes a booking, a carout, or something else
--           is a data decision, not a schema one. There are none here. The
--           WO-004 production import WILL meet the prototype's scheduled jobs,
--           and deciding their fate belongs to that work order — the import must
--           convert them BEFORE writing rows, and this constraint is what stops
--           it from quietly writing them as-is.
--
--           job_status_history is deliberately NOT constrained. History records
--           what happened; a job that was 'scheduled' in the prototype was
--           scheduled, and an import may keep that row as a fact about the past.
--
--           No view needs replacing: queue_board, job_board_state and
--           attention_items were checked against pg_views and none mentions
--           'scheduled' (job_board_state's on_board excludes carout and rejected
--           and admits everything else, which is unchanged). No function does
--           either (pg_proc checked).
-- ROLLBACK: Runnable in one transaction as postgres (packages/db/README.md,
--           "Rolling back a migration — checklist").
--
--           BEGIN;
--             ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
--             ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
--               'received', 'inspecting', 'quoted', 'approved', 'scheduled',
--               'rejected', 'repairing', 'aligning', 'ready', 'delivered',
--               'carout'));
--             DELETE FROM schema_migrations WHERE filename = '0017_job_status_ten.sql';
--           COMMIT;
--
--           Loses no data: widening a CHECK back only re-admits a value.
--           Roll back the application first — the API and domain from before
--           this change no longer know 'scheduled' is gone, but the ones after
--           it do not know it exists, and a rollback of the database alone
--           leaves code that cannot read a scheduled row it might now find.
-- LOCKS:    ALTER TABLE ... ADD CONSTRAINT CHECK scans jobs once under ACCESS
--           EXCLUSIVE to validate. jobs holds 0 rows here — instant. On a
--           populated table it is one sequential read, and never a failure,
--           because the guard above has already proved no row can violate it.
-- ROWS:     jobs: 0 rows with status 'scheduled' (and 0 rows in total) as this
--           file is written. Nothing is updated or deleted.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The guard — refuse, do not guess
-- -----------------------------------------------------------------------------
DO $$
DECLARE stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM jobs WHERE status = 'scheduled';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '0017_job_status_ten: % job(s) still have status ''scheduled'', which is no longer a job status.', stranded
      USING HINT = 'Decide what each one is (a booking for the return visit, a carout, ...) and convert it BEFORE '
                   'running this migration. That decision belongs to the data import (WO-004), not to the schema. '
                   'Find them with: SELECT id, job_number, shop_id FROM jobs WHERE status = ''scheduled''.';
  END IF;
END
$$;


-- -----------------------------------------------------------------------------
-- 2. The ten statuses
-- -----------------------------------------------------------------------------
-- DROP and re-ADD because a CHECK cannot be altered in place. Same name, so
-- anything that reports on it (and the rollback above) finds it where it was.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
  'received', 'inspecting', 'quoted', 'approved', 'rejected',
  'repairing', 'aligning', 'ready', 'delivered', 'carout'
));
