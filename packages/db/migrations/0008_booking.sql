-- =============================================================================
-- 0008_booking.sql — bays and the appointment queue
--
-- WHAT:     Service bays, and bookings that cannot overlap on the same bay.
-- WHY:      Two staff taking a booking for the same bay at the same time is the
--           failure this table exists to make impossible, and an application
--           check cannot do it — two requests both pass the check before either
--           writes.
-- ROLLBACK: DROP TABLE bookings, bays CASCADE;
-- LOCKS:    None; tables are new.
-- =============================================================================

CREATE TABLE bays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  capacity    integer NOT NULL DEFAULT 1,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,

  CONSTRAINT uq_bay_name UNIQUE (shop_id, name)
);
CALL apply_tenant_rls('bays');


CREATE TABLE bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id   uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  bay_id       uuid REFERENCES bays(id) ON DELETE RESTRICT,
  -- Set once the car actually arrives and a job is opened.
  job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,

  -- Booked ahead by phone or chat, or walked in off the street. Both compete
  -- for the same bays, so both live here rather than in two parallel systems.
  source       text NOT NULL DEFAULT 'walk_in'
               CHECK (source IN ('walk_in', 'phone', 'line', 'page', 'self_service')),

  slot_start   timestamptz NOT NULL,
  slot_end     timestamptz NOT NULL,

  status       text NOT NULL DEFAULT 'booked' CHECK (status IN (
                 'booked', 'confirmed', 'arrived', 'no_show', 'cancelled')),
  -- Contact details for a booking taken before the customer exists as a record.
  contact_name  text,
  contact_phone text,
  note          text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_slot_order CHECK (slot_end > slot_start),

  -- The reason this module is on PostgreSQL. Two live bookings can never
  -- overlap on the same bay, enforced by the database rather than by whichever
  -- code path happened to check first. Cancelled and no-show rows are excluded
  -- so the slot frees up the moment it is released.
  CONSTRAINT ex_bookings_no_overlap EXCLUDE USING gist (
    shop_id WITH =,
    bay_id WITH =,
    tstzrange(slot_start, slot_end) WITH &&
  ) WHERE (status IN ('booked', 'confirmed', 'arrived') AND bay_id IS NOT NULL)
);
CREATE INDEX idx_bookings_day ON bookings (shop_id, slot_start);
-- Drives the "who was supposed to come today and hasn't" list.
CREATE INDEX idx_bookings_pending ON bookings (shop_id, slot_start)
  WHERE status IN ('booked', 'confirmed');
CREATE INDEX idx_bookings_phone ON bookings (shop_id, contact_phone)
  WHERE contact_phone IS NOT NULL;
CALL apply_tenant_rls('bookings');

CREATE TRIGGER trg_bookings_updated BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A booking with no bay_id is a soft reservation — the customer is expected but
-- no bay is committed. Those do not participate in the overlap constraint,
-- which is deliberate: a shop that does not assign bays should still be able to
-- take bookings.
