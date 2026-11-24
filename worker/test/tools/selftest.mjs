// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The MC/DC tool tested on planted code: a condition no test made decide
 * must be reported, and one that was must not; a forced condition must
 * change what the code does. Runs in Node before every measured run.
 */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
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

console.log("mcdc selftest: ok");
