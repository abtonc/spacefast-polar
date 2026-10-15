import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeZeroSource } from "@spacefast/zero-compile";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolar } from "../src/zero/index.ts";
import { customerState, jsonResponse, mockFetch, signWebhook, STANDARD_SECRET, stateChangedPayload } from "./fixtures.ts";

const cli = fileURLToPath(new URL("../bin/spacefast-polar.js", import.meta.url));

describe("vendored adapter under the Zero compiler", () => {
  let root: string;
  let snippet: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "spacefast-polar-zero-"));
    await writeFile(join(root, "sf.jsonc"), JSON.stringify({ name: "polar-test", runtime: { kind: "zero", server: "server/index.ts", client: "client/index.tsx" } }));
    const output = execFileSync(process.execPath, [cli, "add", "zero"], { cwd: root, encoding: "utf8" });
    // Compile exactly what the CLI tells people to paste.
    const start = output.indexOf("Next, in server/index.ts:") + "Next, in server/index.ts:".length;
    const end = output.indexOf("Then set the secrets");
    snippet = output
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
    await writeFile(join(root, "server/index.ts"), `${snippet}\n`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes Zero's source checks and declares the tables and endpoints", async () => {
    const analysis = await analyzeZeroSource(root, { server: "server/index.ts", client: "client/index.tsx" });
    expect(analysis.tables).toEqual(expect.arrayContaining(["polarEntitlements", "polarWebhookDeliveries"]));
    expect(analysis.queries).toContain("entitlements");
    expect(analysis.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual([
      "GET /api/polar/checkout",
      "GET /api/polar/portal",
      "POST /api/polar/sync",
      "POST /api/polar/webhooks",
    ]);
  });

  it("refuses to overwrite without --force", () => {
    expect(() => execFileSync(process.execPath, [cli, "add", "zero"], { cwd: root, stdio: "pipe" })).toThrow();
  });
});

/** Just enough of a Zero handler context: a table API over arrays. */
function fakeCtx(options: { userId?: string | null; env?: Record<string, string | undefined> } = {}) {
  const tables: Record<string, Array<Record<string, unknown>>> = { polarEntitlements: [], polarWebhookDeliveries: [] };
  let nextId = 0;
  const invalidated: string[][] = [];
  const db = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      {
        async get(id: string) {
          return rows.find((row) => row.id === id) ?? null;
        },
        withIndex(_index: string, range?: (q: unknown) => unknown) {
          const filters: Array<[string, unknown]> = [];
          const builder = { eq: (field: string, value: unknown) => (filters.push([field, value]), builder) };
          range?.(builder);
          const matches = () => rows.filter((row) => filters.every(([field, value]) => row[field] === value));
          return { first: async () => matches()[0] ?? null, collect: async () => matches() };
        },
        async insert(value: Record<string, unknown>) {
          const row = { ...value, id: `row_${++nextId}` };
          rows.push(row);
          return row;
        },
        async update(id: string, patch: Record<string, unknown>) {
          const row = rows.find((candidate) => candidate.id === id);
          if (row) Object.assign(row, patch);
          return row ?? null;
        },
      },
    ]),
  );
  const userId = options.userId === undefined ? "user_1" : options.userId;
  const ctx = {
    auth: userId
      ? { userId, isAuthenticated: true, displayName: "Jane", email: "jane@example.com", emailVerified: true }
      : { userId: null, isAuthenticated: false, displayName: "" },
    env: { POLAR_ACCESS_TOKEN: "polar_oat_test", POLAR_WEBHOOK_SECRET: STANDARD_SECRET, POLAR_SERVER: "sandbox", ...options.env },
    db,
    log: { info() {}, warn() {}, error() {} },
    invalidate: (...queries: string[]) => void invalidated.push(queries),
  };
  // The adapter only touches the members above.
  return { ctx: ctx as never, tables, invalidated };
}

function endpointRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers = new Headers(init.headers);
  return {
    method: init.method ?? "GET",
    path: new URL(url).pathname,
    url,
    headers,
    query: new URL(url).searchParams,
    text: async () => init.body ?? "",
    json: async () => JSON.parse(init.body ?? "null"),
    bytes: async () => new TextEncoder().encode(init.body ?? ""),
  } as never;
}

