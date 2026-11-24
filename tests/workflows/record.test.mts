// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * .github/workflows/record.yml, the register's only writer: which job runs
 * for which trigger, what a run shows of its inputs, and what each run
 * block passes to registry/cla.py for every input at its edges, from the
 * real text of the workflow. Every code line of every block runs, and
 * every one of them, deleted, makes a case fail.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECORD_INPUTS } from "../../worker/test/record-inputs.ts";
import { codeLines, failures, holds, lineMutants, runBlock, step, stepEnv, strings, template, without, workflow } from "./support.mts";
import type { Case, Ran } from "./support.mts";

const wf = workflow("record.yml");
const TOKEN = "ghu_madeUpSigninToken0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef01234567";

/** Inputs as a dispatch gives them: every input there, "" when not given. */
function inputs(given: Record<string, string>): Record<string, string> {
  return { kind: "", repo: "", pr: "", comment_id: "", github_id: "", version: "", lang: "", site_commit: "", signin_token: "", ...given };
}
const context = (event: string, given: Record<string, string> = {}) => ({
  github: { event_name: event, token: "ghs_madeUpJobToken", server_url: "https://github.com", repository: "kleidos-dev/cla", run_id: "42", sha: HEX },
  inputs: event === "workflow_dispatch" ? inputs(given) : {},
  secrets: { SIGNIN_CLIENT_SECRET: "made-up-client-secret" },
});

/** The lines each block ran, over every case of the file. */
const seen = new Map<string, Set<number>>();
const ran = (block: string) => {
  const s = seen.get(block) ?? new Set<number>();
  seen.set(block, s);
  return s;
};

const argv = (r: Ran, cmd = "python3") => r.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

describe("which job runs", () => {
  const jobs = (event: string, kind?: string) =>
    Object.entries(wf.jobs)
      .filter(([, j]) => holds(j.if, context(event, kind === undefined ? {} : { kind })))
      .map(([name]) => name);

  it("a dispatch runs exactly the job of its kind, and the schedule only the stamp", () => {
    assert.deepEqual(jobs("workflow_dispatch", "sign"), ["record"]);
    assert.deepEqual(jobs("workflow_dispatch", "coverage"), ["record"]);
    assert.deepEqual(jobs("workflow_dispatch", "signin"), ["signin"]);
    assert.deepEqual(jobs("workflow_dispatch", "stamp"), ["stamp"]);
    assert.deepEqual(jobs("schedule"), ["stamp"]);
  });

  it("no other trigger or kind runs any job", () => {
    for (const event of ["push", "pull_request", "workflow_run", "repository_dispatch"]) assert.deepEqual(jobs(event, "sign"), [], event);
    for (const kind of ["", "redact", "sign "]) assert.deepEqual(jobs("workflow_dispatch", kind), [], JSON.stringify(kind));
  });

  it("GitHub compares the kind without case, as it does every string", () => {
    // A choice input refuses "Sign" at dispatch, and cla.py refuses --kind Sign: the record block passes it on as given.
    assert.deepEqual(jobs("workflow_dispatch", "Sign"), ["record"]);
  });

  it("only the sign-in job takes the signin environment, and only on the commit it was dispatched on", () => {
    assert.deepEqual(Object.entries(wf.jobs).map(([n, j]) => [n, j.environment ?? null]), [["record", null], ["signin", "signin"], ["stamp", null]]);
    const checkout = (job: string) => wf.jobs[job]!.steps!.find((s) => s.uses?.startsWith("actions/checkout@"))!.with;
    assert.deepEqual(checkout("signin"), { ref: "${{ github.sha }}", "persist-credentials": false });
    assert.deepEqual(checkout("record"), { ref: "main", "persist-credentials": false });
    assert.deepEqual(checkout("stamp"), { ref: "main", "persist-credentials": false });
  });

  it("each job may write the register and no more; only the recorder may open an issue", () => {
    assert.deepEqual(wf.permissions, {});
    assert.deepEqual(wf.jobs.record!.permissions, { contents: "write", issues: "write" });
    assert.deepEqual(wf.jobs.signin!.permissions, { contents: "write" });
    assert.deepEqual(wf.jobs.stamp!.permissions, { contents: "write" });
    assert.deepEqual(Object.values(wf.jobs).map((j) => j["timeout-minutes"]), [5, 5, 10]);
  });
});

