import { action, capsule, endpoint, mutation, query, string, table, text } from "@spacefast/zero/server";

import { CONFIG_READS_EVENT, cleanNote, FREE_NOTE_LIMIT, PRO_PRODUCT_ID } from "../shared/plans";
import { createPolar, hasActiveSubscription } from "./polar/index.ts";

const polar = createPolar({ invalidate: ["entitlements", "deliveries"] });

export default capsule({
  name: "Polar integration test",
  schema: {
    notes: table({
      body: string(),
      ownerId: string(),
    }).index("by_owner", ["ownerId"]),
    // Written out here because Zero reads the schema from this file's source.
    polarEntitlements: table({
      externalId: string(),
      customerId: string(),
      entitlements: string(),
      version: string(),
    }).index("by_external_id", ["externalId"]),
    polarWebhookDeliveries: table({
      webhookId: string(),
      eventType: string(),
    }).index("by_webhook_id", ["webhookId"]),
  },
  queries: {
    entitlements: query((ctx) => polar.entitlements(ctx)),
    notes: query(async (ctx) => {
      if (!ctx.auth.isAuthenticated) return [];
      return ctx.db.notes
        .withIndex("by_owner", (range) => range.eq("ownerId", ctx.auth.userId))
        .order("desc")
        .collect();
    }),
    deliveries: query(async (ctx) => {
      if (!ctx.auth.isAuthenticated) return [];
      return ctx.db.polarWebhookDeliveries.withIndex("by_creation").order("desc").take(15);
    }),
  },
  mutations: {
    addNote: mutation(async (ctx, body: string) => {
      const auth = ctx.auth.requireSignedIn();
      const clean = cleanNote(body);
      if (!clean) return { ok: false, reason: "empty" };
      const entitlements = await polar.entitlements(ctx);
      if (!hasActiveSubscription(entitlements, PRO_PRODUCT_ID)) {
        const count = await ctx.db.notes.withIndex("by_owner", (range) => range.eq("ownerId", auth.userId)).count();
        if (count >= FREE_NOTE_LIMIT) return { ok: false, reason: "limit" };
      }
      await ctx.db.notes.insert({ body: clean, ownerId: auth.userId });
      ctx.invalidate("notes");
      return { ok: true };
    }),
    deleteNote: mutation(async (ctx, id: string) => {
      const auth = ctx.auth.requireSignedIn();
      const note = await ctx.db.notes.get(id);
      if (!note || note.ownerId !== auth.userId) return;
      await ctx.db.notes.delete(id);
      ctx.invalidate("notes");
    }),
  },
  actions: {
    // Reports metered usage to Polar. Pro only, since only Pro has the meter.
    recordUsage: action(async (ctx, reads: number) => {
      const auth = ctx.auth.requireSignedIn();
      if (!Number.isInteger(reads) || reads < 1 || reads > 100_000_000) throw new Error("Invalid amount");
      const entitlements = await polar.entitlements(ctx);
      if (!hasActiveSubscription(entitlements, PRO_PRODUCT_ID)) throw new Error("Upgrade to Pro to use the API");
      const result = await polar.client(ctx).events.ingest({
        events: [{ name: CONFIG_READS_EVENT, external_customer_id: auth.userId, metadata: { reads } }],
      });
      return { inserted: result.inserted };
    }),
  },
  endpoints: {
    status: endpoint({ method: "GET", path: "/api/status" }, () => text("ok")),
    checkout: endpoint(
      { method: "GET", path: "/api/polar/checkout" },
      polar.checkout({ products: [PRO_PRODUCT_ID], successUrl: "/billing", returnUrl: "/billing" }),
    ),
    portal: endpoint(
      { method: "GET", path: "/api/polar/portal" },
      polar.portal({ returnUrl: "/billing", noCustomerUrl: "/billing" }),
    ),
    sync: endpoint({ method: "POST", path: "/api/polar/sync" }, polar.sync()),
    webhooks: endpoint(
      { method: "POST", path: "/api/polar/webhooks" },
      polar.webhooks({
        onEvent: (event, { ctx }) => ctx.log.info("polar webhook", { type: event.type }),
        "order.paid": (event, { ctx }) =>
          ctx.log.info("order paid", { order: event.data.id, customer: event.data.customer.external_id }),
      }),
    ),
  },
});
