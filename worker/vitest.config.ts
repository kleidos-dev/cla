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
    // Every property keeps its own seed (test/seed.ts); the weekly run moves them all with PROPERTY_SEED.
    provide: { propertySeed: Number(process.env.PROPERTY_SEED ?? 0) },
    // Istanbul, which instruments the code: the Workers runtime has no V8 coverage.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      // lcov with paths relative to the repository, as SonarCloud reads them, and what tests/tools/ratchet.py reads.
      reporter: ["text-summary", "json", ["lcovonly", { projectRoot: ".." }]],
      // Every statement, branch and function of every file of src/ (a file no test loads is counted at 0): what main
      // reaches. The ratchet (tests/tools/ratchet.py) adds the per-file counts, the conditions and the lists.
      thresholds: { statements: 99, branches: 99, functions: 100, lines: 99 },
    },
  },
});
