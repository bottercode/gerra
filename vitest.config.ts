import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against core's sources so `pnpm test` doesn't depend on a prior build.
    alias: { "@gerra/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: { include: ["packages/*/src/**/*.test.ts"] },
});
