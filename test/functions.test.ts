import { describe, expect, it } from "vitest";
import { createD1Store, createPolar } from "../src/functions/index.ts";
import { toEntitlements } from "../src/core/entitlements.ts";
import { customerState, jsonResponse, mockFetch, signWebhook, STANDARD_SECRET, stateChangedPayload } from "./fixtures.ts";
import { sqliteD1 } from "./sqlite-d1.ts";

const env = (overrides: Record<string, unknown> = {}) => ({
  POLAR_ACCESS_TOKEN: "polar_oat_test",
  POLAR_WEBHOOK_SECRET: STANDARD_SECRET,
  POLAR_SERVER: "sandbox",
  DB: sqliteD1(),
  ...overrides,
});

const webhookRequest = (body: string, headers = signWebhook(body)) =>
  new Request("https://shop.spacefast.app/api/polar/webhooks", { method: "POST", headers, body });

describe("createD1Store", () => {
  it("creates its tables and keeps the newest snapshot", async () => {
    const db = sqliteD1();
    const store = createD1Store(db);
    const entitlements = toEntitlements(customerState());

    expect(await store.get("user_1")).toBeNull();
    expect(await store.save(entitlements, "2026-10-05T12:00:00.000000Z")).toBe(true);
    expect(await store.save({ ...entitlements, subscriptions: [] }, "2026-10-05T11:00:00.000000Z")).toBe(false);
    expect((await store.get("user_1"))!.entitlements.subscriptions).toHaveLength(1);
    expect(await store.save({ ...entitlements, subscriptions: [] }, "2026-10-05T13:00:00.000000Z")).toBe(true);
    expect((await store.get("user_1"))!.entitlements.subscriptions).toHaveLength(0);
  });

  it("tracks deliveries and tolerates a duplicate record", async () => {
    const store = createD1Store(sqliteD1());
    expect(await store.hasDelivery!("msg_1")).toBe(false);
    await store.recordDelivery!("msg_1", "order.paid");
    await store.recordDelivery!("msg_1", "order.paid");
    expect(await store.hasDelivery!("msg_1")).toBe(true);
  });

  it("skips customers without an external id and rejects unsafe prefixes", async () => {
    const store = createD1Store(sqliteD1());
    expect(await store.save({ ...toEntitlements(customerState()), externalId: null }, "2026-10-05T12:00:00.000000Z")).toBe(false);
    expect(() => createD1Store(sqliteD1(), { tablePrefix: "x; drop" })).toThrow("Invalid table prefix");
  });
});

