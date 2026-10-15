/** Base class for every error this SDK throws. */
export class PolarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarError";
  }
}

/** The Polar API answered with a non-2xx status. */
export class PolarAPIError extends PolarError {
  readonly status: number;
  /** Parsed JSON body when the response had one, otherwise the raw text. */
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  /** Seconds from `Retry-After`, when Polar sent one (429s). */
  readonly retryAfter: number | null;

  constructor(init: { status: number; body: unknown; method: string; path: string; retryAfter: number | null }) {
    super(`Polar API ${init.method} ${init.path} failed with ${init.status}: ${describeBody(init.body)}`);
    this.name = "PolarAPIError";
    this.status = init.status;
    this.body = init.body;
    this.method = init.method;
    this.path = init.path;
    this.retryAfter = init.retryAfter;
  }

  /** The `error` field Polar puts on typed errors, such as `ResourceNotFound`. */
  get errorType(): string | null {
    const body = this.body as { error?: unknown } | null;
    return body && typeof body === "object" && typeof body.error === "string" ? body.error : null;
  }
}

/** The request never got an answer: network failure, DNS, or a runtime fetch limit. */
export class PolarConnectionError extends PolarError {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "PolarConnectionError";
    this.cause = cause;
  }
}

/** A webhook failed signature or timestamp verification. Answer it with 403. */
export class WebhookVerificationError extends PolarError {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const { detail, error } = body as { detail?: unknown; error?: unknown };
    if (typeof detail === "string") return error ? `${String(error)}: ${detail}` : detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item: { loc?: unknown[]; msg?: string }) => `${(item.loc ?? []).join(".")}: ${item.msg ?? "invalid"}`)
        .join("; ");
    }
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text && text.length > 300 ? `${text.slice(0, 300)}…` : String(text);
}
