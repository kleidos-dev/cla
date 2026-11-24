// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // The hostile Markdown of markdown.test.ts reads a document at every cut: on a busy machine vitest's five seconds are not enough.
    testTimeout: 30_000,
    // Istanbul, which instruments the code: the Workers runtime has no V8 coverage.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      // lcov with paths relative to the repository, as SonarCloud reads them, and what tests/tools/ratchet.py reads.
      reporter: ["text-summary", "json", ["lcovonly", { projectRoot: ".." }]],
    },
  },
});
