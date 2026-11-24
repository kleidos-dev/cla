// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The mutants of the area `scripts`, which StrykerJS cannot run: its
 * runners pick the mutant by an environment variable, and these tests hand
 * the processes they start an environment of their own. So Stryker's own
 * instrumenter makes the mutants, and this driver writes each one over its
 * file in a throwaway copy of the files the tests read, runs the file's own
 * tests with `node --test` and stops them at the first failure: killed. A
 * run that passes every test the unmutated file passes is a survivor; one
 * that ends early with fewer (a mutant that exits the process on import)
 * is killed; one past the time limit is killed by timeout (reported apart);
 * and a mutant whose module does not load is a compile error, never a kill. The report has Stryker's shape, which
 * tests/tools/ratchet.py reads with `--mutants`.
 *
 *   node tests/tools/node/scripts-mut.mjs --out coverage/scripts-mutation.json \
 *     [--workers 2] [--timeout 60] [--files worker/scripts/check-agreement.mjs] \
 *     [--since <revision>] [--max 120] [--tests-max 60] [--seed 1]
 *
 * Run it under the memory guard; two workers at most on a developer's
 * machine. `--since` keeps the mutants of the lines changed since a
 * revision; `--max` a seeded sample of that many, with a notice. With
 * `--tests-max`, a change since that revision to the tests or to what they
 * run under (TESTED_BY) adds a seeded sample of at most that many mutants
 * of the files those tests are for (`testedFiles`): a test that checks less
 * kills fewer mutants and runs the same lines.
 * `--recheck <report>` runs each mutant of a report that was killed by
 * timeout once more with three times the limits, alone, and writes what it
 * then is: a loaded machine slows a whole run past a limit.
 * `--listed <report>` fails on a mutant of the report that no test killed
 * and tests/exclusions/scripts.toml does not list (ratchet.py's own reading
 * of both), for a run of some lines, which no floor can hold.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { MEASURED, ROOT } from "./mcdc-hook.mjs";

// The instrumenter is a development dependency of worker/, where the lockfile pins it.
const { Instrumenter } = await import(pathToFileURL(createRequire(join(ROOT, "worker", "package.json")).resolve("@stryker-mutator/instrumenter")).href);

/** Each measured file and the tests that are its own. */
export const TESTS = {
  "scripts/create-github-app.ts": ["scripts/test/create-github-app.test.ts"],
  "scripts/create-signin-app.ts": ["scripts/test/create-signin-app.test.ts"],
  "worker/scripts/check-agreement.mjs": ["scripts/test/check-agreement.test.ts"],
};

/** How long one test may take under a mutant: the slowest test of the suite takes about 2 s on a loaded machine. */
const TEST_LIMIT_MS = 20_000;

/** What a copy needs for those tests to run: the files they import or read. */
const COPIED = ["scripts", "tests/tools/node", "worker/scripts", "worker/src", "worker/test/tools", "registry/config.json", "agreements"];

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, isTraceEnabled: () => false, isDebugEnabled: () => false, isInfoEnabled: () => false, isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false };

/** Every mutant Stryker's instrumenter makes of a file, with 0-based lines and columns. */
export async function mutantsOf(file, content = readFileSync(join(ROOT, file), "utf8")) {
  const { mutants } = await new Instrumenter(quiet).instrument([{ name: file, content, mutate: true }], { plugins: null, excludedMutations: [], ignorers: [], noHeader: true });
  return mutants.map((m) => ({ id: m.id, mutatorName: m.mutatorName, replacement: m.replacement, location: m.location }));
}

/** The source with one mutant written in its place. */
export function apply(source, m) {
  const lines = source.split("\n");
  const offset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.column;
  return source.slice(0, offset(m.location.start)) + m.replacement + source.slice(offset(m.location.end));
}

