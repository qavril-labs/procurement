// State machines for the procurement documents. Transitions are the only way a status changes.
// Each rule matches the contract enums in contracts/procurement.openapi.yaml.

import { DomainError } from "./errors.js";

export const PURCHASE_REQUEST_STATUSES = ["submitted", "in-approval", "approved", "rejected", "converted", "cancelled"] as const;
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];

export const PURCHASE_ORDER_STATUSES = [
  "draft", "in-approval", "approved", "rejected", "released", "acknowledged",
  "partially-received", "received", "closed", "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const RFQ_STATUSES = ["open", "quotes-in", "compared", "awarded", "cancelled"] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export const SUPPLIER_STATUSES = ["pending-qualification", "approved", "conditionally-approved", "on-hold", "rejected"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

const PR_TRANSITIONS: Record<PurchaseRequestStatus, readonly PurchaseRequestStatus[]> = {
  submitted: ["in-approval", "approved", "rejected", "cancelled"],
  "in-approval": ["approved", "rejected", "cancelled"],
  approved: ["converted"],
  rejected: [],
  converted: [],
  cancelled: [],
};

const PO_TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  draft: ["in-approval", "cancelled"],
  "in-approval": ["approved", "rejected", "cancelled"],
  approved: ["released", "cancelled"],
  rejected: [],
  released: ["acknowledged", "cancelled"],
  acknowledged: ["partially-received", "received", "closed"],
  "partially-received": ["received", "closed"],
  received: ["closed"],
  closed: [],
  cancelled: [],
};

const RFQ_TRANSITIONS: Record<RfqStatus, readonly RfqStatus[]> = {
  open: ["quotes-in", "cancelled"],
  "quotes-in": ["compared", "awarded", "cancelled"],
  compared: ["awarded", "cancelled"],
  awarded: [],
  cancelled: [],
};

export function assertRfqTransition(from: RfqStatus, to: RfqStatus): void {
  if (!RFQ_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE", `RFQ cannot move from ${from} to ${to}`, 409);
  }
}

export function assertPurchaseRequestTransition(from: PurchaseRequestStatus, to: PurchaseRequestStatus): void {
  if (!PR_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE", `purchase request cannot move from ${from} to ${to}`, 409);
  }
}

export function assertPurchaseOrderTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (!PO_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE", `purchase order cannot move from ${from} to ${to}`, 409);
  }
}

export function canCancelPurchaseOrder(status: PurchaseOrderStatus): boolean {
  return PO_TRANSITIONS[status].includes("cancelled");
}
