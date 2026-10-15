import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The examples import the package by name; point that at the source.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^spacefast-polar\/functions$/, replacement: source("./src/functions/index.ts") },
      { find: /^spacefast-polar$/, replacement: source("./src/core/index.ts") },
    ],
  },
});
