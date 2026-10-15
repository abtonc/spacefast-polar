// Polar for Spacefast Zero capsules.
//
// Zero server code can only import `@spacefast/zero/server` and its own files,
// so this folder is vendored into your capsule by `npx spacefast-polar add zero`
// rather than imported from npm. It has no other dependencies.

import {
  json,
  redirect,
  text,
  type EndpointRequest,
  type EndpointResponse,
  type QueryServerContext,
  type ServerContext,
} from "@spacefast/zero/server";
import { createPolarClient, parsePolarServer, type PolarClient, type PolarClientOptions, type PolarServer } from "../core/client.ts";
import { emptyEntitlements, type PolarEntitlements } from "../core/entitlements.ts";
import {
  type CheckoutCustomer,
  type CheckoutOptions,
  type CheckoutPreparation,
  checkoutRedirect,
  isCheckoutRejection,
  type EntitlementStore,
  handleWebhookRequest,
  type HttpResult,
  portalRedirect,
  type PortalOptions,
  syncEntitlements,
  textResult,
} from "../core/handlers.ts";
import type { WebhookEvent, WebhookHandlerMap } from "../core/webhooks.ts";

export * from "../core/index.ts";

/**
 * The tables this adapter reads and writes. Zero reads a capsule's schema from
 * the source of the server entry, so these must be written out there; a
 * spread from this module is not picked up. Paste into `schema`:
 *
 * ```ts
 * polarEntitlements: table({
 *   externalId: string(),
 *   customerId: string(),
 *   entitlements: string(),
 *   version: string(),
 * }).index("by_external_id", ["externalId"]),
 * polarWebhookDeliveries: table({
 *   webhookId: string(),
 *   eventType: string(),
 * }).index("by_webhook_id", ["webhookId"]),
 * ```
 */
const MISSING_TABLES =
  "Polar: declare the polarEntitlements and polarWebhookDeliveries tables in your capsule schema. " +
  "See server/polar/zero/index.ts for the snippet.";

type ReadCtx = Pick<QueryServerContext, "auth" | "env" | "db" | "log">;
type WriteCtx = Pick<ServerContext, "auth" | "env" | "db" | "log" | "invalidate">;
type Handler<C> = (ctx: C, req: EndpointRequest) => Promise<EndpointResponse>;

type EntitlementRow = {
  id: string;
  externalId: string;
  customerId: string;
  entitlements: string;
  version: string;
};

export type PolarZeroConfig = {
  /** Defaults to `ctx.env.POLAR_SERVER`, then `production`. */
  server?: PolarServer;
  /** Extra client options. Retries default to 1, since Zero gives a fetch 5 to 10 seconds. */
  client?: Omit<PolarClientOptions, "accessToken" | "server">;
  /**
   * Live queries to refresh when a customer's entitlements change. Defaults to
   * every live query on the page.
   */
  invalidate?: string[];
};

export type ZeroCheckoutOptions = CheckoutOptions & {
  /**
   * Allow guests to check out. Their purchase is not linked to an account, so
   * it grants no entitlements in the app. Defaults to false.
   */
  allowGuests?: boolean;
  /**
   * Prefill the checkout's name field with `ctx.auth.displayName`. Off by
   * default: a Spacefast display name is often an account handle, not the
   * buyer's legal or billing name, so Polar's form asks for it instead.
   */
  prefillName?: boolean;
  /** Overrides the buyer derived from `ctx.auth`. */
  customer?: (ctx: ReadCtx) => CheckoutCustomer | null;
  /**
   * Computes fields for this checkout on the server: ad-hoc `prices` for
   * dynamic pricing, trusted `metadata`, or `products`. Return
   * `{ reject: "…" }` to refuse the request with a 400.
   */
  prepare?: (
    ctx: ReadCtx,
    req: EndpointRequest,
  ) => CheckoutPreparation | null | undefined | Promise<CheckoutPreparation | null | undefined>;
};

export type WebhookContext = { ctx: WriteCtx; polar: PolarClient };

export type ZeroWebhookHandlers = WebhookHandlerMap<WebhookContext> & {
  onEvent?: (event: WebhookEvent, context: WebhookContext) => unknown;
};

