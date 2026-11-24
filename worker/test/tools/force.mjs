// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The forced conditions: every atomic condition of the given src files held
 * true, then held false, and the tests that evaluate it run. MC/DC says that
 * a test made a condition decide; this says that a test noticed.
 *
 *   node test/tools/force.mjs [--out FILE] src/assess.ts src/bot.ts ...
 *
 * One build serves every mutant: the forcing is the MC/DC instrumentation's
 * own hook (mcdc.mjs), chosen at run time, inside the Workers runtime. Ends
 * with status 1 when one survives. The result is coverage/force.json, as
 * tests/tools/ratchet.py reads it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { createVitest } from "vitest/node";
import { decisionsOf, plugin } from "./mcdc.mjs";

const root = join(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at < 0 ? join(root, "coverage", "force.json") : args.splice(at, 2)[1];
const decisions = decisionsOf(root);
for (const f of args) if (![...decisions.values()].some((d) => d.file === f)) throw new Error(`no decision in ${f}`);

const vitest = await createVitest(
  "test",
  {
    config: false,
    root,
    watch: false,
    bail: 1,
    reporters: [{ onTestRunEnd: () => undefined }],
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/tools/mcdc-setup.ts"],
    testTimeout: 60_000,
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    fsModuleCache: false,
  },
  { plugins: [plugin(root), cloudflareTest({ wrangler: { configPath: join(root, "wrangler.jsonc") } })] },
);

/** Runs the files (all of them when not given) whose tests match, with one condition held. */
async function run(force, files, pattern) {
  vitest.state.filesMap.clear();
  vitest.provide("force", force);
  for (const p of vitest.projects) p.config.testNamePattern = pattern;
  const specs = (await vitest.globTestSpecifications()).filter((s) => !files || files.has(s.moduleId));
  return vitest.runTestSpecifications(specs);
}
const testsOf = (result) => result.testModules.flatMap((m) => [...m.children.allTests()]);
const state = (t) => t.result().state;

const started = Date.now();
const base = await run(null);
if (base.testModules.length === 0 || base.testModules.some((m) => !m.ok())) throw new Error("the suite does not pass unforced");
/** decision -> the files and the names of the tests that evaluate it. */
const reached = new Map();
for (const m of base.testModules) {
  for (const [key, names] of Object.entries(m.meta().reached ?? {})) {
    const r = reached.get(key) ?? { files: new Set(), names: new Set() };
    r.files.add(m.moduleId);
    for (const n of names) r.names.add(n);
    reached.set(key, r);
  }
}

const mutants = [...decisions]
  .filter(([, d]) => args.length === 0 || args.includes(d.file))
  .flatMap(([key, d]) => d.atoms.flatMap((text, index) => [true, false].map((value) => ({ key, index, value, text, d }))));
const result = { total: mutants.length, killed: 0, misses: [] };
for (const [n, { key, index, value, text, d }] of mutants.entries()) {
  const miss = (why) => result.misses.push({ kind: "forced", file: `worker/${d.file}`, function: d.function, text, on: d.text === text ? "" : d.text, operator: String(value), line: d.line, why });
  const r = reached.get(key);
  if (!r) {
    miss("no test evaluates it");
    continue;
  }
  const names = [...r.names].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const ran = await run({ key, index, value }, r.files, new RegExp(`(?:${names.join("|")})$`));
  const failed = testsOf(ran).some((t) => state(t) === "failed") || ran.testModules.some((m) => m.errors().length > 0);
  if (failed) result.killed++;
  else if (!testsOf(ran).some((t) => state(t) === "passed")) miss("no test ran");
  else miss("survived");
  if ((n + 1) % 50 === 0) console.log(`${n + 1} of ${mutants.length}, ${result.misses.length} missed, ${Math.round((Date.now() - started) / 1000)} s`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`forced conditions: ${result.killed} of ${result.total} killed`);
for (const m of result.misses) console.log(`${m.file}:${m.line} ${m.text} := ${m.operator}: ${m.why}`);
await vitest.close();
process.exitCode = result.misses.length > 0 ? 1 : 0;
