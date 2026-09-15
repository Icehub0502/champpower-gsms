-- =============================================================================
-- 0004_documents.sql — quotations, work orders, receipts, tax invoices
--
-- WHAT:     The document layer. A job is work; a document is a photograph of
--           that work at one moment, and once numbered it never changes.
-- WHY:      Today prices live on the job itself, so editing a job silently
--           rewrites history and the paper in the customer's hand stops
--           matching the system. Everything from here down depends on this
--           separation holding.
-- ROLLBACK: DROP TABLE vehicle_offered_items, document_lines, documents CASCADE;
-- LOCKS:    None; tables are new.
-- =============================================================================

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  job_id        uuid REFERENCES jobs(id) ON DELETE RESTRICT,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  type          text NOT NULL CHECK (type IN (
                  'quotation', 'work_order', 'receipt',
                  'tax_invoice', 'abbreviated_tax_invoice', 'credit_note')),
  series        text NOT NULL,

  -- NULL until the document is issued. A draft carries no number, so a booking
  -- that never arrives and a quotation the customer never signs consume nothing
  -- from the sequence — which is what keeps the tax series gap-free.
  --
  -- The value is produced by allocate_document_number() (0003) from the shop's
  -- configured pattern, in the same transaction that sets status to 'issued'.
  -- It is stored, not derived: Samut Prakan keeps its existing formats while a
  -- new branch picks its own, so there is no single expression to generate from.
  number        text,
  -- The local day the number was allocated for. Kept because the pattern may
  -- embed the date, and a document must never renumber if the pattern changes.
  numbered_on   date,

  revision              integer NOT NULL DEFAULT 1,
  supersedes_document_id uuid REFERENCES documents(id) ON DELETE RESTRICT,
  -- A tax invoice points back at the bill it was raised from. Never null for
  -- tax documents: no free-floating tax invoices, whatever the convenience.
  source_document_id    uuid REFERENCES documents(id) ON DELETE RESTRICT,

  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'signed', 'issued', 'void')),
  void_reason   text,
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  -- VAT. none = the ordinary case. add_7 = the customer asked and pays the 7%.
  -- include_7 = a company wanted the invoice, the customer paid the plain
  -- amount and the shop absorbed the tax.
  vat_mode      text NOT NULL DEFAULT 'none'
                CHECK (vat_mode IN ('none', 'add_7', 'include_7')),

  -- Two totals, always. offered is every line; approved is what the customer
  -- accepted, and it is approved that flows to the receipt.
  offered_total   numeric(12,2) NOT NULL DEFAULT 0,
  approved_total  numeric(12,2) NOT NULL DEFAULT 0,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  vat_base        numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount      numeric(12,2) NOT NULL DEFAULT 0,
  -- Under include_7 this is margin the shop gave up. It has to be visible in a
  -- monthly report or it disappears quietly into the accounts.
  vat_absorbed    numeric(12,2) NOT NULL DEFAULT 0,
  grand_total     numeric(12,2) NOT NULL DEFAULT 0,

  -- Both parties as they were on the day of issue. Addresses and registered
  -- names change; a reissued document must not.
  buyer_legal_name   text,
  buyer_tax_id       text,
  buyer_branch_code  text,
  buyer_address      text,
  seller_legal_name  text,
  seller_tax_id      text,
  seller_branch_code text,
  seller_address     text,

  -- The customer's signature freezes the quotation. It belongs to the document,
  -- not the job, because there can be several revisions each with its own.
  signature_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  signed_at          timestamptz,
  -- The rendered artifact. Stored, never re-rendered: a template change must
  -- not alter a document issued last year.
  pdf_file_id        uuid REFERENCES files(id) ON DELETE SET NULL,

  issued_at     timestamptz,
  issued_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_documents_number UNIQUE (shop_id, series, number),
  -- Draft has no number; anything past draft must have one. This is the pair of
  -- rules that makes "allocate at issue" enforceable rather than a convention.
  CONSTRAINT ck_number_when_issued CHECK (
    (status = 'draft' AND number IS NULL) OR
    (status <> 'draft' AND number IS NOT NULL AND numbered_on IS NOT NULL)),
  -- Tax documents must always trace back to a real bill.
  CONSTRAINT ck_tax_has_source CHECK (
    type NOT IN ('tax_invoice', 'abbreviated_tax_invoice', 'credit_note')
    OR source_document_id IS NOT NULL),
  -- A void must say why. "It was wrong" written nowhere helps nobody later.
  CONSTRAINT ck_void_reason CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE INDEX idx_documents_job ON documents (shop_id, job_id, type);
