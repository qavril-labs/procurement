import type { Caller } from "./service.js";
import { hashToken, type SessionResolver } from "./app.js";

/** Test and local session store, keyed by the token hash. Production uses the platform identity service. */
export class MemorySessionResolver implements SessionResolver {
  private readonly sessions = new Map<string, Caller>();

  add(tokenHash: string, caller: Caller): void {
    this.sessions.set(tokenHash, caller);
  }

  async resolve(token: string): Promise<Caller | null> {
    return this.sessions.get(hashToken(token)) ?? null;
  }
}
