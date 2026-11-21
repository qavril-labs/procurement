// Business rules for suppliers, purchase requests and purchase orders.
// Money and quantities use src/money.ts; document states use src/state.ts.

import { DomainError, forbidden, notFound, validation } from "./errors.js";
import {
  formatMoney, formatQuantity, formatRate, lineTotal, MoneyError, parseMoney, parseQuantity, parseRateBps, taxOn,
} from "./money.js";
import { newId, UUID_RE } from "./ids.js";
import type {
  ProcurementStore, PurchaseOrderLineRecord, PurchaseOrderRecord, PurchaseRequestLineRecord, PurchaseRequestRecord,
  SupplierRecord,
} from "./store.js";
import {
  assertPurchaseOrderTransition, assertPurchaseRequestTransition, canCancelPurchaseOrder,
  type PurchaseOrderStatus, type PurchaseRequestStatus, type SupplierStatus,
} from "./state.js";

export interface Caller {
  tenantId: string;
  actorId: string;
  roles: string[];
  permissions: string[];
}

export function requirePermission(caller: Caller, permission: string): void {
  if (!caller.permissions.includes(permission)) {
    throw forbidden(`missing permission ${permission}`);
  }
}

// --- Validation helpers -------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validation("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | null {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.required) throw validation(`${key} is required`, [{ field: key }]);
    return null;
  }
  if (typeof v !== "string" || v.trim() === "") throw validation(`${key} must be a non-empty string`, [{ field: key }]);
  if (opts.max && v.length > opts.max) throw validation(`${key} is too long`, [{ field: key }]);
  return v;
}

function uuid(body: Record<string, unknown>, key: string, required = true): string | null {
  const v = str(body, key, { required });
  if (v !== null && !UUID_RE.test(v)) throw validation(`${key} must be a UUID`, [{ field: key }]);
  return v;
}

function isoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw validation(`${field} must be a YYYY-MM-DD date`, [{ field }]);
  }
  return value;
}

function arr(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = body[key];
  if (!Array.isArray(v) || v.length === 0) throw validation(`${key} must be a non-empty array`, [{ field: key }]);
  return v.map((line, i) => {
    if (typeof line !== "object" || line === null || Array.isArray(line)) {
      throw validation(`${key}[${i}] must be an object`, [{ field: `${key}[${i}]` }]);
    }
    return line as Record<string, unknown>;
  });
}

function wrapMoney<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MoneyError) throw validation(error.message);
    throw error;
  }
}

// --- Suppliers ----------------------------------------------------------------------

const SCORECARD: Record<string, number> = {
  "product-quality": 50,
  delivery: 10,
  "pricing-competitiveness": 10,
  "communication-and-response": 5,
  "compliance-with-specification": 10,
  "technical-capability": 5,
  "service-and-support": 5,
  "reliability-and-consistency": 5,
};

/** Weighted score as a percentage string, using the purchasing SOP weights (scores 1 to 5). */
export function scorecardPercent(scores: Record<string, number>): number {
  let total = 0;
  for (const [criterion, weight] of Object.entries(SCORECARD)) {
    const s = scores[criterion];
    if (s === undefined) throw validation(`missing score for ${criterion}`, [{ field: criterion }]);
    total += s * weight;
  }
  return total / 5; // maximum is 5 * 100, which is 100 percent
}

/** Grade bands from the purchasing SOP. A critical failure overrides the score. */
export function gradeFor(percent: number): { grade: "A" | "B" | "C" | "D"; status: SupplierStatus } {
  if (percent >= 70) return { grade: "A", status: "approved" };
  if (percent >= 60) return { grade: "B", status: "conditionally-approved" };
  if (percent >= 50) return { grade: "C", status: "on-hold" };
  return { grade: "D", status: "rejected" };
}

function supplierView(s: SupplierRecord) {
  return {
    id: s.id, partyId: s.partyId, name: s.name, status: s.status, categories: s.categories,
    grade: s.grade, score: s.score, qualifiedOn: s.qualifiedOn, nextReviewOn: s.nextReviewOn, trialUntil: s.trialUntil,
  };
}

