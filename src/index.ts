import { buildApp } from "./app.js";
import { PORT } from "./config.js";
import { MemoryProcurementStore } from "./store.js";
import { MemorySessionResolver } from "./sessions.js";

// The Postgres store and the platform session resolver are not wired yet. Refuse to run in
// production with in-memory state, so no data can be written there by mistake.
if (process.env.NODE_ENV === "production") {
  throw new Error("procurement: the Postgres store is not wired yet; production start is blocked");
}

const app = buildApp({ store: new MemoryProcurementStore(), sessions: new MemorySessionResolver() });
await app.listen({ port: PORT, host: "0.0.0.0" });
