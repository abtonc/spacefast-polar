---
title: API client
description: The typed, dependency-free Polar API client in spacefast-polar - options, resources and methods, pagination, raw requests, retries, and errors.
lead: A small Polar API client with types generated from Polar's OpenAPI spec. It covers checkout, customers, subscriptions, orders, products, benefits, refunds, license keys, and usage events. Anything else is one `request()` away.
---

## Create a client

```ts
import { createPolarClient } from "spacefast-polar";

const polar = createPolarClient({ accessToken: env.POLAR_ACCESS_TOKEN, server: "sandbox" });

const checkout = await polar.checkouts.create({ products: [PRODUCT_ID], external_customer_id: "user_1" });
const state = await polar.customers.getStateExternal("user_1");
```

Inside the adapters you don't create one yourself: use `polar.client(ctx)` in Zero, `polar.client(env)` in Functions, or `polar` from a webhook handler's context. They read the token and server from the environment.

## Options {#options}

| Option | Default | Meaning |
| --- | --- | --- |
| `accessToken` | required | Organization Access Token (`polar_oat_…`). Server-side only. |
| `server` | `"production"` | `"production"` (`https://api.polar.sh`) or `"sandbox"` (`https://sandbox-api.polar.sh`). |
| `baseUrl` | from `server` | Overrides `server`, for a proxy or a mock. No trailing `/v1`. |
| `apiVersion` | `"{{apiVersion}}"` | Sent as the `Polar-Version` header. |
| `maxRetries` | `2` | Retries for 429s, 502/503/504, and network errors. The Zero adapter uses `1`. |
| `maxRetryDelayMs` | `2000` | Upper bound on any single wait between retries. |
| `timeoutMs` | off | Per-attempt timeout, when the runtime has `AbortController`. |
| `fetch` | global `fetch` | Custom fetch, for tests or instrumentation. |

`parsePolarServer(value)` turns a `POLAR_SERVER` value into `"production"` or `"sandbox"`: empty means production, and anything else throws. `POLAR_BASE_URLS` maps each to its base URL.

## Resources

| Resource | Methods |
| --- | --- |
| `checkouts` | `create(body)`, `get(id)`, `list(params?)` |
| `checkoutLinks` | `create(body)`, `get(id)`, `delete(id)` |
| `customers` | `list(params?)`, `create(body)`, `get(id)`, `update(id, body)`, `delete(id, { anonymize? }?)`, `getExternal(externalId)`, `updateExternal(externalId, body)`, `deleteExternal(externalId, { anonymize? }?)`, `getState(id)`, `getStateExternal(externalId)` |
| `customerSessions` | `create(body)`: mints a portal session; redirect to `customer_portal_url`. |
| `subscriptions` | `list(params?)`, `get(id)`, `update(id, body)`, `revoke(id)` |
| `orders` | `list(params?)`, `get(id)` |
| `products` | `list(params?)`, `get(id)` |
| `benefits` | `list(params?)` |
| `refunds` | `create(body)` |
| `licenseKeys` | `validate(body)`, `activate(body)`, `deactivate(body)` |
| `events` | `ingest(body)`: usage events for usage-based billing. |

`subscriptions.revoke` ends a subscription immediately. To cancel at the end of the period, use `update(id, { cancel_at_period_end: true })`.

Bodies and results use Polar's field names, in snake case, and are fully typed. The generated types are exported too:

```ts
import type { Checkout, CustomerState, Order, Subscription } from "spacefast-polar";
```

A few more examples:

```ts
await polar.events.ingest({
  events: [{ name: "tokens", external_customer_id: "user_1", metadata: { tokens: 120 } }],
});

const validated = await polar.licenseKeys.validate({ key: licenseKey, organization_id: ORGANIZATION_ID });

await polar.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
```

## Pagination

List methods take `page` (1-based), `limit` (up to 100), `sorting` (such as `["-created_at"]`), `metadata` filters, and resource-specific filters. They return `{ items, pagination: { total_count, max_page } }`.

`paginate` walks every page:

```ts
import { paginate } from "spacefast-polar";

for await (const subscription of paginate((page) => polar.subscriptions.list({ active: true, page, limit: 100 }))) {
  console.log(subscription.id, subscription.status);
}
```

It stops after `max_page` or at the first empty page.

## Raw requests

For endpoints the client doesn't wrap, call `request`. The path includes `/v1`:

```ts
const meters = await polar.request<{ items: { id: string; name: string }[] }>("GET", "/v1/meters/", {
  query: { limit: 10 },
});
```

`request(method, path, { query?, body? })` adds the token, `Polar-Version`, JSON encoding, and retries. Array query values repeat the key, and object values are encoded deepObject style, as `metadata[plan]=pro`. `requestWithResponse` does the same and returns `{ data, response }` when you need the headers.

## Retries

- **429** is retried for any method, waiting for `Retry-After` when Polar sends it, since Polar didn't process the request.
- **502, 503, 504, and network errors** are retried only for idempotent methods: GET, HEAD, PUT, and DELETE. A failed POST may still have landed, so it isn't repeated.
- Waits back off exponentially from 250 ms with jitter, capped at `maxRetryDelayMs`.

## Errors

Every error extends `PolarError`:

| Class | When | Fields |
| --- | --- | --- |
| `PolarAPIError` | Polar answered with a non-2xx status. | `status`, `body` (parsed JSON or text), `method`, `path`, `retryAfter`, `errorType` (Polar's `error` field, such as `ResourceNotFound`) |
| `PolarConnectionError` | No answer: network failure, DNS, or a runtime fetch limit. | `cause` |
| `WebhookVerificationError` | A webhook failed signature or timestamp checks. | |

```ts
import { PolarAPIError } from "spacefast-polar";

try {
  await polar.customers.getExternal(userId);
} catch (error) {
  if (error instanceof PolarAPIError && error.status === 404) {
    // no Polar customer for this user yet
  } else {
    throw error;
  }
}
```

The error message includes Polar's `detail`, with validation errors listed by field.
