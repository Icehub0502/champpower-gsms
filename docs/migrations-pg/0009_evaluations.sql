-- =============================================================================
-- 0009_evaluations.sql — quarterly staff evaluations
--
-- WHAT:     Evaluation forms the branch manager or assistant manager fills in,
--           one per person per quarter.
-- WHY:      The owner wants to know how staff are doing. The system's job is to
--           put evidence in front of the person doing the evaluating — not to
--           compute a score. Technicians here are on a fixed salary, so an
--           automatic rating would be pressure with nobody accountable for it.
-- ROLLBACK: DROP TABLE evaluation_answers, evaluations,
--           evaluation_template_items, evaluation_templates CASCADE;
-- LOCKS:    None; tables are new.
-- =============================================================================

CREATE TABLE evaluation_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  -- Technicians and office staff are judged on different things.
  target      text NOT NULL CHECK (target IN ('technician', 'office')),
  cadence     text NOT NULL DEFAULT 'quarterly' CHECK (cadence IN ('quarterly')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CALL apply_tenant_rls('evaluation_templates');

CREATE TABLE evaluation_template_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  template_id  uuid NOT NULL REFERENCES evaluation_templates(id) ON DELETE CASCADE,
  label        text NOT NULL,
  hint         text,
  scale_max    integer NOT NULL DEFAULT 5 CHECK (scale_max BETWEEN 2 AND 10),
  sort_order   integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_eval_items_template ON evaluation_template_items (template_id, sort_order);
CALL apply_tenant_rls('evaluation_template_items');


CREATE TABLE evaluations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  employee_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  -- Technicians have no login yet, so the subject is usually a technician row
  -- rather than a user. One of the two must be set.
  technician_id     uuid REFERENCES technicians(id) ON DELETE RESTRICT,
  template_id       uuid NOT NULL REFERENCES evaluation_templates(id) ON DELETE RESTRICT,

  -- Calendar quarters. The system opens the round and reminds the manager.
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  -- True when the person joined part-way through: rates computed on a short
  -- window are not comparable and the form must say so.
  short_period      boolean NOT NULL DEFAULT false,

  evaluator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- draft     — half filled in, come back to it
  -- submitted — frozen. A correction is a new row superseding this one.
  -- delivered — the manager printed the summary, sat down with the person and
  --             handed it over. Technicians do not log in, so this is how they
  --             see where they need to improve.
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'delivered')),

  supersedes_evaluation_id uuid REFERENCES evaluations(id) ON DELETE RESTRICT,
  revise_reason     text,

  -- Free text. This is the part the employee actually reads.
  strengths         text,
  areas_to_improve  text,
  evaluator_note    text,

  submitted_at      timestamptz,
  delivered_at      timestamptz,
  delivered_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  pdf_file_id       uuid REFERENCES files(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_eval_subject CHECK (
    (employee_user_id IS NOT NULL) OR (technician_id IS NOT NULL)),
  CONSTRAINT ck_eval_period CHECK (period_end > period_start),
  CONSTRAINT ck_eval_revision CHECK (
    (supersedes_evaluation_id IS NULL) = (revise_reason IS NULL)),
  -- Nobody evaluates themselves.
  CONSTRAINT ck_eval_not_self CHECK (evaluator_user_id IS DISTINCT FROM employee_user_id)
);
CREATE INDEX idx_evals_subject ON evaluations (shop_id, technician_id, period_start DESC);
CREATE INDEX idx_evals_employee ON evaluations (shop_id, employee_user_id, period_start DESC);
CREATE INDEX idx_evals_open ON evaluations (shop_id, period_end)
  WHERE status = 'draft';
CALL apply_tenant_rls('evaluations');

-- Same rule as a financial document: once submitted it is a record of what was
-- said at the time. Corrections supersede, they do not overwrite. This data
-- affects someone's livelihood and has to be traceable.
CREATE OR REPLACE FUNCTION evaluations_freeze_on_submit() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('submitted', 'delivered') THEN
    -- Only the delivery hand-off may still be recorded.
    IF NEW.status = 'delivered'
       AND NEW.employee_user_id IS NOT DISTINCT FROM OLD.employee_user_id
       AND NEW.technician_id    IS NOT DISTINCT FROM OLD.technician_id
       AND NEW.strengths        IS NOT DISTINCT FROM OLD.strengths
       AND NEW.areas_to_improve IS NOT DISTINCT FROM OLD.areas_to_improve
       AND NEW.evaluator_note   IS NOT DISTINCT FROM OLD.evaluator_note THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'evaluation % is % and cannot be edited; supersede it instead',
      OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_evals_freeze BEFORE UPDATE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION evaluations_freeze_on_submit();


CREATE TABLE evaluation_answers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  evaluation_id     uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  template_item_id  uuid NOT NULL REFERENCES evaluation_template_items(id) ON DELETE RESTRICT,
  score             integer,
  comment           text,

  CONSTRAINT uq_eval_answer UNIQUE (evaluation_id, template_item_id)
);
CALL apply_tenant_rls('evaluation_answers');


-- -----------------------------------------------------------------------------
-- Reading an evaluation is itself auditable
-- -----------------------------------------------------------------------------
-- Personnel data, so unlike everywhere else in this system the read is logged
-- as well as the write. Who opened whose evaluation, and when.
--
-- The API writes an audit_logs row with action = 'evaluation.read' on every
-- fetch. Enforced in the repository, and covered by an integration test — a
-- trigger cannot see a SELECT.
