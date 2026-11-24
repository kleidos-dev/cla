// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The MC/DC tool tested on planted code: a condition no test made decide
 * must be reported, and one that was must not; a forced condition must
 * change what the code does. Runs in Node before every measured run.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { changedLines, coveredBy, patterns, sampled, shuffled, sourceFiles } from "./changed.mjs";
import { RUNTIME, decisionsOf, independent, instrument, summarize } from "./mcdc.mjs";
import { isSource } from "./sources.mjs";

/** Runs the instrumented source in a world of its own and gives back its functions and what was measured. */
function load(source) {
  const { code, decisions } = instrument(source, "src/planted.ts");
  const world = {};
  runInNewContext(`${RUNTIME}${code}`, world);
  return { world, measured: world.__mcdc, decisions };
}
const misses = ({ measured, decisions }) => summarize(decisions, measured.seen).misses.map((m) => `${m.text}: ${m.why}`);

// The textbook decision: four vectors cover three conditions, two do not.
const both = load("function f(a, b, c) { if (a && (b || c)) return 1; return 0; }");
assert.equal(both.world.f(true, true, false), 1);
assert.equal(both.world.f(false, true, false), 0);
assert.deepEqual(misses(both), ["b: only true", "c: never evaluated"]);
both.world.f(true, false, false);
both.world.f(true, false, true);
assert.deepEqual(misses(both), []);
assert.deepEqual(summarize(both.decisions, both.measured.seen).totals, { "src/planted.ts": { conditions: 3, covered: 3 } });
assert.deepEqual([...both.measured.seen.get("src/planted.ts#0")].sort(), ["F-->F", "TFF>F", "TFT>T", "TT->T"]);

// Both values seen is not independence: here a and b always change together.
const coupled = load("function f(a, b) { return a && b ? 1 : 0; }");
coupled.world.f(true, true);
coupled.world.f(false, false);
assert.deepEqual(misses(coupled), ["b: only true"]);
assert.equal(independent(["TT>T", "FF>F"], 0), false);
assert.equal(independent(["TT>T", "F->F"], 0), true);
assert.equal(independent(["TT>T", "TF>T"], 1), false);

// Every place a decision can be, a default with a literal, and a negation, which is no condition of its own.
const places = load('function f(x, n) { for (; n > 0;) n--; while (n < 0) n++; const y = x.a || "d"; const z = !(x.b && x.c); do n++; while (n < 2); return [y, z, n]; }');
assert.deepEqual([...places.world.f({ a: "", b: 1, c: 0 }, 2)], ["d", true, 2]);
assert.deepEqual([...places.decisions.values()].map((d) => [d.function, ...d.atoms]), [["f", "n > 0"], ["f", "n < 0"], ["f", "x.a"], ["f", "x.b", "x.c"], ["f", "n < 2"]]);

// A value that is an object keeps being that object.
const value = load("function f(o) { return o || null; }");
const o = {};
assert.equal(value.world.f(o), o);

// Evaluations that suspend and interleave do not mix their vectors.
const waits = load("async function f(p, q) { if ((await p) && (await q)) return 1; return 0; }");
let open;
const first = waits.world.f(new Promise((r) => (open = r)), true);
assert.equal(await waits.world.f(false, true), 0);
open(true);
assert.equal(await first, 1);
assert.deepEqual(misses(waits), ["await q: only true"]);

// A recursive decision finds its own evaluation.
const deep = load("function f(n) { if (n > 0 && f(n - 1)) return true; return n === 0; }");
assert.equal(deep.world.f(2), true);

// Held, a condition decides whatever it is; a loop it makes endless is stopped.
both.measured.force = { key: "src/planted.ts#0", index: 0, value: true };
assert.equal(both.world.f(false, true, false), 1);
both.measured.force = { key: "src/planted.ts#0", index: 0, value: false };
assert.equal(both.world.f(true, true, true), 0);
const endless = load("function f(n) { while (n > 0) n--; return n; }");
endless.measured.force = { key: "src/planted.ts#0", index: 0, value: true };
assert.throws(() => endless.world.f(1), /hit limit/);

