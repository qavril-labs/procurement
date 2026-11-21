// Requests for quotation: create, record quotes, compare on landed cost, award, cancel.
// The contract is contracts/procurement.openapi.yaml (RFQ operations).

import { DomainError, notFound, validation } from "./errors.js";
import { newId, UUID_RE } from "./ids.js";
import { formatMoney, formatRate, MoneyError, parseMoney, parseRateBps, taxOn } from "./money.js";
import type { Caller } from "./service.js";
import { requirePermission } from "./service.js";
import { assertRfqTransition, type RfqStatus } from "./state.js";
import type { ProcurementStore, RfqQuoteRecord, RfqRecord } from "./store.js";

const MIN_SUPPLIERS = 3;

function body(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw validation("request body must be a JSON object");
  return value as Record<string, unknown>;
}

function money(value: unknown, currency: string, field: string): bigint {
  try {
    return parseMoney(String(value ?? ""), currency);
  } catch (error) {
    if (error instanceof MoneyError) throw validation(`${field}: ${error.message}`, [{ field }]);
    throw error;
  }
}

function uuidField(b: Record<string, unknown>, field: string): string {
  const v = b[field];
  if (typeof v !== "string" || !UUID_RE.test(v)) throw validation(`${field} must be a UUID`, [{ field }]);
  return v;
}

function quoteView(q: RfqQuoteRecord) {
  return {
    supplierId: q.supplierId,
    unitPrice: formatMoney(q.unitPriceMinor, q.currency),
    currency: q.currency,
    taxRate: formatRate(q.taxBps),
    freight: formatMoney(q.freightMinor, q.currency),
    insurance: formatMoney(q.insuranceMinor, q.currency),
    leadTimeDays: q.leadTimeDays,
    paymentTerms: q.paymentTerms,
    warrantyMonths: q.warrantyMonths,
    validUntil: q.validUntil,
    deviations: q.deviations,
    quotedAt: q.quotedAt,
  };
}

function rfqView(r: RfqRecord) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    purchaseRequestIds: r.purchaseRequestIds,
    suppliers: r.supplierIds,
    responseDeadline: r.responseDeadline,
    deliveryLocation: r.deliveryLocation,
    termsAndConditions: r.termsAndConditions,
    quotes: r.quotes.map(quoteView),
    awardedSupplierId: r.awardedSupplierId,
    createdAt: r.createdAt,
  };
}

/** Landed unit price: unit price, plus tax, plus freight and insurance per unit (minor units). */
export function landedUnitPrice(q: RfqQuoteRecord): bigint {
  return q.unitPriceMinor + taxOn(q.unitPriceMinor, q.taxBps) + q.freightMinor + q.insuranceMinor;
}

export class RfqService {
  constructor(private readonly store: ProcurementStore, private readonly now: () => Date = () => new Date()) {}

  private async load(caller: Caller, id: string): Promise<RfqRecord> {
    const r = await this.store.getRfq(caller.tenantId, id);
    if (!r) throw notFound("RFQ");
    return r;
  }

