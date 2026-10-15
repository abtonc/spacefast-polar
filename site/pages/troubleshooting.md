---
title: Troubleshooting
description: Fixes for common spacefast-polar problems - failing webhooks, private or unclaimed spaces, signature errors, Zero sync, and lagging usage balances.
lead: Common problems and how to fix them. Polar's delivery log shows the status code and body your endpoint returned for each webhook.
---

## Webhooks get "This space is private"

New spaces are private to your team, so Polar receives the Spacefast access page instead of your endpoint. Make only the webhook path public:

```bash
sf share grant --to public --role viewer --path /api/polar/webhooks
```

## Webhooks answer 404

The route doesn't exist at the URL Polar calls. Check that the Polar endpoint URL matches the path you mounted `polar.webhooks()` on, by default `/api/polar/webhooks`, and that the space was published after adding it.

## Webhooks answer 500 "Webhook secret not configured"

`POLAR_WEBHOOK_SECRET` isn't set in the space:

```bash
sf env set POLAR_WEBHOOK_SECRET --value-from-stdin
```

A `500` with any other body means one of your handlers threw. Polar retries the delivery; check the error in your runtime logs.

## Checkout, portal, or sync fail but webhooks work

The space is probably unclaimed. An unclaimed space can only reach a fixed list of trusted hosts, and `api.polar.sh` isn't on it. Incoming webhooks still work, but every call to Polar fails, so checkout answers `502 Could not start checkout: …`. Claim the space.

## Signature failures (403)

Polar's delivery log shows `403 No matching webhook signature`:

- **Wrong secret.** Each Polar webhook endpoint has its own secret. Copy it from the endpoint the deliveries come from.
- **Sandbox and production mixed up.** A sandbox endpoint's secret never verifies a production delivery, and the other way around. Check which organization the endpoint is in.
- **Rotated secret.** After rotating it in Polar, set the new value with `sf env set`.

`Missing webhook-id, webhook-timestamp, or webhook-signature header` means the request didn't come from Polar. `Webhook timestamp is too old` or `too new` means the delivery's `webhook-timestamp` is more than 5 minutes away from the space's clock.

## Polar answers 401, or checkout fails with 502

`POLAR_SERVER` must match where the token was created: `sandbox` for a sandbox token, `production` or empty for a production one. A sandbox token gets `401` from the production API, which the checkout route reports as `502 Could not start checkout: …`. A value other than `sandbox` or `production` throws.

Also check that the token has the [scopes](get-started.html#2-create-an-access-token) the call needs.

## Zero sync answers 401 or is rejected

`POST /api/polar/sync` must come from the signed-in browser, and Zero only accepts cookie-authenticated writes that send a non-safelisted content type. Post JSON with `authenticatedFetch`:

```ts
await authenticatedFetch("/api/polar/sync", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
```

A plain form post or a `text/plain` body is rejected by Zero. Signed-out requests get `401 Sign in first`.

## Visitors see "This site has been disabled pending subscription renewal" {#status-402}

Your route answered `402 Payment Required`. Spacefast replaces any 402 response with that page, which reads as if the whole site were suspended. Answer `403` for "upgrade to unlock" instead.

## Usage balances lag {#usage-balances-lag}

`events.ingest` returns as soon as Polar accepts the events, but Polar adds them to the customer's meter in the background. In the sandbox that took about six minutes. When it finishes, Polar sends `customer.state_changed` and the stored entitlements update on their own. A sync before then returns the old balance.

## Other messages

| Message | Meaning |
| --- | --- |
| `401 Sign in to buy` | Zero checkout without a signed-in user (pass `allowGuests: true` to allow it), or Functions with `requireCustomer`. |
| `400 Missing products` | The request named no products and the route has no allowlist. |
| `400 Product not sold here: …` | The request, or your `prepare` hook, named a product outside the route's `products` allowlist. |
| `404 No billing account yet` | The portal was opened by someone who has never bought anything. Set `noCustomerUrl` to send them somewhere useful. |
| `Polar: declare the polarEntitlements and polarWebhookDeliveries tables…` | The Zero capsule's `schema` is missing the [two tables](zero.html#why-the-tables-are-written-out). |
| `Polar: add POLAR_ACCESS_TOKEN…` or `Polar: set POLAR_ACCESS_TOKEN…` | The access token isn't set in the space or in `.env.server`. |
| `Polar: POLAR_SERVER must be "sandbox" or "production"` | `POLAR_SERVER` has another value. |
