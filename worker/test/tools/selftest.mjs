// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The MC/DC tool tested on planted code: a condition no test made decide
 * must be reported, and one that was must not; a forced condition must
 * change what the code does. Runs in Node before every measured run.
 */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { changedLines, patterns, shuffled } from "./changed.mjs";
import { RUNTIME, independent, instrument, summarize } from "./mcdc.mjs";

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

console.log("mcdc selftest: ok");
