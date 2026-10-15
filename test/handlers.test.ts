import { describe, expect, it } from "vitest";
import { createPolarClient } from "../src/core/client.ts";
import { hasActiveSubscription, hasBenefit, meterBalance, toEntitlements } from "../src/core/entitlements.ts";
import {
  buildCheckoutCreate,
  checkoutRedirect,
  handleWebhookRequest,
  normalizeTimestamp,
  portalRedirect,
  resolveUrl,
  syncEntitlements,
} from "../src/core/handlers.ts";
import { customerState, jsonResponse, mockFetch, signWebhook, STANDARD_SECRET, stateChangedPayload } from "./fixtures.ts";
import { memoryStore } from "./memory-store.ts";

const requestUrl = "https://shop.spacefast.app/api/polar/checkout?x=1";

describe("buildCheckoutCreate", () => {
  const build = (query: string, options = {}, customer = null as Parameters<typeof buildCheckoutCreate>[0]["customer"]) =>
    buildCheckoutCreate({ query: new URLSearchParams(query), requestUrl, options, customer });

  it("reads products and resolves the success URL", () => {
    const result = build("products=a&products=b,c&products=a");
    expect(result).toEqual({
      ok: true,
      body: { products: ["a", "b", "c"], success_url: "https://shop.spacefast.app/?checkout_id={CHECKOUT_ID}" },
    });
  });

  it("never trusts customer ids from the query", () => {
    const result = build("products=a&external_customer_id=victim&customer_id=victim");
    expect(result.ok && result.body.external_customer_id).toBeFalsy();
    expect(result.ok && result.body.customer_id).toBeFalsy();
  });

  it("links the server-side customer", () => {
    const result = build("products=a&customer_email=query@example.com", {}, { externalId: "user_1", email: "auth@example.com" });
    expect(result.ok && result.body.external_customer_id).toBe("user_1");
    expect(result.ok && result.body.customer_email).toBe("auth@example.com");
  });

  it("enforces the product allowlist", () => {
    expect(build("products=other", { products: ["a", "b"] })).toMatchObject({ ok: false, status: 400 });
    expect(build("", { products: ["a", "b"] })).toMatchObject({ ok: true, body: { products: ["a", "b"] } });
    expect(build("products=b", { products: ["a", "b"] })).toMatchObject({ ok: true, body: { products: ["b"] } });
  });

  it("requires products", () => {
    expect(build("")).toEqual({ ok: false, status: 400, message: "Missing products" });
  });

  it("keeps an explicit {CHECKOUT_ID} and honours includeCheckoutId", () => {
    expect(build("products=a", { successUrl: "/thanks?id={CHECKOUT_ID}" })).toMatchObject({
      body: { success_url: "https://shop.spacefast.app/thanks?id={CHECKOUT_ID}" },
    });
    expect(build("products=a", { successUrl: "https://example.com/done", includeCheckoutId: false })).toMatchObject({
      body: { success_url: "https://example.com/done" },
    });
  });

  it("parses optional fields and rejects bad ones", () => {
    const result = build('products=a&seats=3&allow_discount_codes=false&discount_id=d&locale=tr&metadata={"ref":"x"}', {
      defaults: { metadata: { source: "site" } },
      queryMetadata: true,
    });
    expect(result).toMatchObject({
      ok: true,
      body: { seats: 3, allow_discount_codes: false, discount_id: "d", locale: "tr", metadata: { source: "site", ref: "x" } },
    });
    expect(build("products=a&seats=0")).toMatchObject({ ok: false, message: "Invalid seats" });
    expect(build("products=a&metadata=[1]", { queryMetadata: true })).toMatchObject({ ok: false });
  });

  it("ignores buyer-supplied metadata unless opted in", () => {
    const result = build('products=a&metadata={"credits":1000000}', { defaults: { metadata: { source: "site" } } });
    expect(result).toMatchObject({ ok: true, body: { metadata: { source: "site" } } });
    expect(result.ok && result.body.metadata).not.toHaveProperty("credits");
  });
});

