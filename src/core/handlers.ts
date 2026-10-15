// Runtime-neutral request handling shared by the Functions and Zero adapters.
// Each function takes plain inputs and returns a plain HttpResult, which the
// adapters turn into a Fetch Response or a Zero endpoint response.

import type { PolarClient } from "./client.ts";
import { type PolarEntitlements, toEntitlements } from "./entitlements.ts";
import { PolarAPIError, PolarError, WebhookVerificationError } from "./errors.ts";
import type { CheckoutCreate, CustomerState } from "./generated.ts";
import {
  dispatchWebhook,
  type WebhookEvent,
  type WebhookHandlerMap,
  type WebhookHeaders,
  type VerifiedWebhook,
  verifyWebhook,
} from "./webhooks.ts";

export type HttpResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type QueryReader = {
  get(name: string): string | null;
  getAll(name: string): string[];
};

/** Who is buying, as established by your own auth. Never read this from the request. */
export type CheckoutCustomer = {
  /** Your user id. Polar links the purchase to it, and entitlements are looked up by it. */
  externalId?: string;
  email?: string;
  name?: string;
};

export type CheckoutOptions = {
  /**
   * Product ids this route may sell. With `?products=` the request must name a
   * subset; without it, every listed product is offered. Products returned by
   * `prepare` must be on the list too.
   */
  products?: string[];
  /**
   * Where Polar sends the customer after paying. Absolute, or a path on this
   * site. `checkout_id={CHECKOUT_ID}` is appended unless the URL already has
   * `{CHECKOUT_ID}` or `includeCheckoutId` is false. Defaults to `/`.
   */
  successUrl?: string;
  includeCheckoutId?: boolean;
  /** Renders a back button in the checkout. Absolute, or a path on this site. */
  returnUrl?: string;
  /** Extra fields merged into every checkout, e.g. `{ allow_trial: false }`. */
  defaults?: Partial<CheckoutCreate>;
  /**
   * Accept `?metadata=` (URL-encoded JSON) from the request. Off by default:
   * the buyer controls the URL, so anything read from it must not be trusted
   * by your webhook handlers. Set server-side metadata with `defaults` or
   * `prepare` instead.
   */
  queryMetadata?: boolean;
};

/**
 * What a `prepare` hook returns: fields computed on the server for this one
 * checkout, such as ad-hoc `prices` or trusted `metadata`, or a rejection.
 */
export type CheckoutPreparation = Partial<CheckoutCreate> | CheckoutRejection;

export type CheckoutRejection = { reject: string; status?: number };

export function isCheckoutRejection(value: CheckoutPreparation | null | undefined): value is CheckoutRejection {
  return Boolean(value && typeof (value as CheckoutRejection).reject === "string");
}

/**
 * Builds a checkout from query parameters, compatible with Polar's own adapters:
 * `products` (repeatable or comma-separated), `customer_email`, `customer_name`,
 * `discount_id`, `allow_discount_codes`, `seats`, `units`, and `locale`.
 *
 * Fields are layered, later winning: `options.defaults`, the query, then
 * `prepared` (computed by your server). `products` from `prepared` replace the
 * query's. The buyer's `externalId` always comes from `customer`, never from
 * the query: anyone could otherwise open a checkout prefilled for another
 * customer.
 */
