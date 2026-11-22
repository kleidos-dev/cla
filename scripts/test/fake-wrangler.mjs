#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// A stand-in for wrangler in the test of create-github-app.ts: it appends
// its arguments and standard input to FAKE_WRANGLER_LOG (a file the test
// owns, outside the directories it scans) and fails for the secret named in
// FAKE_WRANGLER_FAIL.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args, input }) + "\n");
  if (args[0] === "whoami") process.exit(process.env.FAKE_WRANGLER_WHOAMI === "fail" ? 1 : 0);
  if (args[0] === "secret" && args[2] === process.env.FAKE_WRANGLER_FAIL) {
    console.error("fake wrangler: refused");
    process.exit(1);
  }
  console.log(`fake wrangler: stored ${args[2] ?? ""}`);
});
