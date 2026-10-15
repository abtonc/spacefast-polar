# Changelog

## 0.1.0 (unreleased)

First release.

- Typed Polar API client pinned to API version `2026-10`: checkouts, checkout links, customers and customer state, customer sessions, subscriptions, orders, products, benefits, refunds, license keys, and event ingestion. Retries 429s with `Retry-After`, and 502/503/504 and network errors for idempotent methods. `paginate` and a raw `request` escape hatch.
- Webhook verification for both Polar signing schemes, with handlers per event type.
- Entitlements snapshots stored per customer, ordered by Polar's timestamps, with redeliveries acknowledged once.
- Functions adapter (`spacefast-polar/functions`): checkout, portal, entitlements, and webhook routes, backed by `env.DB`.
- Zero adapter, vendored with `npx spacefast-polar add zero`: checkout, portal, sync, and webhook endpoints, an entitlements query, and live invalidation.
- Checkout `prepare` hook for server-decided products, prices, and metadata, held to the route's `products` allowlist. `?metadata=` is read only with `queryMetadata: true`.
