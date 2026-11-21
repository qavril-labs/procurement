import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp, hashToken } from "../src/app.js";
import { MemoryProcurementStore } from "../src/store.js";
import { MemorySessionResolver } from "../src/sessions.js";
import type { Caller } from "../src/service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PARTY = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const ALL_SCORES = [
  { criterion: "product-quality", score: 3 }, { criterion: "delivery", score: 3 },
  { criterion: "pricing-competitiveness", score: 3 }, { criterion: "communication-and-response", score: 3 },
  { criterion: "compliance-with-specification", score: 3 }, { criterion: "technical-capability", score: 3 },
  { criterion: "service-and-support", score: 3 }, { criterion: "reliability-and-consistency", score: 3 },
];

function token(tenantId: string, label: string): string {
  return `${tenantId}.${label.padEnd(16, "x")}`;
}

describe("procurement API", () => {
  let store: MemoryProcurementStore;
  let sessions: MemorySessionResolver;
  let app: ReturnType<typeof buildApp>;
  let clerk: string;
  let manager: string;
  let otherTenant: string;

  const add = (tok: string, caller: Caller) => sessions.add(hashToken(tok), caller);
  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeEach(() => {
    store = new MemoryProcurementStore();
    sessions = new MemorySessionResolver();
    app = buildApp({ store, sessions, now: () => new Date("2026-11-21T09:00:00Z") });
    clerk = token(TENANT, "clerk");
    manager = token(TENANT, "manager");
    otherTenant = token(OTHER, "other");
    add(clerk, { tenantId: TENANT, actorId: "55555555-5555-4555-8555-555555555555", roles: [], permissions: ["procurement.read", "procurement.write", "procurement.approve-supplier", "procurement.release"] });
    add(manager, { tenantId: TENANT, actorId: "66666666-6666-4666-8666-666666666666", roles: ["purchase-manager"], permissions: ["procurement.read", "procurement.approve"] });
    add(otherTenant, { tenantId: OTHER, actorId: "77777777-7777-4777-8777-777777777777", roles: ["purchase-manager"], permissions: ["procurement.read", "procurement.approve", "procurement.write"] });
  });

  async function approvedSupplier(): Promise<string> {
    const created = await app.inject({ method: "POST", url: "/v1/procurement/suppliers", headers: auth(clerk), payload: { partyId: PARTY, categories: ["raw-material"] } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const q = await app.inject({ method: "POST", url: `/v1/procurement/suppliers/${id}/qualification`, headers: auth(clerk), payload: { scores: ALL_SCORES, outcome: "conditionally-approved" } });
    expect(q.statusCode).toBe(200);
    return id;
  }

  const poPayload = (supplierId: string) => ({
    supplierId, currency: "INR", paymentTerms: "30 days",
    lines: [{ itemId: ITEM, quantity: "2.5", unitPrice: "100.00", taxRate: "18", requiredBy: "2026-12-05" }],
  });

  it("rejects requests without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/procurement/suppliers" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("qualifies a supplier from the scorecard and refuses a wrong outcome", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/procurement/suppliers", headers: auth(clerk), payload: { partyId: PARTY, categories: ["raw-material"] } });
    const id = created.json().id as string;
    expect(created.json().status).toBe("pending-qualification");
    const wrong = await app.inject({ method: "POST", url: `/v1/procurement/suppliers/${id}/qualification`, headers: auth(clerk), payload: { scores: ALL_SCORES, outcome: "rejected" } });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("OUTCOME_MISMATCH");
    const ok = await app.inject({ method: "POST", url: `/v1/procurement/suppliers/${id}/qualification`, headers: auth(clerk), payload: { scores: ALL_SCORES, outcome: "conditionally-approved" } });
    expect(ok.json().status).toBe("conditionally-approved");
    expect(ok.json().grade).toBe("B");
  });

  it("a critical failure rejects regardless of score", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/procurement/suppliers", headers: auth(clerk), payload: { partyId: PARTY, categories: ["raw-material"] } });
    const id = created.json().id as string;
    const res = await app.inject({ method: "POST", url: `/v1/procurement/suppliers/${id}/qualification`, headers: auth(clerk), payload: { scores: ALL_SCORES, criticalFailure: true, outcome: "rejected" } });
    expect(res.json().status).toBe("rejected");
  });

  it("refuses a purchase order to a supplier that is not approved", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/procurement/suppliers", headers: auth(clerk), payload: { partyId: PARTY, categories: ["raw-material"] } });
    const res = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: auth(clerk), payload: poPayload(created.json().id) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SUPPLIER_NOT_APPROVED");
  });

  it("approves a purchase request and records the event", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/procurement/purchase-requests", headers: auth(clerk), payload: { source: "stores-reorder", lines: [{ itemId: ITEM, quantity: "10", requiredBy: "2026-12-01" }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json().lines[0].quantity).toBe("10");
    const id = created.json().id as string;
    const approved = await app.inject({ method: "POST", url: `/v1/procurement/purchase-requests/${id}/decision`, headers: auth(manager), payload: { decision: "approve" } });
    expect(approved.json().status).toBe("approved");
    expect(store.outbox.map((e) => e.eventType)).toContain("pr.approved");
  });

  it("runs a purchase order from draft to closed, with money computed on the server", async () => {
    const supplierId = await approvedSupplier();
    const created = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: auth(clerk), payload: poPayload(supplierId) });
    expect(created.statusCode).toBe(201);
    // 2.5 units at 100.00 INR is 250.00; 18 percent tax is 45.00; total 295.00
    expect(created.json().total).toBe("295.00");
    expect(created.json().lines[0].lineTotal).toBe("250.00");
    expect(created.json().lines[0].taxRate).toBe("18.00");
    const id = created.json().id as string;

    expect((await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/submit`, headers: auth(clerk) })).json().status).toBe("in-approval");
    const approved = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/decision`, headers: auth(manager), payload: { decision: "approve" } });
    expect(approved.json().status).toBe("approved");

    const noKey = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/release`, headers: auth(clerk) });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const release = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/release`, headers: { ...auth(clerk), "idempotency-key": "release-po-0001" } });
    expect(release.json().status).toBe("released");
    expect(release.json().dueAcknowledgementAt).toBe("2026-11-23T09:00:00.000Z");
    expect(store.outbox.map((e) => e.eventType)).toContain("po.issued");

    const replay = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/release`, headers: { ...auth(clerk), "idempotency-key": "release-po-0001" } });
    expect(replay.json()).toEqual(release.json());
    expect(store.outbox.filter((e) => e.eventType === "po.issued")).toHaveLength(1);

    const ack = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/acknowledge`, headers: auth(clerk), payload: { acknowledgedOn: "2026-11-21", signedCopyRef: "doc-123" } });
    expect(ack.json().status).toBe("acknowledged");
    const closed = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/close`, headers: auth(clerk) });
    expect(closed.json().status).toBe("closed");
  });

  it("refuses the same idempotency key with a different body", async () => {
    const supplierId = await approvedSupplier();
    const first = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: { ...auth(clerk), "idempotency-key": "create-po-0001" }, payload: poPayload(supplierId) });
    expect(first.statusCode).toBe(201);
    const other = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: { ...auth(clerk), "idempotency-key": "create-po-0001" }, payload: { ...poPayload(supplierId), currency: "USD" } });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("requires the approver's role at each step", async () => {
    const supplierId = await approvedSupplier();
    const created = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: auth(clerk), payload: poPayload(supplierId) });
    const id = created.json().id as string;
    await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/submit`, headers: auth(clerk) });
    const res = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${id}/decision`, headers: auth(clerk), payload: { decision: "approve" } });
    expect(res.statusCode).toBe(403);
  });

  it("does not show one tenant documents to another", async () => {
    const supplierId = await approvedSupplier();
    const created = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: auth(clerk), payload: poPayload(supplierId) });
    const res = await app.inject({ method: "GET", url: `/v1/procurement/purchase-orders/${created.json().id}`, headers: auth(otherTenant) });
    expect(res.statusCode).toBe(404);
  });

  it("cancels a draft once and refuses a second cancel", async () => {
    const supplierId = await approvedSupplier();
    const created = await app.inject({ method: "POST", url: "/v1/procurement/purchase-orders", headers: auth(clerk), payload: poPayload(supplierId) });
    const first = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${created.json().id}/cancel`, headers: auth(clerk) });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/v1/procurement/purchase-orders/${created.json().id}/cancel`, headers: auth(clerk) });
    expect(again.statusCode).toBe(409);
  });

  it("rejects an invalid quantity and returns the error shape", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/procurement/purchase-requests", headers: auth(clerk), payload: { source: "department", lines: [{ itemId: ITEM, quantity: "-1", requiredBy: "2026-12-01" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("validates the list limit", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/procurement/suppliers?limit=500", headers: auth(clerk) });
    expect(res.statusCode).toBe(400);
  });
});

it("hashes tokens with SHA-256", () => {
  expect(hashToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
});
