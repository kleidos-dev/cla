// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { Reporter, plugin } from "./test/tools/mcdc.mjs";

/** The whole suite once more with every condition instrumented: coverage/mcdc.json (test/tools/mcdc.mjs). */
export default defineConfig({
  plugins: [plugin(import.meta.dirname), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/tools/mcdc-setup.ts"],
    testTimeout: 60_000,
    // A transform left in the module cache by another configuration would not be instrumented.
    fsModuleCache: false,
    reporters: ["default", new Reporter(import.meta.dirname, `${import.meta.dirname}/coverage/mcdc.json`)],
  },
});