describe("buildCheckoutCreate with prepare", () => {
  const build = (query: string, prepared: Parameters<typeof buildCheckoutCreate>[0]["prepared"], options = {}) =>
    buildCheckoutCreate({ query: new URLSearchParams(query), requestUrl, options, customer: { externalId: "user_1" }, prepared });

  it("sets ad-hoc prices and products on the server", () => {
    const result = build("pack=large&products=other", {
      products: ["prod_credits"],
      prices: { prod_credits: [{ amount_type: "fixed", price_amount: 4900, price_currency: "usd" }] },
      metadata: { credits: 500 },
    }, { products: ["prod_x", "prod_credits"] });
    expect(result).toMatchObject({
      ok: true,
      body: {
        products: ["prod_credits"],
        prices: { prod_credits: [{ amount_type: "fixed", price_amount: 4900 }] },
        metadata: { credits: 500 },
        external_customer_id: "user_1",
      },
    });
  });

  it("holds prepare's products to the allowlist too", () => {
    const result = build("products=prod_x", { products: ["prod_x", "prod_secret"] }, { products: ["prod_x"] });
    expect(result).toEqual({ ok: false, status: 400, message: "Product not sold here: prod_secret" });
  });

  it("lets server metadata win over the query's", () => {
    const result = build('products=a&metadata={"credits":999999,"ref":"ad"}', { metadata: { credits: 500 } }, { queryMetadata: true });
    expect(result.ok && result.body.metadata).toEqual({ credits: 500, ref: "ad" });
  });

  it("keeps the authenticated customer even if prepare sets another", () => {
    const result = build("products=a", { external_customer_id: "someone_else" });
    expect(result.ok && result.body.external_customer_id).toBe("user_1");
  });
});

describe("checkoutRedirect and portalRedirect", () => {
  it("redirects to the checkout", async () => {
    const { fetch } = mockFetch(jsonResponse({ url: "https://sandbox.polar.sh/checkout/abc" }, 201));
    const result = await checkoutRedirect(createPolarClient({ accessToken: "t", fetch }), {
      query: new URLSearchParams("products=a"),
      requestUrl,
      options: {},
      customer: null,
    });
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("https://sandbox.polar.sh/checkout/abc");
  });

  it("answers 502 when Polar refuses the token", async () => {
    const { fetch } = mockFetch(jsonResponse({ error: "invalid_token" }, 401));
    const result = await checkoutRedirect(createPolarClient({ accessToken: "t", fetch }), {
      query: new URLSearchParams("products=a"),
      requestUrl,
      options: {},
      customer: null,
    });
    expect(result.status).toBe(502);
  });

  it("opens the portal, or explains there is no customer yet", async () => {
    const { fetch, calls } = mockFetch(
      jsonResponse({ customer_portal_url: "https://polar.sh/portal/x" }, 201),
      jsonResponse({ error: "ResourceNotFound", detail: "Not found" }, 404),
      jsonResponse({ error: "ResourceNotFound", detail: "Not found" }, 404),
    );
    const polar = createPolarClient({ accessToken: "t", fetch });
    const input = { externalId: "user_1", requestUrl, options: { returnUrl: "/account" } };

    expect((await portalRedirect(polar, input)).headers.location).toBe("https://polar.sh/portal/x");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      external_customer_id: "user_1",
      return_url: "https://shop.spacefast.app/account",
    });
    expect((await portalRedirect(polar, input)).status).toBe(404);
    const fallback = await portalRedirect(polar, { ...input, options: { noCustomerUrl: "/pricing" } });
    expect(fallback.headers.location).toBe("https://shop.spacefast.app/pricing");
  });
});

describe("handleWebhookRequest", () => {
  it("stores entitlements, runs handlers once, and acknowledges redeliveries", async () => {
    const store = memoryStore();
    const body = stateChangedPayload(customerState());
    const headers = signWebhook(body);
    let runs = 0;
    let changed = 0;
    const input = {
      body,
      headers,
      secret: STANDARD_SECRET,
      handlers: { "customer.state_changed": () => void runs++ },
      context: null,
      store,
      onEntitlementsChanged: () => void changed++,
    };

    expect(await handleWebhookRequest(input)).toMatchObject({ status: 202 });
    expect(await handleWebhookRequest(input)).toMatchObject({ status: 200, body: "Already processed" });
    expect(runs).toBe(1);
    expect(changed).toBe(1);
    expect(hasActiveSubscription(store.rows.get("user_1")!.entitlements, "prod_pro")).toBe(true);
  });

  it("ignores a snapshot older than the stored one", async () => {
    const store = memoryStore();
    const fresh = stateChangedPayload(customerState(), "2026-10-05T12:00:00.000000Z");
    const stale = stateChangedPayload(customerState({ active_subscriptions: [] }), "2026-10-05T11:00:00Z");
    const now = () => Date.now();
    await handleWebhookRequest({ body: fresh, headers: signWebhook(fresh), secret: STANDARD_SECRET, handlers: {}, context: null, store, now });
    await handleWebhookRequest({ body: stale, headers: signWebhook(stale), secret: STANDARD_SECRET, handlers: {}, context: null, store, now });
    expect(store.rows.get("user_1")!.entitlements.subscriptions).toHaveLength(1);
  });

  it("answers 403 to a bad signature without touching the store", async () => {
    const store = memoryStore();
    const body = stateChangedPayload(customerState());
    const result = await handleWebhookRequest({
      body,
      headers: signWebhook(body, { secret: "whsec_b3RoZXI=" }),
      secret: STANDARD_SECRET,
      handlers: {},
      context: null,
      store,
    });
    expect(result.status).toBe(403);
    expect(store.rows.size).toBe(0);
  });

  it("rethrows handler errors and does not record the delivery", async () => {
    const store = memoryStore();
    const body = stateChangedPayload(customerState());
    await expect(
      handleWebhookRequest({
        body,
        headers: signWebhook(body),
        secret: STANDARD_SECRET,
        handlers: { onEvent: () => { throw new Error("boom"); } },
        context: null,
        store,
      }),
    ).rejects.toThrow("boom");
    expect(store.deliveries.size).toBe(0);
  });
});

