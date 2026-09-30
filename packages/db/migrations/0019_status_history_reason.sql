-- =============================================================================
-- 0019_status_history_reason.sql — why a status move was made, where one is required
--
-- DEPLOY TOGETHER WITH 0018; NEVER ONE WITHOUT THE OTHER. 0018 takes a
-- delivered car off every board the moment "ส่งแล้ว" is pressed; the only way
-- back is the undo (delivered -> ready), and the API refuses that undo without
-- a reason it stores in the column this file adds. 0018 alone leaves a
-- mistaken delivery with no way back; this file alone is a column nothing
-- needs. The API has no runtime fallback for a missing column (by review
-- condition), so the application release that ships these two files needs
-- both.
--
-- WHAT:     job_status_history gains one nullable column, `reason text`, and
--           one CHECK, ck_status_history_reason, added NOT VALID and then
--           VALIDATEd as a separate statement. Nothing else: no backfill, no
--           new table, no index, no policy change.
-- WHY:      docs/WORK-ORDERS/DECISION-carout.md §3 (owner, 30 Sep 2026;
--           this migration approved by the owner the same day). Undoing a
--           mistaken "ส่งแล้ว" is open to the same staff who may deliver, and
--           EVERY undo carries a reason; the job's history must show who undid
--           it, when, and why.
--
--           The reason lives ON THE HISTORY ROW that records the move, because
--           that row already IS the "who and when" (changed_by, changed_at):
--           one row answers all three questions. It is kept NOWHERE else — in
--           particular not in audit_logs, whose rule is "no personal data"
--           (apps/api/src/services/audit.ts) while this is free text staff may
--           fill with a customer's name. The audit entry for an undo
--           (job_delivery_undone) points at this row by id instead.
--
--           Nullable, because almost every move needs no reason and every row
--           written before today has none. WHICH moves require one is
--           packages/domain moveRequiresReason(), enforced by the API with a
--           400 — not by this CHECK, which cannot see the status a row moved
--           FROM.
--
--           THE CHECK — how it matches the API exactly. The API validates with
--           zod `.trim().min(1).max(500)` and STORES THE TRIMMED VALUE. So
--           rather than re-trimming here (btrim() strips only spaces, and
--           `\s` depends on the locale — neither is JavaScript's trim), the
--           CHECK asserts the stored value IS ALREADY TRIMMED and is 1–500
--           long, both measured the way JavaScript measures them:
--
--             * "trimmed" = no leading and no trailing character from
--               JavaScript's String.prototype.trim() set — WhiteSpace plus
--               LineTerminator (ECMA-262): U+0009–U+000D, U+0020, U+00A0,
--               U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
--               U+3000, U+FEFF — spelled out as code points, so no locale can
--               change it.
--             * "length" = UTF-16 code units, which is what zod's .max(500)
--               counts: char_length() (code points) plus one more for every
--               character outside the BMP. 250 emoji pass (500 units), 251 do
--               not (502) — as in the API.
--
--           Consequences: every value the API accepts (trimmed, 1–500) passes;
--           an empty-after-trim value cannot be stored at all (a non-empty
--           string with no whitespace at either end is non-empty after trim);
--           an over-long one is refused; and an UNTRIMMED value written by some
--           other path is refused instead of silently passing a looser rule.
--           Checked against all of these cases on the dev database before this
--           file was applied.
--
--           No RLS change: the table already has its four split policies
--           (0002 apply_tenant_rls, 0012); a new column is covered by them.
-- ROLLBACK: Runnable in one transaction as postgres (packages/db/README.md,
--           "Rolling back a migration — checklist"). Roll 0018 back WITH it
--           (see the first paragraph), and the application first.
--
--           BEGIN;
--             ALTER TABLE job_status_history DROP CONSTRAINT ck_status_history_reason;
--             ALTER TABLE job_status_history DROP COLUMN reason;
--             DELETE FROM schema_migrations WHERE filename = '0019_status_history_reason.sql';
--           COMMIT;
--
--           Data lost on rollback: every reason staff typed when undoing a
--           delivery — it exists only here. Export it first:
--             \copy (SELECT id, job_id, changed_at, changed_by, reason
--                      FROM job_status_history WHERE reason IS NOT NULL)
--               TO 'status_history_reason.csv' CSV HEADER
-- LOCKS:    Step by step. The runner wraps the whole file in ONE transaction,
--           so every lock below is held until COMMIT; on this table that is
--           milliseconds.
--             1. ADD COLUMN reason text (no default): catalogue-only — no
--                rewrite, no scan. ACCESS EXCLUSIVE on job_status_history.
--             2. ADD CONSTRAINT ... NOT VALID: catalogue-only, no scan; new and
--                updated rows are checked from here on. ACCESS EXCLUSIVE.
--             3. VALIDATE CONSTRAINT: one sequential scan of the table under
--                SHARE UPDATE EXCLUSIVE, which on its own lets reads and
--                writes continue. Every existing row has reason NULL and
--                passes. Inside this file's single transaction the ACCESS
--                EXCLUSIVE from steps 1–2 is still held, so the split buys no
--                concurrency HERE; it is written this way so that on a large
--                table the VALIDATE can be moved to its own later migration
--                without rewriting anything.
--           job_status_history on the dev database: 0 rows as applied.
-- ROWS:     None written or changed.
-- =============================================================================

ALTER TABLE job_status_history ADD COLUMN reason text NULL;

-- The whitespace class is JavaScript's trim() set, as code points (see WHY).
ALTER TABLE job_status_history ADD CONSTRAINT ck_status_history_reason CHECK (
  reason IS NULL
  OR (
        reason !~ '^[\u0009-\u000D    -     　﻿]'
    AND reason !~ '[\u0009-\u000D    -     　﻿]$'
    AND char_length(reason)
        + char_length(regexp_replace(reason, '[^\U00010000-\U0010FFFF]', '', 'g'))
        BETWEEN 1 AND 500
  )
) NOT VALID;

ALTER TABLE job_status_history VALIDATE CONSTRAINT ck_status_history_reason;
