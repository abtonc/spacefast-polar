// POST /api/polar/webhooks: point a Polar webhook (raw format, with at least
// customer.state_changed) here. Entitlements are stored before handlers run.
import { polar } from "../../_polar";

export const POST = polar.webhooks({
  "order.paid": (event) => {
    console.log("order paid", { order: event.data.id, customer: event.data.customer.external_id });
  },
  "subscription.canceled": (event) => {
    console.log("subscription canceled", { subscription: event.data.id, endsAt: event.data.ends_at });
  },
});