describe("syncEntitlements", () => {
  it("dates the snapshot with Polar's clock, so a later webhook still wins", async () => {
    const store = memoryStore();
    const { fetch } = mockFetch(jsonResponse(customerState(), 200, { date: "Mon, 05 Oct 2026 12:00:00 GMT" }));
    await syncEntitlements(createPolarClient({ accessToken: "t", fetch }), store, "user_1");
    expect(store.rows.get("user_1")!.version).toBe("2026-10-05T12:00:00.000000Z");

    const later = stateChangedPayload(customerState({ active_subscriptions: [] }), "2026-10-05T12:00:00.250000Z");
    await handleWebhookRequest({ body: later, headers: signWebhook(later), secret: STANDARD_SECRET, handlers: {}, context: null, store });
    expect(store.rows.get("user_1")!.entitlements.subscriptions).toHaveLength(0);
  });

  it("stores an unknown customer as having nothing", async () => {
    const store = memoryStore();
    const { fetch } = mockFetch(jsonResponse({ error: "ResourceNotFound", detail: "Not found" }, 404));
    const entitlements = await syncEntitlements(createPolarClient({ accessToken: "t", fetch }), store, "user_new");
    expect(entitlements).toMatchObject({ externalId: "user_new", subscriptions: [], benefits: [] });
    expect(store.rows.has("user_new")).toBe(true);
  });
});

describe("entitlements", () => {
  const entitlements = toEntitlements(customerState());

  it("checks subscriptions, benefits, and meters", () => {
    expect(hasActiveSubscription(entitlements)).toBe(true);
    expect(hasActiveSubscription(entitlements, ["prod_other", "prod_pro"])).toBe(true);
    expect(hasActiveSubscription(entitlements, "prod_other")).toBe(false);
    expect(hasBenefit(entitlements, "ben_export")).toBe(true);
    expect(hasBenefit(entitlements, { type: "feature_flag", metadata: { feature: "export" } })).toBe(true);
    expect(hasBenefit(entitlements, { metadata: { feature: "import" } })).toBe(false);
    expect(meterBalance(entitlements, "meter_tokens")).toBe(75);
    expect(meterBalance(entitlements, "meter_none")).toBe(0);
  });

  it("treats a deleted customer as having nothing", () => {
    const deleted = toEntitlements(customerState({ deleted_at: "2026-10-05T00:00:00Z" }));
    expect(hasActiveSubscription(deleted)).toBe(false);
    expect(deleted.externalId).toBe("user_1");
  });
});

describe("helpers", () => {
  it("normalizes timestamps to a sortable form", () => {
    expect(normalizeTimestamp("2026-10-05T12:00:00Z")).toBe("2026-10-05T12:00:00.000000Z");
    expect(normalizeTimestamp("2026-10-05T12:00:00.1234567+00:00")).toBe("2026-10-05T12:00:00.123456Z");
    expect(normalizeTimestamp("2026-10-05T14:00:00+02:00")).toBe("2026-10-05T12:00:00.000000Z");
  });

  it("resolves paths against the request origin", () => {
    expect(resolveUrl("/a", "https://x.dev/b?c")).toBe("https://x.dev/a");
    expect(resolveUrl("a", "https://x.dev/b")).toBe("https://x.dev/a");
    expect(resolveUrl("https://y.dev", "https://x.dev")).toBe("https://y.dev");
  });
});