  async createRfq(caller: Caller, value: unknown) {
    requirePermission(caller, "procurement.write");
    const b = body(value);
    const prIds = b.purchaseRequestIds;
    if (!Array.isArray(prIds) || prIds.length === 0) throw validation("purchaseRequestIds must be a non-empty array", [{ field: "purchaseRequestIds" }]);
    for (const id of prIds) {
      if (typeof id !== "string" || !UUID_RE.test(id)) throw validation("purchaseRequestIds must be UUIDs", [{ field: "purchaseRequestIds" }]);
      const pr = await this.store.getPurchaseRequest(caller.tenantId, id);
      if (!pr) throw notFound("purchase request");
      if (pr.status !== "approved") throw new DomainError("PR_NOT_APPROVED", `purchase request ${pr.number} is ${pr.status}`, 409);
    }
    const suppliers = b.supplierIds;
    if (!Array.isArray(suppliers) || new Set(suppliers).size !== suppliers.length) {
      throw validation("supplierIds must be a list of distinct suppliers", [{ field: "supplierIds" }]);
    }
    if (suppliers.length < MIN_SUPPLIERS) {
      throw new DomainError("VALIDATION", `at least ${MIN_SUPPLIERS} suppliers are required`, 400, [{ field: "supplierIds" }]);
    }
    for (const id of suppliers) {
      if (typeof id !== "string" || !UUID_RE.test(id)) throw validation("supplierIds must be UUIDs", [{ field: "supplierIds" }]);
      const s = await this.store.getSupplier(caller.tenantId, id);
      if (!s) throw notFound("supplier");
      if (s.status !== "approved" && s.status !== "conditionally-approved") {
        throw new DomainError("SUPPLIER_NOT_APPROVED", `supplier is ${s.status}`, 409);
      }
    }
    const deadline = typeof b.responseDeadline === "string" ? b.responseDeadline : "";
    if (!/^\d{4}-\d{2}-\d{2}T/.test(deadline) || Number.isNaN(Date.parse(deadline))) {
      throw validation("responseDeadline must be a date-time", [{ field: "responseDeadline" }]);
    }
    const record: RfqRecord = {
      id: newId(), tenantId: caller.tenantId, number: await this.store.nextNumber(caller.tenantId, "rfq"), status: "open",
      purchaseRequestIds: prIds as string[], supplierIds: suppliers as string[], responseDeadline: deadline,
      deliveryLocation: typeof b.deliveryLocation === "string" ? b.deliveryLocation : null,
      termsAndConditions: typeof b.termsAndConditions === "string" ? b.termsAndConditions : null,
      quotes: [], awardedSupplierId: null, createdAt: this.now().toISOString(),
    };
    await this.store.saveRfq(record);
    return rfqView(record);
  }

  async getRfq(caller: Caller, id: string) {
    requirePermission(caller, "procurement.read");
    return rfqView(await this.load(caller, id));
  }

  async listRfqs(caller: Caller, query: { status?: string; limit: number; cursor: string | null }) {
    requirePermission(caller, "procurement.read");
    const page = await this.store.listRfqs(caller.tenantId, query.status as RfqStatus | undefined, query.limit, query.cursor);
    return { items: page.items.map(rfqView), nextCursor: page.nextCursor };
  }

  async recordQuote(caller: Caller, id: string, value: unknown) {
    requirePermission(caller, "procurement.write");
    const b = body(value);
    const r = await this.load(caller, id);
    if (r.status !== "open" && r.status !== "quotes-in") {
      throw new DomainError("INVALID_STATE", `RFQ is ${r.status}; quotes are closed`, 409);
    }
    const supplierId = uuidField(b, "supplierId");
    if (!r.supplierIds.includes(supplierId)) throw new DomainError("SUPPLIER_NOT_INVITED", "this supplier was not invited to the RFQ", 409);
    if (r.quotes.some((q) => q.supplierId === supplierId)) throw new DomainError("DUPLICATE_QUOTE", "this supplier has already quoted", 409);
    const currency = typeof b.currency === "string" ? b.currency : "";
    if (!/^[A-Z]{3}$/.test(currency)) throw validation("currency must be a three-letter code", [{ field: "currency" }]);
    if (r.quotes.length > 0 && r.quotes[0]!.currency !== currency) {
      throw new DomainError("CURRENCY_MISMATCH", `quotes must be in ${r.quotes[0]!.currency} to compare`, 409);
    }
    const leadTime = b.leadTimeDays;
    if (!Number.isInteger(leadTime) || (leadTime as number) < 0) throw validation("leadTimeDays must be a whole number", [{ field: "leadTimeDays" }]);
    let taxBps: bigint;
    try {
      taxBps = parseRateBps(String(b.taxRate ?? "0"));
    } catch (error) {
      throw validation(error instanceof Error ? error.message : "invalid tax rate", [{ field: "taxRate" }]);
    }
    const quote: RfqQuoteRecord = {
      supplierId, unitPriceMinor: money(b.unitPrice, currency, "unitPrice"), currency, taxBps,
      freightMinor: b.freight === undefined ? 0n : money(b.freight, currency, "freight"),
      insuranceMinor: b.insurance === undefined ? 0n : money(b.insurance, currency, "insurance"),
      leadTimeDays: leadTime as number,
      paymentTerms: typeof b.paymentTerms === "string" ? b.paymentTerms : null,
      warrantyMonths: Number.isInteger(b.warrantyMonths) ? (b.warrantyMonths as number) : null,
      validUntil: typeof b.validUntil === "string" ? b.validUntil : null,
      deviations: typeof b.deviations === "string" ? b.deviations : null,
      quotedAt: this.now().toISOString(),
    };
    if (quote.unitPriceMinor < 0n) throw validation("unitPrice cannot be negative", [{ field: "unitPrice" }]);
    if (r.status === "open") assertRfqTransition(r.status, "quotes-in");
    r.status = "quotes-in";
    r.quotes.push(quote);
    await this.store.saveRfq(r);
    return rfqView(r);
  }