describe("createPolar (Functions)", () => {
  it("handles a webhook end to end and serves entitlements from env.DB", async () => {
    const polar = createPolar();
    const workerEnv = env();
    const paid: string[] = [];
    const webhooks = polar.webhooks({ "customer.state_changed": (event) => void paid.push(event.data.id) });

    const body = stateChangedPayload(customerState());
    // File-router shape: (request, { params, env }).
    const response = await webhooks(webhookRequest(body), { params: {}, env: workerEnv });
    expect(response.status).toBe(202);
    expect(paid).toHaveLength(1);

    const entitlements = polar.entitlements({ customer: () => "user_1" });
    // Root-worker shape: (request, env).
    const read = await entitlements(new Request("https://shop.spacefast.app/api/polar/entitlements"), workerEnv);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ externalId: "user_1", subscriptions: [{ productId: "prod_pro" }] });
  });

  it("reads env from a route context without params", async () => {
    const polar = createPolar();
    const body = stateChangedPayload(customerState());
    const response = await polar.webhooks()(webhookRequest(body), { env: env() });
    expect(response.status).toBe(202);
  });

  it("rejects a forged webhook and a missing secret", async () => {
    const polar = createPolar();
    const body = stateChangedPayload(customerState());
    const forged = await polar.webhooks()(webhookRequest(body, signWebhook(body, { secret: "whsec_b3RoZXI=" })), env());
    expect(forged.status).toBe(403);
    const unset = await polar.webhooks()(webhookRequest(body), env({ POLAR_WEBHOOK_SECRET: undefined }));
    expect(unset.status).toBe(500);
  });

  it("answers 500 when a handler throws, so Polar retries", async () => {
    const polar = createPolar();
    const body = stateChangedPayload(customerState());
    const response = await polar.webhooks({ onEvent: () => { throw new Error("boom"); } })(webhookRequest(body), env());
    expect(response.status).toBe(500);
  });

  it("creates a checkout for the resolved customer", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ url: "https://sandbox.polar.sh/checkout/abc" }, 201));
    const polar = createPolar({ client: { fetch } });
    const checkout = polar.checkout({ products: ["prod_pro"], customer: () => ({ externalId: "user_1" }) });
    const response = await checkout(new Request("https://shop.spacefast.app/api/polar/checkout"), env());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sandbox.polar.sh/checkout/abc");
    expect(calls[0]!.url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      products: ["prod_pro"],
      external_customer_id: "user_1",
    });
  });

  it("prices a checkout on the server with prepare, or rejects it", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ url: "https://sandbox.polar.sh/checkout/abc" }, 201));
    const polar = createPolar({ client: { fetch } });
    const packs: Record<string, number> = { small: 500, large: 4900 };
    const checkout = polar.checkout({
      customer: () => ({ externalId: "user_1" }),
      prepare: (request) => {
        const pack = new URL(request.url).searchParams.get("pack") ?? "";
        const amount = packs[pack];
        if (!amount) return { reject: "Unknown pack" };
        return {
          products: ["prod_credits"],
          prices: { prod_credits: [{ amount_type: "fixed", price_amount: amount, price_currency: "usd" }] },
          metadata: { pack },
        };
      },
    });

    const ok = await checkout(new Request("https://shop.spacefast.app/api/credits?pack=large"), env());
    expect(ok.status).toBe(302);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      products: ["prod_credits"],
      prices: { prod_credits: [{ price_amount: 4900 }] },
      metadata: { pack: "large" },
    });
    const bad = await checkout(new Request("https://shop.spacefast.app/api/credits?pack=huge"), env());
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("Unknown pack");
    expect(calls).toHaveLength(1);
  });

  it("refuses checkout, portal, and entitlements to signed-out visitors when required", async () => {
    const polar = createPolar();
    const request = new Request("https://shop.spacefast.app/x");
    expect((await polar.checkout({ requireCustomer: true, customer: () => null })(request, env())).status).toBe(401);
    expect((await polar.portal({ customer: () => null })(request, env())).status).toBe(401);
    expect((await polar.entitlements({ customer: () => undefined })(request, env())).status).toBe(401);
  });

  it("falls back to Polar when nothing is stored, then caches it", async () => {
    const { fetch, calls } = mockFetch(jsonResponse(customerState(), 200, { date: new Date().toUTCString() }));
    const polar = createPolar({ client: { fetch } });
    const workerEnv = env();

    const first = await polar.getEntitlements(workerEnv, "user_1");
    const second = await polar.getEntitlements(workerEnv, "user_1");
    expect(first.subscriptions).toHaveLength(1);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("works without a database by asking Polar", async () => {
    const { fetch } = mockFetch(jsonResponse(customerState()));
    const polar = createPolar({ client: { fetch } });
    const entitlements = await polar.getEntitlements(env({ DB: undefined }), "user_1");
    expect(entitlements.subscriptions).toHaveLength(1);
  });

  it("explains a missing access token", async () => {
    const polar = createPolar();
    const response = await polar.checkout()(new Request("https://x.dev/?products=a"), env({ POLAR_ACCESS_TOKEN: undefined }));
    expect(response.status).toBe(500);
    expect(() => polar.client(env({ POLAR_ACCESS_TOKEN: undefined }))).toThrow("POLAR_ACCESS_TOKEN");
  });
});
