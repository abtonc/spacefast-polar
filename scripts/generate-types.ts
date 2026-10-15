/**
 * Generates src/core/generated.ts from Polar's OpenAPI document.
 *
 *   node scripts/generate-types.ts            # downloads the pinned spec
 *   node scripts/generate-types.ts spec.json  # uses a local copy
 *
 * Only the schemas the SDK touches are emitted, plus everything they reference,
 * so the output stays readable and small enough to vendor into a Zero capsule.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API_VERSION = "2026-10";
const SPEC_URL = `https://polar.sh/docs/openapi/${API_VERSION}.openapi.json`;
const OUTPUT = fileURLToPath(new URL("../src/core/generated.ts", import.meta.url));

const ROOTS = [
  "Benefit",
  "Checkout",
  "CheckoutCreate",
  "CheckoutLink",
  "CheckoutLinkCreate",
  "Customer",
  "CustomerCreate",
  "CustomerSession",
  "CustomerSessionCustomerExternalIDCreate",
  "CustomerSessionCustomerIDCreate",
  "CustomerState",
  "CustomerUpdate",
  "CustomerUpdateExternalID",
  "EventsIngest",
  "EventsIngestResponse",
  "HTTPValidationError",
  "LicenseKeyActivate",
  "LicenseKeyActivationCreated",
  "LicenseKeyDeactivate",
  "LicenseKeyValidate",
  "Order",
  "OrderStatus",
  "Product",
  "Refund",
  "RefundCreate",
  "Subscription",
  "SubscriptionStatus",
  "SubscriptionUpdate",
  "ValidatedLicenseKey",
];

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  deprecated?: boolean;
};

type Spec = {
  info: { version: string };
  components: { schemas: Record<string, JsonSchema> };
  webhooks: Record<string, { post: { requestBody: { content: { "application/json": { schema: JsonSchema } } } } }>;
};

const spec: Spec = JSON.parse(
  process.argv[2] ? await readFile(process.argv[2], "utf8") : await (await fetch(SPEC_URL)).text(),
);
if (spec.info.version !== API_VERSION) {
  throw new Error(`Expected spec version ${API_VERSION}, got ${spec.info.version}`);
}
const schemas = spec.components.schemas;

const webhookTypes = Object.entries(spec.webhooks).map(([type, item]) => {
  const ref = item.post.requestBody.content["application/json"].schema.$ref;
  if (!ref) throw new Error(`Webhook ${type} has no $ref payload`);
  return { type, schema: refName(ref) };
});

function refName(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

function typeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

// Collect every schema reachable from the roots and the webhook payloads.
const included = new Set<string>();
function visit(schema: JsonSchema | boolean | undefined): void {
  if (!schema || typeof schema === "boolean") return;
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (included.has(name)) return;
    if (!schemas[name]) throw new Error(`Unknown schema ${name}`);
    included.add(name);
    visit(schemas[name]);
    return;
  }
  for (const child of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) visit(child);
  visit(schema.items);
  for (const child of Object.values(schema.properties ?? {})) visit(child);
  visit(schema.additionalProperties);
}
for (const root of [...ROOTS, ...webhookTypes.map((w) => w.schema)]) {
  visit({ $ref: `#/components/schemas/${root}` });
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function render(schema: JsonSchema | boolean | undefined, indent: string): string {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";
  if (schema.$ref) return typeName(refName(schema.$ref));
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf || schema.oneOf) return union((schema.anyOf ?? schema.oneOf)!.map((s) => render(s, indent)));
  if (schema.allOf) return schema.allOf.map((s) => wrap(render(s, indent))).join(" & ");
  if (Array.isArray(schema.type)) {
    return union(schema.type.map((type) => render({ ...schema, type }, indent)));
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${render(schema.items, indent)}>`;
    case "object":
    case undefined:
      if (schema.properties) return renderObject(schema, indent);
      if (schema.type === "object" || schema.additionalProperties !== undefined) {
        return `Record<string, ${render(schema.additionalProperties, indent)}>`;
      }
      return "unknown";
    default:
      throw new Error(`Unhandled schema type ${String(schema.type)}`);
  }
}

function renderObject(schema: JsonSchema, indent: string): string {
  if (Object.keys(schema.properties ?? {}).length === 0) {
    return schema.additionalProperties ? `Record<string, ${render(schema.additionalProperties, indent)}>` : "Record<string, never>";
  }
  const inner = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    return `${doc(value, inner)}${inner}${name}${required.has(key) ? "" : "?"}: ${render(value, inner)};`;
  });
  if (schema.additionalProperties && schema.additionalProperties !== true) {
    lines.push(`${inner}[key: string]: unknown;`);
  }
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  return unique.length === 1 ? unique[0]! : unique.map(wrap).join(" | ");
}

function wrap(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

function doc(schema: JsonSchema, indent: string): string {
  const description = schema.description?.trim();
  const lines: string[] = [];
  if (description) lines.push(...description.split("\n"));
  if (schema.deprecated) lines.push("@deprecated");
  if (lines.length === 0) return "";
  // Keep "*/" inside descriptions from closing the comment early.
  const escaped = lines.map((line) => line.replaceAll("*/", "*\\/"));
  if (escaped.length === 1) return `${indent}/** ${escaped[0]} */\n`;
  const body = escaped.map((line) => `${indent} *${line ? ` ${line}` : ""}`);
  return `${indent}/**\n${body.join("\n")}\n${indent} */\n`;
}

const out: string[] = [
  "// Generated by scripts/generate-types.ts. Do not edit.",
  `// Source: Polar OpenAPI ${API_VERSION} (${SPEC_URL})`,
  "",
  `export const POLAR_API_VERSION = ${JSON.stringify(API_VERSION)};`,
  "",
];

for (const name of [...included].sort()) {
  const schema = schemas[name]!;
  out.push(`${doc(schema, "")}export type ${typeName(name)} = ${render(schema, "")};`, "");
}

out.push(
  "/** Every webhook event type Polar sends for this API version. */",
  `export const WEBHOOK_EVENT_TYPES = [\n${webhookTypes.map((w) => `  ${JSON.stringify(w.type)},`).join("\n")}\n] as const;`,
  "",
  "/** Maps a webhook event type to its payload. */",
  `export type WebhookPayloadMap = {\n${webhookTypes.map((w) => `  ${JSON.stringify(w.type)}: ${typeName(w.schema)};`).join("\n")}\n};`,
  "",
);

await writeFile(OUTPUT, out.join("\n"));
console.log(`Wrote ${included.size} schemas and ${webhookTypes.length} webhook events to ${OUTPUT}`);
