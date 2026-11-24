// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// The agreement gate (worker/scripts/check-agreement.mjs), which `npm run
// deploy` and the agreement-digests hook run: each tampering of a copy of the
// texts and of registry/config.json is refused by its own message, and the
// script run from a copy of the tree gives the same verdicts as check().
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { check, exitCode, sentenceFor } from "../../worker/scripts/check-agreement.mjs";
import { hookArgs } from "../../tests/tools/node/child.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "worker", "scripts", "check-agreement.mjs");
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

interface Version {
  path: string;
  set_sha256: string;
  files: Record<string, string>;
  flow: string;
  sentence: string;
}
interface Config {
  current_version: number;
  accepted_versions: number[];
  versions: Record<string, Version>;
}

const live = JSON.parse(readFileSync(join(ROOT, "registry", "config.json"), "utf8")) as Config;
const SETS = Object.fromEntries(Object.entries(live.versions).map(([v, i]) => [v, i.set_sha256]));

const trees: string[] = [];
after(() => {
  for (const t of trees) rmSync(t, { recursive: true, force: true });
});

/** A copy of what the gate reads (the configuration and every version's folder), changed by `edit`. */
function tree(edit: (t: { root: string; config: Config; file: (version: string, name: string) => string }) => void = () => undefined): string {
  const root = mkdtempSync(join(tmpdir(), "cla-agreement-"));
  trees.push(root);
  const config = structuredClone(live);
  for (const info of Object.values(config.versions)) cpSync(join(ROOT, info.path), join(root, info.path), { recursive: true });
  const file = (version: string, name: string): string => join(root, config.versions[version]!.path, name);
  edit({ root, config, file });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "config.json"), JSON.stringify(config));
  return root;
}

/** What check() says of a tree: its verdict, then every line in the order it was given. */
function verdict(root: string): { ok: boolean; log: string[]; error: string[] } {
  const log: string[] = [];
  const error: string[] = [];
  const ok = check(root, { log: (l) => log.push(l), error: (l) => error.push(l) });
  return { ok, log, error };
}

const okLine = (v: string): string => `check-agreement: v${v} ok, set SHA-256 ${SETS[v]!}`;

/** SHA256SUMS of a version with its lines replaced, and the configuration made to agree with the new set digest. */
function resum(t: { config: Config; file: (version: string, name: string) => string }, version: string, lines: (old: string[]) => string[]): string {
  const old = readFileSync(t.file(version, "SHA256SUMS"), "utf8").split("\n").filter(Boolean);
  const text = lines(old).join("\n") + "\n";
  writeFileSync(t.file(version, "SHA256SUMS"), text);
  const set = sha(text);
  const info = t.config.versions[version]!;
  info.set_sha256 = set;
  info.sentence = sentenceFor(version, set);
  return set;
}

