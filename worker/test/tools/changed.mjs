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
 *   node test/tools/changed.mjs --since <revision> [--max 120] [--seed 1]
 *
 * prints the patterns with a comma between them, and nothing when the
 * change mutates nothing; how many mutants they plant goes to stderr. `tests/tools/ratchet.py listed` then judges the
 * report: a run of some lines has no floor to be held to.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Instrumenter } from "@stryker-mutator/instrumenter";

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

/** The patterns of the change's mutants of the Worker's source files (paths relative to worker/), and how many they plant. */
export async function patterns(lines, read, { max = Infinity, seed = 1, log = () => undefined } = {}) {
  const candidates = [];
  for (const [path, changed] of [...lines].sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.replace(/^worker\//, "");
    if (!/^src\/[^/]+\.ts$/.test(file) || file.endsWith(".d.ts") || changed.size === 0) continue;
    const all = await mutantsOf(file, read(file));
    for (const [n, loc] of all.entries()) {
      const spanned = Array.from({ length: loc.end.line - loc.start.line + 1 }, (_, i) => loc.start.line + 1 + i);
      if (spanned.every((l) => changed.has(l))) candidates.push({ file, n, loc, takes: all.flatMap((m, i) => (inside(loc, m) ? [`${file}#${i}`] : [])) });
    }
  }
  const planted = new Set();
  const chosen = new Set();
  for (const c of shuffled(candidates, seed)) {
    const more = c.takes.filter((k) => !planted.has(k));
    if (planted.size + more.length > max) continue;
    for (const k of more) planted.add(k);
    chosen.add(c);
  }
  if (chosen.size < candidates.length) log(`notice: ${planted.size} of the ${candidates.length} mutants of the changed lines, chosen by seed ${seed}`);
  return { patterns: [...new Set(candidates.filter((c) => chosen.has(c)).map((c) => pattern(c.file, c.loc)))], planted: planted.size };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { since: { type: "string" }, max: { type: "string", default: "120" }, seed: { type: "string", default: "1" } } });
  if (!values.since) throw new Error("usage: changed.mjs --since <revision> [--max 120] [--seed 1]");
  const diff = spawnSync("git", ["diff", "--unified=0", "--no-renames", values.since, "--", "src"], { cwd: worker, encoding: "utf8" });
  if (diff.status !== 0) throw new Error(`git diff: ${diff.stderr}`);
  const run = await patterns(changedLines(diff.stdout), (f) => readFileSync(join(worker, f), "utf8"), { max: Number(values.max), seed: Number(values.seed), log: (l) => console.error(l) });
  console.error(`${run.planted} mutants of the changed lines`);
  console.log(run.patterns.join(","));
}
