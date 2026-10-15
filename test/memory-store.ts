import type { EntitlementStore, StoredEntitlements } from "../src/core/handlers.ts";

export function memoryStore(): EntitlementStore & { rows: Map<string, StoredEntitlements>; deliveries: Set<string> } {
  const rows = new Map<string, StoredEntitlements>();
  const deliveries = new Set<string>();
  return {
    rows,
    deliveries,
    async get(externalId) {
      return rows.get(externalId) ?? null;
    },
    async save(entitlements, version) {
      if (!entitlements.externalId) return false;
      const existing = rows.get(entitlements.externalId);
      if (existing && existing.version > version) return false;
      rows.set(entitlements.externalId, { entitlements, version });
      return true;
    },
    async hasDelivery(id) {
      return deliveries.has(id);
    },
    async recordDelivery(id) {
      deliveries.add(id);
    },
  };
}
