-- =============================================================================
-- 0022_quote_freeze.sql — the quotation freezes at "confirm customer result"
--
-- WHAT:     1. Replaces documents_are_immutable() (0004, replaced by 0011) with a
--              state machine that knows the P3.1 lifecycle:
--                draft      everything editable
--                issued     line CONTENT locked; only the customer's per-line
--                           decisions, documents.approved_total / discount,
--                           and the exits (-> signed, -> void, -> superseded)
--                signed     frozen; only back to issued (undo confirm),
--                           -> superseded, or -> void
--                superseded / void   nothing, ever
--           2. Adds document_lines_are_immutable() on document_lines for
--              INSERT / UPDATE / DELETE, keyed on the PARENT document's status.
--           3. Adds documents_cannot_be_deleted(): only a draft (no number)
--              may be deleted, and documents_insert_as_draft(): a document
--              may only be INSERTed as a draft.
--
-- WHY:      Until now only the document row was guarded. Its lines were not, so
--           a UPDATE document_lines SET unit_price = ... on a numbered, even
--           signed, quotation succeeded: the paper in the customer's hand and
--           the system could disagree with nothing in the way (CLAUDE.md §5 rule
--           1, §5.1 rule 4). Per-line approval also needs a precise answer to
--           "what may still change on an issued quotation?" — exactly the
--           decision columns, nothing else — and that answer belongs in the
--           database, not in every code path that might one day touch the table.
--
--           Violations raise SQLSTATE GS002 (registered in CLAUDE.md §9.1 as
--           "document line immutable"). The same code is used for the
--           document-level refusals too; TABLE ('documents' | 'document_lines')
--           and HINT tell the two apart so the API can map on err.code and
--           err.table and never on err.message. Not inventing a second code
--           here: the register in CLAUDE.md may only be edited by the owner, and
--           "a frozen document refused a change" is one condition, not two.
--
--           WHY THE STATUS IS STILL NAMED `signed`:
--           There is no customer signature on a quotation any more. `signed` now
--           means "the customer's per-line decisions have been confirmed and the
--           quotation is frozen" (the "ยืนยันผลลูกค้า" button). The name stays on
--           purpose: it is spelled out in documents_status_check (0011) and in
--           the predicate of uq_live_quotation_per_job (0011), and a rename would
--           have to change the CHECK, that partial unique index, every row, and
--           every deployed client in one step — risk with no behavioural gain.
--           Read `signed` as "confirmed". The columns signature_file_id and
--           signed_at keep their names for the same reason; signed_at is the
--           confirm timestamp.
--
--           DESIGN NOTE — allow-list by JSON diff, not by column list:
--           each branch computes which columns MAY change, removes them from
--           both rows with to_jsonb(...) - text[], and refuses if what remains
--           differs. A column added by a later migration is therefore frozen by
--           default; it must be added to an allow-list on purpose. updated_at is
--           always ignored (set_updated_at() rewrites it after this trigger).
--
-- ROLLBACK: Restores 0011's documents_are_immutable() verbatim and removes
--           everything this file added. Follow packages/db/README.md "Rolling
--           back a migration" (backup first; psql --single-transaction; delete
--           the schema_migrations row in the same transaction). The statements:
--
--             DROP TRIGGER trg_documents_insert_draft ON documents;
--             DROP FUNCTION documents_insert_as_draft();
--             DROP TRIGGER trg_documents_no_delete ON documents;
--             DROP FUNCTION documents_cannot_be_deleted();
--             DROP TRIGGER trg_document_lines_immutable ON document_lines;
--             DROP FUNCTION document_lines_are_immutable();
--             CREATE OR REPLACE FUNCTION documents_are_immutable() RETURNS trigger AS $r$
--             BEGIN
--               IF OLD.status IN ('signed', 'issued') THEN
--                 IF NEW.status IN ('void', 'superseded')
--                    AND NEW.type = OLD.type
--                    AND NEW.number = OLD.number
--                    AND NEW.grand_total = OLD.grand_total THEN
--                   RETURN NEW;
--                 END IF;
--                 RAISE EXCEPTION 'document % is % and cannot be modified', OLD.number, OLD.status;
--               END IF;
--               IF OLD.status IN ('superseded', 'void') THEN
--                 RAISE EXCEPTION 'document % is % and is closed to further change', OLD.number, OLD.status;
--               END IF;
--               RETURN NEW;
--             END;
--             $r$ LANGUAGE plpgsql;
--
--           Rolling back REOPENS the hole (lines of numbered documents become
--           editable again, and a signed quotation can no longer be moved back to
--           issued). Data lost on rollback: none — no table or column is added.
-- LOCKS:    CREATE FUNCTION / CREATE TRIGGER take SHARE ROW EXCLUSIVE on
--           document_lines and documents briefly (blocks writes, not reads, for
--           milliseconds). No table rewrite, no data touched.
--           RUNTIME LOCK: document_lines_are_immutable() reads its parent with
--           SELECT ... FOR SHARE, so a line write waits for any in-flight update
--           of that one document, and a document status change waits for any
--           in-flight line write. That ordering is what makes "confirm" and "a
--           late decision" unable to both succeed; see the function.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Ordering guard — this file must never run before 0021
-- -----------------------------------------------------------------------------
-- The runner does not enforce order. 0022's allow-lists name columns that 0021
-- creates (approved_amount, decided_by, parent_line_id); applied first, the
-- triggers would be live with nothing for them to allow. The whole file is one
-- transaction, so this RAISE leaves the database exactly as it was.
DO $guard$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(ARRAY['approved_amount', 'decided_by', 'parent_line_id']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'document_lines' AND column_name = c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      '0022_quote_freeze requires 0021_quote_lines first: document_lines is missing column(s) %',
      missing;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- documents_are_immutable()
-- -----------------------------------------------------------------------------
-- Branch map against 0011 (every 0011 branch is kept; see the comment on each):
--   0011 b1  OLD in (signed, issued) and NEW in (void, superseded) with type,
--            number, grand_total unchanged            -> KEPT, tightened: now
--            EVERY column other than the transition's own is frozen
--   0011 b2  OLD in (signed, issued) otherwise        -> KEPT (raise), except
--            the new permitted transitions listed below
--   0011 b3  OLD in (superseded, void)                -> KEPT (raise, always)
--   0011 b4  OLD draft                                -> KEPT (RETURN NEW), except
--            that draft -> signed directly is now refused
CREATE OR REPLACE FUNCTION documents_are_immutable() RETURNS trigger AS $$
DECLARE
  v_allowed text[];
  v_old     jsonb := to_jsonb(OLD) - 'updated_at';
  v_new     jsonb := to_jsonb(NEW) - 'updated_at';
BEGIN
  -- 0011 b3. A superseded or void document is history. Not even a no-op update.
  IF OLD.status IN ('superseded', 'void') THEN
    RAISE EXCEPTION 'document % is % and is closed to further change',
        OLD.number, OLD.status
      USING ERRCODE = 'GS002', TABLE = 'documents',
            HINT = 'document_closed';
  END IF;

  -- 0011 b4. A draft carries no number and is not an official document.
  -- NEW: but it cannot jump straight to 'signed'. A document passes through
  -- 'issued' (number allocated, lines locked, decisions recorded) before it can
  -- be confirmed; skipping that would freeze a quotation nobody ever decided.
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'signed' THEN
      RAISE EXCEPTION 'draft document must be issued before it can be signed'
        USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_draft_to_signed';
    END IF;
    RETURN NEW;
  END IF;

  -- From here OLD.status is 'issued' or 'signed' (the CHECK admits no others).
  -- v_allowed = the columns this particular transition may change.

  IF OLD.status = 'issued' THEN

    IF NEW.status = 'issued' THEN
      -- NEW: recording decisions moves the approved total, and the confirm step
      -- may adjust the discount (D11). Quotations only: a work order or receipt
      -- that has been issued changes nothing at all (0011 b2).
      IF OLD.type <> 'quotation' THEN
        RAISE EXCEPTION 'document % is issued and cannot be modified', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_issued';
      END IF;
      v_allowed := ARRAY['approved_total', 'discount'];

    ELSIF NEW.status = 'signed' THEN
      -- NEW: issued -> signed, "ยืนยันผลลูกค้า". Same two adjustable columns
      -- (the adjustments and the transition land in one UPDATE) plus the
      -- transition's own columns. The API checks every top-level line is decided.
      -- grand_total, vat_base, vat_amount and vat_absorbed deliberately stay the
      -- OFFERED figures frozen at issue: the document carries two totals
      -- (CLAUDE.md §5.1 rule 3), offered_total/grand_total as offered and
      -- approved_total as accepted, and the confirm-time discount adjustment
      -- moves only discount and approved_total.
      IF OLD.type <> 'quotation' OR NEW.signed_at IS NULL THEN
        RAISE EXCEPTION 'document % cannot be confirmed', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_confirm_invalid';
      END IF;
      v_allowed := ARRAY['approved_total', 'discount', 'status', 'signed_at'];

    ELSIF NEW.status = 'void' THEN
      -- 0011 b1 (void leg). Voiding changes the void columns and nothing else.
      -- This is the one path the system's "closed by job" (void_reason =
      -- 'job_closed', voided_by NULL) and the owner's manual void share; who may
      -- do which is decided by the API, not here. Content, number and totals
      -- are all frozen, so closing never edits what the customer was shown.
      v_allowed := ARRAY['status', 'void_reason', 'voided_at', 'voided_by'];

    ELSIF NEW.status = 'superseded' THEN
      -- 0011 b1 (superseded leg). Marks history; edits nothing.
      v_allowed := ARRAY['status'];

    ELSE
      RAISE EXCEPTION 'document % is issued and cannot become %', OLD.number, NEW.status
        USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_transition_invalid';
    END IF;

  ELSE  -- OLD.status = 'signed'

    IF NEW.status = 'issued' THEN
      -- NEW: undo confirm. Status and signed_at revert; NOTHING else may move —
      -- not the totals, not the discount, not the number. "Same Bangkok day" and
      -- "job still approved" are conditions of the business, checked by the API.
      IF OLD.type <> 'quotation' OR NEW.signed_at IS NOT NULL THEN
        RAISE EXCEPTION 'document % cannot be un-confirmed this way', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_unconfirm_invalid';
      END IF;
      v_allowed := ARRAY['status', 'signed_at'];

    ELSIF NEW.status = 'superseded' THEN
      -- 0011 b1 (superseded leg): a new revision replaces the confirmed one.
      v_allowed := ARRAY['status'];

    ELSIF NEW.status = 'void' THEN
      -- 0011 b1 (void leg). Kept as 0011 had it: a confirmed document can still
      -- be voided deliberately (owner only, in the API). The system's
      -- job-closed close never touches a signed quotation (Q1) — that is API
      -- behaviour, and this trigger would allow it only with the same
      -- void-columns-only restriction.
      v_allowed := ARRAY['status', 'void_reason', 'voided_at', 'voided_by'];

    ELSE
      -- 0011 b2: signed -> signed (any edit, even a no-op) is refused.
      RAISE EXCEPTION 'document % is signed and cannot be modified', OLD.number
        USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_signed';
    END IF;

  END IF;

  -- Everything outside the allow-list must be byte-identical.
  IF (v_new - v_allowed) IS DISTINCT FROM (v_old - v_allowed) THEN
    RAISE EXCEPTION 'document % is % and only % may change in this transition',
        OLD.number, OLD.status, array_to_string(v_allowed, ', ')
      USING ERRCODE = 'GS002', TABLE = 'documents',
            HINT = 'document_frozen_columns';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- A numbered document can never be deleted
