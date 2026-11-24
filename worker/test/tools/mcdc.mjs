// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Condition and MC/DC coverage of src/*.ts, measured inside the Workers
 * runtime. Istanbul counts that each operand of a logical expression was
 * reached, not that it was true and false, so a Vite transform wraps every
 * atomic condition of every decision (`if`, `while`, `for`, `?:`, and any
 * `&&`/`||` used as a value) and one evaluation leaves one vector: T or F
 * per condition, - where the short circuit skipped it, and the outcome.
 *
 * A condition is covered (masking MC/DC, the form LLVM uses for languages
 * with short circuit) when two vectors differ in it and in the outcome and
 * agree in every other condition both evaluated. `??`, `?.` and `switch`
 * are not decisions: Istanbul's branches count them.
 *
 * `force` (force.mjs) is the same instrumentation made to lie: one
 * condition is held true or false, which is a mutant.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const K = ts.SyntaxKind;

/** A forced condition that turns a loop endless is stopped after this many evaluations. */
const HIT_LIMIT = 200_000;

function bare(n) {
  let at = n;
  while (ts.isParenthesizedExpression(at)) at = at.expression;
  return at;
}

const isLogical = (n) => ts.isBinaryExpression(n) && (n.operatorToken.kind === K.AmpersandAmpersandToken || n.operatorToken.kind === K.BarBarToken);
const isNot = (n) => ts.isPrefixUnaryExpression(n) && n.operator === K.ExclamationToken;
const isLiteral = (n) =>
  ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || n.kind === K.TrueKeyword || n.kind === K.FalseKeyword || n.kind === K.NullKeyword;

/** The atomic conditions of an expression. A literal operand (`x || "y"`) is not one. */
function atomsOf(expression) {
  const n = bare(expression);
  if (isLogical(n)) return [...atomsOf(n.left), ...atomsOf(n.right)];
  if (isNot(n)) return atomsOf(n.operand);
  return isLiteral(n) ? [] : [n];
}

/** Whether evaluating the expression suspends (then its evaluations can interleave and need a frame of their own). */
function suspends(n) {
  let found = false;
  const visit = (m) => {
    if (found || ts.isFunctionLike(m)) return;
    if (ts.isAwaitExpression(m) || ts.isYieldExpression(m)) found = true;
    else ts.forEachChild(m, visit);
  };
  visit(n);
  return found;
}

/** The statement, inside a block, that holds a node; undefined when its function has no block. */
function statementOf(n) {
  let s = n;
  while (s && !ts.isFunctionLike(s)) {
    if (ts.isStatement(s) && (ts.isBlock(s.parent) || ts.isSourceFile(s.parent) || ts.isCaseClause(s.parent))) return s;
    s = s.parent;
  }
  return undefined;
}

function functionOf(n, sf) {
  for (let f = n.parent; f; f = f.parent) {
    if (!ts.isFunctionLike(f)) continue;
    const name = f.name ?? (ts.isVariableDeclaration(f.parent) ? f.parent.name : undefined);
    if (name) return name.getText(sf);
  }
  return "(module)";
}

