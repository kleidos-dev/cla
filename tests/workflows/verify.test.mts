// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * .github/workflows/verify.yml, the register's checker: what it fetches,
 * what it passes to registry/cla.py verify for each state of its cache, and
 * that the commit it cross-checked moves only after a verification that
 * passed, from the real text of the workflow, with date stubbed (the
 * runner's GNU date) and every code line run and, deleted, noticed.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codeLines, failures, holds, lineMutants, step, stepEnv, workflow } from "./support.mts";
import type { Case, Ran } from "./support.mts";

const wf = workflow("verify.yml");
const HEX = "89abcdef0123456789abcdef0123456789abcdef";
const NEXT = "0123456789abcdef0123456789abcdef01234567";
const context = (event: string) => ({ github: { event_name: event, token: "ghs_madeUpJobToken", server_url: "https://github.com", repository: "kleidos-dev/cla", run_id: "77" } });
const calls = (r: Ran, cmd: string) => r.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const marker = (r: Ran, name: string) => (existsSync(join(r.cwd, ".verify", name)) ? readFileSync(join(r.cwd, ".verify", name), "utf8") : null);

describe("the triggers and the job", () => {
  it("runs after a Record run, weekly and by hand, one run at a time, never cancelled", () => {
    assert.deepEqual(wf.on, { workflow_run: { workflows: ["Record"], types: ["completed"] }, schedule: [{ cron: "41 5 * * 1" }], workflow_dispatch: null });
    assert.deepEqual(wf.concurrency, { group: "verify", "cancel-in-progress": false });
  });

  it("reads the code and the runs, and may only open an issue", () => {
    assert.deepEqual(wf.permissions, {});
    assert.deepEqual(wf.jobs.verify!.permissions, { contents: "read", actions: "read", issues: "write" });
    assert.equal(wf.jobs.verify!["timeout-minutes"], 10);
    assert.deepEqual(wf.jobs.verify!.steps![0]!.with, { ref: "main", "fetch-depth": 0, "persist-credentials": false });
  });

  it("keeps the cross-checked commit in a cache keyed by the run, restored from the newest", () => {
    const restore = wf.jobs.verify!.steps!.find((s) => s.uses?.startsWith("actions/cache/restore@"))!;
    const save = wf.jobs.verify!.steps!.find((s) => s.uses?.startsWith("actions/cache/save@"))!;
    assert.deepEqual(restore.with, { path: ".verify", key: "verified-${{ github.run_id }}", "restore-keys": "verified-" });
    assert.deepEqual(save.with, { path: ".verify", key: "verified-${{ github.run_id }}" });
    // The save runs only when the verification passed (no if: means success()).
    assert.equal(holds(save.if, context("schedule"), { failed: false }), true);
    assert.equal(holds(save.if, context("schedule"), { failed: true }), false);
  });
});

describe("fetching the register", () => {
  it("fetches the signatures branch alone, without tags", () => {
    const block = step(wf, "verify", "Fetch the signatures branch");
    const cases: Case[] = [
      { name: "the fetch", env: {}, check: (r) => assert.deepEqual([r.code, calls(r, "git")], [0, [["fetch", "--no-tags", "origin", "+refs/heads/signatures:refs/remotes/origin/signatures"]]]) },
      { name: "a failed fetch fails", env: {}, stubs: { git: { code: 128 } }, check: (r) => assert.equal(r.code, 128) },
    ];
    assert.deepEqual(failures(block.run!, cases), []);
    assert.deepEqual(lineMutants(block.run!, cases, ".github/workflows/verify.yml", "verify/Fetch the signatures branch"), []);
  });
});

describe("the verification", () => {
  const block = step(wf, "verify", "Verify");
  const text = block.run!;
  const env = stepEnv(block, context("workflow_run"));
  const date = { stdout: "2026-11-15\n" };
  const verify = (...since: string[]) => [["-I", "registry/cla.py", "verify", "--ref", "origin/signatures", "--merged-since", "2026-11-15", "--marker-out", ".verify/next", ...since]];
  const writesNext = { writes: [".verify/next", `${NEXT}\n`] as [string, string] };
  const withHead = (head: string, name: string, since: string[]): Case => ({
    name,
    env,
    stubs: { date },
    files: { ".verify/head": head },
    check: (r) => assert.deepEqual([r.code, calls(r, "python3"), marker(r, "head")], [0, verify(...since), head]),
  });
  const seen = new Set<number>();
  const cases: Case[] = [
    {
      name: "the first run: no cache, every record cross-checked, merges of the last nine days, by GNU date",
      env,
      stubs: { date },
      check: (r) => {
        assert.deepEqual([r.code, calls(r, "python3"), calls(r, "date")], [0, verify(), [["-u", "-d", "-9 days", "+%Y-%m-%d"]]]);
        assert.equal(existsSync(join(r.cwd, ".verify")), true);
      },
    },
    withHead(`${HEX}\n`, "a cached commit: only what came after it", ["--since", HEX]),
    withHead(` \t${HEX} \n\n`, "white space around the cached commit is no part of it", ["--since", HEX]),
    withHead(HEX.toUpperCase(), "a commit in capitals is not one", []),
    withHead(HEX.slice(1), "39 digits are not a commit", []),
    withHead(`${HEX}0`, "41 digits are not a commit", []),
    withHead(`${HEX.slice(0, 20)} ${HEX.slice(20)}`, "a commit cut by a space reads as one: tr takes every blank", ["--since", HEX]),
    withHead(`$(touch x)${HEX}`, "anything else in the file is no commit, and is not run", []),
    withHead("", "an empty file is no commit", []),
    {
      name: "a passing run with a new marker moves it into place",
      env,
      stubs: { date, python3: writesNext },
      files: { ".verify/head": `${HEX}\n` },
      check: (r) => assert.deepEqual([r.code, marker(r, "head"), marker(r, "next")], [0, `${NEXT}\n`, null]),
    },
    {
      name: "a passing run that wrote no marker keeps the old one",
      env,
      stubs: { date },
      files: { ".verify/head": `${HEX}\n` },
      check: (r) => assert.deepEqual([r.code, marker(r, "head"), marker(r, "next")], [0, `${HEX}\n`, null]),
    },
    {
      name: "an empty new marker is not moved",
      env,
      stubs: { date, python3: { writes: [".verify/next", ""] } },
      files: { ".verify/head": `${HEX}\n` },
      check: (r) => assert.deepEqual([r.code, marker(r, "head"), marker(r, "next")], [0, `${HEX}\n`, ""]),
    },
    {
      name: "a failing run never moves the marker, whatever it wrote",
      env,
      stubs: { date, python3: { ...writesNext, code: 1 } },
      files: { ".verify/head": `${HEX}\n` },
      check: (r) => assert.deepEqual([r.code, marker(r, "head"), marker(r, "next")], [1, `${HEX}\n`, `${NEXT}\n`]),
    },
    {
      name: "a failing date stops everything before the verifier",
      env,
      stubs: { date: { code: 1 } },
      check: (r) => assert.deepEqual([r.code, calls(r, "python3")], [1, []]),
    },
  ];

  it("passes the right arguments for each state of the cache and moves the marker only after a pass", () => {
    assert.deepEqual(failures(text, cases, seen), []);
  });

  it("every code line ran, and deleting any one of them fails a case", () => {
    assert.deepEqual(codeLines(text).filter((l) => !seen.has(l)), []);
    assert.deepEqual(lineMutants(text, cases, ".github/workflows/verify.yml", "verify/Verify"), []);
  });

  it("the verifier gets the job's token through its environment only", () => {
    assert.deepEqual(env, { GITHUB_TOKEN: "ghs_madeUpJobToken" });
  });
});

describe("the report of a failed verification", () => {
  const block = step(wf, "verify", "Report the problems");

  it("runs only when a step before failed", () => {
    assert.equal(holds(block.if, context("schedule"), { failed: true }), true);
    assert.equal(holds(block.if, context("schedule"), { failed: false }), false);
  });

  it("opens one issue in this repository with the run", () => {
    const env = { ...stepEnv(block, context("schedule")), GITHUB_REPOSITORY: "kleidos-dev/cla" };
    const cases: Case[] = [
      {
        name: "the issue",
        env,
        check: (r) =>
          assert.deepEqual(
            [r.code, calls(r, "gh")],
            [0, [["issue", "create", "--repo", "kleidos-dev/cla", "--title", "The register did not verify", "--body", "verify.yml found problems in the signatures branch or a merged pull request without coverage. Run: https://github.com/kleidos-dev/cla/actions/runs/77"]]],
          ),
      },
    ];
    const seen = new Set<number>();
    assert.deepEqual(failures(block.run!, cases, seen), []);
    assert.deepEqual(codeLines(block.run!).filter((l) => !seen.has(l)), []);
    assert.deepEqual(lineMutants(block.run!, cases, ".github/workflows/verify.yml", "verify/Report the problems"), []);
  });
});
