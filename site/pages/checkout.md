---
title: Checkout and portal
description: Options, query parameters, the products allowlist, the prepare hook, metadata, success URLs, and the customer portal in spacefast-polar.
lead: The checkout endpoint is a GET route. It creates a Polar checkout session from your options and the query string, then redirects the buyer to it. The portal endpoint does the same for Polar's customer portal.
---

## How a checkout is built

Fields are layered, later ones winning:

1. `defaults` from your options.
2. The [query parameters](#query-parameters) the adapter accepts.
3. The output of your [`prepare` hook](#prepare), computed on the server for this request.

Then the buyer's `external_customer_id` is set from your server-side auth. It never comes from the query or from `prepare`.

Link to it like any page:

```tsx
<a href="/api/polar/checkout?products=<product id>">Upgrade</a>
```

## Options

These options are shared by both runtimes:

| Option | Default | Meaning |
| --- | --- | --- |
| `products` | none | Product ids this route may sell. See [allowlist](#products-allowlist). |
| `successUrl` | `"/"` | Where Polar sends the buyer after paying. Absolute, or a path on this site. See [success URL](#success-url). |
| `includeCheckoutId` | `true` | Append `checkout_id={CHECKOUT_ID}` to the success URL. |
| `returnUrl` | none | Renders a back button in the checkout. Absolute, or a path on this site. |
| `defaults` | none | Fields merged into every checkout, such as `{ allow_trial: false }` or server-side `metadata`. |
| `queryMetadata` | `false` | Accept `?metadata=` from the request. See [metadata](#metadata). |
| `prepare` | none | Computes fields for this checkout on the server, or rejects it. See [prepare](#prepare). |

Each runtime adds options for identifying the buyer.

### Zero

| Option | Default | Meaning |
| --- | --- | --- |
| `allowGuests` | `false` | Let signed-out visitors check out. Their purchase grants nothing in the app. Otherwise they get `401 Sign in to buy`. |
| `prefillName` | `false` | Prefill the name field from `ctx.auth.displayName`. |
| `customer` | from `ctx.auth` | `(ctx) => CheckoutCustomer \| null`. Replaces the buyer derived from `ctx.auth`. |
| `prepare` | none | `(ctx, req) => CheckoutPreparation \| null \| undefined`, sync or async. |

### Functions

| Option | Default | Meaning |
| --- | --- | --- |
| `customer` | none | `(request, env) => CheckoutCustomer \| null \| undefined`, sync or async. Resolve it from your session. |
| `requireCustomer` | `false` | Answer `401 Sign in to buy` when `customer` resolves to nobody. Otherwise the checkout is anonymous. |
| `prepare` | none | `(request, env) => CheckoutPreparation \| null \| undefined`, sync or async. |

`CheckoutCustomer` is `{ externalId?: string; email?: string; name?: string }`. `externalId` is your user id. Polar links the purchase to it, and entitlements are looked up by it.

## Query parameters

These match Polar's own framework adapters:

| Parameter | Effect |
| --- | --- |
| `products` | Product ids. Repeat it or separate with commas. |
| `customer_email` | Prefills the email, unless your `customer` already has one. |
| `customer_name` | Prefills the name, unless your `customer` already has one. |
| `discount_id` | Applies a discount. |
| `allow_discount_codes` | Shows the discount code field. Any value but `false` turns it on. |
| `seats` | A positive integer, otherwise `400 Invalid seats`. |
| `units` | A positive integer, otherwise `400 Invalid units`. |
| `locale` | Checkout language. |
| `metadata` | URL-encoded JSON object. Read only with `queryMetadata: true`. |

Everything else is ignored, including `customer_id` and `external_customer_id`. Accepting those would let anyone open a checkout prefilled with another customer's details.

## Products allowlist

Without `products` in the options, the route sells whatever `?products=` names, and a request without it gets `400 Missing products`.

With an allowlist, the request must name a subset of it, or it gets `400 Product not sold here: …`. A request without `?products=` offers every listed product:

```ts
// Zero
polar.checkout({ products: [MONTHLY_ID, YEARLY_ID], successUrl: "/billing" });
```

`/api/polar/checkout` offers both plans; `/api/polar/checkout?products=<yearly id>` offers just one.

## Success URL

The success URL is resolved against the request's origin, so `"/billing"` becomes `https://<your-space>/billing`. Unless it already contains `{CHECKOUT_ID}` or you pass `includeCheckoutId: false`, the adapter appends `checkout_id={CHECKOUT_ID}`, which Polar replaces with the checkout's id:

| `successUrl` | Sent to Polar |
| --- | --- |
| `"/billing"` | `https://<your-space>/billing?checkout_id={CHECKOUT_ID}` |
| `"/billing?tab=plan"` | `https://<your-space>/billing?tab=plan&checkout_id={CHECKOUT_ID}` |
| `"/thanks/{CHECKOUT_ID}"` | `https://<your-space>/thanks/{CHECKOUT_ID}` |

Use the id on the success page to trigger a [sync](entitlements.html#sync) so the page shows the new plan before the webhook lands.

## prepare

`prepare` runs on the server for each checkout request. Return the fields to set for this checkout: ad-hoc `prices` for dynamic pricing, trusted `metadata`, or `products`. Return `{ reject: "message", status? }` to refuse the request; the status defaults to `400`.

- `products` from `prepare` replace the query's. With an allowlist, they must be on it too, so a hook that passes request input through can't sell anything the route wasn't meant to.
- `metadata` from `prepare` is merged over metadata from `defaults` and the query.
- Any `external_customer_id` it returns is overwritten by the authenticated buyer.

Here's a credit-pack checkout priced on the server. The buyer picks a pack in the URL, but can't set its price:

```ts server/index.ts (Zero)
const PACKS: Record<string, number> = { small: 500, large: 4900 }; // cents

credits: endpoint(
  { method: "GET", path: "/api/credits/checkout" },
  polar.checkout({
    successUrl: "/credits",
    prepare: (ctx, req) => {
      const pack = req.query.get("pack") ?? "";
      const amount = PACKS[pack];
      if (!amount) return { reject: "Unknown pack" };
      return {
        products: [CREDITS_PRODUCT_ID],
        prices: { [CREDITS_PRODUCT_ID]: [{ amount_type: "fixed", price_amount: amount, price_currency: "usd" }] },
        metadata: { pack },
      };
    },
  }),
),
```

The same hook in a Functions worker receives the `Request`:

```ts functions/api/credits/checkout.ts
import { currentUserId, polar } from "../../_polar";

const CREDITS_PRODUCT_ID = "…";
const PACKS: Record<string, number> = { small: 500, large: 4900 };

export const GET = polar.checkout({
  successUrl: "/credits",
  requireCustomer: true,
  customer: async (request) => {
    const userId = await currentUserId(request);
    return userId ? { externalId: userId } : null;
  },
  prepare: (request) => {
    const pack = new URL(request.url).searchParams.get("pack") ?? "";
    const amount = PACKS[pack];
    if (!amount) return { reject: "Unknown pack" };
    return {
      products: [CREDITS_PRODUCT_ID],
      prices: { [CREDITS_PRODUCT_ID]: [{ amount_type: "fixed", price_amount: amount, price_currency: "usd" }] },
      metadata: { pack },
    };
  },
});
```

In Zero, `prepare` runs after the sign-in check. In Functions, it runs after `customer` resolves.

## Metadata

Checkout metadata ends up on the order and subscription, where your webhook handlers read it. Because the buyer controls the URL, `?metadata=` is **ignored by default**. Set metadata on the server instead:

- the same value on every checkout: `defaults: { metadata: { plan: "pro" } }`
- per request: return `metadata` from `prepare`

If you do accept `?metadata=` with `queryMetadata: true`, treat it as untrusted input, like a referral tag. It must be a JSON object, or the request gets `400 metadata must be a JSON object`. Keys from `prepare` win over the query's.

## Responses

| Status | When |
| --- | --- |
| `302` | Redirect to the Polar checkout. Sent with `cache-control: no-store`. |
| `400` | `Missing products`, `Product not sold here: …`, `Invalid seats`, `Invalid units`, `metadata must be a JSON object`, a `prepare` rejection, or Polar answered `404` or `422`. |
| `401` | `Sign in to buy`: Zero without a signed-in user, or Functions with `requireCustomer`. |
| `502` | `Could not start checkout: …`: Polar answered with another error, or couldn't be reached. |

## Security notes

- The buyer's identity comes from your server: `ctx.auth` in Zero, your `customer` resolver in Functions.
- Webhook handlers should trust only server-set fields: `external_customer_id`, product ids, and metadata from `defaults` or `prepare`.
- Use an allowlist or `prepare` when one route should sell only some products.
- The access token never reaches the browser. The browser only sees the redirect.

## Customer portal

`polar.portal(options)` mints a customer session for the signed-in user and redirects to Polar's customer portal, where they manage subscriptions, payment methods, and invoices.

| Option | Default | Meaning |
| --- | --- | --- |
| `returnUrl` | `"/"` | Where the portal's back link goes. Absolute, or a path on this site. |
| `noCustomerUrl` | none | Where to send someone who has never bought anything. Without it they get `404 No billing account yet`. |
| `customer` | Functions only, required | `(request, env) => string \| null \| undefined`: the user id passed as `externalId` at checkout. |

Signed-out visitors get `401 Sign in to manage billing`. Polar errors other than "no such customer" answer `502 Could not open the customer portal: …`.