describe("what other code depends on", () => {
  it("is named Record, the name verify.yml's workflow_run starts after", () => {
    assert.equal(wf.name, "Record");
    assert.deepEqual(workflow("verify.yml").on.workflow_run, { workflows: [wf.name], types: ["completed"] });
  });

  it("runs by dispatch and on the daily stamp schedule, and nothing else", () => {
    assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch", "schedule"]);
    assert.deepEqual(wf.on.schedule, [{ cron: "23 4 * * *" }]);
  });

  it("declares the inputs the Worker and the owner dispatch with: their names, types, options and defaults", () => {
    const declared = (wf.on.workflow_dispatch as { inputs: Record<string, Record<string, unknown>> }).inputs;
    const text = { type: "string", required: false, default: "" };
    assert.deepEqual(
      Object.fromEntries(Object.entries(declared).map(([k, { description: _, ...v }]) => [k, v])),
      { kind: { type: "choice", options: ["sign", "coverage", "signin", "stamp"], required: true }, repo: text, pr: text, comment_id: text, github_id: text, version: text, lang: text, site_commit: text, signin_token: text },
    );
    // The fake GitHub of the Worker's and the pages' tests refuses a dispatch with any input this file does not declare.
    assert.deepEqual(Object.fromEntries(Object.entries(declared).map(([k, v]) => [k, (v.options as string[] | undefined) ?? null])), RECORD_INPUTS);
  });
});

describe("the shape of the file", () => {
  it("has these keys and no other at the top, in each job and in each step", () => {
    assert.deepEqual(Object.keys(wf), ["name", "run-name", "on", "permissions", "concurrency", "jobs"]);
    const job = ["name", "if", "runs-on", "timeout-minutes", "permissions", "steps"];
    assert.deepEqual(Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, Object.keys(j)])), { record: job, signin: ["name", "if", "runs-on", "timeout-minutes", "environment", "permissions", "steps"], stamp: job });
    const steps = Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, j.steps!.map((x) => [x.name ?? x.uses!.replace(/@.*/, ""), Object.keys(x)])]));
    assert.deepEqual(steps, {
      record: [
        ["actions/checkout", ["uses", "with"]],
        ["Record", ["name", "id", "env", "run"]],
        ["Report a merged pull request the register cannot cover", ["name", "if", "env", "run"]],
      ],
      signin: [
        ["actions/checkout", ["uses", "with"]],
        ["Record", ["name", "env", "run"]],
      ],
      stamp: [
        ["actions/checkout", ["uses", "with"]],
        ["Stamp", ["name", "env", "run"]],
      ],
    });
  });

  it("no job or step may fail and pass all the same, and every job runs on GitHub's own runner", () => {
    for (const [n, j] of Object.entries(wf.jobs)) {
      assert.equal(j["runs-on"], "ubuntu-latest", n);
      assert.ok(!Object.hasOwn(j, "continue-on-error"), n);
      for (const x of j.steps!) assert.ok(!Object.hasOwn(x, "continue-on-error"), `${n}/${x.name ?? x.uses ?? ""}`);
    }
  });

  it("only the recorder reads the event payload, which holds the sign-in token", () => {
    const code = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    for (const [where, text] of strings(wf.jobs)) assert.doesNotMatch(code(text), /GITHUB_EVENT_PATH|github\.event\b/, where);
  });
});

