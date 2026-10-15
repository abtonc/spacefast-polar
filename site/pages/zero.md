---
title: Zero capsules
description: Add Polar checkout, the customer portal, webhooks, and live entitlements to a Spacefast Zero capsule with spacefast-polar.
lead: Zero server code can only import `@spacefast/zero/server` and its own files. So instead of installing the adapter, you copy its TypeScript source into your capsule and import it from there.
---

## Add the adapter

Run this from the directory that holds `sf.jsonc`:

```bash
npx spacefast-polar add zero
```

It writes `server/polar/`:

```text
server/polar/
  index.ts      re-exports zero/index.ts and records the version
  core/         client, webhooks, entitlements, handlers
  zero/         createPolar for Zero
```

Import everything from `./polar/index.ts`. It re-exports the core helpers too, such as `hasActiveSubscription` and `createPolarClient`. Don't edit the copied files; [update them with `--force`](#update-the-adapter) instead.

## Write the server entry

Here is a complete `server/index.ts` for an app with one Pro plan:

```ts server/index.ts
import { capsule, endpoint, query, string, table } from "@spacefast/zero/server";
import { createPolar } from "./polar/index.ts";

const PRO_PRODUCT_ID = "…"; // the product's UUID from the Polar dashboard

const polar = createPolar({ invalidate: ["entitlements"] });

export default capsule({
  name: "my-app",
  schema: {
    // Zero reads the schema from this file's source, so the adapter's
    // tables are written out here rather than imported.
    polarEntitlements: table({
      externalId: string(),
      customerId: string(),
      entitlements: string(),
      version: string(),
    }).index("by_external_id", ["externalId"]),
    polarWebhookDeliveries: table({
      webhookId: string(),
      eventType: string(),
    }).index("by_webhook_id", ["webhookId"]),
  },
  queries: {
    entitlements: query((ctx) => polar.entitlements(ctx)),
  },
  endpoints: {
    checkout: endpoint(
      { method: "GET", path: "/api/polar/checkout" },
      polar.checkout({ products: [PRO_PRODUCT_ID], successUrl: "/billing" }),
    ),
    portal: endpoint({ method: "GET", path: "/api/polar/portal" }, polar.portal({ returnUrl: "/billing" })),
    sync: endpoint({ method: "POST", path: "/api/polar/sync" }, polar.sync()),
    webhooks: endpoint(
      { method: "POST", path: "/api/polar/webhooks" },
      polar.webhooks({
        "order.paid": (event, { ctx }) => ctx.log.info("order paid", { order: event.data.id }),
      }),
    ),
  },
});
```

### Why the tables are written out

Zero builds a capsule's database schema by reading the source of the server entry. A table spread in from another module isn't picked up, so the two tables have to appear literally in `schema`. Keep the names, fields, and indexes exactly as shown:

| Table | Holds |
| --- | --- |
| `polarEntitlements` | One row per customer: your user id, Polar's customer id, the [entitlements](entitlements.html) as JSON, and the Polar timestamp of that snapshot. |
| `polarWebhookDeliveries` | The `webhook-id` of every delivery that was handled, used to acknowledge redeliveries without running handlers again. |

If they're missing, the adapter throws `Polar: declare the polarEntitlements and polarWebhookDeliveries tables in your capsule schema.` Zero has no way to prune the deliveries table yet, so it grows by one row per webhook.

## The endpoints

| Endpoint | Handler | What it does |
| --- | --- | --- |
| `GET /api/polar/checkout` | `polar.checkout(options)` | Creates a checkout for the signed-in user and redirects to it. See [Checkout](checkout.html). |
| `GET /api/polar/portal` | `polar.portal(options)` | Opens the Polar customer portal for the signed-in user. |
| `POST /api/polar/sync` | `polar.sync()` | Reads the signed-in user's state from Polar, stores it, and returns it as JSON. |
| `POST /api/polar/webhooks` | `polar.webhooks(handlers)` | Verifies the delivery, stores `customer.state_changed`, and runs your handlers inside the endpoint's transaction. See [Webhooks](webhooks.html). |

The paths are yours to choose. Just point the Polar webhook endpoint at whatever path you mount `polar.webhooks()` on.

## Configure createPolar

```ts
const polar = createPolar({
  server: "sandbox",                 // otherwise ctx.env.POLAR_SERVER, then production
  client: { timeoutMs: 4000 },       // extra API client options
  invalidate: ["entitlements"],      // live queries to refresh when entitlements change
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `server` | `ctx.env.POLAR_SERVER`, then `"production"` | Which Polar API to call. |
| `client` | `{ maxRetries: 1 }` | [Client options](client.html#options) other than `accessToken` and `server`. |
| `invalidate` | every live query | Query names to refresh when a webhook or sync changes someone's entitlements. |

Retries default to 1 because Zero gives a fetch 5 seconds in write endpoints and 10 in read endpoints.

## Read entitlements on the server

`polar.entitlements(ctx)` returns the signed-in user's [entitlements](entitlements.html) from the capsule database. It never calls Polar, so it's cheap to run in queries and mutations. Signed-out visitors get empty entitlements.

Gate a mutation like this:

```ts
import { mutation } from "@spacefast/zero/server";
import { createPolar, hasActiveSubscription } from "./polar/index.ts";

