-- =============================================================================
-- 0024_offered_discount.sql — split the OFFERED discount from the AGREED one
--
-- WHAT:     1. documents.offered_discount numeric(12,2) NOT NULL DEFAULT 0 —
--              the discount the customer was OFFERED, written once at issue and
--              immutable on every non-draft row.
--           2. documents.discount keeps its name and becomes the AGREED
--              discount (owner ruling, Ice, 14 Oct 2026, "model A"):
--                draft / at issue     discount = offered_discount
--                issued -> signed     confirm may change it (D11, reason
--                                     mandatory, enforced by the API)
--                signed -> issued     undo restores it to offered_discount
--           3. CREATE OR REPLACE documents_are_immutable() (0022's function;
--              0022 itself is NOT edited). Changes, and only these:
--                a. draft -> issued (quotation): discount must equal
--                   offered_discount (the agreement starts from the discount
--                   that is printed on the offer).
--                b. issued -> issued: unchanged allow-list (approved_total,
--                   discount) BUT discount may only be set equal to
--                   offered_discount. Nothing in the app does this; it is the
--                   heal path for rows left stale by the old undo (see ROWS).
--                c. signed -> issued (undo): allow-list becomes
--                   status, signed_at, discount, approved_total, guarded by
--                   NEW.discount = NEW.offered_discount.
--                d. offered_discount needs no entry in any allow-list: every
--                   non-draft branch compares the whole row minus its
--                   allow-list, so the column is frozen by default.
--           4. Backfill (see ROWS).
--
-- WHY:      documents.discount held both the offered and the agreed discount
--           and confirm overwrote it. 0022 allows only status/signed_at on
--           signed -> issued, so undo could not put it back. Results, all
--           confirmed by document-integrity: after undo approved_total still
--           used the agreed discount; revise copied the agreed discount as if
--           it were the offered one; a signed print showed a discount that did
--           not foot with offered_total (CLAUDE.md s4 rule 4, s5.1 rule 3).
--           Storing both makes every figure on the paper a stored fact:
--             offered_subtotal - offered_discount = offered_total   (always)
--             approved_subtotal - clamp(discount)  = approved_total (always)
--           where offered_subtotal = SUM(line_total) of the top-level lines
--           (there is no stored offered_subtotal column; the lines are immutable
--           from issue, 0022).
--
--           Refusals reuse SQLSTATE GS002, TABLE 'documents' and EXISTING
--           hints ('document_frozen_columns', 'document_unconfirm_invalid').
--           No new hint, no new code, so no CLAUDE.md s9.1 change and no
--           change to lib/pgError.ts.
--
--           No CHECK is added on offered_discount: documents.discount has none,
--           and every write goes through quoteTotals() (packages/domain), which
--           clamps to [0, subtotal]. A CHECK would be a net with nothing in
--           front of it to land on (CLAUDE.md s4.y).
--
-- ROWS:     BACKFILL touches EVERY quotation row of documents, once, with user
--           triggers off (SET LOCAL session_replication_role = replica, back to
--           origin right after; the role must be a superuser, which the
--           guard checks; this also keeps updated_at as it was):
--             quotation, status draft, OR number IS NULL (a draft that was
--             voided: never issued, so offered_total was never written)
--                 offered_discount = GREATEST(discount, 0)
--             quotation, status issued / signed / superseded / void, with a number
--                 offered_discount = GREATEST(S - offered_total, 0)
--                 where S = SUM(line_total) over the document's lines with
--                 parent_line_id IS NULL (0 when it has none)
--             every other document type
--                 left at the column default 0 (they have no offered discount)
--           discount is NOT touched on any row.
--           The non-draft formula is EXACT, not an estimate, because
--           offered_total was written at issue as S - clamp(discount, S) and the
--           lines have been immutable since issue (0022). It is APPROXIMATE
--           only for a row issued before 0022 whose lines were edited after
--           numbering, which could leave S - offered_total negative (clamped to
--           0 by GREATEST). A $verify$ block then RAISES EXCEPTION (whole file
--           rolls back) if any non-draft quotation fails to foot
--           (S - offered_discount <> offered_total, which is exactly the
--           approximated case) or any draft / never-numbered quotation differs
--           from GREATEST(discount, 0),
--           so an approximated row stops the migration for a human decision.
--           It finally RAISES NOTICE with the count of:
--             (b) issued quotations whose discount <> offered_discount after the
--                 backfill. Those are rows the old undo left holding the AGREED
--                 discount (and possibly stale set approved_amount values), or
--                 rows where an entered discount exceeded the subtotal and was
--                 stored unclamped. They are NOT repaired here: repairing
--                 approved_total and approved_amount is a data decision for
--                 migration-safety / document-integrity, and the trigger below
--                 permits the repair (issued -> issued, discount set equal to
--                 offered_discount). Expected count on a database that never
--                 ran confirm-then-undo: 0.
--           Run the counting queries (in the $verify$ block) on a backup first.
--
-- ROLLBACK: (psql -v ON_ERROR_STOP=1 --single-transaction, as postgres; see
--           packages/db/README.md "Rolling back a migration". Back up first.
--           Roll the apps/api code back first: it reads the column.)
--             -- 1. restore 0022's function, verbatim:
--             CREATE OR REPLACE FUNCTION documents_are_immutable() RETURNS trigger AS $$
--             DECLARE
--               v_allowed text[];
--               v_old     jsonb := to_jsonb(OLD) - 'updated_at';
--               v_new     jsonb := to_jsonb(NEW) - 'updated_at';
--             BEGIN
--               -- 0011 b3. A superseded or void document is history. Not even a no-op update.
--               IF OLD.status IN ('superseded', 'void') THEN
--                 RAISE EXCEPTION 'document % is % and is closed to further change',
--                     OLD.number, OLD.status
--                   USING ERRCODE = 'GS002', TABLE = 'documents',
--                         HINT = 'document_closed';
--               END IF;
--             
--               -- 0011 b4. A draft carries no number and is not an official document.
--               -- NEW: but it cannot jump straight to 'signed'. A document passes through
--               -- 'issued' (number allocated, lines locked, decisions recorded) before it can
--               -- be confirmed; skipping that would freeze a quotation nobody ever decided.
--               IF OLD.status = 'draft' THEN
--                 IF NEW.status = 'signed' THEN
--                   RAISE EXCEPTION 'draft document must be issued before it can be signed'
--                     USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_draft_to_signed';
--                 END IF;
--                 RETURN NEW;
--               END IF;
--             
--               -- From here OLD.status is 'issued' or 'signed' (the CHECK admits no others).
--               -- v_allowed = the columns this particular transition may change.
--             
--               IF OLD.status = 'issued' THEN
--             
--                 IF NEW.status = 'issued' THEN
--                   -- NEW: recording decisions moves the approved total, and the confirm step
--                   -- may adjust the discount (D11). Quotations only: a work order or receipt
--                   -- that has been issued changes nothing at all (0011 b2).
--                   IF OLD.type <> 'quotation' THEN
--                     RAISE EXCEPTION 'document % is issued and cannot be modified', OLD.number
--                       USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_issued';
--                   END IF;
--                   v_allowed := ARRAY['approved_total', 'discount'];
--             
--                 ELSIF NEW.status = 'signed' THEN
--                   -- NEW: issued -> signed, "ยืนยันผลลูกค้า". Same two adjustable columns
--                   -- (the adjustments and the transition land in one UPDATE) plus the
--                   -- transition's own columns. The API checks every top-level line is decided.
--                   -- grand_total, vat_base, vat_amount and vat_absorbed deliberately stay the
--                   -- OFFERED figures frozen at issue: the document carries two totals
--                   -- (CLAUDE.md §5.1 rule 3), offered_total/grand_total as offered and
--                   -- approved_total as accepted, and the confirm-time discount adjustment
--                   -- moves only discount and approved_total.
--                   IF OLD.type <> 'quotation' OR NEW.signed_at IS NULL THEN
--                     RAISE EXCEPTION 'document % cannot be confirmed', OLD.number
--                       USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_confirm_invalid';
--                   END IF;
--                   v_allowed := ARRAY['approved_total', 'discount', 'status', 'signed_at'];
--             
--                 ELSIF NEW.status = 'void' THEN
--                   -- 0011 b1 (void leg). Voiding changes the void columns and nothing else.
--                   -- This is the one path the system's "closed by job" (void_reason =
--                   -- 'job_closed', voided_by NULL) and the owner's manual void share; who may
--                   -- do which is decided by the API, not here. Content, number and totals
--                   -- are all frozen, so closing never edits what the customer was shown.
--                   v_allowed := ARRAY['status', 'void_reason', 'voided_at', 'voided_by'];
--             
--                 ELSIF NEW.status = 'superseded' THEN
--                   -- 0011 b1 (superseded leg). Marks history; edits nothing.
--                   v_allowed := ARRAY['status'];
--             
--                 ELSE
--                   RAISE EXCEPTION 'document % is issued and cannot become %', OLD.number, NEW.status
--                     USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_transition_invalid';
--                 END IF;
--             
--               ELSE  -- OLD.status = 'signed'
--             
--                 IF NEW.status = 'issued' THEN
--                   -- NEW: undo confirm. Status and signed_at revert; NOTHING else may move —
--                   -- not the totals, not the discount, not the number. "Same Bangkok day" and
--                   -- "job still approved" are conditions of the business, checked by the API.
--                   IF OLD.type <> 'quotation' OR NEW.signed_at IS NOT NULL THEN
--                     RAISE EXCEPTION 'document % cannot be un-confirmed this way', OLD.number
--                       USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_unconfirm_invalid';
--                   END IF;
--                   v_allowed := ARRAY['status', 'signed_at'];
--             
--                 ELSIF NEW.status = 'superseded' THEN
--                   -- 0011 b1 (superseded leg): a new revision replaces the confirmed one.
--                   v_allowed := ARRAY['status'];
--             
--                 ELSIF NEW.status = 'void' THEN
--                   -- 0011 b1 (void leg). Kept as 0011 had it: a confirmed document can still
--                   -- be voided deliberately (owner only, in the API). The system's
--                   -- job-closed close never touches a signed quotation (Q1) — that is API
--                   -- behaviour, and this trigger would allow it only with the same
--                   -- void-columns-only restriction.
--                   v_allowed := ARRAY['status', 'void_reason', 'voided_at', 'voided_by'];
--             
--                 ELSE
--                   -- 0011 b2: signed -> signed (any edit, even a no-op) is refused.
--                   RAISE EXCEPTION 'document % is signed and cannot be modified', OLD.number
--                     USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_signed';
--                 END IF;
--             
--               END IF;
--             
--               -- Everything outside the allow-list must be byte-identical.
--               IF (v_new - v_allowed) IS DISTINCT FROM (v_old - v_allowed) THEN
--                 RAISE EXCEPTION 'document % is % and only % may change in this transition',
--                     OLD.number, OLD.status, array_to_string(v_allowed, ', ')
--                   USING ERRCODE = 'GS002', TABLE = 'documents',
--                         HINT = 'document_frozen_columns';
--               END IF;
--             
--               RETURN NEW;
--             END;
--             $$ LANGUAGE plpgsql;
--             -- 2. drop the column. Data lost on rollback: the offered_discount
--             --    values, recomputable by the same formula as the backfill;
--             --    documents.discount is untouched. README step 3 export first:
--             --      \copy (SELECT id, offered_discount FROM documents WHERE type='quotation') TO 'offered_discount.csv' CSV HEADER
--             ALTER TABLE documents DROP COLUMN offered_discount;
--             DELETE FROM schema_migrations
--              WHERE filename = '0024_offered_discount.sql';
-- LOCKS:    ADD COLUMN ... NOT NULL DEFAULT 0 is catalog-only on PostgreSQL 16
--           (constant default, no rewrite), but it takes ACCESS EXCLUSIVE on
--           documents and that lock is HELD TO COMMIT, i.e. for the whole file
--           (backfill scan of documents and document_lines included). Reads and
--           writes on documents wait meanwhile. SET LOCAL lock_timeout = '5s'
--           makes the migration give up (and roll back) rather than queue
--           behind a long transaction. CREATE OR REPLACE FUNCTION takes no
--           table lock. Run outside shop hours.
-- ORDER:    Requires 0022 (the function it replaces). 0023 is independent. The
--           guard below refuses to run without 0022.
-- RESERVED: the composite (shop_id, job_id) FK that 0023's header reserves for
--           "0024" is now 0025.
-- DEPLOY:   Migration and API ship TOGETHER. The new API reads and writes
--           offered_discount (it would 500 on the old schema); the old API
--           against the new schema would have confirm/undo refused by the
--           new trigger (undo sends no discount / approved_total).
-- =============================================================================

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_document_lines_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0024_offered_discount requires 0022_quote_freeze first';
  END IF;
  -- superuser, not merely BYPASSRLS: SET session_replication_role (below) needs it.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0024 must run as a superuser (documents is FORCE RLS and the backfill switches triggers off; as anyone else it would touch 0 rows or fail)';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Column
