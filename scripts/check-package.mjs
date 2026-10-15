// Checks the tarball `npm publish` would upload: packs it, unpacks it into a
// scratch consumer, and uses it the way an installer would. Run after build.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const scratch = await mkdtemp(join(tmpdir(), "spacefast-polar-pack-"));
const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) problems.push(message);
};
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch], root));
  const files = packed.files.map((file) => file.path);
  console.log(`Packed ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} kB\n`);

  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "bin/spacefast-polar.js",
    "dist/core/index.js",
    "dist/core/index.d.ts",
    "dist/functions/index.js",
    "dist/functions/index.d.ts",
    "src/core/index.ts",
    "src/zero/index.ts",
  ]) {
    check(files.includes(required), `ships ${required}`);
  }
  const unwanted = files.filter((file) => /^(test|examples|site|scripts)\/|(^|\/)\.env|\.tgz$/.test(file));
  check(unwanted.length === 0, `ships no tests, examples, site, scripts, or env files${unwanted.length ? `: ${unwanted.join(", ")}` : ""}`);

  // Unpack into node_modules of a scratch consumer.
  const consumer = join(scratch, "consumer");
  const installed = join(consumer, "node_modules", "spacefast-polar");
  await mkdir(installed, { recursive: true });
  run("tar", ["-xzf", join(scratch, packed.filename), "-C", installed, "--strip-components=1"], scratch);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));

  const probe = `
    const core = await import("spacefast-polar");
    const functions = await import("spacefast-polar/functions");
    const pkg = (await import("spacefast-polar/package.json", { with: { type: "json" } })).default;
    console.log(JSON.stringify({
      core: ["createPolarClient", "verifyWebhook", "paginate", "hasActiveSubscription", "hasBenefit", "PolarAPIError"].filter((name) => !(name in core)),
      functions: ["createPolar", "createD1Store"].filter((name) => !(name in functions)),
      version: pkg.version,
    }));
  `;
  const exported = JSON.parse(run(process.execPath, ["--input-type=module", "-e", probe], consumer));
  check(exported.core.length === 0, `"spacefast-polar" exports the core API${exported.core.length ? `; missing ${exported.core}` : ""}`);
  check(exported.functions.length === 0, `"spacefast-polar/functions" exports the adapter${exported.functions.length ? `; missing ${exported.functions}` : ""}`);
  check(exported.version === version, `"spacefast-polar/package.json" resolves (${exported.version})`);

  // Types resolve through the exports map under Node's own resolution.
  await writeFile(
    join(consumer, "index.ts"),
    `import { createPolarClient, hasActiveSubscription, type PolarEntitlements } from "spacefast-polar";
import { createPolar } from "spacefast-polar/functions";
const client = createPolarClient({ accessToken: "x", server: "sandbox" });
const polar = createPolar();
const entitlements: PolarEntitlements | null = null;
export const ok: boolean = Boolean(client && polar.webhooks) && (entitlements ? hasActiveSubscription(entitlements, "p") : false);
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, noEmit: true, lib: ["es2022", "dom"], types: [] },
      files: ["index.ts"],
    }),
  );
  const tsc = join(root, "node_modules", ".bin", "tsc");
  let typeErrors = "";
  try {
    run(tsc, ["-p", "tsconfig.json"], consumer);
  } catch (error) {
    typeErrors = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  }
  check(typeErrors === "", `types resolve under moduleResolution nodenext${typeErrors ? `\n${typeErrors}` : ""}`);

  // The CLI runs from the packed copy and vendors from it.
  const cli = join(installed, "bin", "spacefast-polar.js");
  check(run(process.execPath, [cli, "--version"], consumer).trim() === version, "spacefast-polar --version");
  const capsule = join(scratch, "capsule");
  await mkdir(capsule);
  await writeFile(join(capsule, "sf.jsonc"), "{}");
  run(process.execPath, [cli, "add", "zero"], capsule);
  const vendored = ["server/polar/index.ts", "server/polar/zero/index.ts", "server/polar/core/client.ts"];
  check(
    vendored.every((file) => existsSync(join(capsule, file))),
    "spacefast-polar add zero vendors the adapter from the package",
  );
  const header = await readFile(join(capsule, "server/polar/index.ts"), "utf8");
  check(header.includes(`spacefast-polar@${version}`), "the vendored copy records the package version");

  // A bin link is how npx runs it.
  const binDir = join(consumer, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await symlink(cli, join(binDir, "spacefast-polar"));
  check(run(join(binDir, "spacefast-polar"), ["--help"], consumer).includes("add zero"), "the bin runs through a symlink");
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n${problems.length} package check${problems.length === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("\nPackage looks ready to publish.");
