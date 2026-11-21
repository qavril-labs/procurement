// Storage interface for the procurement service. Every method takes the tenant id, so a
// store can never return another tenant's rows. The in-memory store below backs the unit
// tests; the Postgres store implements the same interface inside withTenantTransaction.

import type { PurchaseOrderStatus, PurchaseRequestStatus, RfqStatus, SupplierStatus } from "./state.js";

export interface SupplierRecord {
  id: string;
  tenantId: string;
  partyId: string;
  name: string;
  status: SupplierStatus;
  categories: string[];
  grade: "A" | "B" | "C" | "D" | null;
  score: string | null;
  qualifiedOn: string | null;
  nextReviewOn: string | null;
  trialUntil: string | null;
}

export interface PurchaseRequestLineRecord {
  itemId: string;
  description: string | null;
  specification: string | null;
  quantityScaled: bigint;
  requiredBy: string;
}

export interface PurchaseRequestRecord {
  id: string;
  tenantId: string;
  number: string;
  status: PurchaseRequestStatus;
  source: string;
  requestedBy: string;
  departmentId: string | null;
  lines: PurchaseRequestLineRecord[];
  createdAt: string;
}

export interface PurchaseOrderLineRecord {
  lineNo: number;
  itemId: string;
  description: string | null;
  quantityScaled: bigint;
  receivedScaledQuantity: bigint;
  unitPriceMinor: bigint;
  taxBps: bigint;
  requiredBy: string;
  lineTotalMinor: bigint;
}

export interface PurchaseOrderRecord {
  id: string;
  tenantId: string;
  number: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  rfqId: string | null;
  currency: string;
  paymentTerms: string | null;
  deliveryLocation: string | null;
  lines: PurchaseOrderLineRecord[];
  totalMinor: bigint;
  approvalRoles: string[];
  approvalStep: number | null;
  acknowledgedOn: string | null;
  signedCopyRef: string | null;
  dueAcknowledgementAt: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface RfqQuoteRecord {
  supplierId: string;
  unitPriceMinor: bigint;
  currency: string;
  taxBps: bigint;
  freightMinor: bigint;
  insuranceMinor: bigint;
  leadTimeDays: number;
  paymentTerms: string | null;
  warrantyMonths: number | null;
  validUntil: string | null;
  deviations: string | null;
  quotedAt: string;
}

export interface RfqRecord {
  id: string;
  tenantId: string;
  number: string;
  status: RfqStatus;
  purchaseRequestIds: string[];
  supplierIds: string[];
  responseDeadline: string;
  deliveryLocation: string | null;
  termsAndConditions: string | null;
  quotes: RfqQuoteRecord[];
  awardedSupplierId: string | null;
  createdAt: string;
}

export interface OutboxEvent {
  id: string;
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IdempotencyRecord {
  requestHash: string;
  status: number;
  body: unknown;
}

export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ProcurementStore {
  listSuppliers(tenantId: string, filter: { status?: SupplierStatus; search?: string }, limit: number, cursor: string | null): Promise<ListPage<SupplierRecord>>;
  getSupplier(tenantId: string, id: string): Promise<SupplierRecord | null>;
  saveSupplier(record: SupplierRecord): Promise<void>;

  listPurchaseRequests(tenantId: string, status: PurchaseRequestStatus | undefined, limit: number, cursor: string | null): Promise<ListPage<PurchaseRequestRecord>>;
  getPurchaseRequest(tenantId: string, id: string): Promise<PurchaseRequestRecord | null>;
  savePurchaseRequest(record: PurchaseRequestRecord): Promise<void>;
  nextNumber(tenantId: string, key: "purchase-request" | "purchase-order" | "rfq"): Promise<string>;

  listPurchaseOrders(tenantId: string, filter: { status?: PurchaseOrderStatus; supplierId?: string }, limit: number, cursor: string | null): Promise<ListPage<PurchaseOrderRecord>>;
  getPurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrderRecord | null>;
  savePurchaseOrder(record: PurchaseOrderRecord): Promise<void>;

  listRfqs(tenantId: string, status: RfqStatus | undefined, limit: number, cursor: string | null): Promise<ListPage<RfqRecord>>;
  getRfq(tenantId: string, id: string): Promise<RfqRecord | null>;
  saveRfq(record: RfqRecord): Promise<void>;

  appendOutbox(event: OutboxEvent): Promise<void>;
  findIdempotency(tenantId: string, key: string): Promise<IdempotencyRecord | null>;
  saveIdempotency(tenantId: string, key: string, record: IdempotencyRecord): Promise<void>;
}

function page<T>(items: T[], limit: number, cursor: string | null): ListPage<T> {
  const start = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString("base64url") : null;
  return { items: slice, nextCursor: next };
}

/** In-memory store for tests and local runs. Not for production data. */
export class MemoryProcurementStore implements ProcurementStore {
  private suppliers = new Map<string, SupplierRecord>();
  private requests = new Map<string, PurchaseRequestRecord>();
  private orders = new Map<string, PurchaseOrderRecord>();
  readonly outbox: OutboxEvent[] = [];
  private idem = new Map<string, IdempotencyRecord>();
  private counters = new Map<string, number>();
  private rfqs = new Map<string, RfqRecord>();

