---
title: Polar billing for Spacefast spaces
description: spacefast-polar sells subscriptions and one-time products from a Spacefast space with Polar, for both Functions workers and Zero capsules.
lead: Sell subscriptions and one-time products from a [Spacefast](https://spacefast.com) space with [Polar](https://polar.sh). Checkout and the customer portal are redirect endpoints. Webhooks keep each customer's entitlements in your space's database, so your code checks them without calling Polar.
---

<!-- flow -->

Polar sends `customer.state_changed` whenever a subscription starts, renews, or ends, or a benefit is granted or revoked. The adapter stores a compact snapshot per customer, keyed by your user id (Polar's `external_customer_id`). Snapshots are ordered by Polar's own timestamps, so a late or replayed webhook never overwrites newer state.

## What's included

<dl class="features">
<div><dt>Checkout and portal</dt><dd>GET endpoints that create a Polar checkout or customer portal session and redirect to it.</dd></div>
<div><dt>Verified webhooks</dt><dd>Both Polar signing schemes, typed handlers per event, and redeliveries acknowledged without running your handlers twice.</dd></div>
<div><dt>Entitlements in your database</dt><dd>One snapshot per customer: active subscriptions, granted benefits, and meter balances.</dd></div>
<div><dt>Both runtimes</dt><dd>Functions workers install it from npm. Zero capsules get the TypeScript source vendored in.</dd></div>
<div><dt>A typed Polar client</dt><dd>Types generated from Polar's OpenAPI spec, with retries and pagination.</dd></div>
<div><dt>Zero runtime dependencies</dt><dd>Requests are pinned to Polar API version <code>{{apiVersion}}</code>.</dd></div>
</dl>

## Set up with your agent {#agent}

Using a coding agent? Copy this prompt into it from your project folder. It installs the right adapter for your runtime, wires up the endpoints, and asks you for the parts only you can do: Polar settings and secrets.

<!-- agent-prompt -->

## Quickstart: Zero capsule

Zero server code can't import npm packages, so copy the adapter into your capsule:

```bash
npx spacefast-polar add zero
```

Then declare its two tables and mount the endpoints in `server/index.ts`:

```ts server/index.ts
import { capsule, endpoint, query, string, table } from "@spacefast/zero/server";
import { createPolar } from "./polar/index.ts";

const polar = createPolar();

export default capsule({
  name: "my-app",
  schema: {
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
    checkout: endpoint({ method: "GET", path: "/api/polar/checkout" }, polar.checkout()),
    portal: endpoint({ method: "GET", path: "/api/polar/portal" }, polar.portal()),
    sync: endpoint({ method: "POST", path: "/api/polar/sync" }, polar.sync()),
    webhooks: endpoint({ method: "POST", path: "/api/polar/webhooks" }, polar.webhooks()),
  },
});
```

Link to `/api/polar/checkout?products=<product id>` and read `useQuery("entitlements")` in the browser. The [Zero guide](zero.html) covers the rest.

## Quickstart: Functions worker

```bash
npm install spacefast-polar
```

Each handler is a route export:

```ts functions/api/polar/webhooks.ts
import { createPolar } from "spacefast-polar/functions";

const polar = createPolar();

export const POST = polar.webhooks({
  "order.paid": async (event) => {
    console.log("paid", event.data.id, event.data.customer.external_id);
  },
});
```

```ts functions/api/polar/checkout.ts
import { createPolar } from "spacefast-polar/functions";
import { getSession } from "../../_session"; // your own auth

const polar = createPolar();

export const GET = polar.checkout({
  successUrl: "/welcome",
  requireCustomer: true,
  customer: async (request) => {
    const session = await getSession(request);
    return session ? { externalId: session.userId } : null;
  },
});
```

The [Functions guide](functions.html) adds the portal, a shared helper, and feature gating.

## Before you ship

Both runtimes need the same setup on the Polar side: an access token, a webhook endpoint that sends `customer.state_changed`, two secrets in the space, and a claimed space. [Get started](get-started.html) walks through it.
