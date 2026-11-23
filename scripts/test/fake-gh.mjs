#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 José M. Requena Plens <jmrplens@kleidos.dev>
// SPDX-License-Identifier: MIT
// A stand-in for the gh CLI in the test of create-signin-app.ts: it appends
// its arguments and standard input to FAKE_GH_LOG, answers the calls the
// script makes (admin permission from FAKE_GH_ADMIN, the deployment branch
// policies from FAKE_GH_POLICIES), and fails `secret set` when FAKE_GH_FAIL
// is "secret" (echoing the value, as a careless tool might).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input }) + "\n");
  const path = args.find((a) => a.startsWith("repos/")) ?? "";
  if (args[0] === "api" && path === "repos/kleidos-dev/cla") {
    console.log(process.env.FAKE_GH_ADMIN ?? "true");
    process.exit(0);
  }
  if (args[0] === "api" && path.endsWith("/deployment-branch-policies") && !args.includes("-X")) {
    console.log(process.env.FAKE_GH_POLICIES ?? "");
    process.exit(0);
  }
  if (args[0] === "api") process.exit(0);
  if (args[0] === "secret" && args[1] === "set") {
    if (process.env.FAKE_GH_FAIL === "secret") {
      console.error(`fake gh: refused ${input}`);
      process.exit(1);
    }
    console.log("fake gh: stored");
    process.exit(0);
  }
  process.exit(9);
});
