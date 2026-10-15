import type { BenefitType, CustomerState, MetadataOutputType, RecurringInterval } from "./generated.ts";

/**
 * What a customer is entitled to right now, condensed from Polar's customer
 * state. It is plain JSON, so it can be stored in a database row, returned from
 * a Zero query, or sent to the browser.
 */
export type PolarEntitlements = {
  customerId: string | null;
  externalId: string | null;
  email: string | null;
  subscriptions: Array<{
    id: string;
    productId: string;
    status: "active" | "trialing";
    recurringInterval: RecurringInterval;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
    endsAt: string | null;
  }>;
  benefits: Array<{
    grantId: string;
    benefitId: string;
    type: BenefitType;
    metadata: MetadataOutputType;
  }>;
  meters: Array<{
    meterId: string;
    consumedUnits: number;
    creditedUnits: number;
    balance: number;
  }>;
};

/** Entitlements of someone who has never bought anything. */
export function emptyEntitlements(): PolarEntitlements {
  return { customerId: null, externalId: null, email: null, subscriptions: [], benefits: [], meters: [] };
}

/** Condenses a customer state. A deleted customer, or `null`, has no entitlements. */
export function toEntitlements(state: CustomerState | null | undefined): PolarEntitlements {
  if (!state) return emptyEntitlements();
  if (state.deleted_at) {
    return { ...emptyEntitlements(), customerId: state.id, externalId: state.external_id ?? null };
  }
  return {
    customerId: state.id,
    externalId: state.external_id ?? null,
    email: state.email ?? null,
    subscriptions: state.active_subscriptions.map((subscription) => ({
      id: subscription.id,
      productId: subscription.product_id,
      status: subscription.status,
      recurringInterval: subscription.recurring_interval,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      trialEnd: subscription.trial_end,
      endsAt: subscription.ends_at,
    })),
    benefits: state.granted_benefits.map((grant) => ({
      grantId: grant.id,
      benefitId: grant.benefit_id,
      type: grant.benefit_type,
      metadata: grant.benefit_metadata,
    })),
    meters: state.active_meters.map((meter) => ({
      meterId: meter.meter_id,
      consumedUnits: meter.consumed_units,
      creditedUnits: meter.credited_units,
      balance: meter.balance,
    })),
  };
}

/**
 * True when the customer has an active or trialing subscription, optionally to
 * one of `productIds`.
 */
export function hasActiveSubscription(entitlements: PolarEntitlements, productIds?: string | string[]): boolean {
  if (productIds === undefined) return entitlements.subscriptions.length > 0;
  const wanted = Array.isArray(productIds) ? productIds : [productIds];
  return entitlements.subscriptions.some((subscription) => wanted.includes(subscription.productId));
}

export type BenefitMatcher =
  | string
  | {
      benefitId?: string;
      type?: BenefitType;
      /** Every key here must equal the benefit's metadata value. */
      metadata?: Record<string, string | number | boolean>;
    };

/**
 * True when the customer holds a matching benefit grant. Pass a benefit id, or
 * match on type and metadata, e.g. `{ type: "feature_flag", metadata: { feature: "export" } }`.
 */
export function hasBenefit(entitlements: PolarEntitlements, matcher: BenefitMatcher): boolean {
  const match = typeof matcher === "string" ? { benefitId: matcher } : matcher;
  return entitlements.benefits.some(
    (benefit) =>
      (match.benefitId === undefined || benefit.benefitId === match.benefitId) &&
      (match.type === undefined || benefit.type === match.type) &&
      Object.entries(match.metadata ?? {}).every(([key, value]) => benefit.metadata[key] === value),
  );
}

/** Remaining balance on a meter, or 0 when the customer has none. */
export function meterBalance(entitlements: PolarEntitlements, meterId: string): number {
  return entitlements.meters.find((meter) => meter.meterId === meterId)?.balance ?? 0;
}
