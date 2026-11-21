-- 0002_rfq_and_numbers: requests for quotation, their quotes, and per-tenant document numbers.
-- Same rules as 0001: tenant_id on every row, row-level security, owner runs DDL.

CREATE TABLE procurement.rfqs (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  number                text NOT NULL,
  status                text NOT NULL CHECK (status IN ('open', 'quotes-in', 'compared', 'awarded', 'cancelled')),
  purchase_request_ids  uuid[] NOT NULL,
  supplier_ids          uuid[] NOT NULL,
  response_deadline     timestamptz NOT NULL,
  delivery_location     text,
  terms_and_conditions  text,
  awarded_supplier_id   uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE procurement.rfq_quotes (
  tenant_id        uuid NOT NULL,
  rfq_id           uuid NOT NULL REFERENCES procurement.rfqs (id),
  supplier_id      uuid NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency         char(3) NOT NULL,
  tax_bps          integer NOT NULL CHECK (tax_bps >= 0),
  freight_minor    bigint NOT NULL DEFAULT 0,
  insurance_minor  bigint NOT NULL DEFAULT 0,
  lead_time_days   integer NOT NULL CHECK (lead_time_days >= 0),
  payment_terms    text,
  warranty_months  integer,
  valid_until      date,
  deviations       text,
  quoted_at        timestamptz NOT NULL,
  PRIMARY KEY (rfq_id, supplier_id)
);

-- Per-tenant counters for document numbers. Incremented inside the same transaction as the document.
CREATE TABLE procurement.number_sequences (
  tenant_id   uuid NOT NULL,
  key         text NOT NULL,
  last_value  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE procurement.rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.rfq_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.number_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON procurement.rfqs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.rfq_quotes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.number_sequences
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
