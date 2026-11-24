// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What every workflow of the repository must be, read from the parsed
 * YAML: no secret but the sign-in app's, and only where record.yml's
 * sign-in job runs the recorder; no pull_request_target; every action and
 * reusable workflow pinned by its commit; permissions stated, and read-only
 * in CI; the recorder always run isolated (`python3 -I`); no checkout that
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
    assert.deepEqual(NAMES, ["ci.yml", "commit-check-comment.yml", "commit-check.yml", "mutation.yml", "quality-drift.yml", "record.yml", "verify.yml"]);
  });

  it("states its permissions at the top, none or read-only", () => {
    for (const [n, wf] of ALL) assert.ok([JSON.stringify({}), JSON.stringify({ contents: "read" })].includes(JSON.stringify(wf.permissions)), n);
  });

  it("never runs on pull_request_target", () => {
    for (const [n, wf] of ALL) assert.ok(!Object.hasOwn(wf.on, "pull_request_target"), n);
  });

  it("pins every action and reusable workflow by a full commit", () => {
    for (const [n, wf] of ALL) {
      for (const [where, s] of strings(wf.jobs)) {
        if (!where.endsWith(".uses")) continue;
        assert.match(s, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${n} ${where}: ${s}`);
      }
    }
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

  it("reads the repository and writes nothing; only SonarCloud may ask for an OIDC token", () => {
    assert.deepEqual(ci.permissions, { contents: "read" });
    for (const [job, j] of Object.entries(ci.jobs)) {
      const want = job === "sonarcloud" ? { contents: "read", "id-token": "write" } : { contents: "read" };
      if (j.permissions !== undefined || j.uses !== undefined) assert.deepEqual(j.permissions, want, job);
    }
  });

  it("the mutation runs read the repository and nothing else", () => {
    const m = workflow("mutation.yml");
    assert.deepEqual(m.permissions, { contents: "read" });
    for (const [job, j] of Object.entries(m.jobs)) assert.equal(j.permissions, undefined, job);
  });
});
