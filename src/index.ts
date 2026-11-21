import { Pool } from "pg";
import { buildApp } from "./app.js";
import { PORT } from "./config.js";
import { PlatformSessionResolver } from "./platform-sessions.js";
import { MemoryProcurementStore } from "./store.js";
import { MemorySessionResolver } from "./sessions.js";
import { MemoryUnitOfWork, type UnitOfWork } from "./uow.js";
import { PgUnitOfWork } from "./pg-store.js";

// Production needs three things: the app database role (not the owner), the platform URL, and the
// shared service token that lets this service resolve sessions. Without them it refuses to start,
// so no request is served without a real database and real sign-in.
function wiring(): { uow: UnitOfWork; sessions: { resolve(token: string): Promise<import("./service.js").Caller | null> } } {
  if (process.env.NODE_ENV !== "production") {
    return { uow: new MemoryUnitOfWork(new MemoryProcurementStore()), sessions: new MemorySessionResolver() };
  }
  const databaseUrl = process.env.APP_DATABASE_URL;
  const platformUrl = process.env.PLATFORM_URL;
  const serviceToken = process.env.INTERNAL_SERVICE_TOKEN;
  if (!databaseUrl || !platformUrl || !serviceToken) {
    throw new Error("procurement: production needs APP_DATABASE_URL, PLATFORM_URL and INTERNAL_SERVICE_TOKEN");
  }
  return {
    uow: new PgUnitOfWork(new Pool({ connectionString: databaseUrl, max: 10 })),
    sessions: new PlatformSessionResolver({ baseUrl: platformUrl, serviceToken }),
  };
}

const { uow, sessions } = wiring();
const app = buildApp({ uow, sessions });
await app.listen({ port: PORT, host: "0.0.0.0" });
