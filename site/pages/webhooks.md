---
title: Webhooks
description: How spacefast-polar verifies Polar webhooks, stores customer.state_changed, runs typed handlers, deduplicates redeliveries, and which status codes it returns.
lead: The webhook endpoint verifies each delivery, keeps entitlements in sync from `customer.state_changed`, and then runs your handlers. You don't need any handlers for entitlements to work.
---

## What happens on each delivery

1. The signature and timestamp are verified against `POLAR_WEBHOOK_SECRET`. A bad one answers `403` before anything else runs.
2. If this `webhook-id` was already handled, the endpoint answers `200 Already processed` and stops.
3. For `customer.state_changed`, the snapshot is stored unless a newer one is already there. In Zero, the `invalidate` queries refresh.
4. Your handler for the event type runs, then `onEvent`.
5. The `webhook-id` is recorded and the endpoint answers `202 Accepted`.

The delivery is recorded only after your handlers succeed. If one throws, the endpoint answers `500` and Polar retries the delivery later.

## Handlers

Pass a map from event type to handler. Each handler gets the typed event and a context object:

```ts
polar.webhooks({
  "order.paid": async (event, context) => {
    // event.data is a typed Order
  },
  "subscription.canceled": async (event, context) => {
    // event.data is a typed Subscription
  },
  onEvent: async (event, context) => {
    // runs for every verified event, after the specific handler
  },
});
```

Event names and payload types come from Polar's OpenAPI spec, so your editor completes them. Your Polar webhook endpoint must subscribe to every event you handle; the adapter itself needs only `customer.state_changed`.

### Context

| Runtime | Context | Notes |
| --- | --- | --- |
| Zero | `{ ctx, polar }` | `ctx` is the endpoint's write context: `ctx.db`, `ctx.log`, `ctx.env`, `ctx.auth`, `ctx.invalidate`. Handlers run inside the endpoint's transaction. |
| Functions | `{ request, env, polar }` | `env` is the worker env, including `env.DB`. |

In both, `polar` is the [API client](client.html), created only when you first touch it, so a webhook endpoint whose handlers don't call Polar works without `POLAR_ACCESS_TOKEN`.

A Zero handler that records paid orders in an `orders` table of your own:

```ts
webhooks: endpoint(
  { method: "POST", path: "/api/polar/webhooks" },
  polar.webhooks({
    onEvent: (event, { ctx }) => ctx.log.info("polar webhook", { type: event.type }),
    "order.paid": async (event, { ctx }) => {
      // The handler's ctx isn't typed with your schema, hence the `!`.
      await ctx.db.orders!.insert({
        orderId: event.data.id,
        userId: event.data.customer.external_id ?? "",
        amount: event.data.total_amount,
      });
    },
  }),
),
```

Webhooks are delivered by Polar, not by a signed-in browser, so `ctx.auth` is not the buyer. Use `event.data.customer.external_id`, which is your user id when the checkout had a signed-in buyer.

## Status codes

| Status | Body | Meaning |
| --- | --- | --- |
| `202` | `Accepted` | Verified and handled. |
| `200` | `Already processed` | This `webhook-id` was handled before. Handlers didn't run. |
| `400` | `Webhook payload is not valid JSON`, or `… has no event type` | The signature matched, but the body isn't a Polar event. |
| `403` | the reason | Bad signature, missing `webhook-*` headers, or a timestamp more than 5 minutes off. |
| `405` | `Method not allowed` | Functions only: not a POST. |
| `500` | `Webhook secret not configured` | `POLAR_WEBHOOK_SECRET` is not set. |
| `500` | | A handler threw. The delivery isn't recorded. |

Polar treats any status other than 2xx as a failure and retries the delivery later.

Polar may disable an endpoint after repeated failures. Re-enable it in the Polar dashboard once fixed, and redeliver the failed events from its delivery log.

## Redeliveries and ordering

**Redeliveries.** The `webhook-id` header is stable across retries and manual redeliveries. Once a delivery succeeds, its id is recorded, and later copies are acknowledged with `200` without running handlers. Zero keeps ids in `polarWebhookDeliveries`; Functions keeps them in `polar_webhook_deliveries` for 30 days. A Functions worker without `env.DB` can't track deliveries, so handlers run for every copy.

A delivery whose handler threw is not recorded, so its retry runs every handler again, including ones that succeeded the first time. Write handlers so running twice is harmless, for example by keying inserts on `event.data.id`.

**Ordering.** Webhooks can arrive late or out of order. Each `customer.state_changed` snapshot is stored with Polar's event timestamp, and an older snapshot never replaces a newer one. A [sync](entitlements.html#sync) is dated by the `Date` header of Polar's response, rounded down to the second, so a webhook for a change made in that same second still wins.

## Signing schemes

Polar has signed webhooks two ways. Both are accepted, with the same `whsec_…` secret you paste from the dashboard:

- **Legacy secrets**, created before 8 September 2026, sign with the UTF-8 bytes of the whole secret.
- **Standard Webhooks secrets**, created since, sign with the base64-decoded part after `whsec_`.

Verification follows the [Standard Webhooks](https://www.standardwebhooks.com) format: the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers, `v1` signatures, a constant-time comparison, and a 300-second timestamp tolerance.

## Verify webhooks yourself

Outside the adapters, use `verifyWebhook` from `spacefast-polar`. Pass the raw body, before any JSON parsing:

```ts
import { verifyWebhook, WebhookVerificationError } from "spacefast-polar";

export async function POST(request: Request, { env }: { env: { POLAR_WEBHOOK_SECRET: string } }) {
  const body = await request.text();
  try {
    const { id, timestamp, event } = await verifyWebhook(body, request.headers, env.POLAR_WEBHOOK_SECRET);
    if (event.type === "order.paid") {
      console.log(id, timestamp, event.data.id);
    }
    return new Response("Accepted", { status: 202 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(error.message, { status: 403 });
    throw error;
  }
}
```

| Function | Signature |
| --- | --- |
| `verifyWebhook` | `(body: string \| Uint8Array, headers, secret: string, options?: { toleranceSeconds?, now? }) => Promise<{ id, timestamp, event }>` |
| `dispatchWebhook` | `(event, handlers, context) => Promise<boolean>`: runs the matching handler and `onEvent`; `true` if any ran. |
| `handleWebhookRequest` | The whole flow above, for a custom runtime: `({ body, headers, secret, handlers, context, store?, onEntitlementsChanged? }) => Promise<HttpResult>`. |

`headers` can be a Fetch `Headers`, Zero's request headers, or a plain object; names match case-insensitively. `verifyWebhook` throws `WebhookVerificationError` for a bad signature, missing headers, a stale or future timestamp, or an empty secret, and `PolarError` when the verified body isn't a Polar event.
