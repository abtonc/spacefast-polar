import { createHmac } from "node:crypto";
import { Webhook } from "standardwebhooks";
import type { CustomerState } from "../src/core/generated.ts";

/** A Standard Webhooks secret, as Polar issues them since September 2026. */
export const STANDARD_SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXNwYWNlZmFzdC1wb2xhcg==";
/** A legacy Polar secret: the HMAC key is the UTF-8 of the whole string. */
export const LEGACY_SECRET = "whsec_legacy-polar-secret-not-base64!";

export function customerState(overrides: Partial<CustomerState> = {}): CustomerState {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-10-01T00:00:00Z",
    modified_at: null,
    metadata: {},
    external_id: "user_1",
    email: "jane@example.com",
    email_verified: true,
    type: "individual",
    name: "Jane",
    billing_name: null,
    billing_address: null,
    tax_id: null,
    organization_id: "22222222-2222-4222-8222-222222222222",
    deleted_at: null,
    first_user_event_at: null,
    avatar_url: null,
    active_subscriptions: [
      {
        id: "sub_1",
        created_at: "2026-10-01T00:00:00Z",
        modified_at: null,
        metadata: {},
        status: "active",
        amount: 1000,
        currency: "usd",
        recurring_interval: "month",
        current_period_start: "2026-10-01T00:00:00Z",
        current_period_end: "2026-11-01T00:00:00Z",
        trial_start: null,
        trial_end: null,
        cancel_at_period_end: false,
        canceled_at: null,
        started_at: "2026-10-01T00:00:00Z",
        ends_at: null,
        product_id: "prod_pro",
        discount_id: null,
        seats: null,
        units: null,
        meters: [],
      },
    ],
    granted_benefits: [
      {
        id: "grant_1",
        created_at: "2026-10-01T00:00:00Z",
        modified_at: null,
        granted_at: "2026-10-01T00:00:00Z",
        benefit_id: "ben_export",
        benefit_type: "feature_flag",
        benefit_metadata: { feature: "export" },
        properties: {},
      },
    ],
    active_meters: [
      {
        id: "cm_1",
        created_at: "2026-10-01T00:00:00Z",
        modified_at: null,
        meter_id: "meter_tokens",
        consumed_units: 25,
        credited_units: 100,
        balance: 75,
      },
    ],
    ...overrides,
  } as CustomerState;
}

export function stateChangedPayload(state: CustomerState, timestamp = new Date().toISOString()): string {
  return JSON.stringify({ type: "customer.state_changed", timestamp, api_version: "2026-10", data: state });
}

let counter = 0;

/** Signs like Polar does, with either scheme. */
export function signWebhook(
  body: string,
  options: { secret?: string; scheme?: "standard" | "legacy"; id?: string; at?: Date } = {},
): Record<string, string> {
  const id = options.id ?? `msg_${++counter}_${Date.now()}`;
  const at = options.at ?? new Date();
  const seconds = Math.floor(at.getTime() / 1000);
  if (options.scheme === "legacy") {
    const secret = options.secret ?? LEGACY_SECRET;
    const signature = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${seconds}.${body}`).digest("base64");
    return { "webhook-id": id, "webhook-timestamp": String(seconds), "webhook-signature": `v1,${signature}` };
  }
  const signature = new Webhook(options.secret ?? STANDARD_SECRET).sign(id, at, body);
  return { "webhook-id": id, "webhook-timestamp": String(seconds), "webhook-signature": signature };
}

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a queue and records what it was asked. */
export function mockFetch(...responses: Array<Response | (() => Response) | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected fetch: ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