export function createPolar(config: PolarZeroConfig = {}) {
  function client(ctx: Pick<ReadCtx, "env">): PolarClient {
    const accessToken = ctx.env.POLAR_ACCESS_TOKEN;
    if (!accessToken) throw new Error("Polar: add POLAR_ACCESS_TOKEN to .env.server or run `sf env set POLAR_ACCESS_TOKEN`");
    return createPolarClient({
      maxRetries: 1,
      ...config.client,
      accessToken,
      server: parsePolarServer(config.server ?? ctx.env.POLAR_SERVER),
    });
  }

  function store(ctx: Pick<WriteCtx, "db">): EntitlementStore {
    const entitlementsTable = ctx.db.polarEntitlements;
    const deliveriesTable = ctx.db.polarWebhookDeliveries;
    if (!entitlementsTable || !deliveriesTable) {
      throw new Error(MISSING_TABLES);
    }

    async function findRow(externalId: string): Promise<EntitlementRow | null> {
      return (await entitlementsTable!
        .withIndex("by_external_id", (range) => range.eq("externalId", externalId))
        .first()) as EntitlementRow | null;
    }

    return {
      async get(externalId) {
        const row = await findRow(externalId);
        return row ? { entitlements: JSON.parse(row.entitlements) as PolarEntitlements, version: row.version } : null;
      },
      async save(entitlements, version) {
        if (!entitlements.externalId) return false;
        const row = await findRow(entitlements.externalId);
        if (row && row.version > version) return false;
        const value = {
          externalId: entitlements.externalId,
          customerId: entitlements.customerId ?? "",
          entitlements: JSON.stringify(entitlements),
          version,
        };
        if (row) await entitlementsTable!.update(row.id, value);
        else await entitlementsTable!.insert(value);
        return true;
      },
      async hasDelivery(webhookId) {
        const row = await deliveriesTable!.withIndex("by_webhook_id", (range) => range.eq("webhookId", webhookId)).first();
        return row !== null;
      },
      async recordDelivery(webhookId, eventType) {
        await deliveriesTable!.insert({ webhookId, eventType });
      },
    };
  }

  function invalidate(ctx: WriteCtx): void {
    if (config.invalidate && config.invalidate.length > 0) ctx.invalidate(...config.invalidate);
    else ctx.invalidate();
  }

  return {
    /** A Polar API client built from `ctx.env`. */
    client,

    /**
     * The signed-in user's entitlements, from the capsule database. Call it from
     * a query; it never reaches Polar, so it is cheap to re-run.
     */
    async entitlements(ctx: Pick<ReadCtx, "auth" | "db">): Promise<PolarEntitlements> {
      if (!ctx.auth.isAuthenticated) return emptyEntitlements();
      const table = ctx.db.polarEntitlements;
      if (!table) throw new Error(MISSING_TABLES);
      const row = (await table
        .withIndex("by_external_id", (range) => range.eq("externalId", ctx.auth.userId))
        .first()) as EntitlementRow | null;
      return row ? (JSON.parse(row.entitlements) as PolarEntitlements) : { ...emptyEntitlements(), externalId: ctx.auth.userId };
    },

    /**
     * `GET` endpoint handler that creates a checkout for the signed-in user and
     * redirects to it. Link to it: `<a href="/api/polar/checkout?products=…">`.
     */
    checkout(options: ZeroCheckoutOptions = {}): Handler<ReadCtx> {
      return async (ctx, req) => {
        const customer = options.customer
          ? options.customer(ctx)
          : customerFromAuth(ctx, { prefillName: options.prefillName === true });
        if (!customer && !options.allowGuests) return toEndpointResponse(textResult(401, "Sign in to buy"));
        const prepared = options.prepare ? await options.prepare(ctx, req) : null;
        if (isCheckoutRejection(prepared)) return toEndpointResponse(textResult(prepared.status ?? 400, prepared.reject));
        return toEndpointResponse(
          await checkoutRedirect(client(ctx), { query: req.query, requestUrl: req.url, options, customer, prepared }),
        );
      };
    },

    /** `GET` endpoint handler that opens the Polar customer portal. */
    portal(options: PortalOptions = {}): Handler<ReadCtx> {
      return async (ctx, req) => {
        if (!ctx.auth.isAuthenticated) return toEndpointResponse(textResult(401, "Sign in to manage billing"));
        return toEndpointResponse(
          await portalRedirect(client(ctx), { externalId: ctx.auth.userId, requestUrl: req.url, options }),
        );
      };
    },

    /**
     * `POST` endpoint handler that reads the signed-in user's entitlements from
     * Polar and stores them. Call it from the checkout success page so the app
     * updates before the webhook lands.
     *
     * Zero only accepts cookie-authenticated writes with a non-safelisted
     * content type, so send JSON:
     * `authenticatedFetch("/api/polar/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })`.
     */
    sync(): Handler<WriteCtx> {
      return async (ctx) => {
        if (!ctx.auth.isAuthenticated) return toEndpointResponse(textResult(401, "Sign in first"));
        const entitlements = await syncEntitlements(client(ctx), store(ctx), ctx.auth.userId);
        invalidate(ctx);
        return json(entitlements, { headers: { "cache-control": "private, no-store" } });
      };
    },

    /**
     * `POST` endpoint handler for Polar webhooks. Verifies the signature, keeps
     * the entitlements table in sync on `customer.state_changed`, then runs
     * your handlers inside the endpoint's transaction.
     */
    webhooks(handlers: ZeroWebhookHandlers = {}): Handler<WriteCtx> {
      return async (ctx, req) => {
        const secret = ctx.env.POLAR_WEBHOOK_SECRET;
        if (!secret) {
          ctx.log.error("Polar: POLAR_WEBHOOK_SECRET is not set");
          return toEndpointResponse(textResult(500, "Webhook secret not configured"));
        }
        const result = await handleWebhookRequest({
          body: await req.text(),
          headers: req.headers,
          secret,
          handlers,
          context: {
            ctx,
            get polar() {
              return client(ctx);
            },
          },
          store: store(ctx),
          onEntitlementsChanged: () => invalidate(ctx),
        });
        if (result.status >= 400) ctx.log.warn("Polar webhook rejected", { status: result.status, reason: result.body });
        return toEndpointResponse(result);
      };
    },
  };
}

export type PolarZero = ReturnType<typeof createPolar>;

function customerFromAuth(ctx: Pick<ReadCtx, "auth">, options: { prefillName: boolean }): CheckoutCustomer | null {
  const auth = ctx.auth;
  if (!auth.isAuthenticated) return null;
  const customer: CheckoutCustomer = { externalId: auth.userId };
  if (auth.email && auth.emailVerified !== false) customer.email = auth.email;
  if (options.prefillName && auth.displayName) customer.name = auth.displayName;
  return customer;
}

function toEndpointResponse(result: HttpResult): EndpointResponse {
  const target = result.headers["location"];
  if (result.status === 302 && target) {
    return redirect(target, { headers: { "cache-control": "no-store" } });
  }
  // `text()` sets Content-Type itself, and Zero rejects a response that
  // carries the same header twice in different case.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.headers)) {
    if (name.toLowerCase() !== "content-type") headers[name] = value;
  }
  return text(result.body, { status: result.status, headers });
}