/** The lines (from 1) of each measured file that changed since a revision, by git's own diff. */
export function changedLines(since) {
  const out = new Map();
  for (const file of MEASURED) {
    const diff = spawnSync("git", ["diff", "--unified=0", since, "--", file], { cwd: ROOT, encoding: "utf8" }).stdout;
    const lines = new Set();
    for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(m[1]);
      for (let i = 0; i < Number(m[2] ?? 1); i++) lines.add(start + i);
    }
    out.set(file, lines);
  }
  return out;
}

/** What the tests of the area run under besides their own files: a change to any of these is a change to every test. */
export const TESTED_BY = ["scripts/test", "tests/tools/node", "scripts/tsconfig.json", "worker/package.json", "worker/package-lock.json"];

/**
 * The measured files whose tests a change since a revision touches, in tiers sampled in turn: the files of the
 * changed test files first (TESTS), then, when anything else the tests run under changed too, every other
 * file, so that a helper touched beside a weakened test file does not spread the sample thin.
 */
export function testedFiles(changed) {
  const named = new Set();
  let all = false;
  for (const path of changed) {
    const of = MEASURED.filter((f) => TESTS[f].includes(path));
    if (of.length === 0) all = true;
    for (const f of of) named.add(f);
  }
  const first = MEASURED.filter((f) => named.has(f));
  return [first, all ? MEASURED.filter((f) => !named.has(f)) : []].filter((tier) => tier.length > 0);
}

/** The paths of the tests and of what they run under that changed since a revision, by git's own diff. */
export function changedTests(since) {
  const r = spawnSync("git", ["diff", "--name-only", "--no-renames", since, "--", ...TESTED_BY], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

/** A sample of `n` drawn by a seeded generator, in the original order. */
export function sample(items, n, seed) {
  if (items.length <= n) return items;
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const picked = new Set();
  while (picked.size < n) picked.add(Math.floor(next() * items.length));
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
}

/** Exit code of a module that could not be loaded at all (a syntax error): no module of the area exits with it. */
const LOAD_FAILED = 97;

/**
 * Whether a mutated module still loads: a mutant that breaks the module is no kill. A module that loads
 * and then ends the process (a mutated `import.meta.main`) does load: its tests will find out.
 */
export function loads(copy, file) {
  const url = JSON.stringify(pathToFileURL(join(copy, file)).href);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `try { await import(${url}); } catch (e) { if (e instanceof SyntaxError || e?.code === "ERR_MODULE_NOT_FOUND") process.exit(${LOAD_FAILED}); }`], { cwd: copy, encoding: "utf8", timeout: 30_000 });
  return r.status !== LOAD_FAILED;
}

/**
 * Runs the tests of a file in a copy: Killed at the first failure or when fewer than `expected` pass,
 * Survived when all of them pass, Timeout past the limit. Also says how many passed.
 */
export function verdict(copy, tests, limitMs, expected = 0, testLimitMs = TEST_LIMIT_MS) {
  return new Promise((resolveVerdict) => {
    // A mutant that makes a test wait forever is stopped by the runner's own limit per test, well inside the mutant's.
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", `--test-timeout=${testLimitMs}`, ...tests], { cwd: copy, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let settled = false;
    let text = "";
    const end = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone already.
      }
      const passed = Number(/^# pass (\d+)$/m.exec(text)?.[1] ?? 0);
      resolveVerdict({ status: status === "Survived" && passed < expected ? "Killed" : status, passed });
    };
    const timer = setTimeout(() => end("Timeout"), limitMs);
    child.stdout.on("data", (d) => {
      text += d;
      // The first failure ends the run once its YAML block (which says whether it timed out) is complete.
      const failure = /^( *)not ok [^\n]*\n\1 {2}---\n([\s\S]*?)\n\1 {2}\.\.\.\n/m.exec(text);
      if (failure) end(/failureType: 'testTimeoutFailure'/.test(failure[2]) ? "Timeout" : "Killed");
    });
    child.on("close", (code) => end(code === 0 ? "Survived" : "Killed"));
  });
}

function copyTree() {
  const copy = mkdtempSync(join(tmpdir(), "cla-mut-"));
  for (const p of COPIED) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
  return copy;
}