describe("what a run shows", () => {
  const combos = [
    context("workflow_dispatch", { kind: "sign", repo: "kleidos-dev/cla", pr: "7", comment_id: "5" }),
    context("workflow_dispatch", { kind: "coverage", repo: "kleidos-dev/cla", pr: "7" }),
    context("workflow_dispatch", { kind: "signin", repo: "kleidos-dev/cla", pr: "7", github_id: "123", version: "2", lang: "es", site_commit: HEX, signin_token: TOKEN }),
    context("workflow_dispatch", { kind: "stamp", signin_token: TOKEN }),
    context("schedule"),
  ];

  it("the run name names the target, and the stamp", () => {
    assert.deepEqual(
      combos.map((c) => template(wf["run-name"]!, c)),
      ["Record sign kleidos-dev/cla#7 5", "Record coverage kleidos-dev/cla#7 ", "Record signin kleidos-dev/cla#7 123", "Record stamp", "Record stamp"],
    );
  });

  it("one concurrency group per target, never queued behind another's", () => {
    assert.deepEqual(
      combos.map((c) => template(wf.concurrency!.group, c)),
      ["record-sign-kleidos-dev/cla-7-5", "record-coverage-kleidos-dev/cla-7-", "record-signin-kleidos-dev/cla-7-123", "record-stamp---", "record-stamp---"],
    );
    assert.equal(wf.concurrency!["cancel-in-progress"], false);
  });

  it("the sign-in token is in no run name, group, env or expression: only the input that declares it", () => {
    for (const c of combos) {
      assert.ok(!template(wf["run-name"]!, c).includes(TOKEN));
      assert.ok(!template(wf.concurrency!.group, c).includes(TOKEN));
      for (const job of Object.values(wf.jobs)) for (const s of job.steps ?? []) assert.ok(!Object.values(stepEnv(s, c)).some((v) => v.includes(TOKEN)), s.name ?? "");
    }
    const text = JSON.stringify({ ...wf, on: null });
    assert.doesNotMatch(text, /signin_token|github\.event\.inputs|toJSON\(inputs\)|toJSON\(github/);
    assert.ok(Object.hasOwn((wf.on.workflow_dispatch as { inputs: object }).inputs, "signin_token"));
  });

  it("no expression anywhere in the file yields the sign-in token: job env, job name, with:, run name or group", () => {
    const given = { kind: "signin", repo: "kleidos-dev/cla", pr: "7", github_id: "123", version: "2", lang: "es", site_commit: HEX, signin_token: TOKEN };
    const c = context("workflow_dispatch", given);
    const everything = { ...c, github: { ...c.github, event: { inputs: inputs(given) } }, steps: { record: { outputs: { refused: "true" } } }, env: {}, job: {}, runner: {}, vars: {}, matrix: {}, strategy: {}, needs: {} };
    let evaluated = 0;
    for (const [where, text] of strings({ ...wf, on: null })) {
      if (!text.includes("${{")) continue;
      evaluated++;
      assert.ok(!template(text, everything).includes(TOKEN), where);
    }
    assert.ok(evaluated >= 20, String(evaluated));
  });

  it("the sign-in app's secret reaches the sign-in job's recorder and nothing else", () => {
    const where = Object.entries(wf.jobs).flatMap(([job, j]) => (j.steps ?? []).flatMap((s) => Object.entries(s.env ?? {}).filter(([, v]) => v.includes("secrets.")).map(([k, v]) => `${job}/${s.name}/${k}=${v}`)));
    assert.deepEqual(where, ["signin/Record/SIGNIN_CLIENT_SECRET=${{ secrets.SIGNIN_CLIENT_SECRET }}"]);
  });

  it("no input reaches a run block but through its environment", () => {
    for (const job of Object.values(wf.jobs)) for (const s of job.steps ?? []) assert.doesNotMatch(s.run ?? "", /\$\{\{/, s.name ?? "");
  });
});

describe("the recorder's step (sign and coverage)", () => {
  const block = step(wf, "record", "record");
  const text = block.run!;
  const envFor = (given: Record<string, string>) => stepEnv(block, context("workflow_dispatch", given));
  const good = { kind: "sign", repo: "kleidos-dev/cla", pr: "7", comment_id: "5" };
  const record = (...rest: string[]) => ["-I", "registry/cla.py", "record", ...rest];
  const refused = (name: string, given: Record<string, string>, message: string): Case => ({
    name,
    env: envFor(given),
    check: (r) => {
      assert.deepEqual([r.code, r.stdout, argv(r), r.output], [2, `${message}\n`, [], ""]);
    },
  });
  const passes = (name: string, given: Record<string, string>, args: string[]): Case => ({
    name,
    env: envFor(given),
    check: (r) => {
      assert.deepEqual([r.code, argv(r), r.output], [0, [args], ""]);
    },
  });
  const owner39 = "a".repeat(38) + "-";
  const name100 = "n._-".repeat(25);
  const cases: Case[] = [
    passes("a signature", good, record("--kind", "sign", "--repo", "kleidos-dev/cla", "--pr", "7", "--comment-id", "5")),
    passes("a coverage, whatever comment id it is given", { ...good, kind: "coverage", comment_id: "$(id)" }, record("--kind", "coverage", "--repo", "kleidos-dev/cla", "--pr", "7")),
    passes("the longest owner, name, number and comment id", { ...good, repo: `${owner39}/${name100}`, pr: "9999999999", comment_id: "999999999999999" }, record("--kind", "sign", "--repo", `${owner39}/${name100}`, "--pr", "9999999999", "--comment-id", "999999999999999")),
    passes("owner/.. passes the shell (cla.py then requires a served repository)", { ...good, repo: "owner/.." }, record("--kind", "sign", "--repo", "owner/..", "--pr", "7", "--comment-id", "5")),
    refused("an owner of 40", { ...good, repo: `${"a".repeat(40)}/x` }, "bad repository"),
    refused("a name of 101", { ...good, repo: `a/${"n".repeat(101)}` }, "bad repository"),
    refused("a dot in the owner", { ...good, repo: "a.b/c" }, "bad repository"),
    refused("no owner", { ...good, repo: "/c" }, "bad repository"),
    refused("no name", { ...good, repo: "a/" }, "bad repository"),
    refused("no slash", { ...good, repo: "abc" }, "bad repository"),
    refused("two slashes", { ...good, repo: "a/b/c" }, "bad repository"),
    refused("a second line", { ...good, repo: "a/b\nc/d" }, "bad repository"),
    refused("a shell command", { ...good, repo: "a/b;touch x" }, "bad repository"),
    refused("a space", { ...good, repo: "a/b " }, "bad repository"),
    refused("nothing", { ...good, repo: "" }, "bad repository"),
    refused("a pull request 0", { ...good, pr: "0" }, "bad pull request number"),
    refused("a leading zero", { ...good, pr: "07" }, "bad pull request number"),
    refused("eleven digits", { ...good, pr: "12345678901" }, "bad pull request number"),
    refused("a sign", { ...good, pr: "-7" }, "bad pull request number"),
    refused("another script's digit", { ...good, pr: "٧" }, "bad pull request number"),
    refused("no pull request", { ...good, pr: "" }, "bad pull request number"),
    refused("a comment id 0", { ...good, comment_id: "0" }, "bad comment id"),
    refused("a comment id of 16 digits", { ...good, comment_id: "1".repeat(16) }, "bad comment id"),
    refused("a comment id that is a command", { ...good, comment_id: "$(id)" }, "bad comment id"),
    refused("no comment id for a signature", { ...good, comment_id: "" }, "bad comment id"),
    {
      name: "a refusal (exit 3) says refused=true and fails with 3",
      env: envFor(good),
      stubs: { python3: { code: 3 } },
      check: (r) => assert.deepEqual([r.code, r.output, argv(r).length], [3, "refused=true\n", 1]),
    },
    ...[1, 2, 4, 127].map(
      (code): Case => ({
        name: `exit ${code} is a failure to retry, passed on, not a refusal`,
        env: envFor({ ...good, kind: "coverage" }),
        stubs: { python3: { code } },
        check: (r) => assert.deepEqual([r.code, r.output], [code, ""]),
      }),
    ),
    {
      name: "the token reaches the recorder through its environment only",
      env: envFor(good),
      check: (r) => {
        assert.equal(r.code, 0);
        assert.equal(envFor(good).GITHUB_TOKEN, "ghs_madeUpJobToken");
        assert.ok(!argv(r).flat().some((a) => a.includes("ghs_")));
      },
    },
  ];

  // Run once for both tests, before either: each passes alone, filtered or shuffled.
  let found: string[] = [];
  before(() => {
    found = failures(text, cases, ran("record"));
  });

  it("passes the arguments byte for byte, refuses every input off its pattern, and maps the exit codes", () => {
    assert.deepEqual(found, []);
  });

  it("every code line ran, and deleting any one of them fails a case, but the listed ones", () => {
    assert.deepEqual(codeLines(text).filter((l) => !ran("record").has(l)), []);
    assert.deepEqual(lineMutants(text, cases, ".github/workflows/record.yml", "record/Record"), []);
  });
});

describe("the report of a coverage the recorder refused", () => {
  const block = step(wf, "record", "Report a merged pull request the register cannot cover");
  const given = { kind: "coverage", repo: "kleidos-dev/cla", pr: "7" };

  it("runs only after the recorder refused a coverage", () => {
    const at = (kind: string, refusedOut: string, failed: boolean) => holds(block.if, { ...context("workflow_dispatch", { ...given, kind }), steps: { record: { outputs: { refused: refusedOut } } } }, { failed });
    assert.equal(at("coverage", "true", true), true);
    assert.equal(at("coverage", "true", false), false);
    assert.equal(at("coverage", "", true), false);
    assert.equal(at("sign", "true", true), false);
  });

  it("opens one issue in this repository naming the pull request and the run", () => {
    const env = { ...stepEnv(block, context("workflow_dispatch", given)), GITHUB_REPOSITORY: "kleidos-dev/cla" };
    const cases: Case[] = [
      {
        name: "the issue",
        env,
        check: (r) => {
          assert.equal(r.code, 0);
          assert.deepEqual(argv(r, "gh"), [
            ["issue", "create", "--repo", "kleidos-dev/cla", "--title", "Coverage refused for kleidos-dev/cla#7", "--body", "The recorder could not write the coverage record of kleidos-dev/cla#7: an author has no signature, or cannot be identified. Run: https://github.com/kleidos-dev/cla/actions/runs/42"],
          ]);
        },
      },
      { name: "gh failing fails the step", env, stubs: { gh: { code: 1 } }, check: (r) => assert.equal(r.code, 1) },
    ];
    assert.deepEqual(failures(block.run!, cases, ran("report")), []);
    assert.deepEqual(codeLines(block.run!).filter((l) => !ran("report").has(l)), []);
    assert.deepEqual(lineMutants(block.run!, cases, ".github/workflows/record.yml", "record/Report a merged pull request the register cannot cover"), []);
  });
});

describe("the sign-in recorder's step", () => {
  const block = step(wf, "signin", "Record");
  const text = block.run!;
  const good = { kind: "signin", repo: "kleidos-dev/cla", pr: "7", github_id: "123456", version: "2", lang: "es", site_commit: HEX, signin_token: TOKEN };
  const envFor = (given: Record<string, string>) => stepEnv(block, context("workflow_dispatch", given));
  const record = (g: Record<string, string>) => ["-I", "registry/cla.py", "record", "--kind", "signin", "--repo", g.repo!, "--pr", g.pr!, "--github-id", g.github_id!, "--version", g.version!, "--lang", g.lang!, "--site-commit", g.site_commit!];
  const refused = (field: string, value: string, message: string): Case => ({
    name: `${field}=${JSON.stringify(value)}`,
    env: envFor({ ...good, [field]: value }),
    check: (r) => assert.deepEqual([r.code, r.stdout, argv(r)], [2, `${message}\n`, []]),
  });
  const passes = (name: string, g: Record<string, string>): Case => ({ name, env: envFor(g), check: (r) => assert.deepEqual([r.code, argv(r)], [0, [record(g)]]) });
  const cases: Case[] = [
    passes("a sign-in", good),
    passes("the edges of each field", { ...good, github_id: "999999999999999", version: "9999", lang: "en" }),
    passes("the smallest of each", { ...good, github_id: "1", version: "1", pr: "1" }),
    passes("the longest owner, name and number", { ...good, repo: `${"a".repeat(38)}-/${"n._-".repeat(25)}`, pr: "9999999999" }),
    // The same repositories and numbers the recorder's step refuses.
    ...[`${"a".repeat(40)}/x`, `a/${"n".repeat(101)}`, "a.b/c", "/c", "a/", "abc", "a/b/c", "a/b\nc/d", "a/b;touch x", "a/b ", "a/b c", ""].map((v) => refused("repo", v, "bad repository")),
    ...["0", "07", "12345678901", "-7", "\u0667", ""].map((v) => refused("pr", v, "bad pull request number")),
    refused("github_id", "0", "bad account id"),
    refused("github_id", "1".repeat(16), "bad account id"),
    refused("github_id", "", "bad account id"),
    refused("github_id", "12a", "bad account id"),
    refused("version", "0", "bad version"),
    refused("version", "02", "bad version"),
    refused("version", "10000", "bad version"),
    refused("version", "", "bad version"),
    refused("lang", "fr", "bad language"),
    refused("lang", "EN", "bad language"),
    refused("lang", "en\nes", "bad language"),
    refused("lang", "", "bad language"),
    refused("site_commit", HEX.toUpperCase(), "bad site commit"),
    refused("site_commit", HEX.slice(1), "bad site commit"),
    refused("site_commit", `${HEX}0`, "bad site commit"),
    refused("site_commit", "", "bad site commit"),
    { name: "the recorder's failure is the step's", env: envFor(good), stubs: { python3: { code: 3 } }, check: (r) => assert.deepEqual([r.code, argv(r).length], [3, 1]) },
    {
      name: "the token is in no argument and no variable of the step",
      env: envFor(good),
      check: (r) => {
        assert.equal(r.code, 0);
        assert.ok(!argv(r).flat().join(" ").includes(TOKEN));
        assert.ok(!Object.values(envFor(good)).join(" ").includes(TOKEN));
        assert.equal(envFor(good).SIGNIN_CLIENT_SECRET, "made-up-client-secret");
      },
    },
  ];

  let found: string[] = [];
  before(() => {
    found = failures(text, cases, ran("signin"));
  });

  it("passes every field byte for byte and refuses each one off its pattern, alone", () => {
    assert.deepEqual(found, []);
  });

  it("every code line ran, and deleting any one of them fails a case, but the listed ones", () => {
    assert.deepEqual(codeLines(text).filter((l) => !ran("signin").has(l)), []);
    assert.deepEqual(lineMutants(text, cases, ".github/workflows/record.yml", "signin/Record"), []);
  });
});

describe("the stamp", () => {
  it("runs the recorder's stamp and nothing else, and its failure is the step's", () => {
    const block = step(wf, "stamp", "Stamp");
    const env = stepEnv(block, context("schedule"));
    const cases: Case[] = [
      { name: "the call", env, check: (r) => assert.deepEqual([r.code, argv(r)], [0, [["-I", "registry/cla.py", "record", "--kind", "stamp"]]]) },
      { name: "a failure", env, stubs: { python3: { code: 1 } }, check: (r) => assert.equal(r.code, 1) },
    ];
    assert.deepEqual(failures(block.run!, cases), []);
    assert.deepEqual(lineMutants(block.run!, cases, ".github/workflows/record.yml", "stamp/Stamp"), []);
    assert.deepEqual(env, { GITHUB_TOKEN: "ghs_madeUpJobToken" });
  });
});

describe("the recorder's step, a line that bash never runs is not missed", () => {
  it("runs every block under the bash whose version was checked, 4 or later, whatever bash the block's PATH finds", () => {
    const r = runBlock('echo "${BASH_VERSINFO[0]}"\n', {}, {});
    r.done();
    assert.ok(Number(r.stdout.trim()) >= 4, r.stdout);
  });

  it("the trace sees every command of a block, nested or not", () => {
    const r = runBlock("a=1\nif [[ $a -eq 1 ]]; then\n  echo $(printf x)\nfi\n", {}, {});
    r.done();
    assert.deepEqual([...r.lines].sort(), [1, 2, 3]);
    assert.deepEqual(codeLines("a=1\nif [[ $a -eq 1 ]]; then\n  echo x \\\n    y\nfi\n# c\n"), [1, 2, 3]);
    assert.equal(without("a\nb \\\n c\nd", 2), "a\nd");
  });
});
