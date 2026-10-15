import { PolarAPIError, PolarConnectionError } from "./errors.ts";
import {
  POLAR_API_VERSION,
  type Benefit,
  type Checkout,
  type CheckoutCreate,
  type CheckoutLink,
  type CheckoutLinkCreate,
  type Customer,
  type CustomerCreate,
  type CustomerSession,
  type CustomerSessionCustomerExternalIDCreate,
  type CustomerSessionCustomerIDCreate,
  type CustomerState,
  type CustomerUpdate,
  type CustomerUpdateExternalID,
  type EventsIngest,
  type EventsIngestResponse,
  type LicenseKeyActivate,
  type LicenseKeyActivationCreated,
  type LicenseKeyDeactivate,
  type LicenseKeyValidate,
  type Order,
  type OrderStatus,
  type Product,
  type Refund,
  type RefundCreate,
  type Subscription,
  type SubscriptionStatus,
  type SubscriptionUpdate,
  type ValidatedLicenseKey,
} from "./generated.ts";

export type PolarServer = "production" | "sandbox";

export const POLAR_BASE_URLS: Record<PolarServer, string> = {
  production: "https://api.polar.sh",
  sandbox: "https://sandbox-api.polar.sh",
};

/** Reads a `POLAR_SERVER` value. Empty means production; anything unknown throws. */
export function parsePolarServer(value: unknown): PolarServer {
  if (value === undefined || value === null || value === "") return "production";
  const server = String(value).trim().toLowerCase();
  if (server === "sandbox" || server === "production") return server;
  throw new Error(`Polar: POLAR_SERVER must be "sandbox" or "production", got ${JSON.stringify(value)}`);
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type PolarClientOptions = {
  /** An Organization Access Token (`polar_oat_…`). Server-side only. */
  accessToken: string;
  /** Which Polar environment to talk to. Defaults to `"production"`. */
  server?: PolarServer;
  /** Overrides `server`, e.g. for a proxy or a mock. No trailing `/v1`. */
  baseUrl?: string;
  /** Sent as `Polar-Version`. Defaults to the version the types were generated from. */
  apiVersion?: string;
  /** Retries for 429s, 502/503/504, and network errors. Defaults to 2. */
  maxRetries?: number;
  /** Upper bound on any single wait between retries. Defaults to 2000 ms. */
  maxRetryDelayMs?: number;
  /** Per-attempt timeout, when the runtime has AbortController. Off by default. */
  timeoutMs?: number;
  /** Custom fetch, for tests or instrumentation. Defaults to the global fetch. */
  fetch?: FetchLike;
};

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | null | undefined | QueryPrimitive[] | Record<string, QueryPrimitive | QueryPrimitive[]>;
export type Query = Record<string, QueryValue>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
};

export type ListResource<T> = {
  items: T[];
  pagination: { total_count: number; max_page: number };
};

export type PageParams = {
  /** 1-based page number. */
  page?: number;
  /** Items per page, at most 100. */
  limit?: number;
  /** Sort keys, prefix with `-` for descending, e.g. `["-created_at"]`. */
  sorting?: string[];
  /** Filter by metadata, e.g. `{ plan: "pro" }`. */
  metadata?: Record<string, QueryPrimitive | QueryPrimitive[]>;
};

type OneOrMany<T> = T | T[];

export type ListCheckoutsParams = PageParams & {
  organization_id?: OneOrMany<string>;
  product_id?: OneOrMany<string>;
  customer_id?: OneOrMany<string>;
  external_customer_id?: OneOrMany<string>;
  status?: OneOrMany<Checkout["status"]>;
  query?: string;
};

export type ListCustomersParams = PageParams & {
  organization_id?: OneOrMany<string>;
  email?: string;
  query?: string;
  active?: boolean;
};

export type ListSubscriptionsParams = PageParams & {
  organization_id?: OneOrMany<string>;
  product_id?: OneOrMany<string>;
  customer_id?: OneOrMany<string>;
  external_customer_id?: OneOrMany<string>;
  discount_id?: OneOrMany<string>;
  active?: boolean;
  status?: OneOrMany<SubscriptionStatus>;
  cancel_at_period_end?: boolean;
};

export type ListOrdersParams = PageParams & {
  organization_id?: OneOrMany<string>;
  product_id?: OneOrMany<string>;
  customer_id?: OneOrMany<string>;
  external_customer_id?: OneOrMany<string>;
  checkout_id?: OneOrMany<string>;
  subscription_id?: OneOrMany<string>;
  status?: OneOrMany<OrderStatus>;
};

