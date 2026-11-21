import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryProcurementStore } from "../src/store.js";
import { MemorySessionResolver } from "../src/sessions.js";
import { MemoryUnitOfWork } from "../src/uow.js";

describe("health", () => {
  it("answers 200 with the service name", async () => {
    const app = buildApp({ uow: new MemoryUnitOfWork(new MemoryProcurementStore()), sessions: new MemorySessionResolver() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "procurement" });
    await app.close();
  });
});
