#!/usr/bin/env node
// Vendors the Zero adapter into a capsule. Zero server code cannot import npm
// packages, so the TypeScript source is copied next to your server entry.

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

const USAGE = `spacefast-polar ${version}

Usage:
  spacefast-polar add zero [--dir server/polar] [--force]

Copies the Polar adapter for Spacefast Zero into your capsule. Run it from the
directory that holds sf.jsonc. Re-run with --force to update the copy.

Functions workers do not need this: npm install spacefast-polar and import
"spacefast-polar/functions".`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
};

function fail(message) {
  console.error(`spacefast-polar: ${message}`);
  process.exit(1);
}

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function addZero() {
  const target = resolve(option("--dir", "server/polar"));
  if (!(await exists("sf.jsonc"))) {
    console.warn("spacefast-polar: no sf.jsonc here; copying anyway.");
  }
  if (await exists(target)) {
    if (!flag("--force")) fail(`${relative(process.cwd(), target)} exists. Re-run with --force to replace it.`);
    await rm(target, { recursive: true });
  }

  await mkdir(target, { recursive: true });
  await cp(join(packageRoot, "src/core"), join(target, "core"), { recursive: true });
  await cp(join(packageRoot, "src/zero"), join(target, "zero"), { recursive: true });
  await writeFile(
    join(target, "index.ts"),
    `// Vendored from spacefast-polar@${version}. Update with: npx spacefast-polar add zero --force\nexport * from "./zero/index.ts";\n`,
  );

  const from = relative(join(process.cwd(), "server"), target).replaceAll("\\", "/");
  console.log(`Copied the Polar adapter to ${relative(process.cwd(), target)}.

Next, in server/index.ts:

  import { capsule, endpoint, query, string, table } from "@spacefast/zero/server";
  import { createPolar } from "./${from}/index.ts";

  const polar = createPolar();

  export default capsule({
    name: "my-app",
    schema: {
      // Zero reads the schema from this file's source, so write these out here.
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
    },
    endpoints: {
      checkout: endpoint({ method: "GET", path: "/api/polar/checkout" }, polar.checkout()),
      portal: endpoint({ method: "GET", path: "/api/polar/portal" }, polar.portal()),
      sync: endpoint({ method: "POST", path: "/api/polar/sync" }, polar.sync()),
      webhooks: endpoint({ method: "POST", path: "/api/polar/webhooks" }, polar.webhooks()),
    },
  });

Then set the secrets (server-only):

  sf env set POLAR_ACCESS_TOKEN --value-from-stdin
  sf env set POLAR_WEBHOOK_SECRET --value-from-stdin
  sf env set POLAR_SERVER sandbox --no-secret

Claim the space so it can reach api.polar.sh, and point a Polar webhook with
the customer.state_changed event at https://<your-space>/api/polar/webhooks.`);
}

const [command, subject] = args;
if (!command || flag("--help") || flag("-h")) {
  console.log(USAGE);
} else if (command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "add" && subject === "zero") {
  await addZero();
} else {
  console.error(USAGE);
  process.exit(1);
}
