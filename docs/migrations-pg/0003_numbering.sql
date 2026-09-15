-- =============================================================================
-- 0003_numbering.sql — configurable document numbers, and idempotency
--
-- WHAT:     A per-shop, per-series number format the owner can configure, the
--           allocator that draws from it atomically, and the key table that
--           makes retried writes safe.
-- WHY:      Samut Prakan already has number formats its customers recognise
--           (JB-260820-001, IV260630001) and wants them kept. Other branches
--           will want their own. Hard-coding a format would force every new
--           branch through a code change, so the format is data, not code.
-- ROLLBACK: DROP FUNCTION allocate_document_number(uuid,text,timestamptz);
--           DROP FUNCTION render_document_number(text,integer,timestamptz,text,text);
--           DROP FUNCTION document_period_key(text,timestamptz,text);
--           DROP TABLE idempotency_keys, document_series CASCADE;
-- LOCKS:    None; tables are new.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Series
-- -----------------------------------------------------------------------------
-- Series codes in use:
--   JOB  เลขงาน            QUO  ใบเสนอราคา       WO   ใบแจ้งซ่อม
--   REC  ใบเสร็จรับเงิน     DEP  ใบรับเงินมัดจำ    TAX  ใบกำกับภาษี
--   ABB  ใบกำกับภาษีอย่างย่อ  CN   ใบลดหนี้ (เผื่อไว้ ยังไม่ทำ UI)
--
-- Tax law requires TAX to be continuous, with no gaps and no reuse, per issuer
-- per year. That is why a number is never derived from MAX(number)+1, and why a
-- cancelled document keeps its number instead of releasing it.

CREATE TABLE document_series (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  series       text NOT NULL,
  name         text NOT NULL,

  -- The format, as a pattern the owner edits in settings. Tokens:
  --   {YY}   ปี ค.ศ. 2 หลัก        {YYYY} ปี ค.ศ. 4 หลัก
  --   {BE}   ปี พ.ศ. 2 หลัก        {BEEE} ปี พ.ศ. 4 หลัก
  --   {MM}   เดือน 2 หลัก          {DD}   วัน 2 หลัก
  --   {SHOP} shops.doc_code        {SEQ:n} เลขลำดับ เติมศูนย์ n หลัก
  -- Everything else in the pattern is copied through literally.
  --
  -- Samut Prakan, carried over unchanged:
  --   JOB  'JB-{YY}{MM}{DD}-{SEQ:3}'   → JB-260820-001
  --   QUO  'IV{YY}{MM}{DD}{SEQ:3}'     → IV260630001
  pattern      text NOT NULL,

  -- When the sequence goes back to 1. Must match the pattern: a daily reset on
  -- a pattern with no {DD} produces duplicate numbers, which the check below
  -- cannot catch — it is checked in the settings UI and covered by a test.
  reset_policy text NOT NULL DEFAULT 'yearly'
               CHECK (reset_policy IN ('never', 'yearly', 'monthly', 'daily')),

  -- Numbering follows the shop's local day, not UTC. A bill closed at 01:00
  -- Bangkok time belongs to that day, and would otherwise be numbered into the
  -- previous one.
  timezone     text NOT NULL DEFAULT 'Asia/Bangkok',

  next_no      integer NOT NULL DEFAULT 1 CHECK (next_no >= 1),
  -- Which reset period next_no currently belongs to. When the computed period
  -- differs, the counter restarts. Stored rather than derived so that a shop
  -- that issues nothing for a month still restarts correctly.
  period_key   text NOT NULL DEFAULT '',

  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_series UNIQUE (shop_id, series),
  -- A pattern with no sequence token would hand every document the same number.
  CONSTRAINT ck_pattern_has_seq CHECK (pattern LIKE '%{SEQ:%')
);
CALL apply_tenant_rls('document_series');

CREATE TRIGGER trg_series_updated BEFORE UPDATE ON document_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- Period key
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_period_key(
  p_policy text, p_at timestamptz, p_tz text
) RETURNS text AS $$
DECLARE d timestamp := p_at AT TIME ZONE p_tz;
BEGIN
  RETURN CASE p_policy
    WHEN 'never'   THEN ''
    WHEN 'yearly'  THEN to_char(d, 'YYYY')
    WHEN 'monthly' THEN to_char(d, 'YYYY-MM')
    WHEN 'daily'   THEN to_char(d, 'YYYY-MM-DD')
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- -----------------------------------------------------------------------------
-- Rendering
-- -----------------------------------------------------------------------------
-- Separate from allocation on purpose: the settings screen calls this with a
-- made-up sequence to show the owner a live preview of the pattern they are
-- typing, without touching a counter.
CREATE OR REPLACE FUNCTION render_document_number(
  p_pattern text, p_seq integer, p_at timestamptz, p_tz text, p_shop_code text
) RETURNS text AS $$
DECLARE
  d   timestamp := p_at AT TIME ZONE p_tz;
  out text := p_pattern;
  pad integer;
  tok text;
