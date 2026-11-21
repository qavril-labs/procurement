// A unit of work runs one request's reads and writes in one tenant-scoped transaction, so a
// business change and its outbox event (and its idempotency record) commit together or not at all.

import type { ProcurementStore } from "./store.js";

export interface UnitOfWork {
  run<T>(tenantId: string, work: (store: ProcurementStore) => Promise<T>): Promise<T>;
}

/** For tests only: no real transaction, so a failed request can leave partial writes. */
export class MemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly store: ProcurementStore) {}

  async run<T>(_tenantId: string, work: (store: ProcurementStore) => Promise<T>): Promise<T> {
    return work(this.store);
  }
}
