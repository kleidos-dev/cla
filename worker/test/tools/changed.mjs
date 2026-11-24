// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The mutants of the Worker's lines a pull request changes, as StrykerJS's
 * `--mutate` takes them: one exact range per mutant, made by Stryker's own
 * instrumenter. A mutant is the change's when every line it spans is a line
 * the change added or changed (git's own diff), so a one-line change inside
 * a function does not take the mutant that deletes the whole function. A
 * range takes every mutant inside it as well, and those are the change's
 * too: the run plants exactly these. Past `--max` mutants, a seeded choice
 * of ranges that plants no more than that, with a notice; every mutant of
 * every file runs every Monday (mutation.yml).
 *
 * A change to the tests plants mutants too, since a test that checks less
 * kills fewer and runs the same lines: with `--tests-max`, when the change
 * touches worker/test/, the shared vectors of registry/tests/ or a
 * configuration the tests run under (TESTED_BY), a seeded choice of at most
 * that many mutants of the sources the changed tests are for (`coveredBy`).
 *
 *   node test/tools/changed.mjs --since <revision> [--max 120] [--tests-max 80] [--seed 1]
 *
 * prints the patterns with a comma between them, and nothing when the
 * change mutates nothing; how many mutants they plant goes to stderr.
 * `tests/tools/ratchet.py listed` then judges the report: a run of some
 * lines has no floor to be held to.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { Instrumenter } from "@stryker-mutator/instrumenter";
import { isSource } from "./sources.mjs";

const worker = join(import.meta.dirname, "..", "..");
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, isTraceEnabled: () => false, isDebugEnabled: () => false, isInfoEnabled: () => false, isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false };

/** The lines (from 1) each file of a `git diff --unified=0` has new or changed. */
export function changedLines(diff) {
  const out = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    const named = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(line);
    if (named) {
      file = named[1] ?? null;
      if (file) out.set(file, out.get(file) ?? new Set());
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) for (let i = 0; i < Number(hunk[2] ?? 1); i++) out.get(file).add(Number(hunk[1]) + i);
  }
  return out;
}

/** Every mutant the instrumenter makes of a file, with Stryker's 0-based lines and columns. */
export async function mutantsOf(file, content) {
  const { mutants } = await new Instrumenter(quiet).instrument([{ name: file, content, mutate: true }], { plugins: null, excludedMutations: [], ignorers: [], noHeader: true });
  return mutants.map((m) => m.location);
}

/** A mutant's own range, as `--mutate` reads it: lines from 1, columns from 0. */
export const pattern = (file, { start, end }) => `${file}:${start.line + 1}:${start.column}-${end.line + 1}:${end.column}`;

/** Whether position `a` is at or before position `b`. */
const atOrBefore = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
/** Whether a range takes a mutant, as the instrumenter decides it: the mutant lies inside. */
const inside = (range, loc) => atOrBefore(range.start, loc.start) && atOrBefore(loc.end, range.end);