-- -----------------------------------------------------------------------------
ALTER TABLE documents ADD COLUMN offered_discount numeric(12,2) NOT NULL DEFAULT 0;

-- -----------------------------------------------------------------------------
-- 2. Backfill — user triggers off (so documents_are_immutable() and updated_at
--    stay out of the way) for exactly these two UPDATEs, then back on.
--    session_replication_role needs superuser; the guard above checked it.
-- -----------------------------------------------------------------------------
SET LOCAL session_replication_role = replica;
DO $assert$
BEGIN
  IF current_setting('session_replication_role') <> 'replica' THEN
    RAISE EXCEPTION '0024: triggers were not switched off (not inside a transaction block?). Run via the migrate runner or psql --single-transaction as postgres.';
  END IF;
END
$assert$;

-- A draft, or a draft that was voided (status <> 'draft' but number IS NULL: it was never
-- issued, so offered_total was never written), carries its discount as entered.
UPDATE documents SET offered_discount = GREATEST(discount, 0) WHERE type = 'quotation' AND (status = 'draft' OR number IS NULL);
UPDATE documents d SET offered_discount = GREATEST(COALESCE((SELECT SUM(l.line_total) FROM document_lines l WHERE l.document_id = d.id AND l.parent_line_id IS NULL), 0) - d.offered_total, 0)
 WHERE d.type = 'quotation' AND d.status <> 'draft' AND d.number IS NOT NULL;

