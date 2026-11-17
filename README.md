# Procurement service

Part of the QAVRIL LABS ERP, built as a separate product. Owned by the backend lane.

- **Scope:** PRC-01, PRC-02, PRC-03, PRC-05, PRC-06 (PRC-12 later)
- **API prefix:** `/v1/procurement`
- **Database:** Neon project `qavril-procurement`, database `procurement`
- **Contract:** `contracts/procurement.openapi.yaml` in the `home` repository (reviewed by the frontend lane)

## Run locally

```bash
npm ci
cp .env.example .env
npm run dev          # http://localhost:3000/health
npm test
```

## Checks

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `docker build .`. CI runs them on every push and pull request.

## Rules

- No secrets in the code or in `.env.example`. Secrets come from AWS Secrets Manager.
- Money is `bigint` minor units. Amounts cross the API as decimal strings.
- Every tenant table has `tenant_id` and row-level security. Query tenant data only through the tenant transaction helper.
