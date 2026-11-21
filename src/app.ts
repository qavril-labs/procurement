import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SERVICE_NAME } from "./config.js";
import { DomainError } from "./errors.js";
import { RfqService } from "./rfq-service.js";
import { type Caller, ProcurementService } from "./service.js";
import type { ProcurementStore } from "./store.js";
import type { UnitOfWork } from "./uow.js";

/** Resolves a session token to the caller. Production uses the platform identity service. */
export interface SessionResolver {
  resolve(tokenHash: string): Promise<Caller | null>;
}

export interface AppDeps {
  uow: UnitOfWork;
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

type Services = { purchase: ProcurementService; rfq: RfqService };
type Handler<T> = (svc: Services, caller: Caller) => Promise<T>;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const now = deps.now;

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

  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const token = bearer(req);
    if (!token) throw new DomainError("UNAUTHENTICATED", "missing or invalid session token", 401);
    const caller = await deps.sessions.resolve(hashToken(token));
    if (!caller) throw new DomainError("UNAUTHENTICATED", "session not found or expired", 401);
    (req as FastifyRequest & { caller: Caller }).caller = caller;
  });

  const callerOf = (req: FastifyRequest): Caller => (req as FastifyRequest & { caller: Caller }).caller;

  /** Runs one request in one tenant transaction. */
  function tx<T>(req: FastifyRequest, fn: Handler<T>): Promise<T> {
    const caller = callerOf(req);
    return deps.uow.run(caller.tenantId, (store: ProcurementStore) =>
      fn({ purchase: new ProcurementService(store, now), rfq: new RfqService(store, now) }, caller));
  }

  /**
   * A write runs once per Idempotency-Key, in the same transaction as the write itself, so the
   * stored response and the change commit together. A retry with the same key and body returns
   * the first response; the same key with a different body returns 409. Failed requests are not stored.
   */
  async function idempotent<T>(req: FastifyRequest, reply: FastifyReply, opts: { required: boolean; status: 200 | 201 }, fn: Handler<T>) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string") {
      if (opts.required) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "this operation needs an Idempotency-Key header", 400);
      return reply.code(opts.status).send(await tx(req, fn));
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new DomainError("VALIDATION", "Idempotency-Key must be 8 to 128 letters, digits, dots, colons, dashes or underscores", 400);
    }
    const caller = callerOf(req);
    const requestHash = hashToken(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
    const result = await deps.uow.run(caller.tenantId, async (store: ProcurementStore) => {
      const existing = await store.findIdempotency(caller.tenantId, key);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "this Idempotency-Key was used for a different request", 409);
        }
        return { status: existing.status, body: existing.body };
      }
      const body = await fn({ purchase: new ProcurementService(store, now), rfq: new RfqService(store, now) }, caller);
      await store.saveIdempotency(caller.tenantId, key, { requestHash, status: opts.status, body });
      return { status: opts.status, body };
    });
    return reply.code(result.status).send(result.body);
  }

  const P = "/v1/procurement";
  const param = (req: FastifyRequest, name: string): string => (req.params as Record<string, string>)[name]!;

  // Suppliers
  app.get(`${P}/suppliers`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return tx(req, ({ purchase }, c) => purchase.listSuppliers(c, { status: q.status, search: q.search, ...pageQuery(req) }));
  });
  app.post(`${P}/suppliers`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, ({ purchase }, c) => purchase.createSupplier(c, req.body)));
  app.get(`${P}/suppliers/:supplierId`, async (req) => tx(req, ({ purchase }, c) => purchase.getSupplier(c, param(req, "supplierId"))));
  app.post(`${P}/suppliers/:supplierId/qualification`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, ({ purchase }, c) => purchase.recordQualification(c, param(req, "supplierId"), req.body)));

  // Purchase requests
  app.get(`${P}/purchase-requests`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return tx(req, ({ purchase }, c) => purchase.listPurchaseRequests(c, { status: q.status, ...pageQuery(req) }));
  });
  app.post(`${P}/purchase-requests`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, ({ purchase }, c) => purchase.createPurchaseRequest(c, req.body)));
  app.get(`${P}/purchase-requests/:requestId`, async (req) => tx(req, ({ purchase }, c) => purchase.getPurchaseRequest(c, param(req, "requestId"))));
  app.post(`${P}/purchase-requests/:requestId/decision`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, ({ purchase }, c) => purchase.decidePurchaseRequest(c, param(req, "requestId"), req.body)));
  app.post(`${P}/purchase-requests/:requestId/cancel`, async (req) => tx(req, ({ purchase }, c) => purchase.cancelPurchaseRequest(c, param(req, "requestId"))));

  // RFQs
  app.get(`${P}/rfqs`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return tx(req, ({ rfq }, c) => rfq.listRfqs(c, { status: q.status, ...pageQuery(req) }));
  });
  app.post(`${P}/rfqs`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, ({ rfq }, c) => rfq.createRfq(c, req.body)));
  app.get(`${P}/rfqs/:rfqId`, async (req) => tx(req, ({ rfq }, c) => rfq.getRfq(c, param(req, "rfqId"))));
  app.post(`${P}/rfqs/:rfqId/quotes`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 201 }, ({ rfq }, c) => rfq.recordQuote(c, param(req, "rfqId"), req.body)));
  app.get(`${P}/rfqs/:rfqId/comparison`, async (req) => tx(req, ({ rfq }, c) => rfq.comparison(c, param(req, "rfqId"))));
  app.post(`${P}/rfqs/:rfqId/award`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, ({ rfq }, c) => rfq.awardRfq(c, param(req, "rfqId"), req.body)));
  app.post(`${P}/rfqs/:rfqId/cancel`, async (req) => tx(req, ({ rfq }, c) => rfq.cancelRfq(c, param(req, "rfqId"))));

  // Purchase orders
  app.get(`${P}/purchase-orders`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return tx(req, ({ purchase }, c) => purchase.listPurchaseOrders(c, { status: q.status, supplierId: q.supplierId, ...pageQuery(req) }));
  });
  app.post(`${P}/purchase-orders`, async (req, reply) => idempotent(req, reply, { required: false, status: 201 }, ({ purchase }, c) => purchase.createPurchaseOrder(c, req.body)));
  app.get(`${P}/purchase-orders/:poId`, async (req) => tx(req, ({ purchase }, c) => purchase.getPurchaseOrder(c, param(req, "poId"))));
  app.post(`${P}/purchase-orders/:poId/submit`, async (req) => tx(req, ({ purchase }, c) => purchase.submitPurchaseOrder(c, param(req, "poId"))));
  app.post(`${P}/purchase-orders/:poId/decision`, async (req, reply) =>
    idempotent(req, reply, { required: false, status: 200 }, ({ purchase }, c) => purchase.decidePurchaseOrder(c, param(req, "poId"), req.body)));
  // Releasing a PO emits po.issued and binds the supplier to it: the key is required.
  app.post(`${P}/purchase-orders/:poId/release`, async (req, reply) =>
    idempotent(req, reply, { required: true, status: 200 }, ({ purchase }, c) => purchase.releasePurchaseOrder(c, param(req, "poId"))));
  app.post(`${P}/purchase-orders/:poId/acknowledge`, async (req) =>
    tx(req, ({ purchase }, c) => purchase.acknowledgePurchaseOrder(c, param(req, "poId"), req.body)));
  app.post(`${P}/purchase-orders/:poId/close`, async (req) => tx(req, ({ purchase }, c) => purchase.closePurchaseOrder(c, param(req, "poId"))));
  app.post(`${P}/purchase-orders/:poId/cancel`, async (req) => tx(req, ({ purchase }, c) => purchase.cancelPurchaseOrder(c, param(req, "poId"))));

  return app;
}