/** The instrumented source and the table of its decisions: key -> { file, line, function, text, atoms }. */
export function instrument(code, file) {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
  const decisions = new Map();
  const insertions = [];
  const start = (n) => n.getStart(sf);
  const line = (n) => sf.getLineAndCharacterOfPosition(start(n)).line + 1;
  const depth = (n) => {
    let d = 0;
    for (let p = n.parent; p; p = p.parent) d++;
    return d;
  };
  const insert = (pos, text, close, d) => insertions.push({ pos, text, close, depth: d, seq: insertions.length });

  const decide = (n) => {
    const atoms = atomsOf(n);
    if (atoms.length === 0) return;
    const key = `${file}#${decisions.size}`;
    const id = JSON.stringify(key);
    let begin = `__m.begin(${id},${atoms.length})`;
    let condition = (i) => `__m.condition(${id},${i},(`;
    if (suspends(n)) {
      const s = statementOf(n);
      if (!s) throw new Error(`${file}:${line(n)}: a decision that awaits outside a block cannot be measured`);
      const frame = `__f${decisions.size}`;
      insert(start(s), `let ${frame};`, false, -1);
      begin = `(${frame}=__m.frame(${id},${atoms.length}))`;
      condition = (i) => `__m.set(${frame},${i},(`;
    }
    decisions.set(key, { file, line: line(n), function: functionOf(n, sf), text: n.getText(sf), atoms: atoms.map((a) => a.getText(sf)) });
    insert(start(n), `__m.end(${begin},(`, false, depth(n));
    insert(n.end, "))", true, depth(n));
    atoms.forEach((a, i) => {
      insert(start(a), condition(i), false, depth(a) + 0.5);
      insert(a.end, "))", true, depth(a) + 0.5);
    });
  };

  const done = new Set();
  const mark = (expression) => {
    const n = bare(expression);
    done.add(n);
    if (isLogical(n)) {
      mark(n.left);
      mark(n.right);
    } else if (isNot(n)) mark(n.operand);
  };
  const testOf = (n) => {
    if (ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) return n.expression;
    return ts.isConditionalExpression(n) || ts.isForStatement(n) ? n.condition : undefined;
  };
  const walk = (n) => {
    const test = testOf(n);
    if (test) {
      decide(test);
      mark(test);
    }
    if (isLogical(n) && !done.has(n)) {
      decide(n);
      mark(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  // At one place closings come before openings; of two closings the inner one first, of two openings the outer.
  const inner = (a, b) => (a.close ? b.depth - a.depth : a.depth - b.depth) || a.seq - b.seq;
  insertions.sort((a, b) => a.pos - b.pos || (a.close === b.close ? inner(a, b) : a.close ? -1 : 1));
  let out = "";
  let at = 0;
  for (const i of insertions) {
    out += code.slice(at, i.pos) + i.text;
    at = i.pos;
  }
  return { code: out + code.slice(at), decisions };
}

/** What the instrumented code calls. One per isolate; `seen` is the vectors, `force` the condition held, `reached` the tests per decision. */
export const RUNTIME = `const __m = globalThis.__mcdc ??= (() => {
 const seen = new Map(), stack = [], m = { seen, force: null, reached: null, test: null };
 const hold = (k, i, v) => { const f = m.force; if (!f || f.key !== k || f.index !== i) return v; if ((f.hits = (f.hits ?? 0) + 1) > ${HIT_LIMIT}) throw new Error("forced condition: hit limit"); return f.value; };
 m.frame = (key, n) => ({ key, values: new Array(n).fill(undefined), loose: true });
 m.set = (f, i, v) => { const w = hold(f.key, i, v); f.values[i] = Boolean(w); return w; };
 m.begin = (key, n) => { const f = { key, values: new Array(n).fill(undefined), loose: false }; stack.push(f); return f; };
 m.condition = (key, i, v) => { const w = hold(key, i, v); let j = stack.length - 1; while (stack[j].key !== key) j--; stack[j].values[i] = Boolean(w); return w; };
 m.end = (f, v) => {
  if (!f.loose) while (stack.pop() !== f);
  if (m.reached && m.test) (m.reached[f.key] ??= new Set()).add(m.test);
  let h = seen.get(f.key); if (!h) seen.set(f.key, h = new Set());
  h.add(f.values.map((x) => (x === undefined ? "-" : x ? "T" : "F")).join("") + ">" + (v ? "T" : "F"));
  return v;
 };
 return m;
})();`;

/** Every decision of every src/*.ts, whatever Vite serves from its cache. */
export function decisionsOf(root) {
  const out = new Map();
  for (const f of readdirSync(join(root, "src")).sort()) {
    if (!f.endsWith(".ts") || f.endsWith(".d.ts")) continue;
    for (const [k, d] of instrument(readFileSync(join(root, "src", f), "utf8"), `src/${f}`).decisions) out.set(k, d);
  }
  return out;
}

export function plugin(root) {
  return {
    name: "mcdc",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?")[0];
      if (!/\/src\/[^/]*\.ts$/.test(path) || path.endsWith(".d.ts")) return undefined;
      return { code: RUNTIME + instrument(code, relative(root, path)).code, map: null };
    },
  };
}

/** Whether two of the vectors show that condition `i` decides the outcome alone. */
export function independent(vectors, i) {
  const split = vectors.map((v) => v.split(">"));
  return split.some(([x, rx]) => split.some(([y, ry]) => rx !== ry && x[i] !== y[i] && x[i] !== "-" && y[i] !== "-" && [...x].every((c, j) => j === i || c === y[j] || c === "-" || y[j] === "-")));
}

/** The conditions without MC/DC, as the ratchet reads them, and the totals per file. */
export function summarize(decisions, seen) {
  const misses = [];
  const totals = {};
  for (const [key, d] of decisions) {
    const vectors = [...(seen.get(key) ?? [])];
    totals[d.file] ??= { conditions: 0, covered: 0 };
    const t = totals[d.file];
    d.atoms.forEach((text, i) => {
      t.conditions++;
      if (independent(vectors, i)) {
        t.covered++;
        return;
      }
      const values = new Set(vectors.map((v) => v[i]).filter((x) => x !== "-"));
      const why = values.size === 2 ? "not independent" : values.size === 1 ? `only ${values.has("T") ? "true" : "false"}` : "never evaluated";
      misses.push({ kind: "condition", file: `worker/${d.file}`, function: d.function, text, on: d.text === text ? "" : d.text, line: d.line, why });
    });
  }
  return { totals, misses };
}

/** Merges the vectors every test file left in its meta (mcdc-setup.ts) and writes the report. */
export class Reporter {
  constructor(root, out) {
    this.root = root;
    this.out = out;
    this.seen = new Map();
  }

  onTestModuleEnd(module) {
    for (const [key, vectors] of Object.entries(module.meta().mcdc ?? {})) {
      const h = this.seen.get(key) ?? new Set();
      for (const v of vectors) h.add(v);
      this.seen.set(key, h);
    }
  }

  onTestRunEnd() {
    const report = summarize(decisionsOf(this.root), this.seen);
    mkdirSync(dirname(this.out), { recursive: true });
    writeFileSync(this.out, JSON.stringify(report, null, 1));
    const total = Object.values(report.totals).reduce((a, t) => ({ n: a.n + t.conditions, c: a.c + t.covered }), { n: 0, c: 0 });
    console.log(`MC/DC: ${total.c} of ${total.n} conditions`);
  }
}
