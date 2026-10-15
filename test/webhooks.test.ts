import { describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../src/core/errors.ts";
import { dispatchWebhook, verifyWebhook } from "../src/core/webhooks.ts";
import { customerState, LEGACY_SECRET, signWebhook, STANDARD_SECRET, stateChangedPayload } from "./fixtures.ts";

describe("verifyWebhook", () => {
  const body = stateChangedPayload(customerState());

  it("accepts Standard Webhooks signatures", async () => {
    const headers = signWebhook(body);
    const verified = await verifyWebhook(body, headers, STANDARD_SECRET);
    expect(verified.id).toBe(headers["webhook-id"]);
    expect(verified.event.type).toBe("customer.state_changed");
  });

  it("accepts legacy Polar HMAC signatures", async () => {
    const headers = signWebhook(body, { scheme: "legacy" });
    const verified = await verifyWebhook(body, headers, LEGACY_SECRET);
    expect(verified.event.type).toBe("customer.state_changed");
  });

  it("accepts a Fetch Headers object and a byte body", async () => {
    const headers = new Headers(signWebhook(body));
    const verified = await verifyWebhook(new TextEncoder().encode(body), headers, STANDARD_SECRET);
    expect(verified.event.type).toBe("customer.state_changed");
  });

  it("finds the matching signature among several", async () => {
    const headers = signWebhook(body);
    headers["webhook-signature"] = `v1,${Buffer.alloc(32).toString("base64")} v2,ignored ${headers["webhook-signature"]}`;
    await expect(verifyWebhook(body, headers, STANDARD_SECRET)).resolves.toBeTruthy();
  });

  it("rejects a tampered body", async () => {
    const headers = signWebhook(body);
    await expect(verifyWebhook(body.replace("Jane", "Mallory"), headers, STANDARD_SECRET)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects the wrong secret", async () => {
    const headers = signWebhook(body);
    await expect(verifyWebhook(body, headers, "whsec_d3Jvbmc=")).rejects.toThrow("No matching webhook signature");
  });

  it("rejects stale and future timestamps", async () => {
    const old = signWebhook(body, { at: new Date(Date.now() - 10 * 60_000) });
    await expect(verifyWebhook(body, old, STANDARD_SECRET)).rejects.toThrow("too old");
    const future = signWebhook(body, { at: new Date(Date.now() + 10 * 60_000) });
    await expect(verifyWebhook(body, future, STANDARD_SECRET)).rejects.toThrow("too new");
  });

  it("rejects missing headers and an empty secret", async () => {
    await expect(verifyWebhook(body, {}, STANDARD_SECRET)).rejects.toThrow("Missing");
    await expect(verifyWebhook(body, signWebhook(body), "")).rejects.toThrow("empty");
  });

  it("matches header names case-insensitively in plain objects", async () => {
    const headers = Object.fromEntries(Object.entries(signWebhook(body)).map(([key, value]) => [key.toUpperCase(), value]));
    await expect(verifyWebhook(body, headers, STANDARD_SECRET)).resolves.toBeTruthy();
  });
});

describe("dispatchWebhook", () => {
  it("runs the typed handler and onEvent", async () => {
    const seen: string[] = [];
    const event = JSON.parse(stateChangedPayload(customerState()));
    const handled = await dispatchWebhook(
      event,
      {
        "customer.state_changed": (payload, context: { tag: string }) => {
          seen.push(`${context.tag}:${payload.data.external_id}`);
        },
        onEvent: (payload) => {
          seen.push(`any:${payload.type}`);
        },
      },
      { tag: "ctx" },
    );
    expect(handled).toBe(true);
    expect(seen).toEqual(["ctx:user_1", "any:customer.state_changed"]);
  });

  it("reports when nothing handled the event", async () => {
    const event = JSON.parse(stateChangedPayload(customerState()));
    expect(await dispatchWebhook(event, { "order.paid": () => {} }, null)).toBe(false);
  });
});