-- -----------------------------------------------------------------------------
-- document_lines.document_id is ON DELETE CASCADE (0004). Without this, a
-- DELETE on an issued quotation would cascade into its lines and the line
-- trigger below would see no parent and (rightly, for a cascade) let it go. The
-- guard belongs on the parent: only a draft, which has no number, may go.
-- gsms_app holds DELETE on documents (setup-role.sql), so this is not academic.
CREATE OR REPLACE FUNCTION documents_cannot_be_deleted() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'document % is % and cannot be deleted; void it instead',
        OLD.number, OLD.status
      USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_delete';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_no_delete BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_cannot_be_deleted();


-- -----------------------------------------------------------------------------
-- A document is only ever INSERTed as a draft
-- -----------------------------------------------------------------------------
-- documents_are_immutable() fires on UPDATE only, so without this a row could be
-- born 'signed' (or issued) and skip every transition above: no decisions, no
-- line lock, no ordered number. Every other status must arrive by UPDATE.
-- A grep of apps/api, packages and the test fixtures found no INSERT INTO
-- documents with a non-draft status when this was written (the only one is the
-- freeze test's helper, which inserts a draft).
CREATE OR REPLACE FUNCTION documents_insert_as_draft() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'a document must be created as a draft, not %', NEW.status
      USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_insert_not_draft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_insert_draft BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_insert_as_draft();


-- -----------------------------------------------------------------------------
-- document_lines_are_immutable()
-- -----------------------------------------------------------------------------
-- Rules by the PARENT document's status:
--   draft                   anything (but a line never moves to another document)
--   issued (a quotation)    UPDATE only, and only the customer-decision columns
--                           (approval_status, decided_at, decided_by,
--                           decline_reason, decline_note) and approved_amount
--                           (the agreed amount of a partly-declined set). That
--                           holds for EVERY line, set children included.
--                           parent_line_id, qty, unit_price, name... are frozen.
--                           No INSERT, no DELETE.
--   issued (anything else), signed, superseded, void
--                           nothing: no INSERT, UPDATE or DELETE
--
-- Race: the parent is read FOR SHARE. A concurrent confirm (UPDATE documents
-- issued -> signed) and a concurrent decision write both need that row, so one
-- waits for the other; under READ COMMITTED the late decision then re-reads the
-- parent, sees `signed`, and is refused. Without the lock a decision could slip
-- in after the freeze.
CREATE OR REPLACE FUNCTION document_lines_are_immutable() RETURNS trigger AS $$
DECLARE
  v_doc      uuid;
  v_status   text;
  v_type     text;
  v_number   text;
  v_allowed  text[] := ARRAY['approval_status', 'decided_at', 'decided_by',
                             'decline_reason', 'decline_note', 'approved_amount'];
BEGIN
  v_doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.document_id ELSE OLD.document_id END;

  -- A line never changes document, in any state: it would move a decision and a
  -- price from one piece of paper onto another.
  IF TG_OP = 'UPDATE' AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'a document line cannot be moved to another document'
      USING ERRCODE = 'GS002', TABLE = 'document_lines', HINT = 'line_move';
  END IF;

  SELECT status, type, number INTO v_status, v_type, v_number
    FROM documents WHERE id = v_doc FOR SHARE;

  IF NOT FOUND THEN
    -- Parent not visible/absent. INSERT/UPDATE: the foreign key reports it.
    -- DELETE: the cascade from a deleted draft document (numbered documents
    -- cannot be deleted — documents_cannot_be_deleted above).
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status = 'issued' AND v_type = 'quotation' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
      RAISE EXCEPTION
          'line on issued document % is locked; only the customer decision may change',
          v_number
        USING ERRCODE = 'GS002', TABLE = 'document_lines',
              HINT = 'line_content_locked';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'document % is % and its lines cannot be %',
      v_number, v_status,
      CASE TG_OP WHEN 'INSERT' THEN 'added' WHEN 'DELETE' THEN 'removed' ELSE 'changed' END
    USING ERRCODE = 'GS002', TABLE = 'document_lines',
          HINT = CASE WHEN v_status = 'issued' THEN 'line_set_locked' ELSE 'line_document_frozen' END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_document_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION document_lines_are_immutable();
