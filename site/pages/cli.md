---
title: CLI
description: The spacefast-polar command line - add zero vendors the adapter into a Zero capsule.
lead: The package ships one command, `spacefast-polar`. Run it with npx; nothing needs to be installed globally.
---

```text
spacefast-polar add zero [--dir server/polar] [--force]
spacefast-polar --version
spacefast-polar --help
```

## add zero

Copies the Polar adapter for Zero into your capsule. Zero server code can't import npm packages, so the TypeScript source lives next to your server entry instead.

```bash
npx spacefast-polar add zero
```

Run it from the directory that holds `sf.jsonc`. If there's no `sf.jsonc`, it warns and copies anyway. It writes:

```text
server/polar/
  index.ts    // Vendored from spacefast-polar@<version>. Update with: npx spacefast-polar add zero --force
  core/       the runtime-neutral client, webhooks, entitlements, and handlers
  zero/       createPolar for Zero
```

Then it prints a `server/index.ts` snippet and the `sf env set` commands to run next. The [Zero guide](zero.html) walks through both.

| Flag | Meaning |
| --- | --- |
| `--dir <path>` | Where to write the adapter. Defaults to `server/polar`. The printed import path follows it. |
| `--force` | Replace an existing copy. Without it, the command fails if the directory exists. |

To update after upgrading the package:

```bash
npx spacefast-polar add zero --force
```

`--force` deletes the directory first, so anything you changed inside it is lost.

## --version and --help

`--version` (or `-v`) prints the package version. `--help` (or `-h`), or no arguments, prints usage.
