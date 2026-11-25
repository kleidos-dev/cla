// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What every workflow of the repository must be, read from the parsed
 * YAML: no secret but the sign-in app's, and only where record.yml's
 * sign-in job runs the recorder; no pull_request_target; every action
 * pinned by its commit, and the quality kit called by its branch, v3, and
 * nothing else by a name; permissions stated, and read-only in CI; the gate
 * over every job of CI, under the names the rulesets require; the recorder always run isolated (`python3 -I`); no checkout that
 * keeps its credentials. GitHub's own enforcement of these (environment
 * branch policy, token permissions) is not something a test can run.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROOT, strings, workflow } from "./support.mts";
import type { Workflow } from "./support.mts";

const NAMES = readdirSync(join(ROOT, ".github", "workflows")).filter((f) => f.endsWith(".yml")).sort();
const ALL: [string, Workflow][] = NAMES.map((n) => [n, workflow(n)]);

describe("every workflow", () => {
  it("is one of those this suite knows", () => {
    assert.deepEqual(NAMES, ["ci.yml", "commit-check-comment.yml", "mutation.yml", "record.yml", "verify.yml"]);
  });

  it("states its permissions at the top, none or read-only", () => {
    for (const [n, wf] of ALL) assert.ok([JSON.stringify({}), JSON.stringify({ contents: "read" })].includes(JSON.stringify(wf.permissions)), n);
  });

  it("never runs on pull_request_target", () => {
    for (const [n, wf] of ALL) assert.ok(!Object.hasOwn(wf.on, "pull_request_target"), n);
  });

  it("pins every action by a full commit, and calls the quality kit's workflows, and no other, at the branch v3", () => {
    const kit: string[] = [];
    for (const [n, wf] of ALL) {
      for (const [where, s] of strings(wf.jobs)) {
        if (!where.endsWith(".uses")) continue;
        if (s.startsWith("kleidos-dev/.github/")) kit.push(`${n}${where.replace(".jobs", "")}=${s}`);
        else assert.match(s, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${n} ${where}: ${s}`);
      }
      for (const [job, j] of Object.entries(wf.jobs)) if (j.uses !== undefined) assert.ok(j.uses.startsWith("kleidos-dev/.github/"), `${n}/${job}: ${j.uses}`);
    }
    assert.deepEqual(kit, [
      "ci.yml.quick.uses=kleidos-dev/.github/.github/workflows/quick.yml@v3",
      "ci.yml.check.uses=kleidos-dev/.github/.github/workflows/check.yml@v3",
      "ci.yml.sonar.uses=kleidos-dev/.github/.github/workflows/sonar.yml@v3",
      "commit-check-comment.yml.comment.uses=kleidos-dev/.github/.github/workflows/reusable-commit-check-comment.yml@v3",
    ]);
  });

  it("names a secret only for the sign-in app, in record.yml's sign-in recorder, and hands none to a reusable workflow", () => {
    const found = ALL.flatMap(([n, wf]) => strings(wf).filter(([, s]) => /\$\{\{[^}]*\bsecrets\b/.test(s)).map(([where, s]) => `${n}${where}=${s}`));
    assert.deepEqual(found, ["record.yml.jobs.signin.steps[1].env.SIGNIN_CLIENT_SECRET=${{ secrets.SIGNIN_CLIENT_SECRET }}"]);
    for (const [n, wf] of ALL) for (const [job, j] of Object.entries(wf.jobs)) assert.ok(!Object.hasOwn(j, "secrets"), `${n}/${job} passes secrets on`);
  });

  it("takes an environment only in record.yml's sign-in job", () => {
    const found = ALL.flatMap(([n, wf]) => Object.entries(wf.jobs).filter(([, j]) => j.environment !== undefined).map(([job, j]) => `${n}/${job}=${String(j.environment)}`));
    assert.deepEqual(found, ["record.yml/signin=signin"]);
  });

  it("checks out without keeping the credentials", () => {
    for (const [n, wf] of ALL) {
      for (const [job, j] of Object.entries(wf.jobs)) {
        for (const s of j.steps ?? []) if (s.uses?.startsWith("actions/checkout@")) assert.equal(s.with?.["persist-credentials"], false, `${n}/${job}`);
      }
    }
  });

  it("runs the recorder only isolated from the checkout's Python path", () => {
    let runs = 0;
    for (const [n, wf] of ALL) {
      for (const [where, s] of strings(wf.jobs)) {
        if (!where.endsWith(".run")) continue;
        for (const m of s.matchAll(/python3?(\s+-\S+)*\s+registry\/cla\.py/g)) {
          runs++;
          assert.match(m[0], /^python3 -I registry\/cla\.py$/, `${n} ${where}`);
        }
      }
    }
    assert.equal(runs, 4);
  });

  it("gives every job that runs steps a time limit", () => {
    for (const [n, wf] of ALL) for (const [job, j] of Object.entries(wf.jobs)) if (j.steps) assert.equal(typeof j["timeout-minutes"], "number", `${n}/${job}`);
  });
});

describe("CI", () => {
  const ci = workflow("ci.yml");

  it("runs on pushes and pull requests to main, weekly and by hand, and nothing else", () => {
    assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);
    assert.deepEqual(ci.on.push, { branches: ["main"] });
    assert.deepEqual(ci.on.pull_request, { branches: ["main"] });
  });

  it("reads the repository and writes nothing; only SonarCloud may ask for an OIDC token, and the gate reads nothing", () => {
    assert.deepEqual(ci.permissions, { contents: "read" });
    const own: Record<string, unknown> = { sonar: { contents: "read", "id-token": "write" }, done: {} };
    for (const [job, j] of Object.entries(ci.jobs)) {
      if (j.permissions !== undefined || j.uses !== undefined) assert.deepEqual(j.permissions, own[job] ?? { contents: "read" }, job);
    }
  });

  it("keeps every gate of docs/testing.md under its name, the two the ruleset requires among them, and the last one over all the others", () => {
    const names = Object.fromEntries(Object.entries(ci.jobs).map(([job, j]) => [job, j.name]));
    assert.deepEqual(names, {
      quick: "⚡ Quick",
      check: "🧪 Check",
      worker: "🧪 Worker tests",
      scripts: "🔑 Setup scripts and workflows",
      "scripts-mutants": "🧬 Mutants of the changed scripts",
      "register-mutants": "🧬 Mutants of the changed register lines",
      "worker-mutants": "🧬 Mutants of the changed Worker lines",
      pages: "🌐 Pages",
      floors: "🧭 Floors and lists against the base",
      coverage: "📦 Coverage reports",
      sonar: "📊 Sonar",
      done: "✅ Check",
    });
    const others = Object.keys(ci.jobs).filter((job) => job !== "done");
    assert.deepEqual(ci.jobs["done"]!.needs, others);
    assert.equal(ci.jobs["done"]!.if, "always()");
    // The jobs a condition may skip, and no other, are those the gate lets be skipped.
    const conditions = Object.fromEntries(others.filter((job) => ci.jobs[job]!.if !== undefined).map((job) => [job, ci.jobs[job]!.if]));
    assert.deepEqual(conditions, {
      "scripts-mutants": "github.event_name == 'pull_request'",
      "register-mutants": "github.event_name == 'pull_request'",
      "worker-mutants": "github.event_name == 'pull_request'",
      floors: "github.event_name == 'pull_request'",
      coverage: "github.event_name != 'schedule'",
      sonar: "github.event_name != 'schedule'",
    });
    assert.equal(ci.jobs["done"]!.steps![0]!.env!["MAY_SKIP"], Object.keys(conditions).join(" "));
    // The register's tests, the one suite the kit's check job runs, whole.
    assert.equal(
      String(ci.jobs["check"]!.with!["tests"]).trim(),
      "python -m coverage run tests/tools/py/count.py registry/tests coverage/register-tests.json && python -m coverage xml && python3 tests/tools/ratchet.py tests register --report coverage/register-tests.json || { python -m coverage report --show-missing --skip-covered; exit 1; }",
    );
  });

  it("the mutation runs read the repository and nothing else", () => {
    const m = workflow("mutation.yml");
    assert.deepEqual(m.permissions, { contents: "read" });
    for (const [job, j] of Object.entries(m.jobs)) assert.equal(j.permissions, undefined, job);
  });
});