BEGIN
  -- {SEQ:n} — read the width out of the token itself.
  tok := substring(out from '\{SEQ:([0-9]+)\}');
  IF tok IS NULL THEN
    RAISE EXCEPTION 'pattern % has no {SEQ:n} token', p_pattern;
  END IF;
  pad := tok::integer;
  IF pad < 1 OR pad > 12 THEN
    RAISE EXCEPTION 'pattern % has an out-of-range sequence width %', p_pattern, pad;
  END IF;
  -- A sequence that outgrows its width is not truncated — a short number would
  -- collide with an earlier one. It grows, and the shop notices.
  out := replace(out, '{SEQ:' || pad || '}', lpad(p_seq::text, pad, '0'));

  out := replace(out, '{YYYY}', to_char(d, 'YYYY'));
  out := replace(out, '{YY}',   to_char(d, 'YY'));
  out := replace(out, '{BEEE}', (extract(year from d)::integer + 543)::text);
  out := replace(out, '{BE}',   right((extract(year from d)::integer + 543)::text, 2));
  out := replace(out, '{MM}',   to_char(d, 'MM'));
  out := replace(out, '{DD}',   to_char(d, 'DD'));
  out := replace(out, '{SHOP}', coalesce(p_shop_code, ''));

  -- An unreplaced token means a typo in the pattern. Better to fail here than
  -- to print '{YEAR}' on a customer's tax invoice.
  IF out ~ '\{[A-Za-z]' THEN
    RAISE EXCEPTION 'pattern % contains an unknown token (result: %)', p_pattern, out;
  END IF;
  RETURN out;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- -----------------------------------------------------------------------------
-- Allocation
-- -----------------------------------------------------------------------------
-- Call this in the SAME transaction that inserts the document, and as late in
-- it as possible — see CLAUDE.md §5.8: a number is allocated when a document is
-- issued, never when its row is created. A draft carries number = NULL.
--
-- SELECT ... FOR UPDATE serialises concurrent allocations on the series row, so
-- two simultaneous check-ins can never receive the same number. Never replace
-- this with MAX(number)+1.
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
    RAISE EXCEPTION 'no active document series % for shop %', p_series, p_shop_id;
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


-- -----------------------------------------------------------------------------
-- Defaults for a new shop
-- -----------------------------------------------------------------------------
-- Called by the seed and by shop creation. Samut Prakan's two live formats are
-- the defaults because they are the ones staff and customers already read; a
-- new branch changes them in settings without a deploy.
CREATE OR REPLACE FUNCTION seed_document_series(p_shop_id uuid) RETURNS void AS $$
BEGIN
  INSERT INTO document_series (shop_id, series, name, pattern, reset_policy) VALUES
    (p_shop_id, 'JOB', 'เลขงาน',              'JB-{YY}{MM}{DD}-{SEQ:3}', 'daily'),
    (p_shop_id, 'QUO', 'ใบเสนอราคา',           'IV{YY}{MM}{DD}{SEQ:3}',   'daily'),
    (p_shop_id, 'WO',  'ใบแจ้งซ่อม',            'WO-{YY}{MM}{DD}-{SEQ:3}', 'daily'),
    (p_shop_id, 'REC', 'ใบเสร็จรับเงิน',         'RC-{YY}{MM}-{SEQ:4}',     'monthly'),
    (p_shop_id, 'DEP', 'ใบรับเงินมัดจำ',         'DEP-{YY}{MM}-{SEQ:4}',    'monthly'),
    -- Tax series reset yearly and are padded wide: the Revenue Department reads
    -- these, and a year's worth must fit without the width ever changing.
    (p_shop_id, 'TAX', 'ใบกำกับภาษี',           'TX{BEEE}{SEQ:5}',         'yearly'),
    (p_shop_id, 'ABB', 'ใบกำกับภาษีอย่างย่อ',    'AB{BEEE}{SEQ:5}',         'yearly'),
    (p_shop_id, 'CN',  'ใบลดหนี้',              'CN{BEEE}{SEQ:5}',         'yearly')
  ON CONFLICT (shop_id, series) DO NOTHING;
END;
$$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- Idempotency
-- -----------------------------------------------------------------------------
-- One table serves three callers:
--   * the offline outbox in the browser, which resends whatever did not get
--     through when the connection dropped
--   * stock movements, which must never apply twice however many times the
--     request arrives
--   * the LINE close-bill bot, where both LINE's webhook retries and a staff
--     member resending the message produce the same event twice
--
-- The caller generates the key. The server records it with the result, so a
-- replay returns the original response instead of doing the work again.

CREATE TABLE idempotency_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  key           text NOT NULL,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response      jsonb,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_idempotency UNIQUE (shop_id, key)
);
CREATE INDEX idx_idempotency_created ON idempotency_keys (created_at);
CALL apply_tenant_rls('idempotency_keys');

-- request_hash exists to catch a real mistake: the same key sent with a
-- different body. That means a client bug, not a retry, and must return 409
-- rather than silently replaying the first response.
--
-- Rows older than 30 days can be pruned; by then no client is still retrying.
