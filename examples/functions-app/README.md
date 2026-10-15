# Polar on Spacefast Functions

A Functions worker that sells a Pro plan through Polar and gates an API route on it.

| Route | File |
| --- | --- |
| `GET /api/polar/checkout` | `functions/api/polar/checkout.ts`, the product decided on the server with `prepare` |
| `GET /api/polar/portal` | `functions/api/polar/portal.ts` |
| `GET /api/polar/entitlements` | `functions/api/polar/entitlements.ts`, `?sync=1` after checkout |
| `POST /api/polar/webhooks` | `functions/api/polar/webhooks.ts` |
| `GET /api/report` | `functions/api/report.ts`, Pro only |
| `GET/POST/DELETE /api/session` | `functions/api/session.ts`, demo sign-in |

`functions/_session.ts` is a **demo**: it signs whatever name the visitor types into a cookie. It shows where your auth plugs in and proves nothing about who anyone is. Replace `readSession` with your real session or token check before taking payments.

## Run it

```bash
npm install
sf publish

sf env set POLAR_ACCESS_TOKEN --value-from-stdin
sf env set POLAR_WEBHOOK_SECRET --value-from-stdin
sf env set POLAR_SERVER sandbox --no-secret
sf env set POLAR_PRO_PRODUCT_ID <product id> --no-secret
openssl rand -base64 32 | sf env set SESSION_SECRET --value-from-stdin

sf share grant --to public --role viewer --path /api/polar/webhooks
```

Point a Polar webhook (raw format, with `customer.state_changed`) at `https://<your-space>/api/polar/webhooks`, and claim the space so it can reach `api.polar.sh`.

`tsconfig.json` maps `spacefast-polar` to this repo's `src/` so the example typechecks before the package is published; drop `paths` in your own project. The route modules are exercised by `test/examples.test.ts`.