  async listSuppliers(tenantId: string, filter: { status?: SupplierStatus; search?: string }, limit: number, cursor: string | null) {
    const all = [...this.suppliers.values()]
      .filter((s) => s.tenantId === tenantId)
      .filter((s) => !filter.status || s.status === filter.status)
      .filter((s) => !filter.search || s.name.toLowerCase().includes(filter.search.toLowerCase()));
    return page(all, limit, cursor);
  }
  async getSupplier(tenantId: string, id: string) {
    const s = this.suppliers.get(id);
    return s && s.tenantId === tenantId ? s : null;
  }
  async saveSupplier(record: SupplierRecord) {
    this.suppliers.set(record.id, record);
  }

  async listPurchaseRequests(tenantId: string, status: PurchaseRequestStatus | undefined, limit: number, cursor: string | null) {
    const all = [...this.requests.values()].filter((r) => r.tenantId === tenantId && (!status || r.status === status));
    return page(all, limit, cursor);
  }
  async getPurchaseRequest(tenantId: string, id: string) {
    const r = this.requests.get(id);
    return r && r.tenantId === tenantId ? r : null;
  }
  async savePurchaseRequest(record: PurchaseRequestRecord) {
    this.requests.set(record.id, record);
  }
  async nextNumber(tenantId: string, key: "purchase-request" | "purchase-order" | "rfq") {
    const k = `${tenantId}:${key}`;
    const n = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, n);
    const prefix = key === "purchase-request" ? "PR" : key === "rfq" ? "RFQ" : "PO";
    return `${prefix}-${String(n).padStart(6, "0")}`;
  }

  async listPurchaseOrders(tenantId: string, filter: { status?: PurchaseOrderStatus; supplierId?: string }, limit: number, cursor: string | null) {
    const all = [...this.orders.values()]
      .filter((o) => o.tenantId === tenantId)
      .filter((o) => !filter.status || o.status === filter.status)
      .filter((o) => !filter.supplierId || o.supplierId === filter.supplierId);
    return page(all, limit, cursor);
  }
  async getPurchaseOrder(tenantId: string, id: string) {
    const o = this.orders.get(id);
    return o && o.tenantId === tenantId ? o : null;
  }
  async savePurchaseOrder(record: PurchaseOrderRecord) {
    this.orders.set(record.id, record);
  }

  async listRfqs(tenantId: string, status: RfqStatus | undefined, limit: number, cursor: string | null) {
    const all = [...this.rfqs.values()].filter((r) => r.tenantId === tenantId && (!status || r.status === status));
    return page(all, limit, cursor);
  }
  async getRfq(tenantId: string, id: string) {
    const r = this.rfqs.get(id);
    return r && r.tenantId === tenantId ? r : null;
  }
  async saveRfq(record: RfqRecord) {
    this.rfqs.set(record.id, record);
  }

  async appendOutbox(event: OutboxEvent) {
    this.outbox.push(event);
  }
  async findIdempotency(tenantId: string, key: string) {
    return this.idem.get(`${tenantId}:${key}`) ?? null;
  }
  async saveIdempotency(tenantId: string, key: string, record: IdempotencyRecord) {
    this.idem.set(`${tenantId}:${key}`, record);
  }
}
