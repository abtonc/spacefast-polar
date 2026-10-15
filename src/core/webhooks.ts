import { base64Decode, timingSafeEqual, utf8Decode, utf8Encode } from "./encoding.ts";
import { PolarError, WebhookVerificationError } from "./errors.ts";
import type { WebhookPayloadMap } from "./generated.ts";
import { hmacSha256 } from "./hmac.ts";

export type WebhookEventType = keyof WebhookPayloadMap;
export type WebhookEvent = WebhookPayloadMap[WebhookEventType];
export type WebhookEventOf<T extends WebhookEventType> = WebhookPayloadMap[T];

/** Anything header-shaped: a Fetch `Headers`, Zero's request headers, or a plain object. */
export type WebhookHeaders =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export type VerifyWebhookOptions = {
  /** How far `webhook-timestamp` may drift from now. Defaults to 300 seconds. */
  toleranceSeconds?: number;
  /** Current time in milliseconds, for tests. */
  now?: () => number;
};

export type VerifiedWebhook = {
  /** The `webhook-id` header. Stable across redeliveries, so use it to deduplicate. */
  id: string;
  /** The `webhook-timestamp` header, in Unix seconds. */
  timestamp: number;
  event: WebhookEvent;
};

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Polar webhook and parses its payload.
 *
 * Pass the raw request body, before any JSON parsing, and the `whsec_…` secret
 * from the Polar dashboard. Both of Polar's signing schemes are accepted:
 * legacy secrets (created before 8 September 2026) sign with the UTF-8 bytes of
 * the whole secret, newer Standard Webhooks secrets with its base64-decoded
 * remainder.
 *
 * Throws `WebhookVerificationError` when the signature or timestamp is wrong.
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<VerifiedWebhook> {
  if (!secret) throw new WebhookVerificationError("Webhook secret is empty");
  const header = headerReader(headers);
  const id = header("webhook-id");
  const timestampHeader = header("webhook-timestamp");
  const signatureHeader = header("webhook-signature");
  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp, or webhook-signature header");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) throw new WebhookVerificationError("Invalid webhook-timestamp header");
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = (options.now ?? Date.now)() / 1000;
  if (timestamp < now - tolerance) throw new WebhookVerificationError("Webhook timestamp is too old");
  if (timestamp > now + tolerance) throw new WebhookVerificationError("Webhook timestamp is too new");

  const bodyText = typeof body === "string" ? body : utf8Decode(body);
  const signedContent = utf8Encode(`${id}.${Math.floor(timestamp)}.${bodyText}`);

  const candidates: Uint8Array[] = [];
  for (const entry of signatureHeader.split(" ")) {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature) continue;
    const decoded = base64Decode(signature);
    if (decoded && decoded.length === 32) candidates.push(decoded);
  }
  if (candidates.length === 0) throw new WebhookVerificationError("No v1 signature in webhook-signature header");

  let verified = false;
  for (const key of signingKeys(secret)) {
    const expected = await hmacSha256(key, signedContent);
    for (const candidate of candidates) {
      if (timingSafeEqual(expected, candidate)) verified = true;
    }
    if (verified) break;
  }
  if (!verified) throw new WebhookVerificationError("No matching webhook signature");

  let event: unknown;
  try {
    event = JSON.parse(bodyText);
  } catch {
    throw new PolarError("Webhook payload is not valid JSON");
  }
  if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
    throw new PolarError("Webhook payload has no event type");
  }
  return { id, timestamp, event: event as WebhookEvent };
}

/** The keys Polar may have signed with, legacy first, matching Polar's own SDK. */
function signingKeys(secret: string): Uint8Array[] {
  const utf8Key = utf8Encode(secret);
  const keys = [utf8Key];
  const decoded = base64Decode(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
  if (decoded && decoded.length > 0 && !timingSafeEqual(decoded, utf8Key)) keys.push(decoded);
  return keys;
}

export function headerReader(headers: WebhookHeaders): (name: string) => string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const source = headers as { get(name: string): string | null };
    return (name) => source.get(name);
  }
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (value === undefined) continue;
    lowered[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return (name) => lowered[name.toLowerCase()] ?? null;
}

export type WebhookHandlerMap<C> = {
  [K in WebhookEventType]?: (event: WebhookEventOf<K>, context: C) => unknown;
};

/**
 * Runs the handler registered for `event.type`, if any, then `onEvent`.
 * Returns true when at least one handler ran.
 */
export async function dispatchWebhook<C>(
  event: WebhookEvent,
  handlers: WebhookHandlerMap<C> & { onEvent?: (event: WebhookEvent, context: C) => unknown },
  context: C,
): Promise<boolean> {
  const handler = handlers[event.type] as ((event: WebhookEvent, context: C) => unknown) | undefined;
  if (handler) await handler(event, context);
  if (handlers.onEvent) await handlers.onEvent(event, context);
  return Boolean(handler || handlers.onEvent);
}
