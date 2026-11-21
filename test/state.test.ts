import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import {
  assertPurchaseOrderTransition, assertPurchaseRequestTransition, canCancelPurchaseOrder,
} from "../src/state.js";

describe("purchase order transitions", () => {
  it("allows the happy path", () => {
    const path = ["draft", "in-approval", "approved", "released", "acknowledged", "received", "closed"] as const;
    for (let i = 1; i < path.length; i++) {
      expect(() => assertPurchaseOrderTransition(path[i - 1]!, path[i]!)).not.toThrow();
    }
  });

  it("refuses to release an order that is not approved", () => {
    expect(() => assertPurchaseOrderTransition("draft", "released")).toThrow(DomainError);
    expect(() => assertPurchaseOrderTransition("in-approval", "released")).toThrow(DomainError);
  });

  it("refuses to change a closed or rejected order", () => {
    expect(() => assertPurchaseOrderTransition("closed", "cancelled")).toThrow(DomainError);
    expect(() => assertPurchaseOrderTransition("rejected", "approved")).toThrow(DomainError);
  });

  it("cancels only before release", () => {
    expect(canCancelPurchaseOrder("draft")).toBe(true);
    expect(canCancelPurchaseOrder("approved")).toBe(true);
    expect(canCancelPurchaseOrder("released")).toBe(true);
    expect(canCancelPurchaseOrder("acknowledged")).toBe(false);
    expect(canCancelPurchaseOrder("closed")).toBe(false);
  });

  it("returns 409 with INVALID_STATE", () => {
    try {
      assertPurchaseOrderTransition("closed", "approved");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).code).toBe("INVALID_STATE");
    }
  });
});

describe("purchase request transitions", () => {
  it("approves a submitted request and converts an approved one", () => {
    expect(() => assertPurchaseRequestTransition("submitted", "approved")).not.toThrow();
    expect(() => assertPurchaseRequestTransition("approved", "converted")).not.toThrow();
  });

  it("does not reopen a rejected request", () => {
    expect(() => assertPurchaseRequestTransition("rejected", "approved")).toThrow(DomainError);
  });
});