export class ProcurementService {
  constructor(private readonly store: ProcurementStore, private readonly now: () => Date = () => new Date()) {}

  // Suppliers
  async createSupplier(caller: Caller, body: unknown) {
    requirePermission(caller, "procurement.write");
    const b = asObject(body);
    const categories = b.categories;
    if (!Array.isArray(categories) || categories.length === 0 || categories.some((c) => typeof c !== "string")) {
      throw validation("categories must be a non-empty array of strings", [{ field: "categories" }]);
    }
    const record: SupplierRecord = {
      id: newId(), tenantId: caller.tenantId, partyId: uuid(b, "partyId")!, name: "", status: "pending-qualification",
      categories: categories as string[], grade: null, score: null, qualifiedOn: null, nextReviewOn: null, trialUntil: null,
    };
    record.name = `Supplier ${record.partyId.slice(0, 8)}`;
    await this.store.saveSupplier(record);
    return supplierView(record);
  }

  async getSupplier(caller: Caller, id: string) {
    requirePermission(caller, "procurement.read");
    const s = await this.store.getSupplier(caller.tenantId, id);
    if (!s) throw notFound("supplier");
    return supplierView(s);
  }

  async listSuppliers(caller: Caller, query: { status?: string; search?: string; limit: number; cursor: string | null }) {
    requirePermission(caller, "procurement.read");
    const page = await this.store.listSuppliers(caller.tenantId, { status: query.status as SupplierStatus | undefined, search: query.search }, query.limit, query.cursor);
    return { items: page.items.map(supplierView), nextCursor: page.nextCursor };
  }

  async recordQualification(caller: Caller, supplierId: string, body: unknown) {
    requirePermission(caller, "procurement.approve-supplier");
    const b = asObject(body);
    const s = await this.store.getSupplier(caller.tenantId, supplierId);
    if (!s) throw notFound("supplier");
    if (s.status !== "pending-qualification" && s.status !== "on-hold") {
      throw new DomainError("INVALID_STATE", `supplier is ${s.status}; only pending or on-hold suppliers can be qualified`, 409);
    }
    const scores = b.scores;
    if (!Array.isArray(scores)) throw validation("scores must be an array", [{ field: "scores" }]);
    const map: Record<string, number> = {};
    for (const item of scores as Record<string, unknown>[]) {
      if (typeof item.criterion !== "string" || typeof item.score !== "number" || !Number.isInteger(item.score) || item.score < 1 || item.score > 5) {
        throw validation("each score needs a criterion and an integer score from 1 to 5", [{ field: "scores" }]);
      }
      map[item.criterion] = item.score;
    }
    const percent = scorecardPercent(map);
    const graded = b.criticalFailure === true ? { grade: "D" as const, status: "rejected" as const } : gradeFor(percent);
    if (b.outcome !== graded.status) {
      throw new DomainError("OUTCOME_MISMATCH", `outcome must be ${graded.status} for this scorecard`, 409);
    }
    const today = this.now().toISOString().slice(0, 10);
    const next = new Date(this.now().getTime());
    next.setUTCMonth(next.getUTCMonth() + (graded.grade === "A" ? 24 : 12));
    s.status = graded.status;
    s.grade = graded.grade;
    s.score = percent.toFixed(1);
    s.qualifiedOn = today;
    s.nextReviewOn = next.toISOString().slice(0, 10);
    await this.store.saveSupplier(s);
    return supplierView(s);
  }

  // Purchase requests
  private requestView(r: PurchaseRequestRecord) {
    return {
      id: r.id, number: r.number, status: r.status, source: r.source, requestedBy: r.requestedBy,
      departmentId: r.departmentId, createdAt: r.createdAt,
      lines: r.lines.map((l) => ({
        itemId: l.itemId, description: l.description, specification: l.specification,
        quantity: formatQuantity(l.quantityScaled), requiredBy: l.requiredBy,
      })),
    };
  }

