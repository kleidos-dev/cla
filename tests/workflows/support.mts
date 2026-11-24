// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What the workflow tests share: the workflows as GitHub reads them (the
 * yaml package), their expressions evaluated by GitHub's own evaluator
 * (@actions/expressions), and the real text of a `run:` block run under
 * bash as the runner runs it (`bash -e <file>`), with stub commands first
 * in PATH that log every argument and answer as a case tells them. Every
 * line bash ran is noted, so a test can require all of them to run.
 * Nothing reaches a network or a real GitHub, git, gh or python.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// worker/ holds the repository's one lockfile, so its node_modules hold the test tools.
import { parse } from "../../worker/node_modules/yaml/dist/index.js";
import { Evaluator, Lexer, Parser, data } from "../../worker/node_modules/@actions/expressions/dist/index.js";
import { truthy } from "../../worker/node_modules/@actions/expressions/dist/result.js";
import type { FunctionDefinition } from "../../worker/node_modules/@actions/expressions/dist/funcs/info.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
  shell?: string;
}
export interface Job {
  name?: string;
  if?: string;
  uses?: string;
  needs?: string[];
  environment?: string;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: Step[];
  with?: Record<string, unknown>;
}
export interface Workflow {
  name: string;
  "run-name"?: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

export function workflow(name: string): Workflow {
  return parse(readFileSync(join(ROOT, ".github", "workflows", name), "utf8")) as Workflow;
}

export function step(wf: Workflow, job: string, name: string): Step {
  const s = wf.jobs[job]?.steps?.find((x) => x.id === name || x.name === name);
  if (!s) throw new Error(`no step ${name} in job ${job}`);
  return s;
}

/** A context as GitHub's evaluator takes it, from plain JSON values. */
type Plain = string | number | boolean | null | undefined | Plain[] | { [k: string]: Plain };
function toData(v: Plain): data.ExpressionData {
  if (v === null || v === undefined) return new data.Null();
  if (typeof v === "string") return new data.StringData(v);
  if (typeof v === "number") return new data.NumberData(v);
  if (typeof v === "boolean") return new data.BooleanData(v);
  if (Array.isArray(v)) return new data.Array(...v.map(toData));
  return new data.Dictionary(...Object.entries(v).map(([key, value]) => ({ key, value: toData(value) })));
}

/** The state of the job a status function reads: success() and failure() of the steps before. */
export interface Status {
  failed?: boolean;
  cancelled?: boolean;
}

function statusFunctions(s: Status): Map<string, FunctionDefinition> {
  const fn = (name: string, value: () => boolean): [string, FunctionDefinition] => [name, { name, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(value()) }];
  return new Map([fn("success", () => !s.failed && !s.cancelled), fn("failure", () => Boolean(s.failed)), fn("always", () => true), fn("cancelled", () => Boolean(s.cancelled))]);
}

/** Evaluates one expression (without its ${{ }}) against a context, as GitHub does. */
export function evaluate(expression: string, context: Record<string, Plain>, status: Status = {}): data.ExpressionData {
  const functions = statusFunctions(status);
  const tokens = new Lexer(expression).lex().tokens;
  const tree = new Parser(tokens, Object.keys(context), [...functions.values()]).parse();
  return new Evaluator(tree, toData(context) as data.Dictionary, functions).evaluate();
}

/** Whether an `if:` holds; GitHub reads one without ${{ }} as an expression, and adds success() when it names no status function. */
export function holds(condition: string | undefined, context: Record<string, Plain>, status: Status = {}): boolean {
  if (condition === undefined) return !status.failed && !status.cancelled;
  const bare = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const expr = /\b(success|failure|always|cancelled)\(\)/.test(bare) ? bare : `success() && (${bare})`;
  return truthy(evaluate(expr, context, status));
}

/** A string with ${{ }} in it, every one replaced by its value as text. */
export function template(text: string, context: Record<string, Plain>): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e: string) => evaluate(e, context).coerceString());
}

/** The environment a step's run block gets: each of its env: entries, evaluated. */
export function stepEnv(s: Step, context: Record<string, Plain>): Record<string, string> {
  return Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, template(String(v), context)]));
}

/** Every string in a parsed workflow, with where it is. */
export function strings(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => [[`${path}.${k}#key`, k] as [string, string], ...strings(v, `${path}.${k}`)]);
  return [];
}

