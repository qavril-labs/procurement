import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { DomainError } from "./errors.js";
import { SERVICE_NAME } from "./config.js";
import { type Caller, ProcurementService } from "./service.js";
import type { ProcurementStore } from "./store.js";

/** Resolves a session token to the caller. Production uses the platform identity service. */
export interface SessionResolver {
  resolve(tokenHash: string): Promise<Caller | null>;
}

export interface AppDeps {
  store: ProcurementStore;
  sessions: SessionResolver;
  now?: () => Date;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  // Tokens are "<tenantId>.<random>"; only the hash is stored or compared.
  return /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{16,}$/i.test(token) ? token : null;
}

function pageQuery(req: FastifyRequest): { limit: number; cursor: string | null } {
  const q = req.query as Record<string, string | undefined>;
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new DomainError("VALIDATION", "limit must be an integer from 1 to 200", 400);
  }
  return { limit, cursor: q.cursor ?? null };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = new ProcurementService(deps.store, deps.now);

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    const fastifyError = error as { statusCode?: number; code?: string };
    if (fastifyError.statusCode === 400 || fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "request body is not valid JSON" } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "unexpected error" } });
  });

  app.get("/health", async () => ({ status: "ok", service: SERVICE_NAME }));

  // Authentication for every /v1 route.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const token = bearer(req);
    if (!token) throw new DomainError("UNAUTHENTICATED", "missing or invalid session token", 401);
    const caller = await deps.sessions.resolve(hashToken(token));
    if (!caller) throw new DomainError("UNAUTHENTICATED", "session not found or expired", 401);
    (req as FastifyRequest & { caller: Caller }).caller = caller;
  });

  const callerOf = (req: FastifyRequest): Caller => (req as FastifyRequest & { caller: Caller }).caller;

  /**
   * Runs a write once per Idempotency-Key. A retry with the same key and body returns the first
   * response; the same key with a different body returns 409. Failed requests are not stored.
   */
  async function idempotent(req: FastifyRequest, reply: FastifyReply, opts: { required: boolean; status: 200 | 201 }, run: () => Promise<unknown>) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string") {
      if (opts.required) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "this operation needs an Idempotency-Key header", 400);
      return reply.code(opts.status).send(await run());
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new DomainError("VALIDATION", "Idempotency-Key must be 8 to 128 letters, digits, dots, colons, dashes or underscores", 400);
    }
    const requestHash = hashToken(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
    const tenantId = callerOf(req).tenantId;
    const existing = await deps.store.findIdempotency(tenantId, key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "this Idempotency-Key was used for a different request", 409);
      }
      return reply.code(existing.status).send(existing.body);
    }
    const body = await run();
    await deps.store.saveIdempotency(tenantId, key, { requestHash, status: opts.status, body });
    return reply.code(opts.status).send(body);
  }

  const P = "/v1/procurement";

  // Suppliers
  app.get(`${P}/suppliers`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return service.listSuppliers(callerOf(req), { status: q.status, search: q.search, ...pageQuery(req) });
  });
  app.post(`${P}/suppliers`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, () => service.createSupplier(callerOf(req), req.body)));
  app.get(`${P}/suppliers/:supplierId`, async (req) => service.getSupplier(callerOf(req), (req.params as { supplierId: string }).supplierId));
  app.post(`${P}/suppliers/:supplierId/qualification`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, () => service.recordQualification(callerOf(req), (req.params as { supplierId: string }).supplierId, req.body)));

  // Purchase requests
  app.get(`${P}/purchase-requests`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return service.listPurchaseRequests(callerOf(req), { status: q.status, ...pageQuery(req) });
  });
  app.post(`${P}/purchase-requests`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, () => service.createPurchaseRequest(callerOf(req), req.body)));
  app.get(`${P}/purchase-requests/:requestId`, async (req) => service.getPurchaseRequest(callerOf(req), (req.params as { requestId: string }).requestId));
  app.post(`${P}/purchase-requests/:requestId/decision`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, () => service.decidePurchaseRequest(callerOf(req), (req.params as { requestId: string }).requestId, req.body)));
  app.post(`${P}/purchase-requests/:requestId/cancel`, async (req) => service.cancelPurchaseRequest(callerOf(req), (req.params as { requestId: string }).requestId));

  // Purchase orders
  app.get(`${P}/purchase-orders`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return service.listPurchaseOrders(callerOf(req), { status: q.status, supplierId: q.supplierId, ...pageQuery(req) });
  });
  app.post(`${P}/purchase-orders`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, () => service.createPurchaseOrder(callerOf(req), req.body)));
  app.get(`${P}/purchase-orders/:poId`, async (req) => service.getPurchaseOrder(callerOf(req), (req.params as { poId: string }).poId));
  app.post(`${P}/purchase-orders/:poId/submit`, async (req) => service.submitPurchaseOrder(callerOf(req), (req.params as { poId: string }).poId));
  app.post(`${P}/purchase-orders/:poId/decision`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, () => service.decidePurchaseOrder(callerOf(req), (req.params as { poId: string }).poId, req.body)));
  // Releasing a PO emits po.issued and binds the supplier to it: the key is required.
  app.post(`${P}/purchase-orders/:poId/release`, async (req, reply) =>
    idempotent(req, reply, { required: true, status: 200 }, () => service.releasePurchaseOrder(callerOf(req), (req.params as { poId: string }).poId)));
  app.post(`${P}/purchase-orders/:poId/acknowledge`, async (req) =>
    service.acknowledgePurchaseOrder(callerOf(req), (req.params as { poId: string }).poId, req.body));
  app.post(`${P}/purchase-orders/:poId/close`, async (req) => service.closePurchaseOrder(callerOf(req), (req.params as { poId: string }).poId));
  app.post(`${P}/purchase-orders/:poId/cancel`, async (req) => service.cancelPurchaseOrder(callerOf(req), (req.params as { poId: string }).poId));

  return app;
}
