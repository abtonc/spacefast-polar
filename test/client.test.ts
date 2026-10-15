import { describe, expect, it } from "vitest";
import { createPolarClient, encodeQuery, paginate, parsePolarServer } from "../src/core/client.ts";
import { PolarAPIError, PolarConnectionError } from "../src/core/errors.ts";
import { POLAR_API_VERSION } from "../src/core/generated.ts";
import { jsonResponse, mockFetch } from "./fixtures.ts";

describe("createPolarClient", () => {
  it("sends the token, pinned version, and JSON body", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ id: "co_1", url: "https://polar.sh/checkout/x" }, 201));
    const polar = createPolarClient({ accessToken: "polar_oat_x", server: "sandbox", fetch });
    const checkout = await polar.checkouts.create({ products: ["prod_1"] });

    expect(checkout.id).toBe("co_1");
    const [call] = calls;
    expect(call!.url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    expect(call!.init.method).toBe("POST");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer polar_oat_x");
    expect(headers["polar-version"]).toBe(POLAR_API_VERSION);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call!.init.body as string)).toEqual({ products: ["prod_1"] });
  });

  it("defaults to production and escapes path segments", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({}));
    const polar = createPolarClient({ accessToken: "t", fetch });
    await polar.customers.getStateExternal("user/1 2");
    expect(calls[0]!.url).toBe("https://api.polar.sh/v1/customers/external/user%2F1%202/state");
  });

  it("encodes list filters", async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ items: [], pagination: { total_count: 0, max_page: 1 } }));
    const polar = createPolarClient({ accessToken: "t", fetch });
    await polar.subscriptions.list({ product_id: ["a", "b"], active: true, metadata: { plan: "pro" }, limit: 50 });
    expect(calls[0]!.url).toBe(
      "https://api.polar.sh/v1/subscriptions/?product_id=a&product_id=b&active=true&metadata%5Bplan%5D=pro&limit=50",
    );
  });

  it("retries 429 using Retry-After, for any method", async () => {
    const { fetch, calls } = mockFetch(
      new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      jsonResponse({ id: "co_1" }, 201),
    );
    const polar = createPolarClient({ accessToken: "t", fetch });
    await polar.checkouts.create({ products: ["p"] });
    expect(calls).toHaveLength(2);
  });

  it("retries 503 for GET but not for POST", async () => {
    const get = mockFetch(new Response("", { status: 503 }), jsonResponse({ id: "c" }));
    await createPolarClient({ accessToken: "t", fetch: get.fetch, maxRetryDelayMs: 0 }).customers.get("c");
    expect(get.calls).toHaveLength(2);

    const post = mockFetch(new Response("", { status: 503 }));
    const polar = createPolarClient({ accessToken: "t", fetch: post.fetch, maxRetryDelayMs: 0 });
    await expect(polar.checkouts.create({ products: ["p"] })).rejects.toBeInstanceOf(PolarAPIError);
    expect(post.calls).toHaveLength(1);
  });

  it("gives up after maxRetries", async () => {
    const { fetch, calls } = mockFetch(
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
    );
    const polar = createPolarClient({ accessToken: "t", fetch, maxRetries: 1 });
    const error = await polar.products.get("p").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PolarAPIError);
    expect((error as PolarAPIError).retryAfter).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("surfaces Polar's error body", async () => {
    const { fetch } = mockFetch(
      jsonResponse({ error: "ResourceNotFound", detail: "Not found" }, 404),
      jsonResponse({ detail: [{ loc: ["body", "products"], msg: "Field required", type: "missing" }] }, 422),
    );
    const polar = createPolarClient({ accessToken: "t", fetch });

    const notFound = (await polar.orders.get("o").catch((caught: unknown) => caught)) as PolarAPIError;
    expect(notFound.status).toBe(404);
    expect(notFound.errorType).toBe("ResourceNotFound");
    expect(notFound.message).toContain("ResourceNotFound: Not found");

    const invalid = (await polar.checkouts.create({ products: [] }).catch((caught: unknown) => caught)) as PolarAPIError;
    expect(invalid.message).toContain("body.products: Field required");
  });

  it("wraps network failures, retrying only idempotent calls", async () => {
    const get = mockFetch(new Error("ECONNRESET"), jsonResponse({ id: "p" }));
    await createPolarClient({ accessToken: "t", fetch: get.fetch, maxRetryDelayMs: 0 }).products.get("p");
    expect(get.calls).toHaveLength(2);

    const post = mockFetch(new Error("ECONNRESET"));
    const polar = createPolarClient({ accessToken: "t", fetch: post.fetch });
    await expect(polar.events.ingest({ events: [] })).rejects.toBeInstanceOf(PolarConnectionError);
  });

  it("returns undefined for 204", async () => {
    const { fetch } = mockFetch(new Response(null, { status: 204 }));
    const polar = createPolarClient({ accessToken: "t", fetch });
    await expect(polar.licenseKeys.deactivate({ key: "k", organization_id: "o", activation_id: "a" })).resolves.toBeUndefined();
  });

  it("requires a token", () => {
    expect(() => createPolarClient({ accessToken: "" })).toThrow("accessToken");
  });
});

describe("paginate", () => {
  it("walks every page", async () => {
    const pages = [
      { items: [1, 2], pagination: { total_count: 3, max_page: 2 } },
      { items: [3], pagination: { total_count: 3, max_page: 2 } },
    ];
    const seen: number[] = [];
    for await (const item of paginate(async (page) => pages[page - 1]!)) seen.push(item);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("encodeQuery", () => {
  it("skips empty values", () => {
    expect(encodeQuery({ a: undefined, b: null, c: "x y" })).toBe("?c=x%20y");
    expect(encodeQuery({})).toBe("");
  });
});

describe("parsePolarServer", () => {
  it("defaults to production and rejects typos", () => {
    expect(parsePolarServer(undefined)).toBe("production");
    expect(parsePolarServer(" Sandbox ")).toBe("sandbox");
    expect(() => parsePolarServer("staging")).toThrow("POLAR_SERVER");
  });
});
