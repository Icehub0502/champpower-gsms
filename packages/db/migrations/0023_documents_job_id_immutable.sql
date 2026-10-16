-- =============================================================================
-- 0023_documents_job_id_immutable.sql
--
-- WHAT:     BEFORE UPDATE trigger on documents: job_id may change only from NULL
--           to a value, once, on a draft. Every other change is refused.
-- WHY:      DECISION-2026-10-14 s2: the unlocked read-then-lock pattern in
--           CLAUDE.md 4.x is only safe if documents.job_id cannot change.
--           0022 returns NEW unchecked for drafts, so a draft's job_id could
--           be rewritten. The one intended change is CLAUDE.md 5.8.5 (draft
--           made at booking time with job_id NULL, attached once on arrival).
--           Issued/signed/void/superseded are already refused by
--           documents_are_immutable() (job_id is outside every allow-list);
--           this trigger is what closes the draft case.
--           Reuses SQLSTATE GS002 (table 'documents', HINT
--           'document_job_id_immutable'); no new code, so no s9.1 entry needed.
--           NOT covered here: a job from another shop. documents.job_id is a
--           plain FK to jobs(id), and FK checks bypass RLS; a composite
--           (shop_id, job_id) FK belongs in 0024, before the 5.8.5 attach code.
-- ROWS:     0 rows read or changed. Not validated against existing data.
-- ROLLBACK: (psql -v ON_ERROR_STOP=1 --single-transaction, as postgres; see
--           packages/db/README.md "Rolling back a migration")
--             DROP TRIGGER trg_documents_job_id_immutable ON documents;
--             DROP FUNCTION documents_job_id_immutable();
--             DELETE FROM schema_migrations
--              WHERE filename = '0023_documents_job_id_immutable.sql';
--           Loses no data; reopens the draft job_id hole.
-- LOCKS:    CREATE TRIGGER takes SHARE ROW EXCLUSIVE on documents (blocks
--           writes, not reads) for milliseconds, after in-flight writers finish.
--           No rewrite. Run outside shop hours.
-- ORDER:    Fires after trg_documents_immutable and before trg_documents_updated
--           (name order). Do not rename it to sort earlier than trg_documents_immutable.
-- =============================================================================
CREATE OR REPLACE FUNCTION documents_job_id_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     AND NOT (OLD.job_id IS NULL AND NEW.job_id IS NOT NULL AND OLD.status = 'draft') THEN
    -- OLD.id, not OLD.number: a draft has no number.
    RAISE EXCEPTION 'document % job_id cannot be changed', OLD.id
      USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_job_id_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_job_id_immutable BEFORE UPDATE ON documents
  FOR EACH ROW WHEN (OLD.job_id IS DISTINCT FROM NEW.job_id)
  EXECUTE FUNCTION documents_job_id_immutable();