export type ListProductsParams = PageParams & {
  id?: OneOrMany<string>;
  organization_id?: OneOrMany<string>;
  query?: string;
  is_archived?: boolean;
  is_recurring?: boolean;
  benefit_id?: OneOrMany<string>;
};

export type ListBenefitsParams = PageParams & {
  organization_id?: OneOrMany<string>;
  type?: OneOrMany<Benefit["type"]>;
  id?: OneOrMany<string>;
  query?: string;
};

export type CustomerSessionCreate = CustomerSessionCustomerIDCreate | CustomerSessionCustomerExternalIDCreate;

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export type PolarClient = ReturnType<typeof createPolarClient>;

/**
 * A small, dependency-free client for the Polar API.
 *
 * It covers what a Spacefast app needs for checkout, entitlements, the customer
 * portal, license keys, and usage events. Anything else is one `request()` away.
 */
export function createPolarClient(options: PolarClientOptions) {
  if (!options.accessToken) throw new TypeError("createPolarClient: accessToken is required");
  const baseUrl = (options.baseUrl ?? POLAR_BASE_URLS[options.server ?? "production"]).replace(/\/+$/, "");
  const apiVersion = options.apiVersion ?? POLAR_API_VERSION;
  const maxRetries = options.maxRetries ?? 2;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 2000;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: string, path: string, requestOptions: RequestOptions = {}): Promise<T> {
    return (await requestWithResponse<T>(method, path, requestOptions)).data;
  }

  /** Like `request`, but also returns the response, for its headers. */
  async function requestWithResponse<T>(
    method: string,
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<{ data: T; response: Response }> {
    const url = `${baseUrl}${path}${encodeQuery(requestOptions.query)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.accessToken}`,
      accept: "application/json",
      "polar-version": apiVersion,
    };
    let body: string | undefined;
    if (requestOptions.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(requestOptions.body);
    }

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < maxRetries;
      let response: Response;
      try {
        response = await fetchWithTimeout(doFetch, url, { method, headers, body }, options.timeoutMs);
      } catch (error) {
        // A network failure on a non-idempotent call may still have landed.
        if (canRetry && IDEMPOTENT_METHODS.has(method)) {
          await sleep(backoff(attempt, maxRetryDelayMs));
          continue;
        }
        throw new PolarConnectionError(`Polar API ${method} ${path} did not respond: ${String(error)}`, error);
      }

      if (response.ok) {
        const text = response.status === 204 ? "" : await response.text();
        return { data: (text ? JSON.parse(text) : undefined) as T, response };
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      // 429 means Polar did not process the request, so any method is safe to repeat.
      const retryable =
        response.status === 429 || (RETRYABLE_STATUSES.has(response.status) && IDEMPOTENT_METHODS.has(method));
      if (canRetry && retryable) {
        await sleep(Math.min(retryAfter !== null ? retryAfter * 1000 : backoff(attempt, maxRetryDelayMs), maxRetryDelayMs));
        continue;
      }
      throw new PolarAPIError({ status: response.status, body: await readBody(response), method, path, retryAfter });
    }
  }

  const get = <T>(path: string, query?: Query) => request<T>("GET", path, { query });
  const post = <T>(path: string, body: unknown) => request<T>("POST", path, { body });
  const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, { body });
  const del = <T>(path: string, query?: Query) => request<T>("DELETE", path, { query });
  const id = (value: string) => encodeURIComponent(value);

  return {
    baseUrl,
    apiVersion,
    request,
    requestWithResponse,

    checkouts: {
      create: (body: CheckoutCreate) => post<Checkout>("/v1/checkouts/", body),
      get: (checkoutId: string) => get<Checkout>(`/v1/checkouts/${id(checkoutId)}`),
      list: (params: ListCheckoutsParams = {}) => get<ListResource<Checkout>>("/v1/checkouts/", params),
    },

    checkoutLinks: {
      create: (body: CheckoutLinkCreate) => post<CheckoutLink>("/v1/checkout-links/", body),
      get: (linkId: string) => get<CheckoutLink>(`/v1/checkout-links/${id(linkId)}`),
      delete: (linkId: string) => del<void>(`/v1/checkout-links/${id(linkId)}`),
    },

    customers: {
      list: (params: ListCustomersParams = {}) => get<ListResource<Customer>>("/v1/customers/", params),
      create: (body: CustomerCreate) => post<Customer>("/v1/customers/", body),
      get: (customerId: string) => get<Customer>(`/v1/customers/${id(customerId)}`),
      update: (customerId: string, body: CustomerUpdate) => patch<Customer>(`/v1/customers/${id(customerId)}`, body),
      delete: (customerId: string, params: { anonymize?: boolean } = {}) =>
        del<void>(`/v1/customers/${id(customerId)}`, params),
      getExternal: (externalId: string) => get<Customer>(`/v1/customers/external/${id(externalId)}`),
      updateExternal: (externalId: string, body: CustomerUpdateExternalID) =>
        patch<Customer>(`/v1/customers/external/${id(externalId)}`, body),
      deleteExternal: (externalId: string, params: { anonymize?: boolean } = {}) =>
        del<void>(`/v1/customers/external/${id(externalId)}`, params),
      /** Active subscriptions, granted benefits, and meters, in one call. */
      getState: (customerId: string) => get<CustomerState>(`/v1/customers/${id(customerId)}/state`),
      /** Same as `getState`, keyed by your own user id. */
      getStateExternal: (externalId: string) =>
        get<CustomerState>(`/v1/customers/external/${id(externalId)}/state`),
    },

    customerSessions: {
      /** Mints a customer portal session. Redirect to `customer_portal_url`. */
      create: (body: CustomerSessionCreate) => post<CustomerSession>("/v1/customer-sessions/", body),
    },

    subscriptions: {
      list: (params: ListSubscriptionsParams = {}) =>
        get<ListResource<Subscription>>("/v1/subscriptions/", params),
      get: (subscriptionId: string) => get<Subscription>(`/v1/subscriptions/${id(subscriptionId)}`),
      update: (subscriptionId: string, body: SubscriptionUpdate) =>
        patch<Subscription>(`/v1/subscriptions/${id(subscriptionId)}`, body),
      /** Ends the subscription immediately. To cancel at period end, use `update` with `cancel_at_period_end`. */
      revoke: (subscriptionId: string) => del<Subscription>(`/v1/subscriptions/${id(subscriptionId)}`),
    },

    orders: {
      list: (params: ListOrdersParams = {}) => get<ListResource<Order>>("/v1/orders/", params),
      get: (orderId: string) => get<Order>(`/v1/orders/${id(orderId)}`),
    },

    products: {
      list: (params: ListProductsParams = {}) => get<ListResource<Product>>("/v1/products/", params),
      get: (productId: string) => get<Product>(`/v1/products/${id(productId)}`),
    },

    benefits: {
      list: (params: ListBenefitsParams = {}) => get<ListResource<Benefit>>("/v1/benefits/", params),
    },

    refunds: {
      create: (body: RefundCreate) => post<Refund>("/v1/refunds/", body),
    },

    licenseKeys: {
      validate: (body: LicenseKeyValidate) => post<ValidatedLicenseKey>("/v1/license-keys/validate", body),
      activate: (body: LicenseKeyActivate) => post<LicenseKeyActivationCreated>("/v1/license-keys/activate", body),
      deactivate: (body: LicenseKeyDeactivate) => post<void>("/v1/license-keys/deactivate", body),
    },

    events: {
      /** Sends usage events for usage-based billing. */
      ingest: (body: EventsIngest) => post<EventsIngestResponse>("/v1/events/ingest", body),
    },
  };
}

