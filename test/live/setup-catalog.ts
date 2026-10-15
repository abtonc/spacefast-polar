/**
 * Creates the sandbox products the live tests buy. Safe to re-run: anything
 * that already exists (matched by name) is reused.
 *
 *   POLAR_ACCESS_TOKEN=polar_oat_… node test/live/setup-catalog.ts
 */
import { createPolarClient, type Benefit, type ListResource, type Product } from "../../src/core/index.ts";

const CONFIG_READS_METER_ID = "03d370ee-43e3-4b25-8f67-998a360e4ae7";

const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) throw new Error("Set POLAR_ACCESS_TOKEN to a sandbox token");
const polar = createPolarClient({ accessToken: token, server: "sandbox" });

async function featureFlag(description: string, feature: string): Promise<Benefit> {
  const existing = await polar.benefits.list({ type: "feature_flag", limit: 100 });
  const found = existing.items.find((benefit) => benefit.description === description);
  if (found) return found;
  return polar.request<Benefit>("POST", "/v1/benefits/", {
    body: { type: "feature_flag", description, metadata: { feature }, properties: {} },
  });
}

async function product(name: string, body: Record<string, unknown>, benefitIds: string[] = []): Promise<Product> {
  const existing = await polar.request<ListResource<Product>>("GET", "/v1/products/", { query: { query: name, limit: 100 } });
  let found = existing.items.find((item) => item.name === name && !item.is_archived);
  if (!found) found = await polar.request<Product>("POST", "/v1/products/", { body: { name, ...body } });
  if (benefitIds.length > 0) {
    found = await polar.request<Product>("POST", `/v1/products/${found.id}/benefits`, { body: { benefits: benefitIds } });
  }
  return found;
}

const lifetimeFlag = await featureFlag("SDK test: lifetime access", "lifetime");
const basicFlag = await featureFlag("SDK test: basic plan", "basic");

const catalog = {
  lifetime: await product(
    "SDK Test · Lifetime",
    { description: "One-time purchase. Grants the lifetime feature flag.", prices: [{ amount_type: "fixed", price_amount: 4900 }] },
    [lifetimeFlag.id],
  ),
  basic: await product(
    "SDK Test · Basic",
    {
      description: "Plain monthly subscription. Grants the basic feature flag.",
      recurring_interval: "month",
      prices: [{ amount_type: "fixed", price_amount: 900 }],
    },
    [basicFlag.id],
  ),
  payg: await product("SDK Test · Pay as you go", {
    description: "Metered-only subscription: $2 per million config reads, billed monthly.",
    recurring_interval: "month",
    prices: [{ amount_type: "metered_unit", meter_id: CONFIG_READS_METER_ID, unit_amount: "0.0002" }],
  }),
  credits: await product("SDK Test · Credits", {
    description: "One-time credit packs. The server sets the price per checkout.",
    prices: [{ amount_type: "fixed", price_amount: 500 }],
  }),
};

console.log(
  JSON.stringify(
    Object.fromEntries(Object.entries(catalog).map(([key, item]) => [key, { id: item.id, name: item.name }])),
    null,
    2,
  ),
);
console.log(JSON.stringify({ lifetimeBenefit: lifetimeFlag.id, basicBenefit: basicFlag.id }));