describe("check-agreement.mjs", () => {
  it("the repository's own texts pass, one line per version", () => {
    const r = verdict(ROOT);
    assert.deepEqual(r, { ok: true, log: [okLine("1"), okLine("2")], error: [] });
  });

  it("an untouched copy passes exactly as the repository does", () => {
    assert.deepEqual(verdict(tree()), verdict(ROOT));
  });

  it("a changed byte of a binding text is refused with both digests", () => {
    const root = tree((t) => writeFileSync(t.file("2", "addendum.md"), readFileSync(t.file("2", "addendum.md"), "utf8").replace("Addendum", "Addendun")));
    const actual = sha(readFileSync(join(root, "agreements/v2/addendum.md")));
    assert.deepEqual(verdict(root), {
      ok: false,
      log: [okLine("1")],
      error: [`check-agreement: v2: addendum.md hashes to ${actual}, SHA256SUMS says ${live.versions["2"]!.files["addendum.md"]!}`],
    });
  });

  it("once a version fails, no later version is said to be ok", () => {
    const root = tree((t) => writeFileSync(t.file("1", "entity.md"), "changed\n"));
    const r = verdict(root);
    assert.equal(r.ok, false);
    assert.deepEqual(r.log, []);
    assert.deepEqual(r.error, [`check-agreement: v1: entity.md hashes to ${sha("changed\n")}, SHA256SUMS says ${live.versions["1"]!.files["entity.md"]!}`]);
  });

  it("a binding text SHA256SUMS does not list is refused by name", () => {
    let set = "";
    const root = tree((t) => (set = resum(t, "1", (old) => old.filter((l) => !l.endsWith("  entity.md")))));
    assert.deepEqual(verdict(root), { ok: false, log: [], error: ["check-agreement: v1: SHA256SUMS does not list entity.md"] });
    assert.notEqual(set, SETS["1"]);
  });

  it("every one of the three binding texts must be listed", () => {
    for (const name of ["individual.md", "entity.md", "addendum.md"]) {
      const root = tree((t) => resum(t, "2", (old) => old.filter((l) => !l.endsWith(`  ${name}`))));
      assert.deepEqual(verdict(root).error, [`check-agreement: v2: SHA256SUMS does not list ${name}`], name);
    }
  });

  it("a SHA256SUMS line of any other shape is refused and quoted", () => {
    const digest = live.versions["1"]!.files["individual.md"]!;
    const bad = [`${digest.toUpperCase()}  individual.md`, `${digest} individual.md`, `${digest}  individual.md\r`, `${digest}  ../individual.md`, `${digest.slice(1)}  individual.md`, `${digest}0  individual.md`, " ", `x${digest}  individual.md`, `${digest}  individual.md x`];
    for (const line of bad) {
      const root = tree((t) => resum(t, "1", (old) => [...old, line]));
      assert.deepEqual(verdict(root), { ok: false, log: [], error: [`check-agreement: v1: bad SHA256SUMS line ${JSON.stringify(line)}`] }, JSON.stringify(line));
    }
  });

  it("a binding text that is listed and missing is refused by name, and the other versions still checked", () => {
    const root = tree((t) => rmSync(t.file("1", "addendum.md")));
    assert.deepEqual(verdict(root), { ok: false, log: [], error: ["check-agreement: v1: addendum.md is listed in SHA256SUMS and cannot be read"] });
  });

  it("a version with no SHA256SUMS is refused by name", () => {
    const root = tree((t) => rmSync(t.file("2", "SHA256SUMS")));
    assert.deepEqual(verdict(root), { ok: false, log: [okLine("1")], error: ["check-agreement: v2: agreements/v2/SHA256SUMS cannot be read"] });
  });

  it("an empty line of SHA256SUMS is no line, though it changes the set digest", () => {
    const root = tree((t) => writeFileSync(t.file("1", "SHA256SUMS"), readFileSync(t.file("1", "SHA256SUMS"), "utf8") + "\n"));
    const set = sha(readFileSync(join(root, "agreements/v1/SHA256SUMS")));
    assert.deepEqual(verdict(root), {
      ok: false,
      log: [],
      error: [`check-agreement: v1: set digest ${set}, config.json says ${SETS["1"]!}`, "check-agreement: v1: the sentence in config.json is not the one built from the digest"],
    });
  });

  it("a file the configuration names with another digest than SHA256SUMS is refused", () => {
    const listed = live.versions["2"]!.files["individual.md"]!;
    const root = tree((t) => (t.config.versions["2"]!.files["individual.md"] = "0".repeat(64)));
    assert.deepEqual(verdict(root), { ok: false, log: [okLine("1")], error: [`check-agreement: v2: config.json names ${"0".repeat(64)} for individual.md, SHA256SUMS ${listed}`] });
  });

  it("a set digest the configuration does not name is refused", () => {
    const root = tree((t) => (t.config.versions["1"]!.set_sha256 = "f".repeat(64)));
    assert.deepEqual(verdict(root), { ok: false, log: [], error: [`check-agreement: v1: set digest ${SETS["1"]!}, config.json says ${"f".repeat(64)}`] });
  });

  it("a sentence that differs by one character from the one built from the digest is refused", () => {
    const root = tree((t) => (t.config.versions["2"]!.sentence = t.config.versions["2"]!.sentence.replace("licences", "licenses")));
    assert.deepEqual(verdict(root), { ok: false, log: [okLine("1")], error: ["check-agreement: v2: the sentence in config.json is not the one built from the digest"] });
  });

  it("the sentence names the version and the first twelve digits of the set digest", () => {
    assert.match(sentenceFor("7", "0123456789abcdef"), /, version 7 \(SHA-256 0123456789ab\), made of /);
    for (const [v, info] of Object.entries(live.versions)) assert.equal(sentenceFor(v, info.set_sha256), info.sentence);
  });

  it("the flow is comment or signin, and nothing else", () => {
    for (const flow of ["comment", "signin"]) assert.equal(verdict(tree((t) => (t.config.versions["1"]!.flow = flow))).ok, true, flow);
    for (const flow of ["", "email", "Signin", undefined]) {
      const root = tree((t) => (t.config.versions["1"]!.flow = flow as string));
      assert.deepEqual(verdict(root), { ok: false, log: [], error: ['check-agreement: v1: flow must be "comment" or "signin"'] }, String(flow));
    }
  });

  it("a current version that is not accepted is refused after every version is checked", () => {
    const root = tree((t) => (t.config.accepted_versions = [1]));
    assert.deepEqual(verdict(root), { ok: false, log: [okLine("1"), okLine("2")], error: ["check-agreement: current_version is not an accepted version"] });
  });

  it("every failure of a version is said, in the order of the checks", () => {
    const root = tree((t) => {
      writeFileSync(t.file("1", "individual.md"), "x");
      const info = t.config.versions["1"]!;
      info.files["individual.md"] = "1".repeat(64);
      info.set_sha256 = "2".repeat(64);
      info.sentence = "x";
      info.flow = "x";
      t.config.current_version = 9;
    });
    assert.deepEqual(verdict(root).error, [
      `check-agreement: v1: individual.md hashes to ${sha("x")}, SHA256SUMS says ${live.versions["1"]!.files["individual.md"]!}`,
      `check-agreement: v1: config.json names ${"1".repeat(64)} for individual.md, SHA256SUMS ${live.versions["1"]!.files["individual.md"]!}`,
      `check-agreement: v1: set digest ${SETS["1"]!}, config.json says ${"2".repeat(64)}`,
      "check-agreement: v1: the sentence in config.json is not the one built from the digest",
      'check-agreement: v1: flow must be "comment" or "signin"',
      "check-agreement: current_version is not an accepted version",
    ]);
  });

  it("with no version at all, only the current version is checked", () => {
    const root = tree((t) => (t.config.versions = {}));
    assert.deepEqual(verdict(root), { ok: true, log: [], error: [] });
  });

  it("the Worker builds the very sentence the gate and the configuration hold", () => {
    const web = readFileSync(join(ROOT, "worker", "src", "web.ts"), "utf8");
    const template = /export function sentenceFor\(version: number, setSha256: string\): string \{\n {2}return `([^`]+)`;/.exec(web)?.[1];
    assert.ok(template, "worker/src/web.ts no longer builds the sentence where this test reads it");
    for (const [v, info] of Object.entries(live.versions)) {
      const worker: string = template.replace("${version}", v).replace("${setSha256.slice(0, 12)}", info.set_sha256.slice(0, 12));
      assert.equal(worker, sentenceFor(v, info.set_sha256), `v${v}`);
      assert.equal(worker, info.sentence, `v${v}`);
    }
  });

  it("a check that passed exits 0, one that failed 1", () => {
    assert.deepEqual([exitCode(true), exitCode(false)], [0, 1]);
  });

  it("the script, run on this repository, exits 0 with the lines check() gives", () => {
    const r = spawnSync(process.execPath, [...hookArgs(), SCRIPT], { cwd: tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    const v = verdict(ROOT);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, v.log.map((l) => `${l}\n`).join(""), ""]);
  });

  it("the script itself exits 0 on a good tree and 1 on a tampered one, with the same lines", () => {
    for (const [root, code] of [
      [tree(), 0],
      [tree((t) => (t.config.versions["2"]!.flow = "email")), 1],
    ] as const) {
      // A copy of the script in the tree finds the tree's root from its own place.
      mkdirSync(join(root, "worker", "scripts"), { recursive: true });
      cpSync(SCRIPT, join(root, "worker", "scripts", "check-agreement.mjs"));
      const r = spawnSync(process.execPath, [...hookArgs(), join(root, "worker", "scripts", "check-agreement.mjs")], { cwd: tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
      const v = verdict(root);
      assert.equal(r.status, code);
      assert.equal(r.stdout, v.log.map((l) => `${l}\n`).join(""));
      assert.equal(r.stderr, v.error.map((l) => `${l}\n`).join(""));
    }
  });
});