  async comparison(caller: Caller, id: string) {
    requirePermission(caller, "procurement.read");
    const r = await this.load(caller, id);
    const earliest = await this.earliestRequiredBy(caller, r);
    const ranked = r.quotes
      .map((q) => ({ q, landed: landedUnitPrice(q) }))
      .sort((a, b) => (a.landed < b.landed ? -1 : a.landed > b.landed ? 1 : a.q.leadTimeDays - b.q.leadTimeDays));
    const rows = ranked.map(({ q, landed }, i) => ({
      supplierId: q.supplierId,
      landedUnitPrice: formatMoney(landed, q.currency),
      leadTimeDays: q.leadTimeDays,
      meetsDeliveryDate: earliest === null ? null : this.addDays(q.quotedAt, q.leadTimeDays) <= earliest,
      complianceNotes: q.deviations,
      rank: i + 1,
      recommended: i === 0,
    }));
    return {
      rfqId: r.id,
      rows,
      recommendedSupplierId: rows[0]?.supplierId ?? null,
      missingQuotes: r.supplierIds.filter((s) => !r.quotes.some((q) => q.supplierId === s)),
    };
  }

  private addDays(iso: string, days: number): string {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private async earliestRequiredBy(caller: Caller, r: RfqRecord): Promise<string | null> {
    let earliest: string | null = null;
    for (const id of r.purchaseRequestIds) {
      const pr = await this.store.getPurchaseRequest(caller.tenantId, id);
      for (const line of pr?.lines ?? []) {
        if (earliest === null || line.requiredBy < earliest) earliest = line.requiredBy;
      }
    }
    return earliest;
  }

  async awardRfq(caller: Caller, id: string, value: unknown) {
    requirePermission(caller, "procurement.approve");
    const b = body(value);
    const supplierId = uuidField(b, "supplierId");
    const r = await this.load(caller, id);
    if (r.status !== "quotes-in" && r.status !== "compared") {
      throw new DomainError("INVALID_STATE", `RFQ is ${r.status}; only an RFQ with quotes can be awarded`, 409);
    }
    if (!r.quotes.some((q) => q.supplierId === supplierId)) throw new DomainError("SUPPLIER_NOT_QUOTED", "this supplier has not quoted", 409);
    const recommended = (await this.comparison(caller, id)).recommendedSupplierId;
    const justification = typeof b.justification === "string" ? b.justification.trim() : "";
    if (supplierId !== recommended && justification === "") {
      throw validation("a justification is required when the award is not the lowest landed cost", [{ field: "justification" }]);
    }
    assertRfqTransition(r.status, "awarded");
    r.status = "awarded";
    r.awardedSupplierId = supplierId;
    await this.store.saveRfq(r);
    await this.store.appendOutbox({ id: newId(), tenantId: caller.tenantId, eventType: "rfq.awarded", payload: { rfqId: r.id, supplierId }, createdAt: this.now().toISOString() });
    return rfqView(r);
  }

  async cancelRfq(caller: Caller, id: string) {
    requirePermission(caller, "procurement.write");
    const r = await this.load(caller, id);
    assertRfqTransition(r.status, "cancelled");
    r.status = "cancelled";
    await this.store.saveRfq(r);
    return rfqView(r);
  }
}
