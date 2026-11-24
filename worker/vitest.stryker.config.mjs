// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** The suite as StrykerJS runs it (stryker.config.json): one isolate, kept between mutants, in the Workers runtime. */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // Instrumented, the hostile Markdown of markdown.test.ts passes vitest's five seconds.
    testTimeout: 60_000,
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    fsModuleCache: false,
  },
});
