---
title: Functions workers
description: Add Polar checkout, the customer portal, webhooks, and stored entitlements to a Spacefast Functions worker with spacefast-polar.
lead: Install the package, create one shared helper, and export a handler per route. Entitlements are kept in the worker's `env.DB`.
---

## Install

```bash
npm install spacefast-polar
```

There are two entry points:

| Import | Contains |
| --- | --- |
| `spacefast-polar/functions` | `createPolar` for Functions, plus `createD1Store` and `ensureD1Schema`. |
| `spacefast-polar` | The [API client](client.html), [entitlement helpers](entitlements.html#helpers), `verifyWebhook`, errors, and Polar's types. |

## Create a shared helper

Put the Polar instance and your auth lookup in one file. A file whose name starts with `_` is a colocated helper and is never routed.

```ts functions/_polar.ts
import { createPolar } from "spacefast-polar/functions";
import { getSession } from "./_session"; // your own auth

export const polar = createPolar();

// Your auth decides who is buying. It is never read from the query string.
export const currentUserId = async (request: Request) => (await getSession(request))?.userId;
```

`createPolar` takes optional config. Everything defaults to the environment:

| Option | Default | Meaning |
| --- | --- | --- |
| `accessToken` | `env.POLAR_ACCESS_TOKEN` | Organization Access Token. |
| `webhookSecret` | `env.POLAR_WEBHOOK_SECRET` | Endpoint signing secret. |
| `server` | `env.POLAR_SERVER`, then `"production"` | `"sandbox"` or `"production"`. |
| `client` | `{}` | [Client options](client.html#options) such as `maxRetries` or `timeoutMs`. |
| `database` | `true` | Keep entitlements in `env.DB`. Pass `false` to turn it off, or `{ tablePrefix, deliveryRetentionDays }`. Ignored when there is no `env.DB`. |

## Add the routes

Every handler has the signature `(request, contextOrEnv) => Promise<Response>`, so it works as a file-router export and inside a [root `handler.ts`](#route-by-hand-in-handler-ts).

```ts functions/api/polar/checkout.ts
import { currentUserId, polar } from "../../_polar";

// GET /api/polar/checkout?products=<product id>
export const GET = polar.checkout({
  successUrl: "/welcome",
  requireCustomer: true,
  customer: async (request) => {
    const userId = await currentUserId(request);
    return userId ? { externalId: userId } : null;
  },
});
```

```ts functions/api/polar/portal.ts
import { currentUserId, polar } from "../../_polar";

export const GET = polar.portal({ customer: currentUserId, returnUrl: "/account" });
```

```ts functions/api/polar/webhooks.ts
import { polar } from "../../_polar";

export const POST = polar.webhooks({
  "order.paid": async (event, { env }) => {
    console.log("paid", event.data.id, event.data.customer.external_id);
  },
});
```

```ts functions/api/polar/entitlements.ts
import { currentUserId, polar } from "../../_polar";

export const GET = polar.entitlements({ customer: currentUserId });
```

Without `requireCustomer`, a checkout whose `customer` resolves to nobody goes ahead anonymously, and the purchase isn't linked to a user. The portal and entitlements routes always answer `401` to signed-out visitors. [Checkout](checkout.html) lists every option.

If a handler throws, the route logs `Polar handler failed` and answers `500 Internal error`.

## Gate features

Read the stored entitlements with `polar.getEntitlements(env, userId)` and check them with the helpers from `spacefast-polar`:

```ts functions/api/export.ts
import { hasActiveSubscription, hasBenefit } from "spacefast-polar";
import type { PolarEnv } from "spacefast-polar/functions";
import { currentUserId, polar } from "../_polar";

const PRO_PRODUCT_ID = "…";

export async function GET(request: Request, { env }: { env: PolarEnv }) {
  const userId = await currentUserId(request);
  if (!userId) return new Response("Sign in", { status: 401 });

  const entitlements = await polar.getEntitlements(env, userId);
  const allowed =
    hasActiveSubscription(entitlements, PRO_PRODUCT_ID) ||
    hasBenefit(entitlements, { type: "feature_flag", metadata: { feature: "export" } });
  if (!allowed) return new Response("Upgrade to Pro", { status: 403 });

  return Response.json({ ok: true });
}
```

:::warning Answer 403, not 402
Spacefast replaces a 402 response with its own "This site has been disabled pending subscription renewal" page, so visitors would see that instead of your upgrade message.
:::

`getEntitlements` reads `env.DB` and asks Polar only when nothing is stored for that user yet, then stores the answer. Its third argument tunes that:

| Option | Default | Meaning |
| --- | --- | --- |
| `fallbackToApi` | `true` | Ask Polar when nothing is stored. With `false`, a user with no row gets empty entitlements. |
| `maxAgeSeconds` | off | Ask Polar when the stored snapshot is older than this. Webhooks keep it current, so you rarely need it. |

## The database

On first use, the adapter creates two tables in `env.DB`:

| Table | Columns |
| --- | --- |
| `polar_entitlements` | `external_id` (primary key), `customer_id`, `entitlements` (JSON), `version`, `updated_at` |
| `polar_webhook_deliveries` | `webhook_id` (primary key), `event_type`, `received_at` |

Delivery ids are pruned after 30 days (`deliveryRetentionDays`). Change the `polar_` prefix with `database: { tablePrefix: "billing_" }`. The SQL avoids dialect-specific syntax so it runs on MySQL and SQLite. It's tested against SQLite and hasn't yet been run against a live space's MySQL.

:::warning Without env.DB
Every `getEntitlements` call asks Polar, and webhook redeliveries can't be detected, so your handlers run again for each one.
:::

## Sync after checkout

The `entitlements` route returns the user's entitlements as JSON. Add `?sync=1` to read through to Polar first, which is what you want on the checkout success page, before the webhook lands:

```ts
// On /welcome, after Polar redirects back with ?checkout_id=…
const response = await fetch("/api/polar/entitlements?sync=1");
const entitlements = await response.json();
```

On the server, `polar.syncEntitlements(env, userId)` does the same thing.

## Route by hand in handler.ts

A root worker can call the same handlers directly:

```ts handler.ts
import { createPolar, type PolarEnv, type RouteHandler } from "spacefast-polar/functions";
import { getSession } from "./session"; // your own auth

const polar = createPolar();
const currentUserId = async (request: Request) => (await getSession(request))?.userId;

const routes: Record<string, RouteHandler> = {
  "GET /api/polar/checkout": polar.checkout({
    requireCustomer: true,
    customer: async (request) => {
      const userId = await currentUserId(request);
      return userId ? { externalId: userId } : null;
    },
  }),
  "GET /api/polar/portal": polar.portal({ customer: currentUserId }),
  "GET /api/polar/entitlements": polar.entitlements({ customer: currentUserId }),
  "POST /api/polar/webhooks": polar.webhooks(),
};

export default {
  async fetch(request: Request, env: PolarEnv) {
    const { pathname } = new URL(request.url);
    const route = routes[`${request.method} ${pathname}`];
    return route ? route(request, env) : new Response("Not found", { status: 404 });
  },
};
```

## Other helpers

| Member | What it does |
| --- | --- |
| `polar.client(env)` | The [API client](client.html) for this env, cached per env object. |
| `polar.store(env)` | The `env.DB` [entitlement store](entitlements.html#custom-stores), or `null` without a database. |
| `polar.getEntitlements(env, userId, options?)` | Stored entitlements, asking Polar when none are stored. |
| `polar.syncEntitlements(env, userId)` | Fetches entitlements from Polar now and stores them. |

`polar.webhooks()` creates the API client lazily, so the webhook route works without `POLAR_ACCESS_TOKEN` unless a handler uses `polar`.