/**
 * Walks every page of a list endpoint.
 *
 * ```ts
 * for await (const sub of paginate((page) => polar.subscriptions.list({ ...filters, page, limit: 100 }))) {}
 * ```
 */
export async function* paginate<T>(fetchPage: (page: number) => Promise<ListResource<T>>): AsyncGenerator<T> {
  for (let page = 1; ; page++) {
    const result = await fetchPage(page);
    yield* result.items;
    if (page >= result.pagination.max_page || result.items.length === 0) return;
  }
}

export function encodeQuery(query: Query | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  const add = (key: string, value: QueryPrimitive) =>
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) add(key, item);
    } else if (typeof value === "object") {
      // deepObject style, which Polar uses for `metadata` filters.
      for (const [subKey, subValue] of Object.entries(value)) {
        for (const item of Array.isArray(subValue) ? subValue : [subValue]) add(`${key}[${subKey}]`, item);
      }
    } else {
      add(key, value);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

async function fetchWithTimeout(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
): Promise<Response> {
  if (!timeoutMs || typeof AbortController === "undefined" || typeof setTimeout === "undefined") {
    return doFetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}

function backoff(attempt: number, cap: number): number {
  return Math.min(cap, 250 * 2 ** attempt + Math.floor(Math.random() * 100));
}

function sleep(ms: number): Promise<void> {
  // Zero's QuickJS runner may lack timers; retrying immediately beats failing.
  if (ms <= 0 || typeof setTimeout === "undefined") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
