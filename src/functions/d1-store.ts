import type { PolarEntitlements } from "../core/entitlements.ts";
import type { EntitlementStore, StoredEntitlements } from "../core/handlers.ts";

/** The slice of the D1 API a Spacefast worker gets as `env.DB`. */
export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatementLike;
};

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
};

export type D1StoreOptions = {
  /** Table name prefix. Defaults to `polar_`. */
  tablePrefix?: string;
  /** How long delivery ids are kept for deduplication. Defaults to 30 days. */
  deliveryRetentionDays?: number;
};

// The space database is MySQL behind a D1-shaped broker. Everything here is
// written to run unchanged on MySQL and SQLite: VARCHAR keys (MySQL cannot key
// TEXT), MEDIUMTEXT (SQLite reads it as TEXT), and no dialect-specific upsert.
function schema(prefix: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}entitlements (
      external_id VARCHAR(255) NOT NULL PRIMARY KEY,
      customer_id VARCHAR(64),
      entitlements MEDIUMTEXT NOT NULL,
      version VARCHAR(32) NOT NULL,
      updated_at VARCHAR(32) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}webhook_deliveries (
      webhook_id VARCHAR(255) NOT NULL PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      received_at VARCHAR(32) NOT NULL
    )`,
  ];
}

const schemaReady = new WeakMap<object, Map<string, Promise<void>>>();

/** Creates the store's tables once per isolate. Safe to call on every request. */
export function ensureD1Schema(db: D1DatabaseLike, tablePrefix = "polar_"): Promise<void> {
  let byPrefix = schemaReady.get(db);
  if (!byPrefix) schemaReady.set(db, (byPrefix = new Map()));
  let ready = byPrefix.get(tablePrefix);
  if (!ready) {
    ready = (async () => {
      for (const statement of schema(tablePrefix)) await db.prepare(statement).run();
    })();
    // Let the next request try again instead of caching a failure.
    ready.catch(() => byPrefix!.delete(tablePrefix));
    byPrefix.set(tablePrefix, ready);
  }
  return ready;
}

/** An `EntitlementStore` on the worker's `env.DB`. */
export function createD1Store(db: D1DatabaseLike, options: D1StoreOptions = {}): EntitlementStore {
  const prefix = options.tablePrefix ?? "polar_";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new TypeError(`Invalid table prefix: ${prefix}`);
  const entitlementsTable = `${prefix}entitlements`;
  const deliveriesTable = `${prefix}webhook_deliveries`;
  const retentionMs = (options.deliveryRetentionDays ?? 30) * 86_400_000;
  const ready = () => ensureD1Schema(db, prefix);

  async function update(entitlements: PolarEntitlements, version: string): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE ${entitlementsTable} SET customer_id = ?, entitlements = ?, version = ?, updated_at = ?
         WHERE external_id = ? AND version <= ?`,
      )
      .bind(entitlements.customerId, JSON.stringify(entitlements), version, new Date().toISOString(), entitlements.externalId, version)
      .run();
    return changes(result) > 0;
  }

  return {
    async get(externalId: string): Promise<StoredEntitlements | null> {
      await ready();
      const row = await db
        .prepare(`SELECT entitlements, version FROM ${entitlementsTable} WHERE external_id = ?`)
        .bind(externalId)
        .first<{ entitlements: string; version: string }>();
      if (!row) return null;
      return { entitlements: JSON.parse(row.entitlements) as PolarEntitlements, version: row.version };
    },

    async save(entitlements: PolarEntitlements, version: string): Promise<boolean> {
      // Nothing can look up a customer without an external id.
      if (!entitlements.externalId) return false;
      await ready();
      const existing = await db
        .prepare(`SELECT version FROM ${entitlementsTable} WHERE external_id = ?`)
        .bind(entitlements.externalId)
        .first<{ version: string }>();
      if (existing) {
        if (existing.version > version) return false;
        return update(entitlements, version);
      }
      try {
        await db
          .prepare(
            `INSERT INTO ${entitlementsTable} (external_id, customer_id, entitlements, version, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(entitlements.externalId, entitlements.customerId, JSON.stringify(entitlements), version, new Date().toISOString())
          .run();
        return true;
      } catch (error) {
        // Lost a race with a concurrent insert. The guarded update decides.
        const raced = await db
          .prepare(`SELECT version FROM ${entitlementsTable} WHERE external_id = ?`)
          .bind(entitlements.externalId)
          .first<{ version: string }>();
        if (!raced) throw error;
        return update(entitlements, version);
      }
    },

    async hasDelivery(webhookId: string): Promise<boolean> {
      await ready();
      const row = await db
        .prepare(`SELECT webhook_id FROM ${deliveriesTable} WHERE webhook_id = ?`)
        .bind(webhookId)
        .first();
      return row !== null;
    },

    async recordDelivery(webhookId: string, eventType: string): Promise<void> {
      await ready();
      const now = new Date();
      try {
        await db
          .prepare(`INSERT INTO ${deliveriesTable} (webhook_id, event_type, received_at) VALUES (?, ?, ?)`)
          .bind(webhookId, eventType, now.toISOString())
          .run();
      } catch {
        // Already recorded by a concurrent delivery. Nothing to do.
      }
      // Prune now and then rather than on every delivery.
      if (Math.random() < 0.05) {
        await db
          .prepare(`DELETE FROM ${deliveriesTable} WHERE received_at < ?`)
          .bind(new Date(now.getTime() - retentionMs).toISOString())
          .run();
      }
    },
  };
}

function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number; rows_written?: number } } | null)?.meta;
  return meta?.changes ?? meta?.rows_written ?? 1;
}
