---
title: Entitlements
description: The PolarEntitlements snapshot spacefast-polar stores per customer, the helpers that check it, how snapshots are ordered, and how to sync.
lead: An entitlements snapshot is what a customer has right now, condensed from Polar's customer state. It's plain JSON, so it fits in a database row, a Zero query result, or a response to the browser.
---

## The shape

```ts
type PolarEntitlements = {
  customerId: string | null;   // Polar's customer id
  externalId: string | null;   // your user id
  email: string | null;
  subscriptions: Array<{
    id: string;
    productId: string;
    status: "active" | "trialing";
    recurringInterval: RecurringInterval;  // "day" | "week" | "month" | "year"
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
    endsAt: string | null;
  }>;
  benefits: Array<{
    grantId: string;
    benefitId: string;
    type: BenefitType;           // e.g. "feature_flag", "license_keys", "meter_credit"
    metadata: MetadataOutputType;
  }>;
  meters: Array<{
    meterId: string;
    consumedUnits: number;
    creditedUnits: number;
    balance: number;
  }>;
};
```

- `subscriptions` holds only active and trialing subscriptions. A subscription set to cancel stays here, with `cancelAtPeriodEnd: true`, until the period ends.
- `benefits` holds the benefit grants the customer has now. `metadata` is the benefit's metadata from the Polar dashboard, which is handy for matching feature flags.
- `meters` holds meter balances for usage-based billing. `balance` can go negative when usage exceeds the credited units.
- A customer deleted in Polar, or one Polar doesn't know, has empty lists.

Import the type from `spacefast-polar`, or from `./polar/index.ts` in a Zero capsule.

## Helpers

```ts
import { hasActiveSubscription, hasBenefit, meterBalance } from "spacefast-polar";

hasActiveSubscription(entitlements);                         // any active or trialing subscription
hasActiveSubscription(entitlements, PRO_PRODUCT_ID);         // to this product
hasActiveSubscription(entitlements, [MONTHLY_ID, YEARLY_ID]); // to any of these

hasBenefit(entitlements, BENEFIT_ID);                         // by benefit id
hasBenefit(entitlements, { type: "feature_flag", metadata: { feature: "export" } });

meterBalance(entitlements, METER_ID);                         // 0 when there's no such meter
```

| Function | Returns |
| --- | --- |
| `hasActiveSubscription(entitlements, productIds?)` | `true` when there's an active or trialing subscription, to one of `productIds` if given. |
| `hasBenefit(entitlements, matcher)` | `true` when a grant matches. `matcher` is a benefit id, or `{ benefitId?, type?, metadata? }` where every given field and metadata key must match. |
| `meterBalance(entitlements, meterId)` | The meter's remaining balance, or `0`. |
| `emptyEntitlements()` | The entitlements of someone who has never bought anything. |
| `toEntitlements(state)` | Condenses a Polar `CustomerState`. `null` or a deleted customer gives empty entitlements. |

Gating on a benefit instead of a product id lets you change plans in Polar without redeploying: give every plan that includes exports a feature-flag benefit with `{ feature: "export" }` metadata.

## Where they're stored

| Runtime | Storage | Read with |
| --- | --- | --- |
| Zero | The `polarEntitlements` table, one row per user. | `polar.entitlements(ctx)` in queries, mutations, and actions. |
| Functions | The `polar_entitlements` table in `env.DB`. | `polar.getEntitlements(env, userId)`. |

Snapshots are keyed by `externalId`, your user id. A customer without one, such as a guest checkout, isn't stored, because nothing could look it up.

## Ordering

Every stored snapshot has a version: the Polar timestamp it reflects, normalized to `YYYY-MM-DDTHH:MM:SS.ffffffZ` so versions compare as strings. A save is skipped when the stored version is newer, so a late or replayed webhook never overwrites newer state.

- A webhook snapshot is dated by the event's `timestamp`.
- A sync is dated by the `Date` header of Polar's response, rounded down to the second. A webhook for a change made in that same second still wins.

## Sync

Webhooks keep entitlements current, usually within seconds. To read through to Polar sooner, sync:

| Runtime | How |
| --- | --- |
| Zero | `POST /api/polar/sync` from the signed-in browser. See [Zero: sync after checkout](zero.html#sync-after-checkout). |
| Functions | `GET /api/polar/entitlements?sync=1`, or `polar.syncEntitlements(env, userId)` on the server. |
| Anywhere | `syncEntitlements(client, store, externalId)` from `spacefast-polar`. |

Sync fetches the customer's state with `GET /v1/customers/external/{id}/state` and stores it. A user Polar doesn't know yet is stored as having nothing. It needs the `customers:read` scope and a claimed space.

Usage is the exception to "within seconds": Polar adds ingested events to meter balances in the background, which took about six minutes in the sandbox. When it finishes, Polar sends `customer.state_changed` and the stored balance updates on its own.

## Custom stores

Both adapters implement the `EntitlementStore` interface from `spacefast-polar`. Implement it to keep entitlements somewhere else, and pass it to `handleWebhookRequest` and `syncEntitlements`:

```ts
type EntitlementStore = {
  get(externalId: string): Promise<{ entitlements: PolarEntitlements; version: string } | null>;
  // Save unless a newer version is stored. Return whether it was written.
  save(entitlements: PolarEntitlements, version: string): Promise<boolean>;
  // Optional: delivery tracking for redeliveries.
  hasDelivery?(webhookId: string): Promise<boolean>;
  recordDelivery?(webhookId: string, eventType: string): Promise<void>;
};
```

In Functions, `createD1Store(db, { tablePrefix?, deliveryRetentionDays? })` from `spacefast-polar/functions` builds the `env.DB` store on any D1-shaped database.