describe("createPolar (Zero)", () => {
  it("stores entitlements from a webhook and serves them to queries", async () => {
    const polar = createPolar({ invalidate: ["entitlements"] });
    const { ctx, tables, invalidated } = fakeCtx();
    const body = stateChangedPayload(customerState());

    const response = await polar.webhooks()(
      ctx,
      endpointRequest("https://app.spacefast.app/api/polar/webhooks", { method: "POST", headers: signWebhook(body), body }),
    );
    expect(response.status).toBe(202);
    expect(tables.polarEntitlements).toHaveLength(1);
    expect(tables.polarWebhookDeliveries).toHaveLength(1);
    expect(invalidated).toEqual([["entitlements"]]);

    const entitlements = await polar.entitlements(ctx);
    expect(entitlements.subscriptions[0]!.productId).toBe("prod_pro");
  });

  it("gives guests no entitlements and no checkout by default", async () => {
    const polar = createPolar();
    const { ctx } = fakeCtx({ userId: null });
    expect((await polar.entitlements(ctx)).subscriptions).toEqual([]);
    const response = await polar.checkout()(ctx, endpointRequest("https://app.spacefast.app/api/polar/checkout?products=a"));
    expect(response.status).toBe(401);
  });

  it("checks out the signed-in user", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ url: "https://sandbox.polar.sh/checkout/abc" }, 201));
    const polar = createPolar({ client: { fetch } });
    const { ctx } = fakeCtx();
    const response = await polar.checkout({ successUrl: "/thanks" })(
      ctx,
      endpointRequest("https://app.spacefast.app/api/polar/checkout?products=prod_pro&external_customer_id=someone_else"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.Location).toBe("https://sandbox.polar.sh/checkout/abc");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      products: ["prod_pro"],
      external_customer_id: "user_1",
      customer_email: "jane@example.com",
      success_url: "https://app.spacefast.app/thanks?checkout_id={CHECKOUT_ID}",
    });
  });

  it("prices a checkout on the server with prepare", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ url: "https://sandbox.polar.sh/checkout/abc" }, 201));
    const polar = createPolar({ client: { fetch } });
    const { ctx } = fakeCtx();
    const handler = polar.checkout({
      prepare: (_ctx, req) =>
        req.query.get("pack") === "large"
          ? { products: ["prod_credits"], prices: { prod_credits: [{ amount_type: "fixed", price_amount: 4900 }] } }
          : { reject: "Unknown pack", status: 422 },
    });
    const ok = await handler(ctx, endpointRequest("https://app.spacefast.app/api/credits?pack=large"));
    expect(ok.status).toBe(302);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ products: ["prod_credits"], external_customer_id: "user_1" });
    const bad = await handler(ctx, endpointRequest("https://app.spacefast.app/api/credits?pack=huge"));
    expect(bad.status).toBe(422);
  });

  it("never prefills the name unless asked", async () => {
    const { fetch, calls } = mockFetch(
      jsonResponse({ url: "https://sandbox.polar.sh/checkout/a" }, 201),
      jsonResponse({ url: "https://sandbox.polar.sh/checkout/b" }, 201),
    );
    const polar = createPolar({ client: { fetch } });
    const { ctx } = fakeCtx();
    const request = endpointRequest("https://app.spacefast.app/api/polar/checkout?products=prod_pro");

    await polar.checkout()(ctx, request);
    expect(JSON.parse(calls[0]!.init.body as string).customer_name).toBeUndefined();
    await polar.checkout({ prefillName: true })(ctx, request);
    expect(JSON.parse(calls[1]!.init.body as string).customer_name).toBe("Jane");
  });

  // Production Zero rejects a response carrying the same header twice in
  // different case (zero_response_header_invalid); sf dev does not.
  it("never sends a header twice in different case", async () => {
    const polar = createPolar();
    const { ctx } = fakeCtx({ userId: null });
    const body = stateChangedPayload(customerState());
    const responses = [
      await polar.checkout()(ctx, endpointRequest("https://app.spacefast.app/api/polar/checkout?products=a")),
      await polar.portal()(ctx, endpointRequest("https://app.spacefast.app/api/polar/portal")),
      await polar.webhooks()(
        fakeCtx().ctx,
        endpointRequest("https://app.spacefast.app/api/polar/webhooks", { method: "POST", headers: signWebhook(body), body }),
      ),
    ] as Array<{ headers: Record<string, string> }>;
    for (const response of responses) {
      const names = Object.keys(response.headers).map((name) => name.toLowerCase());
      expect(new Set(names).size, names.join(", ")).toBe(names.length);
    }
  });

  it("syncs from Polar on demand", async () => {
    const { fetch } = mockFetch(jsonResponse(customerState(), 200, { date: new Date().toUTCString() }));
    const polar = createPolar({ client: { fetch } });
    const { ctx, tables } = fakeCtx();
    const response = await polar.sync()(ctx, endpointRequest("https://app.spacefast.app/api/polar/sync", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(tables.polarEntitlements).toHaveLength(1);
  });

  it("explains missing tables", async () => {
    const polar = createPolar();
    const { ctx } = fakeCtx();
    (ctx as { db: Record<string, unknown> }).db = {};
    await expect(polar.entitlements(ctx)).rejects.toThrow("polarEntitlements");
  });
});