/** What a stub command does when called: its exit code and, optionally, what it prints and a file it writes. */
export interface Stub {
  code?: number;
  stdout?: string;
  /** A file (relative to the working directory) and what the stub writes in it. */
  writes?: [string, string];
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** Each stub call: the command's name and its arguments, byte for byte. */
  calls: { cmd: string; args: string[] }[];
  /** What the run appended to GITHUB_OUTPUT. */
  output: string;
  /** The lines of the run block bash ran (from 1). */
  lines: Set<number>;
  /** The working directory, removed by the caller with done(). */
  cwd: string;
  done: () => void;
}

const BASH = process.env.CLA_TEST_BASH ?? "bash";
/** The mark of bash's trace lines (PS4), which no block prints. */
const TRACE = "cla-trace:";
const version = spawnSync(BASH, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout.trim();
if (Number(version) < 4) throw new Error(`the runner's bash is 5; ${BASH} is ${version || "missing"}: set CLA_TEST_BASH to a bash 4 or later`);

/** The C.UTF-8 locale of the runner, where this machine has it. */
const LOCALE = spawnSync("locale", ["-a"], { encoding: "utf8" }).stdout.split("\n").find((l) => /^C\.(UTF-8|utf8)$/.test(l)) ?? "C";

/** The commands a block may call; each is always a stub, so a real python3, git, gh or date never runs. */
const STUBBED = ["python3", "git", "gh", "date"];
const STUB = `#!/bin/sh
# A stub: logs its name and arguments (NUL between, a record separator after) and does what STUB_<NAME>_* say.
name=\${0##*/}
printf '%s\\0' "$name" "$@" >>"$STUB_LOG"
printf '\\036' >>"$STUB_LOG"
eval "code=\\\${STUB_\${name}_CODE:-0} out=\\\${STUB_\${name}_OUT-} path=\\\${STUB_\${name}_PATH-} text=\\\${STUB_\${name}_TEXT-}"
if [ -n "$path" ]; then mkdir -p "\${path%/*}" && printf '%s' "$text" >"$path"; fi
printf '%s' "$out"
exit "$code"
`;
let bin = "";
/** The folder of stubs, made once for the process. */
function stubs(): string {
  if (bin) return bin;
  bin = mkdtempSync(join(tmpdir(), "cla-wf-bin-"));
  for (const name of STUBBED) {
    writeFileSync(join(bin, name), STUB);
    chmodSync(join(bin, name), 0o755);
  }
  process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
  return bin;
}

/**
 * Runs a run block's text as the runner does (`bash -e` on a file), in a fresh working directory with
 * `files` in it and `env` as its whole environment, python3, git, gh and date answered by stubs first in
 * PATH as `told` says (exit 0 and no output when not told).
 */
export function runBlock(text: string, env: Record<string, string>, told: Record<string, Stub>, files: Record<string, string> = {}): Ran {
  const cwd = mkdtempSync(join(tmpdir(), "cla-wf-"));
  const scratch = mkdtempSync(join(tmpdir(), "cla-wf-run-"));
  const log = join(scratch, "calls");
  const output = join(scratch, "output");
  writeFileSync(output, "");
  writeFileSync(log, "");
  const stubEnv: Record<string, string> = { STUB_LOG: log };
  for (const [name, s] of Object.entries(told)) {
    if (!STUBBED.includes(name)) throw new Error(`${name} is not a stubbed command`);
    if (s.code !== undefined) stubEnv[`STUB_${name}_CODE`] = String(s.code);
    if (s.stdout !== undefined) stubEnv[`STUB_${name}_OUT`] = s.stdout;
    if (s.writes) [stubEnv[`STUB_${name}_PATH`], stubEnv[`STUB_${name}_TEXT`]] = s.writes;
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const script = join(scratch, "step.sh");
  writeFileSync(script, text);
  const r = spawnSync(BASH, ["-e", "-x", script], {
    cwd,
    env: { PATH: `${stubs()}:/usr/bin:/bin`, GITHUB_OUTPUT: output, LC_ALL: LOCALE, PS4: `${TRACE}\${LINENO} `, ...stubEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  // bash takes no BASH_XTRACEFD from its environment, so the trace is in stderr, each line marked.
  const traced = r.stderr.split("\n");
  const trace = traced.filter((l) => l.includes(TRACE)).join("\n");
  const stderr = traced.filter((l) => !l.includes(TRACE)).join("\n");
  const calls = readFileSync(log, "utf8")
    .split("\u001e")
    .filter(Boolean)
    .map((record) => {
      const [cmd, ...args] = record.split("\0").slice(0, -1);
      return { cmd: cmd!, args };
    });
  const ran: Ran = {
    code: r.status ?? -1,
    stdout: r.stdout,
    stderr,
    calls,
    output: readFileSync(output, "utf8"),
    lines: new Set([...trace.matchAll(/cla-trace:(\d+) /g)].map((m) => Number(m[1]))),
    cwd,
    done: () => rmSync(cwd, { recursive: true, force: true }),
  };
  rmSync(scratch, { recursive: true, force: true });
  return ran;
}

/** The lines of a run block that hold code: not blank, not a comment, not a bare keyword that closes or continues another. */
export function codeLines(text: string): number[] {
  const lines = text.split("\n");
  const out: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    const continued = i > 0 && lines[i - 1]!.trimEnd().endsWith("\\");
    if (t && !t.startsWith("#") && !/^(fi|then|else|done|esac|\}|;;)$/.test(t) && !continued) out.push(i + 1);
  });
  return out;
}

/** The block with one logical line (and the lines that continue it) deleted: a mutant of the shell. */
export function without(text: string, line: number): string {
  const lines = text.split("\n");
  let end = line;
  while (lines[end - 1]!.trimEnd().endsWith("\\")) end++;
  return [...lines.slice(0, line - 1), ...lines.slice(end)].join("\n");
}

/**
 * A table of cases for one run block: each says what it is given and checks what came out by throwing.
 * `failures` runs them all on a text and says which failed and why, so a test can require none for the
 * real text and at least one for each mutant.
 */
export interface Case {
  name: string;
  env: Record<string, string>;
  stubs?: Record<string, Stub>;
  files?: Record<string, string>;
  check: (r: Ran) => void;
}

export function failures(text: string, cases: Case[], seen?: Set<number>, first = false): string[] {
  const out: string[] = [];
  for (const c of cases) {
    if (first && out.length > 0) break;
    const r = runBlock(text, c.env, c.stubs ?? {}, c.files ?? {});
    for (const l of r.lines) seen?.add(l);
    try {
      c.check(r);
    } catch (e) {
      out.push(`${c.name}: ${(e as Error).message.split("\n")[0]!}`);
    } finally {
      r.done();
    }
  }
  return out;
}

/** One entry of a list of tests/exclusions/, as tests/tools/ratchet.py reads them. */
export interface Entry {
  kind: string;
  file: string;
  function: string;
  text: string;
  reason: string;
  why: string;
  operator?: string;
  test?: string;
}

/** The entries of tests/exclusions/<area>.toml (Python's tomllib reads it: Node has no TOML parser). */
export function listed(area: string): Entry[] {
  const r = spawnSync("python3", ["-I", "-c", "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb')).get('entry', [])))", join(ROOT, "tests", "exclusions", `${area}.toml`)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tests/exclusions/${area}.toml: ${r.stderr}`);
  return JSON.parse(r.stdout) as Entry[];
}

/**
 * Deletes each code line of a block in turn and runs the cases on what is left: every line whose deletion
 * no case notices must be listed as an equivalent mutant of that block, and every listed one must still
 * survive. Gives what is wrong.
 */
export function lineMutants(text: string, cases: Case[], file: string, where: string): string[] {
  const listedTexts = listed("workflows")
    .filter((e) => e.kind === "mutant" && e.file === file && e.function === where)
    .map((e) => e.text);
  const problems: string[] = [];
  const survivors: string[] = [];
  for (const l of codeLines(text)) {
    if (failures(without(text, l), cases, undefined, true).length === 0) survivors.push(text.split("\n")[l - 1]!.trim());
  }
  for (const s of survivors) if (!listedTexts.includes(s)) problems.push(`survives and is not listed: ${s}`);
  for (const t of listedTexts) if (!survivors.includes(t)) problems.push(`listed and killed, or gone: ${t}`);
  for (const e of listed("workflows").filter((x) => x.file === file && x.function === where)) {
    if (e.reason !== "equivalent" || !e.why.trim()) problems.push(`no reason or why: ${e.text}`);
  }
  return problems;
}
