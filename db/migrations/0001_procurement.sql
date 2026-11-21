-- 0001_procurement: suppliers, purchase requests, purchase orders, outbox, idempotency.
-- Runs as the owner role. Every tenant table has tenant_id and row-level security; the app
-- sets app.tenant_id per transaction (src/db/tenant.ts). Money is bigint minor units with a
-- currency code; quantities are integers scaled by 10^4 (see src/money.ts).

CREATE SCHEMA IF NOT EXISTS procurement;

CREATE TABLE procurement.suppliers (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  party_id        uuid NOT NULL,
  name            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending-qualification', 'approved', 'conditionally-approved', 'on-hold', 'rejected')),
  categories      text[] NOT NULL,
  grade           char(1) CHECK (grade IN ('A', 'B', 'C', 'D')),
  score           numeric(5,1),
  qualified_on    date,
  next_review_on  date,
  trial_until     date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE procurement.purchase_requests (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  number          text NOT NULL,
  status          text NOT NULL CHECK (status IN ('submitted', 'in-approval', 'approved', 'rejected', 'converted', 'cancelled')),
  source          text NOT NULL CHECK (source IN ('stores-reorder', 'stores-order-shortage', 'department')),
  requested_by    uuid NOT NULL,
  department_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE procurement.purchase_request_lines (
  tenant_id        uuid NOT NULL,
  request_id       uuid NOT NULL REFERENCES procurement.purchase_requests (id),
  line_no          integer NOT NULL,
  item_id          uuid NOT NULL,
  description      text,
  specification    text,
  quantity_scaled  bigint NOT NULL CHECK (quantity_scaled > 0),
  required_by      date NOT NULL,
  PRIMARY KEY (request_id, line_no)
);

CREATE TABLE procurement.purchase_orders (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL,
  number                 text NOT NULL,
  status                 text NOT NULL CHECK (status IN ('draft', 'in-approval', 'approved', 'rejected', 'released', 'acknowledged', 'partially-received', 'received', 'closed', 'cancelled')),
  supplier_id            uuid NOT NULL REFERENCES procurement.suppliers (id),
  rfq_id                 uuid,
  currency               char(3) NOT NULL,
  payment_terms          text,
  delivery_location      text,
  total_minor            bigint NOT NULL,
  approval_roles         text[] NOT NULL,
  approval_step          integer,
  acknowledged_on        date,
  signed_copy_ref        text,
  released_at            timestamptz,
  due_acknowledgement_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE procurement.purchase_order_lines (
  tenant_id                 uuid NOT NULL,
  order_id                  uuid NOT NULL REFERENCES procurement.purchase_orders (id),
  line_no                   integer NOT NULL,
  item_id                   uuid NOT NULL,
  description               text,
  quantity_scaled           bigint NOT NULL CHECK (quantity_scaled > 0),
  received_quantity_scaled  bigint NOT NULL DEFAULT 0 CHECK (received_quantity_scaled >= 0),
  unit_price_minor          bigint NOT NULL CHECK (unit_price_minor >= 0),
  tax_bps                   integer NOT NULL CHECK (tax_bps >= 0),
  required_by               date NOT NULL,
  line_total_minor          bigint NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

-- Outbox: written in the same transaction as the business change, then relayed.
CREATE TABLE procurement.outbox (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

-- Idempotency: one stored response per tenant and key.
CREATE TABLE procurement.idempotency_keys (
  tenant_id     uuid NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status        integer NOT NULL,
  body          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Row-level security on every tenant table.
ALTER TABLE procurement.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.purchase_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.purchase_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON procurement.suppliers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.purchase_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.purchase_request_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.purchase_orders
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.purchase_order_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON procurement.idempotency_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