// The mutants of a pull request: the lines git says it added or changed, and the mutants that lie on them alone.
const diff = [
  "diff --git a/worker/src/a.ts b/worker/src/a.ts",
  "--- a/worker/src/a.ts",
  "+++ b/worker/src/a.ts",
  "@@ -2,0 +3,2 @@",
  "+x",
  "+y",
  "@@ -9 +11 @@",
  "-z",
  "+w",
  "diff --git a/worker/src/gone.ts b/worker/src/gone.ts",
  "--- a/worker/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
].join("\n");
assert.deepEqual(changedLines(diff), new Map([["worker/src/a.ts", new Set([3, 4, 11])]]));
const source = "export function f(a: number) {\n  return a > 1;\n}\nexport const g = (b: boolean) => !b;\n";
const read = () => source;
const line2 = await patterns(new Map([["worker/src/a.ts", new Set([2])], ["worker/src/m.d.ts", new Set([1])], ["worker/test/x.ts", new Set([1])]]), read);
assert.ok(line2.patterns.length > 0, "a changed line has its mutants");
assert.ok(line2.patterns.every((p) => /^src\/a\.ts:2:\d+-2:\d+$/.test(p)), `only the changed line, not the function around it: ${line2.patterns}`);
assert.equal(line2.planted, 4, "a > 1: held true, held false, >= and <=");
const whole = await patterns(new Map([["worker/src/a.ts", new Set([1, 2, 3, 4])]]), read);
assert.ok(whole.patterns.some((p) => p.startsWith("src/a.ts:1:") && p.includes("-3:")), "a function changed whole has the mutant that empties it");
const said = [];
const capped = await patterns(new Map([["worker/src/a.ts", new Set([1, 2, 3, 4])]]), read, { max: 3, seed: 5, log: (l) => said.push(l) });
assert.ok(capped.planted <= 3 && capped.planted > 0, `a cap plants no more than it says: ${capped.planted}`);
assert.match(said[0], new RegExp(`^notice: ${capped.planted} of the ${whole.planted} mutants of the changed lines, chosen by seed 5$`));
assert.deepEqual(await patterns(new Map([["worker/src/a.ts", new Set([1, 2, 3, 4])]]), read, { max: 3, seed: 5 }), capped, "the same seed, the same choice");
assert.deepEqual(shuffled([1, 2, 3, 4, 5], 7).sort(), [1, 2, 3, 4, 5]);
assert.notDeepEqual(shuffled([1, 2, 3, 4, 5, 6, 7, 8], 7), shuffled([1, 2, 3, 4, 5, 6, 7, 8], 8));

// The sources of the Worker, at any depth of src/, and nothing else; the MC/DC tool reads them all.
assert.deepEqual(["src/a.ts", "src/rules/z.ts", "src/a.d.ts", "src/a.mjs", "test/a.ts", "node_modules/x/src/a.ts", "srcx/a.ts"].map(isSource), [true, true, false, false, false, false, false]);
const sources = sourceFiles();
assert.ok(sources.length > 10 && sources.every(isSource) && sources.includes("src/bot.ts"), `every source of src/: ${sources}`);
const measuredFiles = new Set([...decisionsOf(join(import.meta.dirname, "..", "..")).keys()].map((k) => k.split("#")[0]));
assert.ok(measuredFiles.size > 10 && [...measuredFiles].every((f) => sources.includes(f)), `the MC/DC tool reads the sources: ${[...measuredFiles]}`);

// A change of the tests: the sources each changed test file is for, or every source.
const tests = { "worker/test/core/keys.test.ts": 'import { a } from "../../src/keys";\nimport { must } from "../../src/util";', "worker/test/edge/web-sign.test.ts": 'import { b } from "../../src/session";', "worker/test/edge/assets.test.ts": 'import { AGREEMENTS } from "../../src/agreement.ts";', "worker/test/core/nothing.test.ts": "" };
const all = ["src/agreement.ts", "src/keys.ts", "src/session.ts", "src/util.ts", "src/web.ts"];
const readTest = (p) => tests[p] ?? null;
assert.deepEqual(coveredBy(["worker/test/core/keys.test.ts"], all, readTest), { files: ["src/keys.ts", "src/util.ts"], all: false }, "by its name and its imports");
assert.deepEqual(coveredBy(["worker/test/edge/web-sign.test.ts", "worker/test/edge/assets.test.ts"], all, readTest), { files: ["src/agreement.ts", "src/session.ts", "src/web.ts"], all: false }, "web-sign is for web.ts");
for (const other of ["worker/test/core/gone.test.ts", "worker/test/core/nothing.test.ts", "worker/test/helpers.ts", "worker/vitest.config.ts", "registry/tests/vectors/authors.json"]) {
  assert.deepEqual(coveredBy(["worker/test/core/keys.test.ts", other], all, readTest), { files: ["src/keys.ts", "src/util.ts"], all: true }, `${other} is for every source, after the named ones`);
}
assert.deepEqual(coveredBy(["worker/test/helpers.ts"], all, readTest), { files: [], all: true }, "a helper alone is for every source");
const notes = [];
const planted = new Set();
const some = await sampled(["src/a.ts"], read, { max: 3, seed: 2, log: (l) => notes.push(l), planted });
assert.ok(some.planted > 0 && some.planted <= 3 && planted.size === some.planted, `a sample plants what it says: ${some.planted}`);
assert.match(notes[0], new RegExp(`^notice: ${some.planted} of the \\d+ mutants of 1 files the changed tests are for, chosen by seed 2$`));
const again = await sampled(["src/a.ts"], read, { max: 10, seed: 2, planted });
assert.ok(again.planted > 0 && planted.size === some.planted + again.planted, "what is planted already is not counted twice");
assert.ok([...again.patterns].every((p) => !some.patterns.includes(p)), "a second sample takes other mutants");

console.log("mcdc selftest: ok");
