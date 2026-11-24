// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The conditions of the area `scripts` (tests/floors/scripts.toml): runs the
 * given test files under mcdc-hook.mjs, merges what every process saw and
 * writes the report tests/tools/ratchet.py reads (`--conditions`): totals per
 * file and each condition without MC/DC. Exits 1 when a test fails.
 *
 *   node tests/tools/node/scripts-mcdc.mjs coverage/scripts-mcdc.json scripts/test/*.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { instrument, summarize } from "../../../worker/test/tools/mcdc.mjs";
import { MEASURED, ROOT } from "./mcdc-hook.mjs";

/** Every decision of the measured files, keyed as the instrumented code keys them. */
export function decisions() {
  const all = new Map();
  for (const file of MEASURED) for (const [k, d] of instrument(readFileSync(join(ROOT, file), "utf8").replace(/^#!.*/, ""), file).decisions) all.set(k, d);
  return all;
}

/** The vectors every process left in `dir`, merged per decision. */
export function merged(dir) {
  const seen = new Map();
  for (const f of readdirSync(dir)) {
    for (const [k, vectors] of Object.entries(JSON.parse(readFileSync(join(dir, f), "utf8")))) {
      const h = seen.get(k) ?? new Set();
      for (const v of vectors) h.add(v);
      seen.set(k, h);
    }
  }
  return seen;
}

/** The report, with each file as the repository names it (summarize() prefixes worker/ for the Worker's sources). */
export function report(seen) {
  const r = summarize(decisions(), seen);
  return { totals: r.totals, misses: r.misses.map((m) => ({ ...m, file: m.file.replace(/^worker\//, "") })) };
}

if (import.meta.main) {
  const [target, ...tests] = process.argv.slice(2);
  if (!target || tests.length === 0) {
    console.error("usage: scripts-mcdc.mjs <report.json> <test file>...");
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "cla-mcdc-"));
  const hook = `${pathToFileURL(join(dirname(new URL(import.meta.url).pathname), "mcdc-hook.mjs")).href}?out=${encodeURIComponent(dir)}`;
  const run = spawnSync(process.execPath, ["--import", hook, "--test", ...tests], { stdio: "inherit", cwd: ROOT });
  const r = report(merged(dir));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(resolve(target)), { recursive: true });
  writeFileSync(target, JSON.stringify(r, null, 1));
  const n = Object.values(r.totals).reduce((a, t) => ({ c: a.c + t.covered, all: a.all + t.conditions }), { c: 0, all: 0 });
  console.log(`MC/DC of the scripts: ${n.c} of ${n.all} conditions`);
  for (const m of r.misses) console.log(`  ${m.file}:${m.line} ${m.function}: ${m.text} (${m.why})`);
  process.exit(run.status === 0 ? 0 : 1);
}
