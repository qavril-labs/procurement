import { beforeEach, describe, expect, it } from "vitest";
import { buildApp, hashToken } from "../src/app.js";
import type { Caller } from "../src/service.js";
import { MemoryProcurementStore } from "../src/store.js";
import { MemorySessionResolver } from "../src/sessions.js";
import { MemoryUnitOfWork } from "../src/uow.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ITEM = "44444444-4444-4444-8444-444444444444";
const PARTY = "33333333-3333-4333-8333-333333333333";
const ALL_THREE = [
  { criterion: "product-quality", score: 3 }, { criterion: "delivery", score: 3 },
  { criterion: "pricing-competitiveness", score: 3 }, { criterion: "communication-and-response", score: 3 },
  { criterion: "compliance-with-specification", score: 3 }, { criterion: "technical-capability", score: 3 },
  { criterion: "service-and-support", score: 3 }, { criterion: "reliability-and-consistency", score: 3 },
];

describe("RFQ flow", () => {
  let store: MemoryProcurementStore;
  let app: ReturnType<typeof buildApp>;
  let clerk: string;
  let manager: string;
  let approvedPr: string;
  const suppliers: string[] = [];

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const call = (method: "GET" | "POST", url: string, tok: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth(tok), payload: payload as object | undefined });

  beforeEach(async () => {
    store = new MemoryProcurementStore();
    suppliers.length = 0;
    const sessions = new MemorySessionResolver();
    app = buildApp({ uow: new MemoryUnitOfWork(store), sessions, now: () => new Date("2026-11-21T09:00:00Z") });
    clerk = `${TENANT}.clerk${"x".repeat(16)}`;
    manager = `${TENANT}.manager${"x".repeat(12)}`;
    const base: Caller = { tenantId: TENANT, actorId: "55555555-5555-4555-8555-555555555555", roles: [], permissions: [] };
    sessions.add(hashToken(clerk), { ...base, permissions: ["procurement.read", "procurement.write", "procurement.approve-supplier"] });
    sessions.add(hashToken(manager), { ...base, roles: ["purchase-manager"], permissions: ["procurement.read", "procurement.approve", "procurement.write"] });

    for (let i = 0; i < 3; i++) {
      const created = await call("POST", "/v1/procurement/suppliers", clerk, { partyId: `${PARTY.slice(0, -1)}${i}`, categories: ["raw-material"] });
      const id = created.json().id as string;
      suppliers.push(id);
      await call("POST", `/v1/procurement/suppliers/${id}/qualification`, clerk, { scores: ALL_THREE, outcome: "conditionally-approved" });
    }
    const pr = await call("POST", "/v1/procurement/purchase-requests", clerk, {
      source: "stores-reorder", lines: [{ itemId: ITEM, quantity: "10", requiredBy: "2026-12-15" }],
    });
    approvedPr = pr.json().id as string;
    await call("POST", `/v1/procurement/purchase-requests/${approvedPr}/decision`, manager, { decision: "approve" });
  });

  async function openRfq(): Promise<string> {
    const res = await call("POST", "/v1/procurement/rfqs", clerk, {
      purchaseRequestIds: [approvedPr], supplierIds: suppliers, responseDeadline: "2026-11-28T12:00:00Z", deliveryLocation: "Plant A",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().number).toMatch(/^RFQ-\d{6}$/);
    return res.json().id as string;
  }

  const quote = (supplierId: string, unitPrice: string, leadTimeDays: number, freight = "0.00") => ({
    supplierId, unitPrice, currency: "INR", taxRate: "18", freight, insurance: "0.00", leadTimeDays, paymentTerms: "30 days",
  });

  it("refuses an RFQ with fewer than three suppliers", async () => {
    const res = await call("POST", "/v1/procurement/rfqs", clerk, {
      purchaseRequestIds: [approvedPr], supplierIds: suppliers.slice(0, 2), responseDeadline: "2026-11-28T12:00:00Z",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a request that is not approved", async () => {
    const pr = await call("POST", "/v1/procurement/purchase-requests", clerk, { source: "department", lines: [{ itemId: ITEM, quantity: "1", requiredBy: "2026-12-15" }] });
    const res = await call("POST", "/v1/procurement/rfqs", clerk, {
      purchaseRequestIds: [pr.json().id], supplierIds: suppliers, responseDeadline: "2026-11-28T12:00:00Z",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PR_NOT_APPROVED");
  });

  it("records quotes, refuses a duplicate, and compares on landed cost", async () => {
    const rfq = await openRfq();
    // Supplier 0: 100.00 plus 18 percent tax, lead 10 days. Landed 118.00.
    // Supplier 1: 95.00 plus 18 percent tax plus 5.00 freight, lead 14 days. Landed 117.10 + 5.00 = 117.10? computed below.
    expect((await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[0]!, "100.00", 10))).json().status).toBe("quotes-in");
    await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[1]!, "95.00", 14, "5.00"));
    const dup = await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[0]!, "90.00", 5));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("DUPLICATE_QUOTE");

    const comparison = (await call("GET", `/v1/procurement/rfqs/${rfq}/comparison`, clerk)).json();
    expect(comparison.rows[0].supplierId).toBe(suppliers[1]);
    expect(comparison.rows[0].recommended).toBe(true);
    expect(comparison.rows[0].landedUnitPrice).toBe("117.10");
    expect(comparison.rows[1].landedUnitPrice).toBe("118.00");
    expect(comparison.missingQuotes).toEqual([suppliers[2]]);
    expect(comparison.recommendedSupplierId).toBe(suppliers[1]);
  });

  it("refuses a quote from a supplier that was not invited", async () => {
    const rfq = await openRfq();
    const stranger = "99999999-9999-4999-8999-999999999999";
    const res = await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(stranger, "10.00", 3));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SUPPLIER_NOT_INVITED");
  });

  it("requires a justification to award anyone but the lowest landed cost", async () => {
    const rfq = await openRfq();
    await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[0]!, "100.00", 10));
    await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[1]!, "95.00", 14, "5.00"));
    const noReason = await call("POST", `/v1/procurement/rfqs/${rfq}/award`, manager, { supplierId: suppliers[0] });
    expect(noReason.statusCode).toBe(400);
    const withReason = await call("POST", `/v1/procurement/rfqs/${rfq}/award`, manager, { supplierId: suppliers[0], justification: "faster delivery" });
    expect(withReason.json().status).toBe("awarded");
    expect(store.outbox.map((e) => e.eventType)).toContain("rfq.awarded");
  });

  it("awards the lowest landed cost and then refuses to cancel", async () => {
    const rfq = await openRfq();
    await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[0]!, "100.00", 10));
    await call("POST", `/v1/procurement/rfqs/${rfq}/quotes`, clerk, quote(suppliers[1]!, "95.00", 14, "5.00"));
    const award = await call("POST", `/v1/procurement/rfqs/${rfq}/award`, manager, { supplierId: suppliers[1] });
    expect(award.json().awardedSupplierId).toBe(suppliers[1]);
    const cancel = await call("POST", `/v1/procurement/rfqs/${rfq}/cancel`, clerk);
    expect(cancel.statusCode).toBe(409);
  });

  it("cancels an open RFQ", async () => {
    const rfq = await openRfq();
    const res = await call("POST", `/v1/procurement/rfqs/${rfq}/cancel`, clerk);
    expect(res.json().status).toBe("cancelled");
  });
});
