import { buildApp } from "./app.js";
import { PORT } from "./config.js";
import { MemoryProcurementStore } from "./store.js";
import { MemorySessionResolver } from "./sessions.js";
import { MemoryUnitOfWork } from "./uow.js";

// Production needs two things that are not wired yet: the platform session resolver (the
// platform service, in progress) and the Postgres unit of work, which is ready in pg-store.ts.
// Until the session resolver exists, production start is refused so nothing is served without
// real sign-in.
if (process.env.NODE_ENV === "production") {
  throw new Error("procurement: production start waits for the platform session resolver; see docs/product-platform-decisions.md");
}

const store = new MemoryProcurementStore();
const app = buildApp({ uow: new MemoryUnitOfWork(store), sessions: new MemorySessionResolver() });
await app.listen({ port: PORT, host: "0.0.0.0" });
