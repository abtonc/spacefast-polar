// Polar for Spacefast Functions workers.
//
// Every handler here takes `(request, contextOrEnv)`, so the same value works
// as a `functions/` file-router export (`export const GET = polar.checkout()`)
// and inside a root `handler.ts` (`polar.checkout()(request, env)`).

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
import { createD1Store, type D1DatabaseLike, type D1StoreOptions } from "./d1-store.ts";

export { createD1Store, ensureD1Schema, type D1DatabaseLike, type D1StoreOptions } from "./d1-store.ts";

/** The variables this adapter reads. Set them with `sf env set` or `.env.server`. */
export type PolarEnv = {
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  /** `sandbox` or `production`. Defaults to `production`. */
  POLAR_SERVER?: string;
  DB?: D1DatabaseLike;
};

type Env = PolarEnv & Record<string, unknown>;

/** The second argument Spacefast passes: the route context, or a root worker's env. */
export type RouteContextOrEnv = { env: Env; params?: Record<string, string>; ctx?: unknown } | Env;

export type RouteHandler = (request: Request, contextOrEnv: RouteContextOrEnv) => Promise<Response>;

/** Resolves who is making the request, from your own session or token. */
export type Resolver<T> = (request: Request, env: Env) => T | null | undefined | Promise<T | null | undefined>;

export type PolarFunctionsConfig = {
  /** Defaults to `env.POLAR_ACCESS_TOKEN`. */
  accessToken?: string;
  /** Defaults to `env.POLAR_WEBHOOK_SECRET`. */
  webhookSecret?: string;
  /** Defaults to `env.POLAR_SERVER`, then `production`. */
  server?: PolarServer;
  /** Extra client options, such as `maxRetries` or `timeoutMs`. */
  client?: Omit<PolarClientOptions, "accessToken" | "server">;
  /** Keep entitlements in `env.DB`. Defaults to true; ignored when there is no `env.DB`. */
  database?: boolean | D1StoreOptions;
};

export type FunctionsCheckoutOptions = CheckoutOptions & {
  /**
   * The signed-in buyer. Their `externalId` links the purchase to your user, so
   * entitlements can be looked up later. Return null for an anonymous checkout.
   */
  customer?: Resolver<CheckoutCustomer>;
  /** Refuse checkout when `customer` resolves to nobody. Defaults to false. */
  requireCustomer?: boolean;
  /**
   * Computes fields for this checkout on the server: ad-hoc `prices` for
   * dynamic pricing, trusted `metadata`, or `products`. Return
   * `{ reject: "…" }` to refuse the request with a 400.
   */
  prepare?: (
    request: Request,
    env: Env,
  ) => CheckoutPreparation | null | undefined | Promise<CheckoutPreparation | null | undefined>;
};

export type FunctionsPortalOptions = PortalOptions & {
  /** The signed-in user's id, the same one passed as `externalId` at checkout. */
  customer: Resolver<string>;
};

export type FunctionsEntitlementsOptions = {
  /** The signed-in user's id, the same one passed as `externalId` at checkout. */
  customer: Resolver<string>;
};

export type GetEntitlementsOptions = {
  /** Ask Polar when nothing is stored. Defaults to true. */
  fallbackToApi?: boolean;
  /** Ask Polar when the stored copy is older than this. Off by default, since webhooks keep it current. */
  maxAgeSeconds?: number;
};

export type WebhookContext = { request: Request; env: Env; polar: PolarClient };

export type FunctionsWebhookHandlers = WebhookHandlerMap<WebhookContext> & {
  onEvent?: (event: WebhookEvent, context: WebhookContext) => unknown;
};