CREATE INDEX idx_documents_customer ON documents (shop_id, customer_id, issued_at DESC);
CREATE INDEX idx_documents_type_issued ON documents (shop_id, type, issued_at DESC);
CREATE INDEX idx_documents_supersedes ON documents (supersedes_document_id)
  WHERE supersedes_document_id IS NOT NULL;
CALL apply_tenant_rls('documents');

CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Once a document is issued or signed, nothing on it may change except the
-- fields that record a void. Enforced here rather than trusted to every code
-- path that might one day touch the table.
CREATE OR REPLACE FUNCTION documents_are_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('signed', 'issued') THEN
    IF NEW.status = 'void'
       AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)
       AND NEW.type = OLD.type AND NEW.number = OLD.number
       AND NEW.grand_total = OLD.grand_total THEN
      RETURN NEW;  -- voiding is the one permitted transition
    END IF;
    RAISE EXCEPTION 'document % is % and cannot be modified', OLD.number, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_immutable BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_are_immutable();


-- -----------------------------------------------------------------------------
-- Document lines
-- -----------------------------------------------------------------------------

CREATE TABLE document_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The line on the previous revision this one came from, so a customer can be
  -- shown what changed between rev 1 and rev 2.
  source_line_id uuid REFERENCES document_lines(id) ON DELETE SET NULL,

  -- Parts consume stock and can carry VAT. Labour does neither — the shop
  -- charges for it separately but never puts it on a tax invoice.
  line_type      text NOT NULL DEFAULT 'part'
                 CHECK (line_type IN ('part', 'labor', 'fee')),
  sku_id         uuid,  -- FK added in 0006 once skus exists

  -- Snapshot. The print reads these, never the live catalog.
  name_snapshot  text NOT NULL,
  brand_snapshot text,
  qty            numeric(12,2) NOT NULL DEFAULT 1,
  unit           text,
  unit_price     numeric(12,2) NOT NULL DEFAULT 0,
  line_total     numeric(12,2) NOT NULL DEFAULT 0,
  is_vatable     boolean NOT NULL DEFAULT false,

  -- The customer approves line by line. A declined line stays on the document
  -- and stays on the print: the shop needs to prove it offered the work.
  approval_status text NOT NULL DEFAULT 'pending'
                  CHECK (approval_status IN ('pending', 'approved', 'declined')),
  decided_at      timestamptz,
  -- Why the customer said no. The owner's biggest blind spot today.
  decline_reason  text CHECK (decline_reason IN (
                    'too_expensive', 'next_time', 'going_elsewhere',
                    'not_needed_yet', 'other')),
  decline_note    text,

  -- What was actually done, ticked off before the receipt is issued.
  -- The receipt bills approved ∩ fulfilled, not everything approved.
  fulfilled_qty   numeric(12,2),

  sort_order      integer NOT NULL DEFAULT 0,

  -- Labour never carries VAT, whatever the UI sends.
  CONSTRAINT ck_labor_no_vat CHECK (line_type <> 'labor' OR is_vatable = false),
  -- A decline reason without a decline, or a decline without a reason, is a
  -- data-entry bug worth catching at the boundary.
  CONSTRAINT ck_decline_reason CHECK (
    (approval_status = 'declined') = (decline_reason IS NOT NULL))
);
CREATE INDEX idx_doc_lines_document ON document_lines (document_id, sort_order);
CREATE INDEX idx_doc_lines_sku ON document_lines (shop_id, sku_id)
  WHERE sku_id IS NOT NULL;
-- Feeds the "why do customers say no" report.
CREATE INDEX idx_doc_lines_declined ON document_lines (shop_id, decline_reason)
  WHERE approval_status = 'declined';
CALL apply_tenant_rls('document_lines');


-- -----------------------------------------------------------------------------
-- Offered items — the sales follow-up the shop does not have today
-- -----------------------------------------------------------------------------
-- A line the customer turned down is a real sales opportunity next visit, and
-- proof of what was recommended if a part later fails.

CREATE TABLE vehicle_offered_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  vehicle_id        uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  document_line_id  uuid NOT NULL REFERENCES document_lines(id) ON DELETE CASCADE,
  name              text NOT NULL,
  offered_at        timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'declined'
                    CHECK (status IN ('declined', 'done_later', 'dismissed')),

  CONSTRAINT uq_offered_line UNIQUE (document_line_id)
);
CREATE INDEX idx_offered_vehicle ON vehicle_offered_items (shop_id, vehicle_id, offered_at DESC)
  WHERE status = 'declined';
CALL apply_tenant_rls('vehicle_offered_items');