  async createPurchaseRequest(caller: Caller, body: unknown) {
    requirePermission(caller, "procurement.write");
    const b = asObject(body);
    const source = str(b, "source", { required: true });
    if (!["stores-reorder", "stores-order-shortage", "department"].includes(source!)) {
      throw validation("source is not allowed", [{ field: "source" }]);
    }
    const lines: PurchaseRequestLineRecord[] = arr(b, "lines").map((l, i) => {
      const field = `lines[${i}]`;
      const quantity = wrapMoney(() => parseQuantity(String(l.quantity ?? "")));
      if (quantity === 0n) throw validation("quantity must be greater than zero", [{ field }]);
      return {
        itemId: uuid(l, "itemId")!,
        description: str(l, "description"),
        specification: str(l, "specification", { max: 2000 }),
        quantityScaled: quantity,
        requiredBy: isoDate(str(l, "requiredBy", { required: true })!, `${field}.requiredBy`),
      };
    });
    const record: PurchaseRequestRecord = {
      id: newId(), tenantId: caller.tenantId, number: await this.store.nextNumber(caller.tenantId, "purchase-request"),
      status: "submitted", source: source!, requestedBy: caller.actorId, departmentId: uuid(b, "departmentId", false),
      lines, createdAt: this.now().toISOString(),
    };
    await this.store.savePurchaseRequest(record);
    return this.requestView(record);
  }

  async getPurchaseRequest(caller: Caller, id: string) {
    requirePermission(caller, "procurement.read");
    const r = await this.store.getPurchaseRequest(caller.tenantId, id);
    if (!r) throw notFound("purchase request");
    return this.requestView(r);
  }

  async listPurchaseRequests(caller: Caller, query: { status?: string; limit: number; cursor: string | null }) {
    requirePermission(caller, "procurement.read");
    const page = await this.store.listPurchaseRequests(caller.tenantId, query.status as PurchaseRequestStatus | undefined, query.limit, query.cursor);
    return { items: page.items.map((r) => this.requestView(r)), nextCursor: page.nextCursor };
  }

  async decidePurchaseRequest(caller: Caller, id: string, body: unknown) {
    requirePermission(caller, "procurement.approve");
    const b = asObject(body);
    const decision = str(b, "decision", { required: true });
    if (decision !== "approve" && decision !== "reject") throw validation("decision must be approve or reject", [{ field: "decision" }]);
    const r = await this.store.getPurchaseRequest(caller.tenantId, id);
    if (!r) throw notFound("purchase request");
    const to: PurchaseRequestStatus = decision === "approve" ? "approved" : "rejected";
    assertPurchaseRequestTransition(r.status, to);
    r.status = to;
    await this.store.savePurchaseRequest(r);
    if (to === "approved") {
      await this.store.appendOutbox({ id: newId(), tenantId: caller.tenantId, eventType: "pr.approved", payload: { purchaseRequestId: r.id }, createdAt: this.now().toISOString() });
    }
    return this.requestView(r);
  }

  async cancelPurchaseRequest(caller: Caller, id: string) {
    requirePermission(caller, "procurement.write");
    const r = await this.store.getPurchaseRequest(caller.tenantId, id);
    if (!r) throw notFound("purchase request");
    assertPurchaseRequestTransition(r.status, "cancelled");
    r.status = "cancelled";
    await this.store.savePurchaseRequest(r);
    return this.requestView(r);
  }

  // Purchase orders
  /** Approval chain by value. The platform's approval matrices replace this default once they are wired in. */
  approvalChainFor(totalMinor: bigint): string[] {
    return totalMinor < 5000000n ? ["purchase-manager"] : ["purchase-manager", "managing-director"];
  }

