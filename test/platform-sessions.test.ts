import { describe, expect, it } from "vitest";
import { PlatformSessionResolver } from "../src/platform-sessions.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const token = `${TENANT}.clerk${"x".repeat(16)}`;

function fakePlatform(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const next = answers.shift()!;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("PlatformSessionResolver", () => {
  it("asks the platform with the service token and returns the caller", async () => {
    const { calls, fetchImpl } = fakePlatform([{ status: 200, body: { tenantId: TENANT, actorId: "a", roles: ["purchase-manager"], permissions: ["procurement.read"] } }]);
    const r = new PlatformSessionResolver({ baseUrl: "https://api.example.test/", serviceToken: "svc", fetchImpl });
    const caller = await r.resolve(token);
    expect(caller).toMatchObject({ tenantId: TENANT, roles: ["purchase-manager"] });
    expect(calls[0]!.url).toBe("https://api.example.test/internal/sessions/resolve");
    expect(calls[0]!.headers["x-service-token"]).toBe("svc");
    expect(JSON.parse(calls[0]!.body)).toEqual({ token });
  });

  it("returns null for an unknown session and caches the answer", async () => {
    const { calls, fetchImpl } = fakePlatform([{ status: 401, body: { error: {} } }]);
    const t = 0;
    const r = new PlatformSessionResolver({ baseUrl: "https://p.test", serviceToken: "svc", fetchImpl, now: () => t });
    expect(await r.resolve(token)).toBeNull();
    expect(await r.resolve(token)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("caches a session for the window, then asks again", async () => {
    const ok = { status: 200, body: { tenantId: TENANT, actorId: "a", roles: [], permissions: [] } };
    const { calls, fetchImpl } = fakePlatform([ok, ok]);
    let t = 0;
    const r = new PlatformSessionResolver({ baseUrl: "https://p.test", serviceToken: "svc", fetchImpl, ttlMs: 30_000, now: () => t });
    await r.resolve(token);
    t = 29_000;
    await r.resolve(token);
    expect(calls).toHaveLength(1);
    t = 31_000;
    await r.resolve(token);
    expect(calls).toHaveLength(2);
  });

  it("fails closed when the platform is unavailable, and does not cache the failure", async () => {
    const { calls, fetchImpl } = fakePlatform([{ status: 503 }, { status: 200, body: { tenantId: TENANT, actorId: "a", roles: [], permissions: [] } }]);
    const r = new PlatformSessionResolver({ baseUrl: "https://p.test", serviceToken: "svc", fetchImpl });
    await expect(r.resolve(token)).rejects.toThrow(/503/);
    expect(await r.resolve(token)).toMatchObject({ tenantId: TENANT });
    expect(calls).toHaveLength(2);
  });
});
