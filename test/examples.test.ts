// Drives the Functions example's route modules the way the file router would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as checkout from "../examples/functions-app/functions/api/polar/checkout.ts";
import * as entitlements from "../examples/functions-app/functions/api/polar/entitlements.ts";
import * as portal from "../examples/functions-app/functions/api/polar/portal.ts";
import * as webhooks from "../examples/functions-app/functions/api/polar/webhooks.ts";
import * as report from "../examples/functions-app/functions/api/report.ts";
import * as session from "../examples/functions-app/functions/api/session.ts";
import { customerState, jsonResponse, mockFetch, signWebhook, STANDARD_SECRET, stateChangedPayload } from "./fixtures.ts";
import { sqliteD1 } from "./sqlite-d1.ts";

const ORIGIN = "https://shop.view.fast";
let env: Record<string, unknown>;
/** What the file router passes as the second argument. */
const routeContext = () => ({ env, params: {}, ctx: {} });
let polar: ReturnType<typeof mockFetch>;

beforeEach(() => {
  env = {
    POLAR_ACCESS_TOKEN: "polar_oat_test",
    POLAR_WEBHOOK_SECRET: STANDARD_SECRET,
    POLAR_SERVER: "sandbox",
    POLAR_PRO_PRODUCT_ID: "prod_pro",
    SESSION_SECRET: "a-test-secret-that-is-long-enough",
    DB: sqliteD1(),
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Queues Polar API answers; any unexpected call fails the test. */
function polarAnswers(...responses: Parameters<typeof mockFetch>) {
  polar = mockFetch(...responses);
  vi.stubGlobal("fetch", polar.fetch);
}

async function signIn(name: string): Promise<string> {
  const response = await session.POST(
    new Request(`${ORIGIN}/api/session`, { method: "POST", body: new URLSearchParams({ name }) }),
    routeContext(),
  );
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });

describe("functions example", () => {
  it("signs in with a signed cookie and rejects a tampered one", async () => {
    const cookie = await signIn("Jane");
    expect(await (await session.GET(get("/api/session", cookie), routeContext())).json()).toEqual({ userId: "demo:jane" });

    const tampered = cookie.replace("demo%3Ajane", "demo%3Aadmin");
    expect(await (await session.GET(get("/api/session", tampered), routeContext())).json()).toBeNull();
  });

  it("refuses checkout and the portal when signed out", async () => {
    polarAnswers();
    expect((await checkout.GET(get("/api/polar/checkout"), routeContext())).status).toBe(401);
    expect((await portal.GET(get("/api/polar/portal"), routeContext())).status).toBe(401);
  });

  it("checks out the configured product for the signed-in user, whatever the URL asks for", async () => {
    const cookie = await signIn("jane");
    polarAnswers(jsonResponse({ url: "https://sandbox.polar.sh/checkout/abc" }, 201));

    const response = await checkout.GET(get("/api/polar/checkout?products=prod_other", cookie), routeContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sandbox.polar.sh/checkout/abc");
    const body = JSON.parse(String(polar.calls[0]!.init.body));
    expect(body.products).toEqual(["prod_pro"]);
    expect(body.external_customer_id).toBe("demo:jane");
    expect(body.success_url).toContain(`${ORIGIN}/?checkout=success`);
  });

  it("gates the report until a webhook stores a Pro subscription", async () => {
    const cookie = await signIn("jane");

    // Nothing stored and Polar has no such customer yet.
    polarAnswers(jsonResponse({ error: "ResourceNotFound" }, 404));
    expect((await report.GET(get("/api/report", cookie), routeContext())).status).toBe(403);

    const payload = stateChangedPayload(customerState({ external_id: "demo:jane" }));
    const delivery = await webhooks.POST(
      new Request(`${ORIGIN}/api/polar/webhooks`, { method: "POST", headers: signWebhook(payload), body: payload }),
      routeContext(),
    );
    expect(delivery.status).toBe(202);

    // Served from env.DB now: no queued Polar answers, so a call would throw.
    polarAnswers();
    const unlocked = await report.GET(get("/api/report", cookie), routeContext());
    expect(unlocked.status).toBe(200);
    expect(await unlocked.json()).toMatchObject({ rows: [{ metric: "signups" }] });

    const plan = await (await entitlements.GET(get("/api/polar/entitlements", cookie), routeContext())).json();
    expect(plan.subscriptions[0].productId).toBe("prod_pro");
  });

  it("runs its own webhook handlers", async () => {
    const payload = JSON.stringify({
      type: "order.paid",
      timestamp: new Date().toISOString(),
      data: { id: "ord_1", customer: { external_id: "demo:jane" } },
    });
    const delivery = await webhooks.POST(
      new Request(`${ORIGIN}/api/polar/webhooks`, { method: "POST", headers: signWebhook(payload), body: payload }),
      routeContext(),
    );
    expect(delivery.status).toBe(202);
    expect(console.log).toHaveBeenCalledWith("order paid", { order: "ord_1", customer: "demo:jane" });
  });

  it("rejects unsigned webhooks", async () => {
    const delivery = await webhooks.POST(new Request(`${ORIGIN}/api/polar/webhooks`, { method: "POST", body: "{}" }), routeContext());
    expect(delivery.status).toBe(403);
  });
});
