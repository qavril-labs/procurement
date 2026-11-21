// Resolves session tokens through the platform's internal endpoint. The platform owns sessions;
// this service never reads the platform database. Results are cached briefly, keyed by the token
// hash, so a burst of requests does not call the platform each time. Revocation takes effect
// within the cache window (30 seconds by default).

import { createHash } from "node:crypto";
import type { SessionResolver } from "./app.js";
import type { Caller } from "./service.js";

export interface PlatformSessionOptions {
  baseUrl: string;
  serviceToken: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CacheEntry {
  caller: Caller | null;
  expiresAt: number;
}

export class PlatformSessionResolver implements SessionResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: PlatformSessionOptions) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(token: string): Promise<Caller | null> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.caller;

    const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/internal/sessions/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": this.options.serviceToken },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(2_000),
    });
    if (res.status === 401) {
      this.remember(key, null);
      return null;
    }
    if (!res.ok) {
      // Platform unavailable: fail closed, and do not cache the failure.
      throw new Error(`platform session check failed with status ${res.status}`);
    }
    const body = (await res.json()) as { tenantId: string; actorId: string; roles: string[]; permissions: string[] };
    const caller: Caller = { tenantId: body.tenantId, actorId: body.actorId, roles: body.roles, permissions: body.permissions };
    this.remember(key, caller);
    return caller;
  }

  private remember(key: string, caller: Caller | null): void {
    this.cache.set(key, { caller, expiresAt: this.now() + this.ttlMs });
  }
}