/** The items in an order drawn by a seeded generator. */
export function shuffled(items, seed) {
  let s = seed >>> 0 || 1;
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Each candidate mutant of a file whose every spanned line `keep` takes, with the mutants its range plants. */
async function candidatesOf(file, source, keep) {
  const all = await mutantsOf(file, source);
  const out = [];
  for (const [n, loc] of all.entries()) {
    const spanned = Array.from({ length: loc.end.line - loc.start.line + 1 }, (_, i) => loc.start.line + 1 + i);
    if (spanned.every(keep)) out.push({ file, n, loc, takes: all.flatMap((m, i) => (inside(loc, m) ? [`${file}#${i}`] : [])) });
  }
  return out;
}

/** A seeded choice of candidates whose ranges plant at most `max` mutants that `planted` does not hold yet; it adds them there. */
function choose(candidates, planted, max, seed) {
  const chosen = new Set();
  let more = 0;
  for (const c of shuffled(candidates, seed)) {
    const added = c.takes.filter((k) => !planted.has(k));
    // A range whose every mutant is planted already (by a range around it) adds nothing.
    if (added.length === 0 || more + added.length > max) continue;
    for (const k of added) planted.add(k);
    more += added.length;
    chosen.add(c);
  }
  return { patterns: [...new Set(candidates.filter((c) => chosen.has(c)).map((c) => pattern(c.file, c.loc)))], planted: more, chosen: chosen.size };
}

/** The patterns of the change's mutants of the Worker's source files (paths relative to worker/), and how many they plant. */
export async function patterns(lines, read, { max = Infinity, seed = 1, log = () => undefined, planted = new Set() } = {}) {
  const candidates = [];
  for (const [path, changed] of [...lines].sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.replace(/^worker\//, "");
    if (!isSource(file) || changed.size === 0) continue;
    candidates.push(...(await candidatesOf(file, read(file), (l) => changed.has(l))));
  }
  const run = choose(candidates, planted, max, seed);
  if (run.chosen < candidates.length) log(`notice: ${run.planted} of the ${candidates.length} mutants of the changed lines, chosen by seed ${seed}`);
  return { patterns: run.patterns, planted: run.planted };
}

/** What a change of the tests touches besides worker/test/: the configurations they run under and the vectors they share with the register. */
export const TESTED_BY = ["worker/package.json", "worker/package-lock.json", "worker/tsconfig.json", "worker/stryker.config.json", "worker/vitest.config.ts", "worker/vitest.mcdc.config.mjs", "worker/vitest.stryker.config.mjs", "registry/tests/normalize-vectors.json", "registry/tests/vectors"];

/**
 * The sources (relative to worker/) that the changed test files are for. A test file of worker/test/ is for the
 * sources it imports and for the one its name names (core/keys.test.ts: src/keys.ts; edge/web-sign.test.ts:
 * src/web.ts); a file that is gone, a helper, a tool, a configuration or a shared vector is for every source,
 * as is a test file that names none. `read` gives a test file's text, or null when it is gone.
 */
export function coveredBy(changed, sources, read) {
  const known = new Set(sources);
  const out = new Set();
  for (const path of changed) {
    const test = /^worker\/(test\/.+)\.test\.ts$/.exec(path);
    const text = test ? read(path) : null;
    if (text === null) return [...known].sort();
    const name = basename(test[1]);
    const found = [`src/${name}.ts`, `src/${name.split("-")[0]}.ts`];
    for (const m of text.matchAll(/from\s+["'](?:\.\.\/)+src\/([^"']+)["']/g)) found.push(`src/${m[1].replace(/\.ts$/, "")}.ts`);
    const mine = found.filter((f) => known.has(f));
    if (mine.length === 0) return [...known].sort();
    for (const f of mine) out.add(f);
  }
  return [...out].sort();
}

/** A seeded choice of at most `max` mutants of whole files, besides those `planted` holds already: the patterns and how many they add. */
export async function sampled(files, read, { max, seed = 1, log = () => undefined, planted = new Set() }) {
  const candidates = [];
  for (const file of files) candidates.push(...(await candidatesOf(file, read(file), () => true)));
  const run = choose(candidates, planted, max, seed);
  log(`notice: ${run.planted} of the ${candidates.length} mutants of ${files.length} files the changed tests are for, chosen by seed ${seed}`);
  return { patterns: run.patterns, planted: run.planted };
}

/** Every source file of the Worker, relative to worker/. */
export const sourceFiles = (root = worker) =>
  readdirSync(join(root, "src"), { recursive: true })
    .map((f) => `src/${f.split(sep).join("/")}`)
    .filter(isSource)
    .sort();

if (import.meta.main) {
  const { values } = parseArgs({ options: { since: { type: "string" }, max: { type: "string", default: "120" }, "tests-max": { type: "string", default: "0" }, seed: { type: "string", default: "1" } } });
  if (!values.since) throw new Error("usage: changed.mjs --since <revision> [--max 120] [--tests-max 80] [--seed 1]");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: worker, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
    return r.stdout;
  };
  const read = (f) => readFileSync(join(worker, f), "utf8");
  const log = (l) => console.error(l);
  const seed = Number(values.seed);
  const planted = new Set();
  const run = await patterns(changedLines(git("diff", "--unified=0", "--no-renames", values.since, "--", "src")), read, { max: Number(values.max), seed, log, planted });
  console.error(`${run.planted} mutants of the changed lines`);
  const out = [...run.patterns];
  const testsMax = Number(values["tests-max"]);
  if (testsMax > 0) {
    const root = join(worker, "..");
    const changed = git("diff", "--name-only", "--no-renames", values.since, "--", "test", ...TESTED_BY.map((p) => join(root, p))).split("\n").filter(Boolean);
    if (changed.length > 0) {
      const files = coveredBy(changed, sourceFiles(), (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null));
      const more = await sampled(files, read, { max: testsMax, seed, log, planted });
      console.error(`${more.planted} mutants of the sources of the ${changed.length} changed test files`);
      out.push(...more.patterns);
    }
  }
  console.log([...new Set(out)].join(","));
}
