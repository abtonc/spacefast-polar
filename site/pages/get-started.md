---
title: Get started
description: Set up Polar for a Spacefast space - a sandbox organization, an access token, a webhook endpoint, and the space's secrets.
lead: The Polar side is the same for Zero capsules and Functions workers. Do it in Polar's sandbox first, then repeat it for production.
---

:::tip Working with a coding agent?
Give it the [setup prompt](index.html#agent). It does the code steps below and asks you for the Polar settings and secrets.
:::

## 1. Create a sandbox organization

Create an organization at [sandbox.polar.sh](https://sandbox.polar.sh) and add a product or two. Sandbox and production are separate: separate organizations, products, tokens, and webhook endpoints. Nothing carries over, so you'll repeat these steps when you go live.

Product ids are UUIDs. Copy them from the product page; you'll pass them to checkout as `?products=<product id>`.

## 2. Create an access token

In your organization settings, create an **Organization Access Token** (`polar_oat_…`). Give it the scopes the adapter uses, plus anything your own code calls:

| Scope | Used by |
| --- | --- |
| `checkouts:write` | The checkout endpoint. |
| `customer_sessions:write` | The customer portal endpoint. |
| `customers:read` | Sync, and the Functions fallback that reads a customer's state when nothing is stored yet. |

Webhook handling doesn't need the token. Webhooks are verified with the webhook secret alone.

## 3. Add a webhook endpoint

In **Settings, Webhooks**, add an endpoint:

- **URL:** `https://<your-space>/api/polar/webhooks`
- **Format:** raw
- **Events:** `customer.state_changed`, plus any event your own handlers use

Copy the endpoint's signing secret (`whsec_…`) for the next step. Both of Polar's secret formats work; see [signing schemes](webhooks.html#signing-schemes).

## 4. Give the space its secrets

The adapter reads three variables. The first two are secrets and stay server-only:

```bash
sf env set POLAR_ACCESS_TOKEN --value-from-stdin    # polar_oat_…
sf env set POLAR_WEBHOOK_SECRET --value-from-stdin  # whsec_…
sf env set POLAR_SERVER sandbox --no-secret         # omit for production
```

| Variable | Value |
| --- | --- |
| `POLAR_ACCESS_TOKEN` | The Organization Access Token from step 2. |
| `POLAR_WEBHOOK_SECRET` | The endpoint secret from step 3. Without it, the webhook endpoint answers `500 Webhook secret not configured`. |
| `POLAR_SERVER` | `sandbox` or `production`. Empty means production. It must match where the token was created. Any other value throws. |

For local development, put the same variables in `.env.server`.

## 5. Claim the space

An unclaimed space can only reach a fixed list of trusted hosts, and `api.polar.sh` isn't on it. Webhooks still arrive, but checkout, the portal, and sync fail until you claim the space with the claim link Spacefast gave you when you first published.

## 6. Let Polar reach the webhook

New spaces start private to your team. Polar would get the Spacefast "This space is private" page instead of your endpoint. Make only the webhook path public:

```bash
sf share grant --to public --role viewer --path /api/polar/webhooks
```

The rest of the space stays private unless you share it.

## 7. Add the endpoints

Follow the guide for your runtime:

- [Zero capsules](zero.html): `npx spacefast-polar add zero`, then mount the endpoints in `server/index.ts`.
- [Functions workers](functions.html): `npm install spacefast-polar`, then add route files.

Publish the space when the endpoints are in place.

## 8. Make a test purchase

Open your checkout endpoint while signed in, for example `/api/polar/checkout?products=<product id>`. In the sandbox, pay with the test card `4242 4242 4242 4242`, any future expiry, and any CVC.

After payment, Polar sends the buyer to your success URL with `?checkout_id=…` and, separately, sends `customer.state_changed` to your webhook. Your app reads the new entitlements from its own database. To update the page before the webhook lands, sync on the success page; each runtime guide shows how.

## Going to production

Repeat steps 1 to 4 in your production organization at [polar.sh](https://polar.sh): a new token, a new webhook endpoint with its own secret, and `POLAR_SERVER` set to `production` or left empty. A sandbox secret never verifies a production webhook, and a sandbox token gets `401` from the production API.