/** Runs every mutant of `files` on `workers` copies; the report, in Stryker's shape. */
export async function campaign({ files = MEASURED, workers = 2, limitMs = 60_000, lines = null, max = Infinity, seed = 1, tested = [], testsMax = 0, log = () => undefined } = {}) {
  const jobs = [];
  const others = [];
  const report = { schemaVersion: "2", thresholds: { high: 100, low: 100 }, files: {} };
  for (const file of new Set([...files, ...tested.flat()])) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const all = await mutantsOf(file, source);
    report.files[file] = { language: file.endsWith(".ts") ? "typescript" : "javascript", source, mutants: [] };
    for (const m of all) {
      const at = m.location.start.line + 1;
      if (files.includes(file) && !(lines && !lines.get(file)?.has(at))) jobs.push({ file, source, m });
      else if (tested.flat().includes(file)) others.push({ file, source, m });
    }
  }
  const chosen = sample(jobs, max, seed);
  if (chosen.length < jobs.length) log(`notice: ${chosen.length} of ${jobs.length} mutants, a sample by seed ${seed}`);
  let budget = testsMax;
  for (const tier of tested) {
    const pool = others.filter((j) => tier.includes(j.file));
    const more = sample(pool, Math.min(budget, pool.length), seed);
    if (more.length > 0) log(`notice: ${more.length} of the ${pool.length} other mutants of ${tier.join(", ")}, for the changed tests, a sample by seed ${seed}`);
    chosen.push(...more);
    budget -= more.length;
  }
  const copies = Array.from({ length: Math.max(1, Math.min(workers, chosen.length)) }, copyTree);
  // The unmutated tests must pass in a copy, and their count is what a survivor must reach.
  const expected = {};
  for (const file of new Set(chosen.map((j) => j.file))) {
    const base = await verdict(copies[0], TESTS[file], limitMs * 5);
    if (base.status !== "Survived" || base.passed === 0) {
      for (const c of copies) rmSync(c, { recursive: true, force: true });
      throw new Error(`the tests of ${file} do not pass unmutated in a copy (${base.status}, ${base.passed} passed)`);
    }
    expected[file] = base.passed;
  }
  let next = 0;
  let done = 0;
  const runOne = async (copy) => {
    while (next < chosen.length) {
      const { file, source, m } = chosen[next++];
      const started = Date.now();
      writeFileSync(join(copy, file), apply(source, m));
      const status = loads(copy, file) ? (await verdict(copy, TESTS[file], limitMs, expected[file])).status : "CompileError";
      writeFileSync(join(copy, file), source);
      const loc = m.location;
      report.files[file].mutants.push({
        id: m.id,
        mutatorName: m.mutatorName,
        replacement: m.replacement,
        location: { start: { line: loc.start.line + 1, column: loc.start.column + 1 }, end: { line: loc.end.line + 1, column: loc.end.column + 1 } },
        status,
        duration: Date.now() - started,
      });
      done++;
      if (status !== "Killed") log(`${status} ${file}:${loc.start.line + 1}:${loc.start.column + 1} ${m.mutatorName} -> ${JSON.stringify(m.replacement).slice(0, 80)}`);
      if (done % 25 === 0) log(`${done} of ${chosen.length}`);
    }
  };
  try {
    await Promise.all(copies.map(runOne));
  } finally {
    for (const c of copies) rmSync(c, { recursive: true, force: true });
  }
  for (const f of Object.values(report.files)) f.mutants.sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column || a.mutatorName.localeCompare(b.mutatorName));
  return report;
}

/** How many of each status, per file and in all. */
export function tally(report) {
  const out = {};
  for (const [file, f] of Object.entries(report.files)) {
    out[file] = {};
    for (const m of f.mutants) out[file][m.status] = (out[file][m.status] ?? 0) + 1;
  }
  return out;
}