  private orderView(o: PurchaseOrderRecord) {
    return {
      id: o.id, number: o.number, status: o.status, supplierId: o.supplierId, rfqId: o.rfqId, currency: o.currency,
      paymentTerms: o.paymentTerms, deliveryLocation: o.deliveryLocation,
      lines: o.lines.map((l) => ({
        lineNo: l.lineNo, itemId: l.itemId, description: l.description, quantity: formatQuantity(l.quantityScaled),
        receivedQuantity: formatQuantity(l.receivedScaledQuantity), unitPrice: formatMoney(l.unitPriceMinor, o.currency),
        taxRate: formatRate(l.taxBps), requiredBy: l.requiredBy, lineTotal: formatMoney(l.lineTotalMinor, o.currency),
      })),
      total: formatMoney(o.totalMinor, o.currency),
      approvalStep: o.approvalStep, acknowledgedOn: o.acknowledgedOn,
      dueAcknowledgementAt: o.dueAcknowledgementAt, createdAt: o.createdAt,
    };
  }

  async createPurchaseOrder(caller: Caller, body: unknown) {
    requirePermission(caller, "procurement.write");
    const b = asObject(body);
    const supplierId = uuid(b, "supplierId")!;
    const supplier = await this.store.getSupplier(caller.tenantId, supplierId);
    if (!supplier) throw notFound("supplier");
    if (supplier.status !== "approved" && supplier.status !== "conditionally-approved") {
      throw new DomainError("SUPPLIER_NOT_APPROVED", `supplier is ${supplier.status}`, 409);
    }
    const currency = str(b, "currency", { required: true })!;
    if (!/^[A-Z]{3}$/.test(currency)) throw validation("currency must be a three-letter code", [{ field: "currency" }]);
    const lines: PurchaseOrderLineRecord[] = [];
    let total = 0n;
    arr(b, "lines").forEach((l, i) => {
      const field = `lines[${i}]`;
      const quantity = wrapMoney(() => parseQuantity(String(l.quantity ?? "")));
      if (quantity === 0n) throw validation("quantity must be greater than zero", [{ field }]);
      const unitPrice = wrapMoney(() => parseMoney(String(l.unitPrice ?? ""), currency));
      if (unitPrice < 0n) throw validation("unitPrice cannot be negative", [{ field }]);
      const taxBps = wrapMoney(() => parseRateBps(String(l.taxRate ?? "0")));
      const net = lineTotal(quantity, unitPrice);
      const tax = taxOn(net, taxBps);
      total += net + tax;
      lines.push({
        lineNo: i + 1, itemId: uuid(l, "itemId")!, description: str(l, "description"), quantityScaled: quantity,
        receivedScaledQuantity: 0n, unitPriceMinor: unitPrice, taxBps,
        requiredBy: isoDate(str(l, "requiredBy", { required: true })!, `${field}.requiredBy`), lineTotalMinor: net,
      });
    });
    const record: PurchaseOrderRecord = {
      id: newId(), tenantId: caller.tenantId, number: await this.store.nextNumber(caller.tenantId, "purchase-order"),
      status: "draft", supplierId, rfqId: uuid(b, "rfqId", false), currency, paymentTerms: str(b, "paymentTerms"),
      deliveryLocation: str(b, "deliveryLocation"), lines, totalMinor: total,
      approvalRoles: this.approvalChainFor(total), approvalStep: null, acknowledgedOn: null, signedCopyRef: null,
      dueAcknowledgementAt: null, releasedAt: null, createdAt: this.now().toISOString(),
    };
    await this.store.savePurchaseOrder(record);
    return this.orderView(record);
  }

  async getPurchaseOrder(caller: Caller, id: string) {
    requirePermission(caller, "procurement.read");
    const o = await this.store.getPurchaseOrder(caller.tenantId, id);
    if (!o) throw notFound("purchase order");
    return this.orderView(o);
  }

  async listPurchaseOrders(caller: Caller, query: { status?: string; supplierId?: string; limit: number; cursor: string | null }) {
    requirePermission(caller, "procurement.read");
    const page = await this.store.listPurchaseOrders(caller.tenantId, { status: query.status as PurchaseOrderStatus | undefined, supplierId: query.supplierId }, query.limit, query.cursor);
    return { items: page.items.map((o) => this.orderView(o)), nextCursor: page.nextCursor };
  }

  private async loadOrder(caller: Caller, id: string): Promise<PurchaseOrderRecord> {
    const o = await this.store.getPurchaseOrder(caller.tenantId, id);
    if (!o) throw notFound("purchase order");
    return o;
  }

