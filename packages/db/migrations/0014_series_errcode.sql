-- =============================================================================
-- 0014_series_errcode.sql — "no document series" says so in a SQLSTATE
--
-- WHAT:     Replaces allocate_document_number (0003_numbering.sql) with a body
--           identical in every respect except one: the "no active document
--           series" RAISE EXCEPTION now carries USING ERRCODE = 'GS001'.
--           No table, column, index, policy or view is touched.
-- WHY:      The API has to tell staff something useful when a shop tries to
--           open a job and has no JOB series — "สาขานี้ยังไม่ได้ตั้งค่าเลขที่ใบงาน"
--           rather than a bare 500 at the counter with a customer waiting.
--           Without a distinguishing error code the only way to recognise the
--           condition is to match the exception's MESSAGE TEXT with a regex,
--           which breaks the day anyone rewords it or runs a localised server,
--           and breaks silently — the check simply stops matching and the
--           friendly message disappears. Every other error this API maps is
--           keyed on something the database states deliberately (a constraint
--           name); this makes that true here too.
--
--           'GS001' is in class 'GS', which is not assigned by the SQL
--           standard or used by PostgreSQL, so it cannot collide with a real
--           SQLSTATE. Class GS = this application's own conditions.
--
--           Note for whoever is reading this because a shop hit GS001: the
--           durable fix is not in this file. seed_document_series() is called
--           from packages/db/src/seed.ts and NOWHERE else — there is no
--           shop-creation endpoint yet, and when one is written it must call
--           seed_document_series(new_shop_id) in the same transaction that
--           inserts the shop. Until then, any shop created outside the seed
--           script cannot open a job.
-- ROLLBACK: Restore the 0003 body, which differs only in the RAISE:
--
--           BEGIN;
--             CREATE OR REPLACE FUNCTION allocate_document_number(
--               p_shop_id uuid, p_series text, p_at timestamptz DEFAULT now()
--             ) RETURNS text AS $$
--             DECLARE
--               r          document_series%ROWTYPE;
--               shop_code  text;
--               new_period text;
--               seq        integer;
--             BEGIN
--               SELECT * INTO r FROM document_series
--                WHERE shop_id = p_shop_id AND series = p_series AND is_active
--                FOR UPDATE;
--               IF NOT FOUND THEN
--                 RAISE EXCEPTION 'no active document series % for shop %',
--                   p_series, p_shop_id;
--               END IF;
--               SELECT doc_code INTO shop_code FROM shops WHERE id = p_shop_id;
--               new_period := document_period_key(r.reset_policy, p_at, r.timezone);
--               seq := CASE WHEN new_period IS DISTINCT FROM r.period_key
--                           THEN 1 ELSE r.next_no END;
--               UPDATE document_series
--                  SET next_no = seq + 1, period_key = new_period
--                WHERE id = r.id;
--               RETURN render_document_number(r.pattern, seq, p_at, r.timezone, shop_code);
--             END;
--             $$ LANGUAGE plpgsql;
--           COMMIT;
--
--           Rolling back only loses the error code. Callers that match on
--           GS001 stop recognising the condition and fall back to a generic
--           500, which is the behaviour before this migration — no data is
--           affected either way.
-- LOCKS:    None worth planning for. CREATE OR REPLACE FUNCTION takes an
--           ACCESS EXCLUSIVE lock on the function's own catalogue row, not on
--           any table, and completes in microseconds. Sessions already
--           executing the old body finish with the old body; the next call
--           picks up the new one.
-- ROWS:     No rows are read or written. document_series holds 48 rows (6
--           seeded shops x 8 series) as this file is written; none is touched.
-- =============================================================================


-- Byte-for-byte 0003's function apart from the RAISE. Reproduced in full
-- rather than patched, because CREATE OR REPLACE FUNCTION has no other form:
-- the whole body is the unit of replacement.
--
-- Everything the original comment said still holds and is repeated here so it
-- does not get lost by being in an older file: call this in the SAME
-- transaction that inserts the document, and as late in it as possible
-- (CLAUDE.md §5.8 — a number is allocated when a document is ISSUED, never
-- when its row is created; a draft carries number = NULL). The
-- SELECT ... FOR UPDATE serialises concurrent allocations on the series row,
-- so two simultaneous check-ins can never receive the same number. Never
-- replace it with MAX(number)+1.
CREATE OR REPLACE FUNCTION allocate_document_number(
  p_shop_id uuid, p_series text, p_at timestamptz DEFAULT now()
) RETURNS text AS $$
DECLARE
  r          document_series%ROWTYPE;
  shop_code  text;
  new_period text;
  seq        integer;
BEGIN
  SELECT * INTO r FROM document_series
   WHERE shop_id = p_shop_id AND series = p_series AND is_active
   FOR UPDATE;

  IF NOT FOUND THEN
    -- The one change in this file. The message is unchanged and still names
    -- the series and the shop for the server log; the ERRCODE is what the
    -- application matches on, so rewording the message above can never again
    -- silently stop the API from recognising this.
    RAISE EXCEPTION 'no active document series % for shop %', p_series, p_shop_id
      USING ERRCODE = 'GS001';
  END IF;

  SELECT doc_code INTO shop_code FROM shops WHERE id = p_shop_id;

  new_period := document_period_key(r.reset_policy, p_at, r.timezone);
  seq := CASE WHEN new_period IS DISTINCT FROM r.period_key THEN 1 ELSE r.next_no END;

  UPDATE document_series
     SET next_no = seq + 1, period_key = new_period
   WHERE id = r.id;

  RETURN render_document_number(r.pattern, seq, p_at, r.timezone, shop_code);
END;
$$ LANGUAGE plpgsql;
