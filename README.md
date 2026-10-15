<img src="assets/icon.svg" width="64" height="64" alt="">

# spacefast-polar

Sell subscriptions and one-time products from a [Spacefast](https://spacefast.com) space with [Polar](https://polar.sh).

**Documentation:** https://sf-polar.space.fast · [llms.txt](https://sf-polar.space.fast/llms.txt) for coding agents

- **Checkout and the customer portal**: endpoints that redirect to Polar.
- **Webhooks**: verified for both Polar signing schemes.
- **Entitlements**: kept in the space's own database, so gating a feature never waits on Polar.
- **Both Spacefast runtimes**: [Functions](https://spacefast.com/docs/functions) workers and [Zero](https://spacefast.com/docs/zero-runtime) capsules.
- **No runtime dependencies.** API types are generated from Polar's OpenAPI spec, and requests are pinned to API version `2026-10`.

## How it works

```
browser ──GET /api/polar/checkout──▶ your space ──POST /v1/checkouts──▶ Polar
                                                                         │
Polar ──POST /api/polar/webhooks (customer.state_changed)──▶ your space ─┘
                                                              │
                                              entitlements row in the space DB
                                                              │
your code ──hasActiveSubscription(entitlements, "prod_…")─────┘
```

Polar sends `customer.state_changed` whenever a subscription starts, renews, or ends, or a benefit is granted or revoked. The adapter stores a compact entitlements snapshot per customer, keyed by your user id (Polar's `external_customer_id`).

Snapshots are ordered by Polar's own timestamps, so a late or replayed webhook never overwrites newer state. Redelivered webhooks are acknowledged without running your handlers again.

## Set up Polar

1. Create an organization in the [sandbox](https://sandbox.polar.sh) first. Production and sandbox are separate, with separate tokens.
2. Create an **Organization Access Token** with these scopes:
   - `checkouts:write`
   - `customer_sessions:write`
   - `customers:read`
   - anything else your own code calls
3. Add a **webhook endpoint**:
   - URL: `https://<your-space>/api/polar/webhooks`
   - Format: raw
   - Events: at least `customer.state_changed`, plus any your handlers use
4. Give the space the secrets. They stay server-only:

   ```bash
   sf env set POLAR_ACCESS_TOKEN --value-from-stdin    # polar_oat_…
   sf env set POLAR_WEBHOOK_SECRET --value-from-stdin  # whsec_…
   sf env set POLAR_SERVER sandbox --no-secret         # omit for production
   ```

5. **Claim the space.** An unclaimed space can only reach a fixed list of trusted hosts, and `api.polar.sh` isn't on it. Webhooks still arrive, but checkout, the portal, and sync fail until the space is claimed.
6. **Let Polar reach the webhook.** New spaces start private to your team, so make just that path public:

   ```bash
   sf share grant --to public --role viewer --path /api/polar/webhooks
   ```

## Functions workers

```bash
npm install spacefast-polar
```

Every handler takes `(request, contextOrEnv)`. The same value works as a `functions/` file-router export and inside a root `handler.ts`.

```ts
// functions/_polar.ts — a colocated helper, never routed
import { createPolar } from "spacefast-polar/functions";
import { getSession } from "./_session";

export const polar = createPolar();

// Your auth decides who is buying. It is never read from the query string.
export const currentUserId = async (request: Request) => (await getSession(request))?.userId;
```

```ts
// functions/api/polar/checkout.ts → GET /api/polar/checkout?products=<product id>
import { currentUserId, polar } from "../../_polar";

export const GET = polar.checkout({
  successUrl: "/welcome",
  customer: async (request) => {
    const userId = await currentUserId(request);
    return userId ? { externalId: userId } : null;
  },
  requireCustomer: true,
});
```

```ts
// functions/api/polar/webhooks.ts
import { polar } from "../../_polar";

export const POST = polar.webhooks({
  "order.paid": async (event, { env }) => {
    console.log("paid", event.data.id, event.data.customer.external_id);
  },
});
```

```ts
// functions/api/polar/portal.ts
import { currentUserId, polar } from "../../_polar";

export const GET = polar.portal({ customer: currentUserId, returnUrl: "/account" });
```

Gate features with the stored entitlements:

```ts
import { hasActiveSubscription, hasBenefit } from "spacefast-polar";
import { currentUserId, polar } from "../_polar";

export async function GET(request: Request, { env }: { env: Record<string, unknown> }) {
  const userId = await currentUserId(request);
  if (!userId) return new Response("Sign in", { status: 401 });

  const entitlements = await polar.getEntitlements(env, userId);
  if (!hasActiveSubscription(entitlements, "prod_…")) return new Response("Upgrade to Pro", { status: 403 });
  // hasBenefit(entitlements, { type: "feature_flag", metadata: { feature: "export" } })
  return Response.json({ ok: true });
}
```

Answer 403, not 402, when a plan is missing: Spacefast replaces a 402 response with its own "site disabled pending subscription renewal" page.

`getEntitlements` reads `env.DB` and asks Polar only when nothing is stored yet. On first use the adapter creates two tables, `polar_entitlements` and `polar_webhook_deliveries`. With no `env.DB`, every call asks Polar.

`polar.entitlements({ customer })` is a ready-made `GET` route that returns the same data as JSON. Add `?sync=1` on your success page to read through to Polar before the webhook lands.

A root worker can route by hand:

```ts
// handler.ts
import { createPolar } from "spacefast-polar/functions";

const polar = createPolar();
const webhooks = polar.webhooks();

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/polar/webhooks") return webhooks(request, env);
    return new Response("Not found", { status: 404 });
  },
};
```

## Zero capsules

Zero server code can only import `@spacefast/zero/server` and its own files, so the adapter is copied into your capsule instead of installed:

```bash
npx spacefast-polar add zero        # writes server/polar/
npx spacefast-polar add zero --force  # later, to update it
```

```ts
// server/index.ts
import { capsule, endpoint, query, string, table } from "@spacefast/zero/server";
import { createPolar } from "./polar/index.ts";

const polar = createPolar({ invalidate: ["entitlements"] });

export default capsule({
  name: "my-app",
  schema: {
    // Zero reads the schema from this file's source, so these are written out
    // here rather than imported.
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
    checkout: endpoint({ method: "GET", path: "/api/polar/checkout" }, polar.checkout({ successUrl: "/welcome" })),
    portal: endpoint({ method: "GET", path: "/api/polar/portal" }, polar.portal()),
    sync: endpoint({ method: "POST", path: "/api/polar/sync" }, polar.sync()),
    webhooks: endpoint({ method: "POST", path: "/api/polar/webhooks" }, polar.webhooks()),
  },
});
```

```tsx
// client/Pricing.tsx
import { useQuery } from "@spacefast/zero/client";

export function Pricing() {
  // The full shape is PolarEntitlements in server/polar/core/entitlements.ts.
  const entitlements = useQuery<{ subscriptions: { productId: string }[] }>("entitlements");
  const isPro = entitlements?.subscriptions.some((s) => s.productId === "prod_…");
  return isPro ? <a href="/api/polar/portal">Manage billing</a> : <a href="/api/polar/checkout?products=prod_…">Upgrade</a>;
}
```

- **Signed-in users only:** checkout uses the signed-in user's `ctx.auth.userId` as the Polar external id. Guests get a 401 unless you pass `allowGuests: true`, and a guest's purchase isn't linked to an account.
- **Live updates:** when a webhook changes someone's entitlements, the queries named in `invalidate` refresh live in the browser.
- **Email, but no name:** checkout prefills the signed-in user's email. The name is left for the buyer to type, since a Spacefast display name is often an account handle. Pass `polar.checkout({ prefillName: true })` to prefill it anyway.
- **Before the webhook lands:** `POST /api/polar/sync` reads the current user's state from Polar and stores it. Call it from your success page. Zero only accepts signed-in writes that send a non-safelisted content type, so send JSON:

  ```ts
  await authenticatedFetch("/api/polar/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  ```
- **No WebCrypto in Zero:** Zero's QuickJS runner has no `crypto.subtle`, so webhook signatures are checked with the adapter's own HMAC-SHA256.

## Using the client directly

```ts
import { createPolarClient, paginate, verifyWebhook } from "spacefast-polar";

const polar = createPolarClient({ accessToken: env.POLAR_ACCESS_TOKEN, server: "sandbox" });

await polar.checkouts.create({ products: ["prod_…"], external_customer_id: "user_1" });
await polar.customers.getStateExternal("user_1");
await polar.events.ingest({ events: [{ name: "tokens", external_customer_id: "user_1", metadata: { tokens: 120 } }] });
await polar.licenseKeys.validate({ key: "…", organization_id: "…" });

for await (const subscription of paginate((page) => polar.subscriptions.list({ active: true, page, limit: 100 }))) {
  // …
}

// Anything not wrapped:
await polar.request("GET", "/v1/meters/", { query: { limit: 10 } });

const { id, event } = await verifyWebhook(rawBody, request.headers, env.POLAR_WEBHOOK_SECRET);
```

The client covers:

| Resource | Methods |
| --- | --- |
| `checkouts` | `create`, `get`, `list` |
| `checkoutLinks` | `create`, `get`, `delete` |
| `customers` | `list`, `create`, `get`, `update`, `delete`, the `…External` variants, `getState`, `getStateExternal` |
| `customerSessions` | `create` |
| `subscriptions` | `list`, `get`, `update`, `revoke` |
| `orders` | `list`, `get` |
| `products` | `list`, `get` |
| `benefits` | `list` |
| `refunds` | `create` |
| `licenseKeys` | `validate`, `activate`, `deactivate` |
| `events` | `ingest` |

Error handling:

- **Retries:** 429s are retried using `Retry-After`. 502, 503, 504, and network errors are retried only for idempotent methods.
- **Errors:** failures throw `PolarAPIError` with `status`, `body`, and `errorType`.

## Checkout query parameters

These match Polar's own adapters:

- `products`: repeatable, or comma-separated
- `customer_email`
- `customer_name`
- `discount_id`
- `allow_discount_codes`
- `seats`
- `units`
- `locale`
- `metadata`: URL-encoded JSON, only with `queryMetadata: true`

`metadata` (URL-encoded JSON) is read only with `queryMetadata: true`. The buyer controls the URL, so webhook handlers must not trust anything that came from it.

`customer_id` and `external_customer_id` are ignored on purpose. Accepting them would let anyone open a checkout prefilled with another customer's details. The buyer always comes from your server-side auth.

Pass `products: [...]` to restrict a route to an allowlist. Products returned by `prepare` are held to it as well.

To decide fields on the server, such as the product, ad-hoc `prices`, or trusted `metadata`, pass `prepare`. Its result wins over the query and `defaults`, and `{ reject: "…" }` refuses the request with a 400:

```ts
// Functions: prepare(request, env). Zero: prepare(ctx, req).
polar.checkout({
  prepare: async (request, env) => {
    const plan = new URL(request.url).searchParams.get("plan");
    if (plan !== "pro" && plan !== "team") return { reject: "Unknown plan" };
    return { products: [String(plan === "pro" ? env.PRO_PRODUCT_ID : env.TEAM_PRODUCT_ID)], metadata: { plan } };
  },
});
```

## Troubleshooting

- **`403` with "This space is private".** Polar is getting the access page. Grant public access to `/api/polar/webhooks` (see [Set up Polar](#set-up-polar)).
- **Signature failures.** The secret must be the one for this endpoint, and sandbox and production endpoints have different secrets. `POLAR_SERVER` must match where the token was created.
- **Checkout, portal, or sync fail with a fetch error.** Claim the space so it can reach `api.polar.sh`.

## Development

```bash
npm test               # vitest; includes Spacefast's Zero compiler and the Functions example
npm run typecheck
npm run build
npm run check:package  # pack, install into a scratch project, import every entry point, run the CLI
npm run docs:build     # build the docs site into site/dist
npm run generate       # regenerate src/core/generated.ts from Polar's OpenAPI spec
```

**Moving to a new Polar API version:**

1. Bump `API_VERSION` in `scripts/generate-types.ts`.
2. Run `npm run generate`.
3. Fix any type errors.
4. Upgrade the webhook endpoint's `api_version` in Polar.

## Known limits

- **`env.DB` dialect:** the Functions store's SQL avoids dialect-specific syntax so it runs on MySQL and SQLite. Tests run it against SQLite; it has not yet been run against a live space's MySQL.
- **Zero's fetch budget:** 5 seconds per fetch in write endpoints, 10 in read endpoints. The Zero adapter therefore retries at most once.
- **Usage balances lag:** `events.ingest` returns as soon as Polar accepts the events, but Polar adds them to the customer's balance in the background. In the sandbox that took about 6 minutes. When it finishes, Polar sends `customer.state_changed` and the stored entitlements update on their own. `meters/{id}/quantities` shows the raw count right away.
- **Pruning:** Zero has no way to prune the deliveries table yet. The Functions store prunes delivery ids older than 30 days.