  async submitPurchaseOrder(caller: Caller, id: string) {
    requirePermission(caller, "procurement.write");
    const o = await this.loadOrder(caller, id);
    assertPurchaseOrderTransition(o.status, "in-approval");
    o.status = "in-approval";
    o.approvalStep = 0;
    await this.store.savePurchaseOrder(o);
    return this.orderView(o);
  }

  async decidePurchaseOrder(caller: Caller, id: string, body: unknown) {
    requirePermission(caller, "procurement.approve");
    const b = asObject(body);
    const decision = str(b, "decision", { required: true });
    if (decision !== "approve" && decision !== "reject") throw validation("decision must be approve or reject", [{ field: "decision" }]);
    const o = await this.loadOrder(caller, id);
    if (o.status !== "in-approval" || o.approvalStep === null) {
      throw new DomainError("INVALID_STATE", "purchase order is not waiting for approval", 409);
    }
    const role = o.approvalRoles[o.approvalStep]!;
    if (!caller.roles.includes(role)) throw forbidden(`this step needs the ${role} role`);
    if (decision === "reject") {
      assertPurchaseOrderTransition(o.status, "rejected");
      o.status = "rejected";
      o.approvalStep = null;
    } else if (o.approvalStep + 1 < o.approvalRoles.length) {
      o.approvalStep += 1;
    } else {
      assertPurchaseOrderTransition(o.status, "approved");
      o.status = "approved";
      o.approvalStep = null;
    }
    await this.store.savePurchaseOrder(o);
    return this.orderView(o);
  }

  async releasePurchaseOrder(caller: Caller, id: string) {
    requirePermission(caller, "procurement.release");
    const o = await this.loadOrder(caller, id);
    assertPurchaseOrderTransition(o.status, "released");
    const at = this.now();
    o.status = "released";
    o.releasedAt = at.toISOString();
    o.dueAcknowledgementAt = new Date(at.getTime() + 48 * 60 * 60 * 1000).toISOString();
    await this.store.savePurchaseOrder(o);
    await this.store.appendOutbox({
      id: newId(), tenantId: caller.tenantId, eventType: "po.issued",
      payload: { purchaseOrderId: o.id, supplierId: o.supplierId, total: formatMoney(o.totalMinor, o.currency) },
      createdAt: at.toISOString(),
    });
    return this.orderView(o);
  }

  async acknowledgePurchaseOrder(caller: Caller, id: string, body: unknown) {
    requirePermission(caller, "procurement.write");
    const b = asObject(body);
    const acknowledgedOn = isoDate(str(b, "acknowledgedOn", { required: true })!, "acknowledgedOn");
    const signedCopyRef = str(b, "signedCopyRef", { required: true, max: 512 })!;
    const o = await this.loadOrder(caller, id);
    assertPurchaseOrderTransition(o.status, "acknowledged");
    o.status = "acknowledged";
    o.acknowledgedOn = acknowledgedOn;
    o.signedCopyRef = signedCopyRef;
    await this.store.savePurchaseOrder(o);
    return this.orderView(o);
  }

  async closePurchaseOrder(caller: Caller, id: string) {
    requirePermission(caller, "procurement.write");
    const o = await this.loadOrder(caller, id);
    assertPurchaseOrderTransition(o.status, "closed");
    o.status = "closed";
    await this.store.savePurchaseOrder(o);
    await this.store.appendOutbox({ id: newId(), tenantId: caller.tenantId, eventType: "po.closed", payload: { purchaseOrderId: o.id }, createdAt: this.now().toISOString() });
    return this.orderView(o);
  }

  async cancelPurchaseOrder(caller: Caller, id: string) {
    requirePermission(caller, "procurement.write");
    const o = await this.loadOrder(caller, id);
    if (!canCancelPurchaseOrder(o.status)) {
      throw new DomainError("INVALID_STATE", `purchase order cannot be cancelled once it is ${o.status}`, 409);
    }
    o.status = "cancelled";
    await this.store.savePurchaseOrder(o);
    return this.orderView(o);
  }
}
