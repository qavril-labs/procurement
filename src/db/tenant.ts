import type { Pool, PoolClient } from "pg";

/**
 * Runs `work` inside a transaction with app.tenant_id set, so row-level security
 * limits every query to that tenant. Tenant tables are queried only through this.
 * The tenant id is validated as a UUID before it is used.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error("invalid tenant id");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config with is_local = true lasts only for this transaction.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
