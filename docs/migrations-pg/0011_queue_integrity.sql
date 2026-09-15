-- =============================================================================
-- 0011_queue_integrity.sql — one booking, one job, one queue list
--
-- WHAT:     The link between a booking and the job it becomes, the rules that
--           make that link one-way and one-time, the single view the queue
--           screen reads, and the log of every bill the LINE bot closes.
-- WHY:      In the prototype a booking, its quotation, its deposit and the queue
--           entry are four rows that do not know about each other. On arrival
--           staff press "create new queue" and the system does exactly that —
--           it creates a fifth thing, and the old one stays on the board. See
--           CLAUDE.md §5.8. The fix is structural: arrival is a state
--           transition, and the board reads one view.
-- ROLLBACK: DROP VIEW queue_today;
--           DROP TABLE bot_messages CASCADE;
--           DROP TRIGGER trg_jobs_booking_immutable ON jobs;
--           DROP FUNCTION jobs_booking_link_is_permanent();
--           DROP INDEX uq_jobs_booking, uq_live_quotation_per_job;
--           (restore the previous documents_status_check and documents_are_immutable)
--           ALTER TABLE jobs DROP COLUMN booking_id;
--           ALTER TABLE bookings ADD COLUMN job_id uuid REFERENCES jobs(id);
-- LOCKS:    ALTER TABLE jobs takes a brief ACCESS EXCLUSIVE lock. Adding a
--           nullable column with no default does not rewrite the table.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- One direction only
-- -----------------------------------------------------------------------------
-- 0008 put job_id on bookings. Holding the link on both sides invites the two
-- to disagree, and a disagreement here is exactly the duplicate the shop already
-- suffers. The link lives on jobs, because that is the side the uniqueness rule
-- belongs to: many bookings may never arrive, but a booking that does arrive
-- becomes exactly one job.
ALTER TABLE bookings DROP COLUMN IF EXISTS job_id;

ALTER TABLE jobs
  ADD COLUMN booking_id uuid REFERENCES bookings(id) ON DELETE RESTRICT;

-- The invariant. Press the arrival button twice, or race two staff members on
-- two tablets, and the second attempt fails instead of opening a second job.
CREATE UNIQUE INDEX uq_jobs_booking ON jobs (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX idx_jobs_booking ON jobs (shop_id, booking_id)
  WHERE booking_id IS NOT NULL;

-- Once a job is tied to a booking, that tie is history. Re-pointing it would
-- silently move a deposit and an arrival record onto a different car.
CREATE OR REPLACE FUNCTION jobs_booking_link_is_permanent() RETURNS trigger AS $$
BEGIN
  IF OLD.booking_id IS NOT NULL AND NEW.booking_id IS DISTINCT FROM OLD.booking_id THEN
    RAISE EXCEPTION 'job % is already linked to booking %; the link cannot be changed',
      OLD.id, OLD.booking_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_booking_immutable BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_booking_link_is_permanent();


-- -----------------------------------------------------------------------------
-- One live quotation per job
-- -----------------------------------------------------------------------------
-- A revision supersedes its predecessor, so exactly one quotation per job is
-- ever current. Without this, the draft made at booking time and a second one
-- made on arrival both look current, and staff cannot tell which the customer
-- signed.
--
-- 'superseded' is a new status. It is what a revised quotation becomes: still a
-- real document with its number intact, no longer the live one. An index
-- predicate cannot contain a subquery, so the state has to be on the row.
ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('draft', 'signed', 'issued', 'superseded', 'void'));

CREATE UNIQUE INDEX uq_live_quotation_per_job ON documents (job_id)
  WHERE type = 'quotation'
    AND job_id IS NOT NULL
    AND status IN ('draft', 'signed', 'issued');

-- Being superseded is the second permitted transition out of a frozen document,
-- alongside voiding. Everything that identifies the document must stay put:
-- this marks a document as history, it does not edit it.
CREATE OR REPLACE FUNCTION documents_are_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('signed', 'issued') THEN
    IF NEW.status IN ('void', 'superseded')
       AND NEW.type = OLD.type
       AND NEW.number = OLD.number
       AND NEW.grand_total = OLD.grand_total THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'document % is % and cannot be modified', OLD.number, OLD.status;
  END IF;
  IF OLD.status IN ('superseded', 'void') THEN
    RAISE EXCEPTION 'document % is % and is closed to further change', OLD.number, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- The queue board reads this and nothing else
