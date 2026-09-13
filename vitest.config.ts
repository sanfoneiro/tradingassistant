import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest did not know about the `@/` alias.
 *
 * Everything under src/lib/ had been written with relative imports, so the
 * gap never showed — until a module imported `@/db` and its test failed to
 * load at all. A test that cannot import its subject fails loudly, which is
 * the good case; the bad one is that the alias silently limits which modules
 * are testable, and the answer to "why is there no test for this" becomes an
 * accident of import style rather than a decision.
 *
 * tsconfig.json already maps `@/*` to ./src/*. This says the same thing to
 * the test runner, in the only other place that resolves modules.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
