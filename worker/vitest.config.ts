// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // Istanbul, which instruments the code: the Workers runtime has no V8 coverage.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      // Paths relative to the repository, as SonarCloud reads them.
      reporter: ["text-summary", ["lcovonly", { projectRoot: ".." }]],
    },
  },
});
