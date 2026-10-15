Add Polar billing to this Spacefast project with the spacefast-polar SDK.

Read {{origin}}/llms-full.txt first. It has the whole documentation as Markdown, and the code there matches the SDK's real API.

1. Find the runtime. `"kind": "zero"` under `runtime` in sf.jsonc means a Zero capsule. A `functions/` folder or a root `handler.ts` means a Functions worker. If there is no Spacefast project yet, ask me which runtime to use.
2. Install the adapter.
   - Zero: run `npx spacefast-polar add zero` in the folder that holds sf.jsonc. Zero server code cannot import npm packages, so do not `npm install` the SDK for server code. In server/index.ts, write the `polarEntitlements` and `polarWebhookDeliveries` tables out literally, add an `entitlements` query, and mount the checkout, portal, sync, and webhooks endpoints as the Zero guide shows.
   - Functions: run `npm install spacefast-polar`, create `functions/_polar.ts` with `createPolar()`, and add route files for checkout, portal, entitlements, and webhooks as the Functions guide shows.
3. Identify the buyer with this app's existing sign-in. Never read a customer id from the query string or the request body.
4. Ask me which Polar product unlocks which feature, then gate those features with `hasActiveSubscription` or `hasBenefit` on the stored entitlements, on the server.
5. Typecheck, then publish with `sf publish`.
6. Make only the webhook path public: `sf share grant --to public --role viewer --path /api/polar/webhooks`
7. Ask me to do the Polar side, in the sandbox first:
   - Create an Organization Access Token with `checkouts:write`, `customer_sessions:write`, and `customers:read`.
   - Add a webhook endpoint at `https://<this space>/api/polar/webhooks`, format raw, with `customer.state_changed` and any events your handlers use.
   - Claim the space if it is unclaimed, so it can reach api.polar.sh.
8. Ask me to set the secrets myself, so their values never pass through you. Do not print, log, or commit them:
   ```
   sf env set POLAR_ACCESS_TOKEN --value-from-stdin
   sf env set POLAR_WEBHOOK_SECRET --value-from-stdin
   sf env set POLAR_SERVER sandbox --no-secret
   ```
9. Finish with a test plan: buy in the sandbox with card 4242 4242 4242 4242, confirm the delivery succeeded in Polar's webhook log, and check that the gated feature unlocks.
