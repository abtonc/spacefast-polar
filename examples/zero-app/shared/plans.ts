// Polar sandbox catalog for the "Klor" organization. Product and meter ids are
// public; the access token lives only in the space's secret variables.
export const PRO_PRODUCT_ID = "ec7191df-7d8c-4b64-9e56-f67a64572657";
export const CONFIG_READS_METER_ID = "03d370ee-43e3-4b25-8f67-998a360e4ae7";
/** The meter counts `config_reads` events, summing their `reads` property. */
export const CONFIG_READS_EVENT = "config_reads";

export const FREE_NOTE_LIMIT = 3;

export type Note = {
  id: string;
  body: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

/** The JSON shape the `entitlements` query returns (PolarEntitlements). */
export type Entitlements = {
  customerId: string | null;
  externalId: string | null;
  email: string | null;
  subscriptions: Array<{
    id: string;
    productId: string;
    status: "active" | "trialing";
    recurringInterval: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
    endsAt: string | null;
  }>;
  benefits: Array<{ grantId: string; benefitId: string; type: string; metadata: Record<string, unknown> }>;
  meters: Array<{ meterId: string; consumedUnits: number; creditedUnits: number; balance: number }>;
};

export type Delivery = { id: string; webhookId: string; eventType: string; createdAt: string };

export function isPro(entitlements: Entitlements | undefined | null): boolean {
  return Boolean(entitlements?.subscriptions.some((subscription) => subscription.productId === PRO_PRODUCT_ID));
}

export function cleanNote(value: string): string {
  return value.trim().slice(0, 280);
}
