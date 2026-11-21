// Postgres implementation of ProcurementStore. Every query runs on the transaction client that
// withTenantTransaction opened, so row-level security applies. Dates and timestamps are cast to
// ISO text in SQL so the records match the in-memory store exactly.

import type { Pool, PoolClient } from "pg";
import { withTenantTransaction } from "./db/tenant.js";
import type { UnitOfWork } from "./uow.js";
import type {
  IdempotencyRecord, ListPage, OutboxEvent, ProcurementStore, PurchaseOrderLineRecord, PurchaseOrderRecord,
  PurchaseRequestLineRecord, PurchaseRequestRecord, RfqQuoteRecord, RfqRecord, SupplierRecord,
} from "./store.js";
import type { PurchaseOrderStatus, PurchaseRequestStatus, RfqStatus, SupplierStatus } from "./state.js";

const ISO_TS = `to_char(%COL% AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ISO_DATE = `to_char(%COL%, 'YYYY-MM-DD')`;
const ts = (col: string) => ISO_TS.replace("%COL%", col) + ` AS ${col.split(".").pop()}`;
const dt = (col: string) => ISO_DATE.replace("%COL%", col) + ` AS ${col.split(".").pop()}`;

function page<T extends { id: string }>(rows: T[], limit: number): ListPage<T> {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString("base64url") : null;
  return { items, nextCursor };
}

function decodeCursor(cursor: string | null): string | null {
  return cursor ? Buffer.from(cursor, "base64url").toString("utf8") : null;
}

export class PgProcurementStore implements ProcurementStore {
  constructor(private readonly db: PoolClient | Pool, private readonly tenantId: string) {}

  private q<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    return this.db.query(sql, params).then((r) => r.rows as R[]);
  }

  // Suppliers
  async listSuppliers(tenantId: string, filter: { status?: SupplierStatus; search?: string }, limit: number, cursor: string | null) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT id, tenant_id, party_id, name, status, categories, grade, score::text, ${dt("qualified_on")}, ${dt("next_review_on")}, ${dt("trial_until")}
         FROM procurement.suppliers
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
          AND ($4::uuid IS NULL OR id > $4::uuid)
        ORDER BY id LIMIT $5`,
      [tenantId, filter.status ?? null, filter.search ?? null, decodeCursor(cursor), limit + 1],
    );
    return page(rows.map(supplierFrom), limit);
  }

  async getSupplier(tenantId: string, id: string) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT id, tenant_id, party_id, name, status, categories, grade, score::text, ${dt("qualified_on")}, ${dt("next_review_on")}, ${dt("trial_until")}
         FROM procurement.suppliers WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? supplierFrom(rows[0]) : null;
  }

  async saveSupplier(r: SupplierRecord) {
    await this.q(
      `INSERT INTO procurement.suppliers (id, tenant_id, party_id, name, status, categories, grade, score, qualified_on, next_review_on, trial_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, grade = EXCLUDED.grade, score = EXCLUDED.score,
         qualified_on = EXCLUDED.qualified_on, next_review_on = EXCLUDED.next_review_on, trial_until = EXCLUDED.trial_until`,
      [r.id, r.tenantId, r.partyId, r.name, r.status, r.categories, r.grade, r.score, r.qualifiedOn, r.nextReviewOn, r.trialUntil],
    );
  }

  // Purchase requests
  private async requestLines(id: string): Promise<PurchaseRequestLineRecord[]> {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT item_id, description, specification, quantity_scaled::text, ${dt("required_by")} FROM procurement.purchase_request_lines WHERE request_id = $1 ORDER BY line_no`,
      [id],
    );
    return rows.map((l) => ({
      itemId: String(l.item_id), description: (l.description as string) ?? null, specification: (l.specification as string) ?? null,
      quantityScaled: BigInt(String(l.quantity_scaled)), requiredBy: String(l.required_by),
    }));
  }

  private async requestFrom(row: Record<string, unknown>): Promise<PurchaseRequestRecord> {
    return {
      id: String(row.id), tenantId: String(row.tenant_id), number: String(row.number), status: row.status as PurchaseRequestStatus,
      source: String(row.source), requestedBy: String(row.requested_by), departmentId: (row.department_id as string) ?? null,
      lines: await this.requestLines(String(row.id)), createdAt: String(row.created_at),
    };
  }

  async listPurchaseRequests(tenantId: string, status: PurchaseRequestStatus | undefined, limit: number, cursor: string | null) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT id, tenant_id, number, status, source, requested_by, department_id, ${ts("created_at")}
         FROM procurement.purchase_requests
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id LIMIT $4`,
      [tenantId, status ?? null, decodeCursor(cursor), limit + 1],
    );
    const records = await Promise.all(rows.map((r) => this.requestFrom(r)));
    return page(records, limit);
  }

  async getPurchaseRequest(tenantId: string, id: string) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT id, tenant_id, number, status, source, requested_by, department_id, ${ts("created_at")} FROM procurement.purchase_requests WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? this.requestFrom(rows[0]) : null;
  }

  async savePurchaseRequest(r: PurchaseRequestRecord) {
    await this.q(
      `INSERT INTO procurement.purchase_requests (id, tenant_id, number, status, source, requested_by, department_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [r.id, r.tenantId, r.number, r.status, r.source, r.requestedBy, r.departmentId, r.createdAt],
    );
    await this.q("DELETE FROM procurement.purchase_request_lines WHERE request_id = $1", [r.id]);
    for (const [i, l] of r.lines.entries()) {
      await this.q(
        `INSERT INTO procurement.purchase_request_lines (tenant_id, request_id, line_no, item_id, description, specification, quantity_scaled, required_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.tenantId, r.id, i + 1, l.itemId, l.description, l.specification, l.quantityScaled.toString(), l.requiredBy],
      );
    }
  }

  async nextNumber(tenantId: string, key: "purchase-request" | "purchase-order" | "rfq") {
    const rows = await this.q<{ last_value: string }>(
      `INSERT INTO procurement.number_sequences (tenant_id, key, last_value) VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, key) DO UPDATE SET last_value = procurement.number_sequences.last_value + 1
       RETURNING last_value`,
      [tenantId, key],
    );
    const prefix = key === "purchase-request" ? "PR" : key === "rfq" ? "RFQ" : "PO";
    return `${prefix}-${String(rows[0]!.last_value).padStart(6, "0")}`;
  }

  // Purchase orders
  private async orderLines(id: string): Promise<PurchaseOrderLineRecord[]> {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT line_no, item_id, description, quantity_scaled::text, received_quantity_scaled::text, unit_price_minor::text, tax_bps, ${dt("required_by")}, line_total_minor::text
         FROM procurement.purchase_order_lines WHERE order_id = $1 ORDER BY line_no`,
      [id],
    );
    return rows.map((l) => ({
      lineNo: Number(l.line_no), itemId: String(l.item_id), description: (l.description as string) ?? null,
      quantityScaled: BigInt(String(l.quantity_scaled)), receivedScaledQuantity: BigInt(String(l.received_quantity_scaled)),
      unitPriceMinor: BigInt(String(l.unit_price_minor)), taxBps: BigInt(Number(l.tax_bps)), requiredBy: String(l.required_by),
      lineTotalMinor: BigInt(String(l.line_total_minor)),
    }));
  }

  private async orderFrom(row: Record<string, unknown>): Promise<PurchaseOrderRecord> {
    const currency = String(row.currency).trim();
    return {
      id: String(row.id), tenantId: String(row.tenant_id), number: String(row.number), status: row.status as PurchaseOrderStatus,
      supplierId: String(row.supplier_id), rfqId: (row.rfq_id as string) ?? null, currency,
      paymentTerms: (row.payment_terms as string) ?? null, deliveryLocation: (row.delivery_location as string) ?? null,
      lines: await this.orderLines(String(row.id)), totalMinor: BigInt(String(row.total_minor)),
      approvalRoles: row.approval_roles as string[], approvalStep: row.approval_step === null ? null : Number(row.approval_step),
      acknowledgedOn: (row.acknowledged_on as string) ?? null, signedCopyRef: (row.signed_copy_ref as string) ?? null,
      releasedAt: (row.released_at as string) ?? null, dueAcknowledgementAt: (row.due_acknowledgement_at as string) ?? null,
      createdAt: String(row.created_at),
    };
  }

  private static orderColumns = `id, tenant_id, number, status, supplier_id, rfq_id, currency, payment_terms, delivery_location, total_minor::text,
    approval_roles, approval_step, ${dt("acknowledged_on")}, signed_copy_ref, ${ts("released_at")}, ${ts("due_acknowledgement_at")}, ${ts("created_at")}`;

  async listPurchaseOrders(tenantId: string, filter: { status?: PurchaseOrderStatus; supplierId?: string }, limit: number, cursor: string | null) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT ${PgProcurementStore.orderColumns} FROM procurement.purchase_orders
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR supplier_id = $3::uuid)
          AND ($4::uuid IS NULL OR id > $4::uuid)
        ORDER BY id LIMIT $5`,
      [tenantId, filter.status ?? null, filter.supplierId ?? null, decodeCursor(cursor), limit + 1],
    );
    return page(await Promise.all(rows.map((r) => this.orderFrom(r))), limit);
  }

  async getPurchaseOrder(tenantId: string, id: string) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT ${PgProcurementStore.orderColumns} FROM procurement.purchase_orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? this.orderFrom(rows[0]) : null;
  }

  async savePurchaseOrder(o: PurchaseOrderRecord) {
    await this.q(
      `INSERT INTO procurement.purchase_orders (id, tenant_id, number, status, supplier_id, rfq_id, currency, payment_terms, delivery_location,
         total_minor, approval_roles, approval_step, acknowledged_on, signed_copy_ref, released_at, due_acknowledgement_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, approval_step = EXCLUDED.approval_step,
         acknowledged_on = EXCLUDED.acknowledged_on, signed_copy_ref = EXCLUDED.signed_copy_ref,
         released_at = EXCLUDED.released_at, due_acknowledgement_at = EXCLUDED.due_acknowledgement_at`,
      [o.id, o.tenantId, o.number, o.status, o.supplierId, o.rfqId, o.currency, o.paymentTerms, o.deliveryLocation,
        o.totalMinor.toString(), o.approvalRoles, o.approvalStep, o.acknowledgedOn, o.signedCopyRef, o.releasedAt, o.dueAcknowledgementAt, o.createdAt],
    );
    await this.q("DELETE FROM procurement.purchase_order_lines WHERE order_id = $1", [o.id]);
    for (const l of o.lines) {
      await this.q(
        `INSERT INTO procurement.purchase_order_lines (tenant_id, order_id, line_no, item_id, description, quantity_scaled, received_quantity_scaled,
           unit_price_minor, tax_bps, required_by, line_total_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [o.tenantId, o.id, l.lineNo, l.itemId, l.description, l.quantityScaled.toString(), l.receivedScaledQuantity.toString(),
          l.unitPriceMinor.toString(), Number(l.taxBps), l.requiredBy, l.lineTotalMinor.toString()],
      );
    }
  }

  // RFQs
  private async rfqFrom(row: Record<string, unknown>): Promise<RfqRecord> {
    const quotes = await this.q<Record<string, unknown>>(
      `SELECT supplier_id, unit_price_minor::text, currency, tax_bps, freight_minor::text, insurance_minor::text, lead_time_days,
              payment_terms, warranty_months, ${dt("valid_until")}, deviations, ${ts("quoted_at")}
         FROM procurement.rfq_quotes WHERE rfq_id = $1 ORDER BY quoted_at, supplier_id`,
      [String(row.id)],
    );
    return {
      id: String(row.id), tenantId: String(row.tenant_id), number: String(row.number), status: row.status as RfqStatus,
      purchaseRequestIds: (row.purchase_request_ids as string[]).map(String), supplierIds: (row.supplier_ids as string[]).map(String),
      responseDeadline: String(row.response_deadline), deliveryLocation: (row.delivery_location as string) ?? null,
      termsAndConditions: (row.terms_and_conditions as string) ?? null,
      quotes: quotes.map((q): RfqQuoteRecord => ({
        supplierId: String(q.supplier_id), unitPriceMinor: BigInt(String(q.unit_price_minor)), currency: String(q.currency).trim(),
        taxBps: BigInt(Number(q.tax_bps)), freightMinor: BigInt(String(q.freight_minor)), insuranceMinor: BigInt(String(q.insurance_minor)),
        leadTimeDays: Number(q.lead_time_days), paymentTerms: (q.payment_terms as string) ?? null,
        warrantyMonths: q.warranty_months === null ? null : Number(q.warranty_months), validUntil: (q.valid_until as string) ?? null,
        deviations: (q.deviations as string) ?? null, quotedAt: String(q.quoted_at),
      })),
      awardedSupplierId: (row.awarded_supplier_id as string) ?? null, createdAt: String(row.created_at),
    };
  }

  private static rfqColumns = `id, tenant_id, number, status, purchase_request_ids, supplier_ids, ${ts("response_deadline")}, delivery_location,
    terms_and_conditions, awarded_supplier_id, ${ts("created_at")}`;

  async listRfqs(tenantId: string, status: RfqStatus | undefined, limit: number, cursor: string | null) {
    const rows = await this.q<Record<string, unknown>>(
      `SELECT ${PgProcurementStore.rfqColumns} FROM procurement.rfqs
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id LIMIT $4`,
      [tenantId, status ?? null, decodeCursor(cursor), limit + 1],
    );
    return page(await Promise.all(rows.map((r) => this.rfqFrom(r))), limit);
  }

  async getRfq(tenantId: string, id: string) {
    const rows = await this.q<Record<string, unknown>>(`SELECT ${PgProcurementStore.rfqColumns} FROM procurement.rfqs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? this.rfqFrom(rows[0]) : null;
  }

  async saveRfq(r: RfqRecord) {
    await this.q(
      `INSERT INTO procurement.rfqs (id, tenant_id, number, status, purchase_request_ids, supplier_ids, response_deadline, delivery_location,
         terms_and_conditions, awarded_supplier_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, awarded_supplier_id = EXCLUDED.awarded_supplier_id`,
      [r.id, r.tenantId, r.number, r.status, r.purchaseRequestIds, r.supplierIds, r.responseDeadline, r.deliveryLocation,
        r.termsAndConditions, r.awardedSupplierId, r.createdAt],
    );
    for (const q of r.quotes) {
      await this.q(
        `INSERT INTO procurement.rfq_quotes (tenant_id, rfq_id, supplier_id, unit_price_minor, currency, tax_bps, freight_minor, insurance_minor,
           lead_time_days, payment_terms, warranty_months, valid_until, deviations, quoted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (rfq_id, supplier_id) DO NOTHING`,
        [r.tenantId, r.id, q.supplierId, q.unitPriceMinor.toString(), q.currency, Number(q.taxBps), q.freightMinor.toString(),
          q.insuranceMinor.toString(), q.leadTimeDays, q.paymentTerms, q.warrantyMonths, q.validUntil, q.deviations, q.quotedAt],
      );
    }
  }

  // Outbox and idempotency
  async appendOutbox(event: OutboxEvent) {
    await this.q("INSERT INTO procurement.outbox (id, tenant_id, event_type, payload, created_at) VALUES ($1, $2, $3, $4, $5)",
      [event.id, event.tenantId, event.eventType, JSON.stringify(event.payload), event.createdAt]);
  }

  async findIdempotency(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
    const rows = await this.q<{ request_hash: string; status: number; body: unknown }>(
      "SELECT request_hash, status, body FROM procurement.idempotency_keys WHERE tenant_id = $1 AND key = $2", [tenantId, key]);
    return rows[0] ? { requestHash: rows[0].request_hash, status: rows[0].status, body: rows[0].body } : null;
  }

  async saveIdempotency(tenantId: string, key: string, record: IdempotencyRecord) {
    await this.q(
      `INSERT INTO procurement.idempotency_keys (tenant_id, key, request_hash, status, body) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, key, record.requestHash, record.status, JSON.stringify(record.body)],
    );
  }
}

function supplierFrom(row: Record<string, unknown>): SupplierRecord {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), partyId: String(row.party_id), name: String(row.name),
    status: row.status as SupplierStatus, categories: row.categories as string[], grade: (row.grade as SupplierRecord["grade"]) ?? null,
    score: (row.score as string) ?? null, qualifiedOn: (row.qualified_on as string) ?? null,
    nextReviewOn: (row.next_review_on as string) ?? null, trialUntil: (row.trial_until as string) ?? null,
  };
}

/** Runs each request in one tenant-scoped transaction on the Postgres pool. */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  run<T>(tenantId: string, work: (store: ProcurementStore) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, tenantId, (client) => work(new PgProcurementStore(client, tenantId)));
  }
}