export function buildCheckoutCreate(input: {
  query: QueryReader;
  requestUrl: string;
  options: CheckoutOptions;
  customer: CheckoutCustomer | null;
  prepared?: Partial<CheckoutCreate> | null;
}): { ok: true; body: CheckoutCreate } | { ok: false; status: number; message: string } {
  const { query, requestUrl, options, customer } = input;
  const prepared = input.prepared ?? {};

  const allowed = options.products && options.products.length > 0 ? options.products : null;
  let products: string[];
  if (prepared.products && prepared.products.length > 0) {
    products = prepared.products;
  } else {
    const requested = query
      .getAll("products")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    products = requested.length > 0 || !allowed ? requested : allowed;
  }
  // The allowlist also covers `prepare`, so a hook that passes request input
  // through cannot sell something the route was not meant to.
  if (allowed) {
    const outside = products.filter((id) => !allowed.includes(id));
    if (outside.length > 0) return { ok: false, status: 400, message: `Product not sold here: ${outside.join(", ")}` };
  }
  if (products.length === 0) return { ok: false, status: 400, message: "Missing products" };

  const body: CheckoutCreate = { ...options.defaults, products };

  let successUrl = resolveUrl(options.successUrl ?? "/", requestUrl);
  if (options.includeCheckoutId !== false && !successUrl.includes("{CHECKOUT_ID}")) {
    successUrl += `${successUrl.includes("?") ? "&" : "?"}checkout_id={CHECKOUT_ID}`;
  }
  body.success_url = successUrl;
  if (options.returnUrl) body.return_url = resolveUrl(options.returnUrl, requestUrl);

  const email = customer?.email ?? query.get("customer_email");
  const name = customer?.name ?? query.get("customer_name");
  if (email) body.customer_email = email;
  if (name) body.customer_name = name;

  const discountId = query.get("discount_id");
  if (discountId) body.discount_id = discountId;
  const allowDiscountCodes = query.get("allow_discount_codes");
  if (allowDiscountCodes !== null) body.allow_discount_codes = allowDiscountCodes !== "false";
  const locale = query.get("locale");
  if (locale) body.locale = locale;

  for (const field of ["seats", "units"] as const) {
    const raw = query.get(field);
    if (raw === null) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return { ok: false, status: 400, message: `Invalid ${field}` };
    body[field] = value;
  }

  let metadata = body.metadata;
  const queryMetadata = options.queryMetadata ? query.get("metadata") : null;
  if (queryMetadata) {
    const parsed = parseJsonObject(queryMetadata);
    if (!parsed) return { ok: false, status: 400, message: "metadata must be a JSON object" };
    metadata = { ...metadata, ...(parsed as Record<string, string | number | boolean>) };
  }

  // Server-computed fields win over anything from the request.
  Object.assign(body, prepared, { products: unique(products) });
  if (metadata || prepared.metadata) body.metadata = { ...metadata, ...prepared.metadata };
  if (customer?.externalId) body.external_customer_id = customer.externalId;

  return { ok: true, body };
}

/** Creates a checkout session and redirects to it. */
export async function checkoutRedirect(
  polar: PolarClient,
  input: Parameters<typeof buildCheckoutCreate>[0],
): Promise<HttpResult> {
  const built = buildCheckoutCreate(input);
  if (!built.ok) return textResult(built.status, built.message);
  try {
    const checkout = await polar.checkouts.create(built.body);
    return redirectResult(checkout.url);
  } catch (error) {
    return apiErrorResult(error, "Could not start checkout");
  }
}

export type PortalOptions = {
  /** Where the portal's back link goes. Absolute, or a path on this site. Defaults to `/`. */
  returnUrl?: string;
  /** Where to send someone with no Polar customer yet. Without it they get a 404. */
  noCustomerUrl?: string;
};

/** Mints a customer portal session for `externalId` and redirects to it. */
export async function portalRedirect(
  polar: PolarClient,
  input: { externalId: string; requestUrl: string; options: PortalOptions },
): Promise<HttpResult> {
  const { externalId, requestUrl, options } = input;
  try {
    const session = await polar.customerSessions.create({
      external_customer_id: externalId,
      return_url: resolveUrl(options.returnUrl ?? "/", requestUrl),
    });
    return redirectResult(session.customer_portal_url);
  } catch (error) {
    if (error instanceof PolarAPIError && (error.status === 404 || error.status === 422)) {
      return options.noCustomerUrl
        ? redirectResult(resolveUrl(options.noCustomerUrl, requestUrl))
        : textResult(404, "No billing account yet");
    }
    return apiErrorResult(error, "Could not open the customer portal");
  }
}

/**
 * Where entitlements are kept between webhooks. The Functions adapter backs
 * this with `env.DB`, the Zero adapter with capsule tables.
 */
export type EntitlementStore = {
  get(externalId: string): Promise<StoredEntitlements | null>;
  /**
   * Saves a snapshot taken at `version` (a normalized Polar timestamp), unless
   * a newer one is already stored. Returns whether it was written.
   */
  save(entitlements: PolarEntitlements, version: string): Promise<boolean>;
  /** Whether a webhook delivery was already handled. Optional. */
  hasDelivery?(webhookId: string): Promise<boolean>;
  recordDelivery?(webhookId: string, eventType: string): Promise<void>;
};

export type StoredEntitlements = {
  entitlements: PolarEntitlements;
  version: string;
};

export type WebhookRequestInput<C> = {
  body: string | Uint8Array;
  headers: WebhookHeaders;
  secret: string;
  handlers: WebhookHandlerMap<C> & { onEvent?: (event: WebhookEvent, context: C) => unknown };
  context: C;
  store?: EntitlementStore | null;
  /** Called after a `customer.state_changed` event is stored, e.g. to refresh live queries. */
  onEntitlementsChanged?: (entitlements: PolarEntitlements) => unknown;
  now?: () => number;
};