-- -----------------------------------------------------------------------------
-- The reported symptom — "the old one comes back" — is the queue screen asking
-- two sources and concatenating them in the browser. One view removes the
-- possibility: a booking that has become a job is not in it, because the job is.
--
-- security_invoker so the base tables' RLS applies to the caller. Without it a
-- view runs as its owner and every shop sees every shop.
CREATE VIEW queue_today WITH (security_invoker = true) AS

  -- Cars expected but not yet here
  SELECT b.shop_id,
         'booking'::text            AS kind,
         b.id                       AS ref_id,
         b.bay_id,
         b.slot_start               AS at,
         b.status,
         b.source,
         coalesce(c.name, b.contact_name)   AS customer_name,
         coalesce(c.phone, b.contact_phone) AS phone,
         v.plate,
         NULL::uuid                 AS job_id,
         b.note
    FROM bookings b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN vehicles  v ON v.id = b.vehicle_id
   WHERE b.status IN ('booked', 'confirmed')
     -- The whole point: converted bookings leave this list on their own, with
     -- nobody having to remember to remove them.
     AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.booking_id = b.id)

  UNION ALL

  -- Cars that are here
  SELECT j.shop_id,
         'job'::text                AS kind,
         j.id                       AS ref_id,
         j.bay_id,
         j.created_at               AS at,
         j.status,
         CASE WHEN j.booking_id IS NULL THEN 'walk_in' ELSE 'booked' END AS source,
         c.name                     AS customer_name,
         c.phone,
         v.plate,
         j.id                       AS job_id,
         NULL::text                 AS note
    FROM jobs j
    LEFT JOIN customers c ON c.id = j.customer_id
    LEFT JOIN vehicles  v ON v.id = j.vehicle_id
   -- 'carout' is the car leaving; 'rejected' is the customer declining
   -- everything. Neither is still on the board.
   WHERE j.status NOT IN ('carout', 'rejected')
     AND j.deleted_at IS NULL;


-- -----------------------------------------------------------------------------
-- What the LINE bot was told
-- -----------------------------------------------------------------------------
-- Every bill the bot closes is closed on the strength of a chat message. The
-- message is the evidence, so it is kept verbatim — including the ones that were
-- refused, which are the ones worth reading when staff say the bot is broken.
CREATE TABLE bot_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,

  channel         text NOT NULL DEFAULT 'line' CHECK (channel IN ('line')),
  group_id        text NOT NULL,
  line_message_id text,
  raw_text        text NOT NULL,

  -- What the parser made of it. NULL where parsing itself failed.
  document_number text,
  payment_method  text,
  amount          numeric(12,2),

  outcome         text NOT NULL CHECK (outcome IN (
                    'closed',            -- bill closed
                    'amount_mismatch',   -- the checksum did not agree
                    'no_document_code',  -- nothing to match on; never guess
                    'not_found',
                    'not_closable',      -- wrong status for closing
                    'duplicate',         -- idempotency key already seen
                    'parse_error')),
  -- The difference, when the amounts disagreed. Written so the reply to the
  -- group and the record of it cannot drift apart.
  difference      numeric(12,2),
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  reply_text      text,

  -- (shop, document code, amount). A LINE webhook retry and a staff member
  -- resending the same message are the same event, and must close one bill.
  idempotency_key text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_bot_idempotency UNIQUE (shop_id, idempotency_key)
);
CREATE INDEX idx_bot_messages_recent ON bot_messages (shop_id, created_at DESC);
CREATE INDEX idx_bot_messages_doc ON bot_messages (document_id)
  WHERE document_id IS NOT NULL;
CALL apply_tenant_rls('bot_messages');

-- A refused message has no idempotency_key: the same correction may legitimately
-- be sent again once staff fix the amount. Only a close claims a key.