// inside capsule({ mutations: { … } })
addNote: mutation(async (ctx, body: string) => {
  const auth = ctx.auth.requireSignedIn();
  const entitlements = await polar.entitlements(ctx);
  if (!hasActiveSubscription(entitlements, PRO_PRODUCT_ID)) {
    const count = await ctx.db.notes.withIndex("by_owner", (range) => range.eq("ownerId", auth.userId)).count();
    if (count >= 3) return { ok: false, reason: "limit" };
  }
  await ctx.db.notes.insert({ body, ownerId: auth.userId });
  ctx.invalidate("notes");
  return { ok: true };
}),
```

## Use it in the browser

The `entitlements` query is live. Read it with `useQuery`, and link to the endpoints with plain anchors, since both are GET redirects:

```tsx client/Upgrade.tsx
import { useQuery } from "@spacefast/zero/client";

// The full shape is PolarEntitlements in server/polar/core/entitlements.ts.
type Entitlements = { subscriptions: { productId: string; status: "active" | "trialing" }[] };

const PRO_PRODUCT_ID = "…";

export function Upgrade() {
  const entitlements = useQuery<Entitlements>("entitlements");
  const isPro = entitlements?.subscriptions.some((s) => s.productId === PRO_PRODUCT_ID);
  return isPro ? <a href="/api/polar/portal">Manage billing</a> : <a href="/api/polar/checkout">Upgrade to Pro</a>;
}
```

The checkout link has no `?products=` here because the endpoint's `products` allowlist has one entry, which it offers by default.

## Sync after checkout

After paying, Polar sends the buyer to your success URL with `?checkout_id=…`. The webhook usually lands within seconds, but you can read through to Polar right away with `POST /api/polar/sync`.

Zero only accepts cookie-authenticated writes that send a non-safelisted content type, so post JSON with `authenticatedFetch` from the signed-in browser:

```tsx pages/billing.tsx
import { authenticatedFetch, useAuth } from "@spacefast/zero/client";
import { useEffect } from "preact/hooks";

export default function BillingPage() {
  const auth = useAuth();

  // Coming back from checkout: read through to Polar instead of waiting for the webhook.
  useEffect(() => {
    if (!auth.isSignedIn) return;
    if (!new URLSearchParams(window.location.search).has("checkout_id")) return;
    void authenticatedFetch("/api/polar/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }, [auth.isSignedIn]);

  return <p>…</p>;
}
```

Sync stores the result and refreshes the `invalidate` queries, so `useQuery("entitlements")` updates on its own.

## Who is buying

Checkout uses the signed-in user's `ctx.auth.userId` as Polar's `external_customer_id`. That id links the purchase to the account, and entitlements are looked up by it. It never comes from the request.

- **Guests** get `401 Sign in to buy`. Pass `allowGuests: true` to let them check out anyway; their purchase isn't linked to an account, so it grants nothing in the app.
- **Email** is prefilled from `ctx.auth.email` unless the email is marked unverified.
- **Name** is left for the buyer to type, since a Spacefast display name is often an account handle. Pass `prefillName: true` to prefill it from `ctx.auth.displayName`.
- **Your own mapping:** `customer: (ctx) => ({ externalId, email, name })` replaces the buyer derived from `ctx.auth`. Return `null` for nobody.

The portal and sync endpoints always require a signed-in user.

## Live invalidation

When a webhook or sync writes newer entitlements for someone, the adapter calls `ctx.invalidate` with the query names in `invalidate`, so open pages refresh without polling. Without `invalidate`, it refreshes every live query on the page.

List every query whose result depends on entitlements, such as one that returns a user's quota.

## Call Polar from actions

`polar.client(ctx)` builds an [API client](client.html) from `ctx.env`. Use it in actions, for example to report metered usage:

```ts
import { action } from "@spacefast/zero/server";

// inside capsule({ actions: { … } })
recordUsage: action(async (ctx, reads: number) => {
  const auth = ctx.auth.requireSignedIn();
  const result = await polar.client(ctx).events.ingest({
    events: [{ name: "config_reads", external_customer_id: auth.userId, metadata: { reads } }],
  });
  return { inserted: result.inserted };
}),
```

Polar adds ingested events to the customer's meter in the background, so the balance in entitlements [catches up a few minutes later](troubleshooting.html#usage-balances-lag).

Zero's QuickJS runner has no `crypto.subtle`, so the adapter checks webhook signatures with its own HMAC-SHA256. You don't need to do anything for this.

## Update the adapter

After upgrading `spacefast-polar`, replace the copy:

```bash
npx spacefast-polar add zero --force
```

This deletes `server/polar/` and copies it again, so local edits there are lost. The first line of `server/polar/index.ts` records the version it came from. See [CLI](cli.html#add-zero) for `--dir`.
