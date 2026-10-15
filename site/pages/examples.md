---
title: Examples
description: Working spacefast-polar examples in the repository - a Zero capsule with a Pro plan and metered usage, and a minimal Functions worker.
lead: Two runnable apps live in the repository's `examples/` folder. Copy from them freely.
---

## Zero: notes with a Pro plan {#zero-app}

`examples/zero-app` is a notes app on a Zero capsule. Free accounts keep three notes; a Pro subscription removes the limit and adds metered API usage.

| File | What to look at |
| --- | --- |
| `server/index.ts` | The two Polar tables, the `entitlements` query, all four endpoints, and webhook handlers that log every event and paid orders. |
| `server/polar/` | The adapter, vendored by `npx spacefast-polar add zero`. |
| `shared/plans.ts` | Product and meter ids, and the entitlements type shared by server and client. |
| `pages/index.tsx` | The notes page. Shows the free limit and the upgrade prompt. |
| `pages/billing.tsx` | Plan status, checkout and portal links, sync after checkout, and the meter balance. |
| `pages/debug.tsx` | Your user id, the stored entitlements row, and recent webhook deliveries, all live. |

Things it demonstrates:

- **Gating a mutation.** `addNote` reads `polar.entitlements(ctx)` and enforces the free limit unless `hasActiveSubscription(entitlements, PRO_PRODUCT_ID)`.
- **A single-product checkout.** The checkout endpoint has `products: [PRO_PRODUCT_ID]`, so the billing page links to `/api/polar/checkout` with no query string.
- **Sync after checkout.** The billing page posts to `/api/polar/sync` when the URL has `checkout_id`.
- **Metered usage.** The `recordUsage` action calls `polar.client(ctx).events.ingest` with a `config_reads` event. The meter balance on the billing page updates a few minutes later, when Polar's `customer.state_changed` arrives.
- **Live invalidation.** `createPolar({ invalidate: ["entitlements", "deliveries"] })` refreshes both the plan and the deliveries list when a webhook lands.

To run your own copy, create a product with a meter in your Polar sandbox, put their ids in `shared/plans.ts`, and follow [Get started](get-started.html).

## Functions: a gated Pro report {#functions-app}

`examples/functions-app` is a Functions worker that sells a Pro plan and gates an API route on it. Every route shares one `functions/_polar.ts` helper, as in the [Functions guide](functions.html#create-a-shared-helper).

| Route | File |
| --- | --- |
| `GET /api/polar/checkout` | `functions/api/polar/checkout.ts`: the product is decided on the server with `prepare`, so the URL can't pick another one. |
| `GET /api/polar/portal` | `functions/api/polar/portal.ts` |
| `GET /api/polar/entitlements` | `functions/api/polar/entitlements.ts`: the page adds `?sync=1` after a checkout. |
| `POST /api/polar/webhooks` | `functions/api/polar/webhooks.ts`: logs `order.paid` and `subscription.canceled`. |
| `GET /api/report` | `functions/api/report.ts`: `403` unless `hasActiveSubscription`. |
| `GET/POST/DELETE /api/session` | `functions/api/session.ts`: demo sign-in. |

`functions/_session.ts` is a **demo**. It signs whatever name the visitor types into a cookie, which shows where your auth plugs in but proves nothing about who anyone is. Replace `readSession` with your own session or token check before taking payments.

Besides the Polar secrets, it reads two variables:

```bash
sf env set POLAR_PRO_PRODUCT_ID <product id> --no-secret
openssl rand -base64 32 | sf env set SESSION_SECRET --value-from-stdin
```

The repository's tests drive these route modules end to end, with a SQLite `env.DB` and a mocked Polar API, in `test/examples.test.ts`.