SET LOCAL session_replication_role = origin;

DO $verify$
DECLARE n_bad integer; n_draft integer; n_stale integer;
BEGIN
  SELECT count(*) INTO n_bad FROM documents d
   WHERE d.type = 'quotation' AND d.status <> 'draft' AND d.number IS NOT NULL
     AND COALESCE((SELECT SUM(l.line_total) FROM document_lines l WHERE l.document_id = d.id AND l.parent_line_id IS NULL), 0) - d.offered_discount <> d.offered_total;
  SELECT count(*) INTO n_draft FROM documents WHERE type = 'quotation' AND (status = 'draft' OR number IS NULL) AND offered_discount <> GREATEST(discount, 0);
  IF n_bad > 0 OR n_draft > 0 THEN
    RAISE EXCEPTION '0024 backfill does not foot: % non-draft quotation(s), % draft(s). Nothing applied; decide those rows first.', n_bad, n_draft;
  END IF;
  SELECT count(*) INTO n_stale FROM documents WHERE type = 'quotation' AND status = 'issued' AND discount <> offered_discount;
  RAISE NOTICE '0024: % issued quotation(s) with discount <> offered_discount; not repaired here', n_stale;
END
$verify$;

-- -----------------------------------------------------------------------------
-- 3. documents_are_immutable() — 0022's function with the changes in WHAT
--    (marked "0024" below). The logic of everything else is 0022's; some of 0022's
--    longer comments are shortened or dropped here (the ROLLBACK block above keeps
--    0022's function byte-for-byte, comments included).
-- -----------------------------------------------------------------------------
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
  -- It cannot jump straight to 'signed' (0022).
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'signed' THEN
      RAISE EXCEPTION 'draft document must be issued before it can be signed'
        USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_draft_to_signed';
    END IF;
    -- 0024: a quotation is issued with the agreed discount equal to the offered
    -- one. Both are written by the same UPDATE; a caller that wrote only one of
    -- them would print an offer the agreement does not start from.
    IF NEW.status = 'issued' AND NEW.type = 'quotation'
       AND NEW.discount IS DISTINCT FROM NEW.offered_discount THEN
      RAISE EXCEPTION 'quotation must be issued with discount equal to offered_discount'
        USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_frozen_columns';
    END IF;
    RETURN NEW;
  END IF;

  -- From here OLD.status is 'issued' or 'signed' (the CHECK admits no others).
  -- v_allowed = the columns this particular transition may change.
  -- offered_discount is in NO list below, so it is frozen on every non-draft row.

  IF OLD.status = 'issued' THEN

    IF NEW.status = 'issued' THEN
      -- Recording decisions moves the approved total (0022). Quotations only.
      IF OLD.type <> 'quotation' THEN
        RAISE EXCEPTION 'document % is issued and cannot be modified', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_issued';
      END IF;
      -- 0024: discount stays in the list (heal path) but may only be set equal
      -- to offered_discount. The agreed discount moves at confirm, never here.
      IF NEW.discount IS DISTINCT FROM OLD.discount
         AND NEW.discount IS DISTINCT FROM NEW.offered_discount THEN
        RAISE EXCEPTION 'document % is issued: discount may only be set to offered_discount', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_frozen_columns';
      END IF;
      v_allowed := ARRAY['approved_total', 'discount'];

    ELSIF NEW.status = 'signed' THEN
      -- issued -> signed, "ยืนยันผลลูกค้า" (0022, unchanged). discount here IS
      -- the agreed discount; the API requires a reason when it differs from
      -- offered_discount. offered_total / grand_total / vat_* stay as offered.
      IF OLD.type <> 'quotation' OR NEW.signed_at IS NULL THEN
        RAISE EXCEPTION 'document % cannot be confirmed', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_confirm_invalid';
      END IF;
      v_allowed := ARRAY['approved_total', 'discount', 'status', 'signed_at'];

    ELSIF NEW.status = 'void' THEN
      v_allowed := ARRAY['status', 'void_reason', 'voided_at', 'voided_by'];

    ELSIF NEW.status = 'superseded' THEN
      v_allowed := ARRAY['status'];

    ELSE
      RAISE EXCEPTION 'document % is issued and cannot become %', OLD.number, NEW.status
        USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_transition_invalid';
    END IF;

  ELSE  -- OLD.status = 'signed'

    IF NEW.status = 'issued' THEN
      -- Undo confirm. 0024: status and signed_at revert AND the agreed figures
      -- go back with them: discount to offered_discount, approved_total
      -- recomputed by the API from the decisions and that discount. Nothing
      -- else moves: not offered_total, not grand_total, not the number, and
      -- not offered_discount.
      IF OLD.type <> 'quotation' OR NEW.signed_at IS NOT NULL
         OR NEW.discount IS DISTINCT FROM NEW.offered_discount THEN
        RAISE EXCEPTION 'document % cannot be un-confirmed this way', OLD.number
          USING ERRCODE = 'GS002', TABLE = 'documents', HINT = 'document_unconfirm_invalid';
      END IF;
      v_allowed := ARRAY['status', 'signed_at', 'discount', 'approved_total'];

    ELSIF NEW.status = 'superseded' THEN
      v_allowed := ARRAY['status'];

    ELSIF NEW.status = 'void' THEN
      v_allowed := ARRAY['status', 'void_reason', 'voided_at', 'voided_by'];

    ELSE
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