/**
 * Verifies a webhook, keeps the store in sync with `customer.state_changed`,
 * and runs your handlers.
 *
 * Answers 403 on a bad signature and 202 once handled. A handler that throws
 * is rethrown; the adapters answer 500 so Polar retries. Redeliveries of a
 * webhook that already succeeded are acknowledged without running handlers
 * again, when the store tracks deliveries.
 */
export async function handleWebhookRequest<C>(input: WebhookRequestInput<C>): Promise<HttpResult> {
  let verified: VerifiedWebhook;
  try {
    verified = await verifyWebhook(input.body, input.headers, input.secret, { now: input.now });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return textResult(403, error.message);
    if (error instanceof PolarError) return textResult(400, error.message);
    throw error;
  }

  const { id, event } = verified;
  const store = input.store ?? null;
  if (store?.hasDelivery && (await store.hasDelivery(id))) return textResult(200, "Already processed");

  if (store && event.type === "customer.state_changed") {
    const entitlements = toEntitlements(event.data);
    const written = await store.save(entitlements, normalizeTimestamp(event.timestamp));
    if (written && input.onEntitlementsChanged) await input.onEntitlementsChanged(entitlements);
  }

  await dispatchWebhook(event, input.handlers, input.context);
  if (store?.recordDelivery) await store.recordDelivery(id, event.type);
  return textResult(202, "Accepted");
}

/**
 * Fetches a customer's state from Polar and stores it. A customer Polar does
 * not know yet is stored as having no entitlements.
 */
export async function syncEntitlements(
  polar: PolarClient,
  store: EntitlementStore | null,
  externalId: string,
): Promise<PolarEntitlements> {
  let state: CustomerState | null = null;
  let version: string;
  try {
    const { data, response } = await polar.requestWithResponse<CustomerState>(
      "GET",
      `/v1/customers/external/${encodeURIComponent(externalId)}/state`,
    );
    state = data;
    version = versionFromResponse(response);
  } catch (error) {
    if (!(error instanceof PolarAPIError) || error.status !== 404) throw error;
    version = normalizeTimestamp(new Date().toISOString());
  }
  const entitlements = state ? toEntitlements(state) : { ...toEntitlements(null), externalId };
  if (store) await store.save(entitlements, version);
  return entitlements;
}

/**
 * Polar's clock, not ours, decides which snapshot is newer. An API read is
 * dated by the response's `Date` header, rounded down to the second, so a
 * webhook for a change made in that same second still wins.
 */
function versionFromResponse(response: Response): string {
  const header = response.headers?.get?.("date");
  const parsed = header ? Date.parse(header) : Number.NaN;
  const millis = Number.isNaN(parsed) ? Date.now() : parsed;
  return normalizeTimestamp(new Date(Math.floor(millis / 1000) * 1000).toISOString());
}

/**
 * Turns an ISO timestamp into `YYYY-MM-DDTHH:MM:SS.ffffffZ`, so snapshot
 * versions compare correctly as strings whatever precision Polar sent.
 */
export function normalizeTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]00:?00)?$/.exec(value);
  if (match) return `${match[1]}.${(match[2] ?? "").padEnd(6, "0").slice(0, 6)}Z`;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return normalizeTimestamp(new Date(parsed).toISOString());
}

/** Resolves a path against the request's origin. Absolute URLs pass through. */
export function resolveUrl(target: string, requestUrl: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const origin = /^(https?:\/\/[^/?#]+)/i.exec(requestUrl)?.[1];
  if (!origin) return target;
  return `${origin}${target.startsWith("/") ? "" : "/"}${target}`;
}

export function textResult(status: number, body: string): HttpResult {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

// Header names are quoted on purpose: Zero's compiler rejects any bare
// identifier that shares a name with a browser global.
export function redirectResult(target: string): HttpResult {
  return { status: 302, headers: { "location": target, "cache-control": "no-store" }, body: "" };
}

function apiErrorResult(error: unknown, message: string): HttpResult {
  if (error instanceof PolarAPIError) {
    // 4xx from Polar means the request we built was wrong for this org.
    const status = error.status === 422 || error.status === 404 ? 400 : 502;
    return textResult(status, `${message}: ${error.message}`);
  }
  if (error instanceof PolarError) return textResult(502, `${message}: ${error.message}`);
  throw error;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