/** Runs each mutant a report says was killed by timeout again, alone, with three times the limits; the report, updated. */
export async function recheck(report, { limitMs = 60_000, log = () => undefined } = {}) {
  const copy = copyTree();
  try {
    for (const [file, f] of Object.entries(report.files)) {
      const pending = f.mutants.filter((m) => m.status === "Timeout");
      if (pending.length === 0) continue;
      const base = await verdict(copy, TESTS[file], limitMs * 5);
      for (const m of pending) {
        const zero = { start: { line: m.location.start.line - 1, column: m.location.start.column - 1 }, end: { line: m.location.end.line - 1, column: m.location.end.column - 1 } };
        writeFileSync(join(copy, file), apply(f.source, { replacement: m.replacement, location: zero }));
        m.status = loads(copy, file) ? (await verdict(copy, TESTS[file], limitMs * 3, base.passed, TEST_LIMIT_MS * 3)).status : "CompileError";
        writeFileSync(join(copy, file), f.source);
        log(`recheck ${m.status} ${file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} -> ${JSON.stringify(m.replacement).slice(0, 80)}`);
      }
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  return report;
}

/** The mutants of a report that no test killed and the list does not name: ratchet.py reads both. */
export function unlisted(report) {
  const code = [
    "import json, sys",
    "from collections import Counter",
    "from pathlib import Path",
    "sys.path.insert(0, 'tests/tools')",
    "import ratchet",
    "found = Counter(ratchet.stryker(Path(sys.argv[1])))",
    "listed, wrong = ratchet.exclusions(ratchet.ROOT / 'tests' / 'exclusions' / 'scripts.toml')",
    "print(json.dumps(wrong + [str(m) for m, n in sorted(found.items(), key=str) if n > listed[m]]))",
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", code, resolve(report)], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { recheck: { type: "string" }, listed: { type: "string" }, out: { type: "string" }, workers: { type: "string", default: "2" }, timeout: { type: "string", default: "60" }, files: { type: "string" }, since: { type: "string" }, max: { type: "string" }, "tests-max": { type: "string" }, seed: { type: "string", default: "1" } } });
  if (values.recheck) {
    const report = await recheck(JSON.parse(readFileSync(values.recheck, "utf8")), { limitMs: Number(values.timeout) * 1000, log: (l) => console.log(l) });
    writeFileSync(values.recheck, JSON.stringify(report, null, 1));
    console.log(JSON.stringify(tally(report)));
    process.exit(0);
  }
  if (values.listed) {
    const problems = unlisted(values.listed);
    for (const p of problems) console.error(`not killed and not listed: ${p}`);
    console.log(`scripts-mut --listed: ${problems.length ? `${problems.length} problems` : "ok"}`);
    process.exit(problems.length ? 1 : 0);
  }
  if (!values.out) {
    console.error("usage: scripts-mut.mjs --out <report.json> [--workers 2] [--timeout 60] [--files a,b] [--since rev] [--max n] [--tests-max n] [--seed n]");
    process.exit(2);
  }
  const files = values.files ? values.files.split(",").filter(Boolean) : MEASURED;
  const unknown = files.filter((f) => !MEASURED.includes(f));
  if (unknown.length) {
    console.error(`not a file of the area scripts: ${unknown.join(", ")}`);
    process.exit(2);
  }
  const t0 = Date.now();
  const testsMax = values.since && values["tests-max"] ? Number(values["tests-max"]) : 0;
  const changed = testsMax > 0 ? changedTests(values.since) : [];
  const tested = changed.length > 0 ? testedFiles(changed) : [];
  if (changed.length > 0) console.log(`the tests changed: ${changed.join(", ")}`);
  const report = await campaign({ files, workers: Math.min(2, Number(values.workers)), limitMs: Number(values.timeout) * 1000, lines: values.since ? changedLines(values.since) : null, max: values.max ? Number(values.max) : Infinity, seed: Number(values.seed), tested, testsMax, log: (l) => console.log(l) });
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(tally(report)), `${Math.round((Date.now() - t0) / 1000)} s`);
}