export function createPolar(config: PolarFunctionsConfig = {}) {
  const clients = new WeakMap<object, PolarClient>();

  function client(env: Env): PolarClient {
    const cached = clients.get(env);
    if (cached) return cached;
    const accessToken = config.accessToken ?? env.POLAR_ACCESS_TOKEN;
    if (!accessToken) throw new Error("Polar: set POLAR_ACCESS_TOKEN (sf env set POLAR_ACCESS_TOKEN --value-from-stdin)");
    const created = createPolarClient({ ...config.client, accessToken, server: parsePolarServer(config.server ?? env.POLAR_SERVER) });
    clients.set(env, created);
    return created;
  }

  function store(env: Env): EntitlementStore | null {
    if (config.database === false || !env.DB) return null;
    return createD1Store(env.DB, typeof config.database === "object" ? config.database : {});
  }

  async function getEntitlements(
    env: Env,
    externalId: string,
    options: GetEntitlementsOptions = {},
  ): Promise<PolarEntitlements> {
    const entitlementStore = store(env);
    const stored = entitlementStore ? await entitlementStore.get(externalId) : null;
    const maxAge = options.maxAgeSeconds;
    if (stored && (maxAge === undefined || Date.parse(stored.version) >= Date.now() - maxAge * 1000)) {
      return stored.entitlements;
    }
    if (options.fallbackToApi === false) return stored?.entitlements ?? { ...emptyEntitlements(), externalId };
    return syncEntitlements(client(env), entitlementStore, externalId);
  }

  return {
    /** The Polar API client for this request's env. */
    client,
    /** The `env.DB` entitlement store, or null when there is no database. */
    store,

    /** Reads stored entitlements, asking Polar when none are stored yet. */
    getEntitlements,

    /** Fetches entitlements from Polar now and stores them. Use after a checkout succeeds. */
    syncEntitlements: (env: Env, externalId: string) => syncEntitlements(client(env), store(env), externalId),

    /** `GET` handler that creates a checkout and redirects to it. */
    checkout(options: FunctionsCheckoutOptions = {}): RouteHandler {
      return route(async (request, env) => {
        const customer = options.customer ? ((await options.customer(request, env)) ?? null) : null;
        if (options.requireCustomer && !customer) return textResult(401, "Sign in to buy");
        const prepared = options.prepare ? await options.prepare(request, env) : null;
        if (isCheckoutRejection(prepared)) return textResult(prepared.status ?? 400, prepared.reject);
        const url = new URL(request.url);
        return checkoutRedirect(client(env), { query: url.searchParams, requestUrl: request.url, options, customer, prepared });
      });
    },

    /** `GET` handler that opens the Polar customer portal for the signed-in user. */
    portal(options: FunctionsPortalOptions): RouteHandler {
      return route(async (request, env) => {
        const externalId = await options.customer(request, env);
        if (!externalId) return textResult(401, "Sign in to manage billing");
        return portalRedirect(client(env), { externalId, requestUrl: request.url, options });
      });
    },

    /**
     * `GET` handler returning the signed-in user's entitlements as JSON. Add
     * `?sync=1` to read through to Polar, e.g. on the checkout success page.
     */
    entitlements(options: FunctionsEntitlementsOptions): RouteHandler {
      return route(async (request, env) => {
        const externalId = await options.customer(request, env);
        if (!externalId) return textResult(401, "Sign in to see your plan");
        const sync = new URL(request.url).searchParams.get("sync") === "1";
        const entitlements = sync
          ? await syncEntitlements(client(env), store(env), externalId)
          : await getEntitlements(env, externalId);
        return {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "private, no-store" },
          body: JSON.stringify(entitlements),
        };
      });
    },

    /**
     * `POST` handler for Polar webhooks. Verifies the signature, keeps
     * `env.DB` in sync on `customer.state_changed`, then runs your handlers.
     */
    webhooks(handlers: FunctionsWebhookHandlers = {}): RouteHandler {
      return route(async (request, env) => {
        if (request.method !== "POST") return textResult(405, "Method not allowed");
        const secret = config.webhookSecret ?? env.POLAR_WEBHOOK_SECRET;
        if (!secret) {
          console.error("Polar: POLAR_WEBHOOK_SECRET is not set");
          return textResult(500, "Webhook secret not configured");
        }
        const body = await request.text();
        return handleWebhookRequest({
          body,
          headers: request.headers,
          secret,
          handlers,
          // The client is created lazily, so webhooks work without an access token.
          context: {
            request,
            env,
            get polar() {
              return client(env);
            },
          },
          store: store(env),
        });
      });
    },
  };
}

export type PolarFunctions = ReturnType<typeof createPolar>;

function route(handler: (request: Request, env: Env) => Promise<HttpResult>): RouteHandler {
  return async (request, contextOrEnv) => {
    const env = envFrom(contextOrEnv);
    try {
      return toResponse(await handler(request, env));
    } catch (error) {
      console.error("Polar handler failed", error);
      return new Response("Internal error", { status: 500 });
    }
  };
}

function envFrom(contextOrEnv: RouteContextOrEnv | undefined): Env {
  if (!contextOrEnv) return {};
  // A file-router context carries `env` (with `params` and `ctx`); a root worker
  // passes env itself. Env values are strings or bindings, never a nested `env`.
  if ("env" in contextOrEnv && contextOrEnv.env && typeof contextOrEnv.env === "object") {
    return contextOrEnv.env as Env;
  }
  return contextOrEnv as Env;
}

function toResponse(result: HttpResult): Response {
  const empty = result.status === 204 || result.status === 302 || result.body === "";
  return new Response(empty ? null : result.body, { status: result.status, headers: result.headers });
}
