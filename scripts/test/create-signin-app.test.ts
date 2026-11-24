// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// scripts/create-signin-app.ts against a mocked GitHub (both github.com and
// api.github.com), a fake wrangler and a fake gh: its parts one by one,
// main() in this process with settings of the test's own, and the script as
// the owner runs it, a child process with --test. Run with
// `node --test scripts/test/`.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { WORKER_SECRETS, ensureEnvironment, escapeHtml, exchange, main, manifest, printable, run, sameText, settings } from "../create-signin-app.ts";
import type { Settings } from "../create-signin-app.ts";
import { BREAK_SPAWN, CODE, assertStrict, FAKE_GH, FAKE_WRANGLER, FORGED, ORG_ID, WORKER_DIR, assertPlain, capture, cleanup, filesUnder, here, localPage, mockGitHub, otherAddresses, rawGet, reaches, readLog, roundTrip, runChild, scratch, setEnv } from "./support.ts";
import type { GitHub, Output } from "./support.ts";

const SCRIPT = join(here, "..", "create-signin-app.ts");
const PINNED = join(WORKER_DIR, "node_modules", ".bin", "wrangler");
const CLIENT_ID = "Iv23liSIGNINMOCK0001";
const REGISTRY = "repos/kleidos-dev/cla";
const ENV = `${REGISTRY}/environments/signin`;
const JQ = '[.branch_policies[] | .name + ":" + (.type // "branch")] | join(",")';

const EXPECTED = {
  name: "Kleidos CLA sign-in",
  url: "https://cla.kleidos.dev",
  description: "Signs you in to cla.kleidos.dev to accept the Kleidos Contributor Agreement. It has no permission at all: it only tells the site which GitHub account you are, and posts nothing.",
  public: true,
  callback_urls: ["https://cla.kleidos.dev/auth/callback"],
  request_oauth_on_install: false,
  default_permissions: {},
  default_events: [],
};

// The conversion of any GitHub App also returns a private key and a webhook secret: the script must drop both.
const SECRETS = { client_secret: `cs_${randomBytes(20).toString("hex")}`, webhook_secret: `wh_${randomBytes(20).toString("hex")}`, pem: `-----BEGIN RSA PRIVATE KEY-----\n${randomBytes(48).toString("base64")}\n-----END RSA PRIVATE KEY-----\n` };
const ANSWER = { id: 4343, slug: "kleidos-cla-sign-in", owner: { id: ORG_ID, login: "kleidos-dev" }, client_id: CLIENT_ID, html_url: "https://github.com/apps/kleidos-cla-sign-in", permissions: {}, events: [], ...SECRETS };

let gh: GitHub;
let logs: string;
let wlog: string;
let glog: string;
before(async () => {
  gh = await mockGitHub(ANSWER);
});
after(async () => {
  await gh.close();
});
beforeEach(() => {
  logs = scratch("cla-log-");
  wlog = join(logs, "wrangler.log");
  glog = join(logs, "gh.log");
  gh.answer = {};
  gh.status = 201;
  gh.hold = null;
  gh.conversions.length = 0;
  gh.manifests.length = 0;
});
afterEach(() => cleanup(logs));

const base = (): Settings => ({ test: false, web: gh.url, api: gh.url, wrangler: FAKE_WRANGLER, gh: FAKE_GH, waitMs: 900_000 });
const wcalls = () => readLog(wlog);
const gcalls = () => readLog(glog);
const puts = () => wcalls().filter((c) => c.args[1] === "put");
const sets = () => gcalls().filter((c) => c.args[0] === "secret");

/** The gh calls of a run that gets through the checks with no policy yet: admin, the environment, its policies, main added. */
const SETUP = [
  ["api", REGISTRY, "--jq", ".permissions.admin"],
  ["api", "-X", "PUT", ENV, "--input", "-"],
  ["api", `${ENV}/deployment-branch-policies`, "--jq", JQ],
  ["api", "-X", "POST", `${ENV}/deployment-branch-policies`, "--input", "-"],
];

/** main() in this process, the fakes told `fake`; resolves once the page is up, or main has ended. */
async function start(t: TestContext, s: Settings = base(), fake: Record<string, string> = {}): Promise<{ out: Output; done: Promise<number>; base: string | null }> {
  const restore = setEnv({ FAKE_WRANGLER_LOG: wlog, FAKE_WRANGLER_FAIL: "", FAKE_WRANGLER_WHOAMI: "", FAKE_WRANGLER_LIST: "", FAKE_WRANGLER_DIE: "", FAKE_GH_LOG: glog, FAKE_GH_ADMIN: "true", FAKE_GH_POLICIES: "", FAKE_GH_FAIL: "", FAKE_GH_DIE: "", ...fake });
  t.after(restore);
  const out = capture(t);
  const done = main(s);
  const opened = await Promise.race([out.waitFor(/^Open (http:\/\/127\.0\.0\.1:\d+\/) in your browser, signed in to GitHub as an owner of kleidos-dev\.$/).then((m) => m[1]!), done.then(() => null)]);
  return { out, done, base: opened };
}

/** main() that must end before it shows the page: a mutant that goes on fails here, not by hanging. */
async function refused(t: TestContext, s: Settings = base(), fake: Record<string, string> = {}): ReturnType<typeof start> {
  const r = await start(t, s, fake);
  assert.equal(r.base, null, "the page was shown");
  return r;
}

async function complete(t: TestContext, fake: Record<string, string> = {}): Promise<{ out: Output; code: number; page: { status: number; html: string }; port: number }> {
  const r = await start(t, base(), fake);
  assert.ok(r.base, r.out.text());
  const page = await roundTrip(r.base);
  assertStrict(page.headers, gh.url, `the callback's ${page.status}`);
  return { out: r.out, code: await r.done, page, port: Number(new URL(r.base).port) };
}

/** A gh that answers from a table and records its calls, for ensureEnvironment alone. */
function fakeGh(answers: Record<string, { code: number; out?: string }>) {
  const seen: { args: string[]; input: string | undefined; keep: boolean }[] = [];
  const fn = (args: string[], input?: string, keep = false) => {
    seen.push({ args, input, keep });
    const call = args.includes("POST") ? "post" : args.includes("PUT") ? "put" : "policies";
    return Promise.resolve({ out: "", ...(answers[call] ?? { code: 0 }) });
  };
  return { fn, seen };
}

describe("settings", () => {
  it("without --test the places are GitHub's, the pinned wrangler's and gh's, whatever the environment says", () => {
    const env = { CLA_TEST_GITHUB_WEB: "http://evil.example", CLA_TEST_GITHUB_API: "http://evil.example", CLA_TEST_WRANGLER: "/tmp/evil", CLA_TEST_GH: "/tmp/evil-gh" };
    for (const argv of [[], ["--testing"], ["test"]]) assert.deepEqual(settings(argv, env), { test: false, web: "https://github.com", api: "https://api.github.com", wrangler: PINNED, gh: "gh", waitMs: 900_000 });
  });

  it("with --test the environment names the places, each URL without one trailing slash", () => {
    const env = { CLA_TEST_GITHUB_WEB: "http://127.0.0.1:1/", CLA_TEST_GITHUB_API: "http://127.0.0.1:2//", CLA_TEST_WRANGLER: "/x/w/", CLA_TEST_GH: "/x/gh/" };
    assert.deepEqual(settings(["--test"], env), { test: true, web: "http://127.0.0.1:1", api: "http://127.0.0.1:2/", wrangler: "/x/w/", gh: "/x/gh/", waitMs: 900_000 });
    assert.deepEqual(settings(["x", "--test"], {}), { test: true, web: "https://github.com", api: "https://api.github.com", wrangler: PINNED, gh: "gh", waitMs: 900_000 });
  });
});

describe("the manifest", () => {
  it("has no permission, no event and no webhook, and the local port in redirect_url only", () => {
    assert.deepEqual(manifest(4321), { ...EXPECTED, redirect_url: "http://127.0.0.1:4321/callback" });
    assert.deepEqual(WORKER_SECRETS, ["SIGNIN_CLIENT_ID", "SIGNIN_CLIENT_SECRET"]);
  });
});

describe("the small parts", () => {
  it("escapeHtml, sameText and printable do what the bot's script's do", () => {
    assert.equal(escapeHtml(`a&b<c>d"e'f é`), "a&amp;b&lt;c&gt;d&quot;e&#39;f é");
    assert.equal(sameText("abc", "abc"), true);
    assert.equal(sameText("abc", "abx"), false);
    assert.equal(sameText("abc", "ab"), false);
    assert.equal(printable(" ~a\x1f\x7f\u0080\u2028"), " ~a????");
    assert.equal(printable("s".repeat(201)), "s".repeat(200));
  });

  it("run keeps the command's output only when asked, and gives its exit code", async (t) => {
    t.after(setEnv({ FAKE_GH_LOG: glog, FAKE_GH_ADMIN: "yes", FAKE_GH_FAIL: "secret", FAKE_WRANGLER_LOG: wlog }));
    assert.deepEqual(await run(FAKE_GH, ["api", REGISTRY], undefined, { keep: true }), { code: 0, out: "yes\n" });
    assert.deepEqual(await run(FAKE_GH, ["api", REGISTRY]), { code: 0, out: "" });
    assert.deepEqual(await run(FAKE_GH, ["secret", "set", "X"], "v", { keep: true }), { code: 1, out: "fake gh: refused v\n" });
    assert.deepEqual(gcalls().map((c) => [c.cwd, c.input]), [
      [WORKER_DIR.replace(/\/$/, ""), ""],
      [WORKER_DIR.replace(/\/$/, ""), ""],
      [WORKER_DIR.replace(/\/$/, ""), "v"],
    ]);
    assert.deepEqual(await run(FAKE_WRANGLER, ["whoami"], undefined, { cwd: logs }), { code: 0, out: "" });
    assert.equal(wcalls()[0]!.cwd, logs.replace(/^\/var\//, "/private/var/"));
  });

  it("a command that prints a lot is neither shown nor waited for, unless its output is kept", async (t) => {
    const loud = join(logs, "loud");
    writeFileSync(loud, "#!/bin/sh\nhead -c 1048576 /dev/zero | tr '\\0' s\nhead -c 1048576 /dev/zero | tr '\\0' s >&2\nexit 0\n");
    chmodSync(loud, 0o755);
    const out = capture(t);
    assert.deepEqual(await run(loud, []), { code: 0, out: "" });
    const kept = await run(loud, [], undefined, { keep: true });
    assert.deepEqual([kept.code, kept.out.length, /^s+$/.test(kept.out)], [0, 1048576, true]);
    assert.deepEqual(out.lines, []);
  });

  it("a command that cannot start is 127, one killed by a signal is 1, one that ignores its input does no harm", async (t) => {
    t.after(setEnv({ FAKE_GH_LOG: glog, FAKE_GH_DIE: "admin" }));
    const plain = join(logs, "plain");
    writeFileSync(plain, "#!/bin/sh\nexit 0\n");
    chmodSync(plain, 0o644);
    const quits = join(logs, "quits");
    writeFileSync(quits, "#!/bin/sh\necho out\nexit 6\n");
    chmodSync(quits, 0o755);
    assert.deepEqual(await run(join(logs, "missing"), [], undefined, { keep: true }), { code: 127, out: "" });
    assert.deepEqual(await run(plain, []), { code: 127, out: "" });
    assert.deepEqual(await run(FAKE_GH, ["api", REGISTRY], undefined, { keep: true }), { code: 1, out: "" });
    assert.deepEqual(await run(quits, [], "x".repeat(4 << 20), { keep: true }), { code: 6, out: "out\n" });
  });
});

describe("exchange", () => {
  it("posts the code to the conversion with GitHub's headers, and keeps only what the script needs", async () => {
    assert.deepEqual(await exchange(gh.url, CODE), { id: 4343, slug: "kleidos-cla-sign-in", owner: ANSWER.owner, client_id: CLIENT_ID, client_secret: SECRETS.client_secret, permissions: {}, events: [] });
    const sent = gh.conversions[0]!;
    assert.deepEqual([sent.method, sent.path, sent.headers.accept, sent.headers["x-github-api-version"], sent.headers["user-agent"]], ["POST", `/app-manifests/${CODE}/conversions`, "application/vnd.github+json", "2022-11-28", "kleidos-cla-setup"]);
    await exchange(gh.url, "a/b");
    assert.equal(gh.conversions[1]!.path, "/app-manifests/a%2Fb/conversions");
  });

  it("permissions only as an object, events only as a list, and no owner as null", async () => {
    for (const [answer, kept] of [
      [{ permissions: { contents: "read" }, events: ["push"] }, { permissions: { contents: "read" }, events: ["push"] }],
      [{ permissions: "all", events: "push" }, {}],
      [{ permissions: null, events: null }, {}],
      [{ permissions: undefined, events: undefined }, {}],
      [{ permissions: ["x"], events: {} }, { permissions: ["x"] }],
    ] as const) {
      gh.answer = answer;
      const c = await exchange(gh.url, CODE);
      assert.deepEqual({ permissions: c.permissions, events: c.events }, { permissions: undefined, events: undefined, ...kept }, JSON.stringify(answer));
      assert.deepEqual(Object.keys(c).sort(), ["client_id", "client_secret", "id", "owner", "slug", ...Object.keys(kept)].sort());
    }
    gh.answer = { owner: undefined };
    assert.equal((await exchange(gh.url, CODE)).owner, null);
    gh.answer = { owner: null };
    assert.equal((await exchange(gh.url, CODE)).owner, null);
  });

  it("any status but 201, a body that is not JSON, and a bad id are refused", async () => {
    gh.status = 403;
    await assert.rejects(exchange(gh.url, CODE), { message: "GitHub answered 403 to the manifest conversion" });
    gh.status = 201;
    gh.answer = "{";
    await assert.rejects(exchange(gh.url, CODE), { message: "the conversion is not JSON" });
    for (const id of [undefined, "1", 0, -2, 0.5, 2 ** 53]) {
      gh.answer = { id };
      await assert.rejects(exchange(gh.url, CODE), { message: "the conversion has no id" }, String(id));
    }
  });

  it("slug, client id and client secret must be non-empty strings", async () => {
    for (const k of ["slug", "client_id", "client_secret"]) {
      for (const v of [undefined, "", 9]) {
        gh.answer = { [k]: v };
        await assert.rejects(exchange(gh.url, CODE), { message: `the conversion has no ${k}` }, `${k}=${String(v)}`);
      }
    }
  });

  it("the client id is the recorder's: 16 to 40 letters, digits and dots", async () => {
    for (const id of ["a".repeat(16), "a".repeat(40), "Iv23.li.0123456789"]) {
      gh.answer = { client_id: id };
      assert.equal((await exchange(gh.url, CODE)).client_id, id);
    }
    for (const id of ["a".repeat(15), "a".repeat(41), "Iv23liSIGNINMOCK_1", "Iv23liSIGNINMOCK\n", " Iv23liSIGNINMOCK1", "Iv23liSIGNINMOCKé"]) {
      gh.answer = { client_id: id };
      await assert.rejects(exchange(gh.url, CODE), { message: "the conversion has no valid client_id" }, JSON.stringify(id));
    }
  });
});

describe("ensureEnvironment", () => {
  it("makes the environment custom-branch only, then adds main when no policy is there", async () => {
    const g = fakeGh({ policies: { code: 0, out: "\n" } });
    assert.equal(await ensureEnvironment(g.fn), true);
    assert.deepEqual(g.seen, [
      { args: ["api", "-X", "PUT", ENV, "--input", "-"], input: '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}', keep: false },
      { args: ["api", `${ENV}/deployment-branch-policies`, "--jq", JQ], input: undefined, keep: true },
      { args: ["api", "-X", "POST", `${ENV}/deployment-branch-policies`, "--input", "-"], input: '{"name":"main","type":"branch"}', keep: false },
    ]);
  });

  it("keeps a policy of main alone and adds nothing", async () => {
    const g = fakeGh({ policies: { code: 0, out: " main:branch\n" } });
    assert.equal(await ensureEnvironment(g.fn), true);
    assert.equal(g.seen.length, 2);
  });

  it("refuses any other branch or a tag, saying which, cut short and printable", async (t) => {
    const out = capture(t);
    for (const [policies, shown] of [
      ["main:branch,release:branch", "main:branch, release:branch"],
      ["main:tag", "main:tag"],
      ["dev:branch", "dev:branch"],
      [`main:branch,${FORGED}${"s".repeat(300)}:branch`, printable(`main:branch, ${FORGED}${"s".repeat(300)}:branch`)],
    ] as const) {
      const g = fakeGh({ policies: { code: 0, out: policies } });
      assert.equal(await ensureEnvironment(g.fn), false);
      assert.equal(g.seen.length, 2);
      assert.deepEqual(out.lines.at(-1), { stream: "err", text: `The environment signin of kleidos-dev/cla allows other branches than main (${shown}): remove them in its settings, then run this script again.` });
    }
    assertPlain(out.text());
  });

  it("a failing call at any of its three steps is a refusal, and nothing after it runs", async () => {
    for (const [fail, calls] of [
      ["put", 1],
      ["policies", 2],
      ["post", 3],
    ] as const) {
      const g = fakeGh({ [fail]: { code: 1 } });
      assert.equal(await ensureEnvironment(g.fn), false, fail);
      assert.equal(g.seen.length, calls, fail);
    }
  });
});

describe("main, before anything is shown", () => {
  it("says the test places only in test mode", async (t) => {
    const missing = join(logs, "missing");
    const quiet = await refused(t, { ...base(), wrangler: missing });
    assert.equal(await quiet.done, 2);
    assert.deepEqual(quiet.out.lines, [{ stream: "err", text: `No wrangler at ${missing}: run \`npm ci\` in worker/ first, then this script again.` }]);
    t.mock.restoreAll();
    const loud = await refused(t, { ...base(), test: true, wrangler: missing });
    assert.equal(await loud.done, 2);
    assert.deepEqual(loud.out.lines[0], { stream: "out", text: `Test mode: GitHub web ${gh.url}, API ${gh.url}, wrangler ${missing}, gh ${FAKE_GH}.` });
    assert.deepEqual(wcalls(), []);
  });

  it("wrangler not signed in or killed, or a Worker it cannot reach: exit 2, gh never asked", async (t) => {
    for (const [fake, text] of [
      [{ FAKE_WRANGLER_WHOAMI: "fail" }, "wrangler is not signed in: run `npx wrangler login` in worker/ first, then this script again."],
      [{ FAKE_WRANGLER_DIE: "whoami" }, "wrangler is not signed in: run `npx wrangler login` in worker/ first, then this script again."],
      [{ FAKE_WRANGLER_LIST: "fail" }, "wrangler cannot reach the Worker kleidos-cla (exit 7): deploy it first with `npm run deploy` in worker/, then run this script again. Nothing was created."],
    ] as const) {
      const r = await refused(t, base(), fake);
      assert.equal(await r.done, 2);
      assert.deepEqual(r.out.lines, [{ stream: "err", text }]);
      assert.deepEqual(gcalls(), []);
      t.mock.restoreAll();
    }
  });

  it("gh that cannot administer the register, is missing or dies: exit 2, nothing created", async (t) => {
    const text = "gh cannot administer kleidos-dev/cla: sign in with `gh auth login` as an owner of kleidos-dev, then run this script again. Nothing was created.";
    // A gh that says "true" and still fails is not believed.
    const liar = join(logs, "liar-gh");
    writeFileSync(liar, "#!/bin/sh\ncat >/dev/null\necho true\nexit 1\n");
    chmodSync(liar, 0o755);
    for (const [s, fake] of [
      [{ ...base(), gh: liar }, {}],
      [base(), { FAKE_GH_ADMIN: "false" }],
      [base(), { FAKE_GH_ADMIN: "" }],
      [base(), { FAKE_GH_ADMIN: "true true" }],
      [base(), { FAKE_GH_FAIL: "admin", FAKE_GH_ADMIN: "true" }],
      [base(), { FAKE_GH_DIE: "admin" }],
      [{ ...base(), gh: join(logs, "no-gh") }, {}],
    ] as const) {
      const r = await refused(t, s, fake);
      assert.equal(await r.done, 2, JSON.stringify(fake));
      assert.deepEqual(r.out.lines, [{ stream: "err", text }]);
      assert.ok(gcalls().every((c) => c.args[1] === REGISTRY));
      cleanup(glog);
      t.mock.restoreAll();
    }
  });

  it("an environment that cannot be set to main only: exit 2, nothing shown", async (t) => {
    for (const fake of [{ FAKE_GH_FAIL: "put" }, { FAKE_GH_FAIL: "policies" }, { FAKE_GH_FAIL: "post" }, { FAKE_GH_POLICIES: "dev:branch" }]) {
      const r = await refused(t, base(), fake);
      assert.equal(await r.done, 2);
      assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: "The Actions environment signin of kleidos-dev/cla could not be set to main only. Nothing was created." });
      assert.equal(gh.conversions.length, 0);
      t.mock.restoreAll();
    }
  });
});

describe("main, the local page", () => {
  it("listens on the loopback address alone, not on every interface", async (t) => {
    const r = await start(t);
    const port = Number(new URL(r.base!).port);
    const answered: string[] = [];
    for (const address of otherAddresses()) if (await reaches(address, port)) answered.push(address);
    // The run ends before the assert, so that a server open to every interface fails the test instead of hanging it.
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
    assert.deepEqual(answered, []);
  });

  it("shows one form that posts the exact manifest, with the state, under strict headers", async (t) => {
    const r = await start(t);
    const port = Number(new URL(r.base!).port);
    const p = await localPage(r.base!);
    assert.equal(p.status, 200);
    assert.equal(p.headers.get("content-security-policy"), `default-src 'none'; form-action ${gh.url}`);
    assert.equal(p.headers.get("cache-control"), "no-store");
    assert.equal(p.headers.get("referrer-policy"), "no-referrer");
    assert.equal(p.headers.get("content-type"), "text/html; charset=utf-8");
    const state = new URL(p.action).searchParams.get("state")!;
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(p.action, `${gh.url}/organizations/kleidos-dev/settings/apps/new?state=${state}`);
    assert.equal(
      p.html,
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Kleidos CLA sign-in setup</title><body><h1>Create the GitHub App Kleidos CLA sign-in</h1><p>An app with no permission at all, only to sign in. The button posts its manifest to GitHub, which shows it and asks you to confirm.</p><form method="post" action="${escapeHtml(p.action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest(port)))}"><button type="submit">Create the GitHub App on kleidos-dev</button></form></body></html>`,
    );
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
  });

  it("each run has a state of its own", async (t) => {
    const states: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await start(t);
      states.push(new URL((await localPage(r.base!)).action).searchParams.get("state")!);
      await roundTrip(r.base!);
      assert.equal(await r.done, 0);
      t.mock.restoreAll();
    }
    assert.equal(states.length, 2);
    assert.notEqual(states[0], states[1]);
  });

  it("another Host, path or method gets nothing", async (t) => {
    const r = await start(t);
    const port = new URL(r.base!).port;
    const got: [string, Awaited<ReturnType<typeof rawGet>>][] = [];
    for (const host of ["rebound.example", `localhost:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `127.0.0.1.evil.example:${port}`, `127.0.0.1:${port}.evil.example`]) got.push([host, await rawGet(r.base!, host)]);
    const other: number[] = [];
    for (const [method, path] of [["POST", ""], ["GET", "x"], ["POST", "callback"]] as const) other.push((await fetch(`${r.base!}${path}`, { method })).status);
    // The run ends before anything is asserted, so a refusal that fails ends the test instead of leaving the server up.
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
    for (const [host, answer] of got) assert.deepEqual(answer, { status: 421, body: "wrong host\n", type: "text/plain" }, host);
    assert.deepEqual(other, [404, 404, 404]);
  });

  it("a stray state is refused and the genuine redirect still completes; a bad code ends with 3", async (t) => {
    const r = await start(t);
    const state = new URL((await localPage(r.base!)).action).searchParams.get("state")!;
    const refused: [string, Response, string][] = [];
    for (const query of [`code=${CODE}&state=${state.slice(1)}x`, `code=${CODE}`]) {
      const res = await fetch(`${r.base!}callback?${query}`);
      refused.push([query, res, await res.text()]);
    }
    assert.equal(r.out.lines.filter((l) => l.stream === "err" && l.text === "Refused a redirect whose state does not match; still waiting for GitHub's.").length, 2);
    assert.equal((await roundTrip(r.base!)).status, 200);
    assert.equal(await r.done, 0);
    // Asserted once the run has ended, so that a failure ends the test instead of leaving the server up.
    for (const [query, res, text] of refused) {
      assert.equal(res.status, 400, query);
      assertStrict(res.headers, gh.url, query);
      assert.match(text, /Refused: this redirect did not start here\. Nothing was exchanged\./);
    }
    t.mock.restoreAll();
    for (const query of [`state=${"S"}`, "code=a%2Bb"]) {
      const s = await start(t);
      const st = new URL((await localPage(s.base!)).action).searchParams.get("state")!;
      const res = await fetch(`${s.base!}callback?${query.startsWith("state") ? "" : `${query}&`}state=${st}`);
      assert.equal(res.status, 400);
      assertStrict(res.headers, gh.url, query);
      assert.match(await res.text(), /<p>Refused: no valid code\.<\/p>/);
      assert.equal(await s.done, 3);
      assert.deepEqual(s.out.lines.at(-1), { stream: "err", text: "Refused: GitHub's redirect carried no valid code." });
      t.mock.restoreAll();
    }
    assert.equal(gh.conversions.length, 1);
  });

  it("a second callback during the exchange is 'Already handled'", async (t) => {
    let release!: () => void;
    gh.hold = new Promise((r) => (release = r));
    const asked = new Promise<void>((r) => (gh.asked = r));
    const r = await start(t);
    const state = new URL((await localPage(r.base!)).action).searchParams.get("state")!;
    const first = fetch(`${r.base!}callback?code=${CODE}&state=${state}`);
    await asked;
    const second = await fetch(`${r.base!}callback?code=${CODE}&state=${state}`);
    release();
    assert.equal((await first).status, 200);
    assert.equal(await r.done, 0);
    // Asserted once the run has ended, so that a failure ends the test instead of holding the exchange.
    assert.equal(second.status, 409);
    assertStrict(second.headers, gh.url);
    assert.match(await second.text(), /<body><p>Already handled\.<\/p><\/body>/);
    assert.equal(gh.conversions.length, 1);
  });

  it("waits fifteen minutes, then exits 5; once done, the server and the timer are gone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const r = await start(t, { ...base(), waitMs: settings([], {}).waitMs });
    t.mock.timers.tick(15 * 60 * 1000 - 1);
    assert.ok(!r.out.lines.some((l) => /Timed out/.test(l.text)));
    t.mock.timers.tick(1);
    assert.equal(await r.done, 5);
    assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: "Timed out waiting for GitHub's redirect." });
    await assert.rejects(fetch(r.base!), /fetch failed/);
    t.mock.restoreAll();
    const ok = await start(t);
    await roundTrip(ok.base!);
    assert.equal(await ok.done, 0);
    const lines = ok.out.lines.length;
    t.mock.timers.tick(900_000);
    assert.equal(ok.out.lines.length, lines);
    await assert.rejects(fetch(ok.base!), /fetch failed/);
  });
});

describe("main, after GitHub's redirect", () => {
  it("stores the client id and secret in the Worker and the secret in the environment, and says what to do next", async (t) => {
    const r = await complete(t);
    assert.equal(r.code, 0, r.out.text());
    assert.deepEqual(gh.manifests, [manifest(r.port)]);
    assert.deepEqual(wcalls().map((c) => c.args), [["whoami"], ["secret", "list", "--name", "kleidos-cla"], ["secret", "put", "SIGNIN_CLIENT_ID", "--name", "kleidos-cla"], ["secret", "put", "SIGNIN_CLIENT_SECRET", "--name", "kleidos-cla"]]);
    assert.deepEqual(puts().map((c) => c.input), [CLIENT_ID, SECRETS.client_secret]);
    assert.deepEqual(gcalls().map((c) => c.args), [...SETUP, ["secret", "set", "SIGNIN_CLIENT_SECRET", "--env", "signin", "--repo", "kleidos-dev/cla"]]);
    assert.equal(sets()[0]!.input, SECRETS.client_secret);
    assert.equal(r.page.status, 200);
    assert.match(r.page.html, /<h1>Done<\/h1><p>Stored: SIGNIN_CLIENT_ID \(Worker\), SIGNIN_CLIENT_SECRET \(Worker\), SIGNIN_CLIENT_SECRET \(environment signin of kleidos-dev\/cla\)\.<\/p><p>You can close this tab and go back to the terminal\.<\/p>/);
    assert.deepEqual(r.out.lines.slice(1), [
      { stream: "out", text: `\nGitHub App created: kleidos-cla-sign-in (app id 4343, ${gh.url}/apps/kleidos-cla-sign-in).` },
      { stream: "out", text: "Stored: SIGNIN_CLIENT_ID (Worker), SIGNIN_CLIENT_SECRET (Worker), SIGNIN_CLIENT_SECRET (environment signin of kleidos-dev/cla)." },
      { stream: "out", text: `\nThe client id (public): ${CLIENT_ID}` },
      { stream: "out", text: `\nNext:\n  1. On ${gh.url}/organizations/kleidos-dev/settings/apps/kleidos-cla-sign-in: "Expire user authorization tokens" on, "Enable Device Flow" off, webhook inactive, no permission and no event; under "Private keys" delete the key GitHub generated (nothing uses it).` },
      { stream: "out", text: "  2. Do not install it anywhere: signing in needs no installation." },
      { stream: "out", text: `  3. In registry/config.json set "signin_client_id": "${CLIENT_ID}" (a signed commit on main). The site signs in with this app only once a version whose flow is "signin" is current.` },
    ]);
    // The private key and the webhook secret reach nothing at all.
    for (const c of [...wcalls(), ...gcalls()]) for (const s of [SECRETS.webhook_secret, SECRETS.pem.split("\n")[1]!]) assert.ok(!c.input.includes(s) && !c.args.join(" ").includes(s));
  });

  it("warns when GitHub gave the app any permission or event, and stores all the same", async (t) => {
    for (const [answer, shown] of [
      [{ permissions: { contents: "read" } }, '[{"contents":"read"},[]]'],
      [{ events: ["push"] }, '[{},["push"]]'],
      [{ permissions: { a: "b" }, events: ["c"] }, '[{"a":"b"},["c"]]'],
      [{ permissions: null, events: null }, null],
      [{ permissions: { a: "b" }, events: undefined }, '[{"a":"b"},[]]'],
      [{ permissions: undefined, events: ["c"] }, '[{},["c"]]'],
    ] as const) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 0);
      const warning = r.out.lines.filter((l) => l.text.startsWith("Warning:"));
      assert.deepEqual(warning, shown === null ? [] : [{ stream: "err", text: `Warning: GitHub gave the app permissions or events (${shown}): remove them on its settings page.` }], JSON.stringify(answer));
      assert.equal(puts().length, 2);
      cleanup(wlog);
      t.mock.restoreAll();
    }
  });

  it("an app that is not the sign-in app of kleidos-dev stores nothing: owner and slug each alone", async (t) => {
    for (const [answer, shown] of [
      [{ owner: { id: 7 } }, "slug kleidos-cla-sign-in, owner id 7"],
      [{ owner: undefined }, "slug kleidos-cla-sign-in, owner id none"],
      [{ owner: {} }, "slug kleidos-cla-sign-in, owner id none"],
      [{ slug: "kleidos-cla" }, "slug kleidos-cla, owner id 357318718"],
    ] as const) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 4);
      assert.equal(r.page.status, 502);
      assert.match(r.page.html, /<p>Refused: this is not the sign-in app of kleidos-dev\. Nothing was stored\. See the terminal\.<\/p>/);
      assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: `Refused: GitHub returned an app that is not kleidos-cla-sign-in of kleidos-dev (${shown}). Nothing was stored; if you created an app by mistake, delete it on GitHub.` });
      assert.deepEqual(puts(), []);
      assert.deepEqual(sets(), []);
      cleanup(wlog, glog);
      t.mock.restoreAll();
    }
  });

  it("a failed exchange stores nothing and says why", async (t) => {
    gh.status = 500;
    const r = await complete(t);
    assert.equal(r.code, 4);
    assert.equal(r.page.status, 502);
    assert.match(r.page.html, /<p>The exchange with GitHub failed\. See the terminal\.<\/p>/);
    assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: "The exchange failed: GitHub answered 500 to the manifest conversion. Nothing was stored." });
    assert.deepEqual(sets(), []);
  });

  it("each secret that is not stored is named, its value not shown, and the run ends with 1", async (t) => {
    const worker = (n: string) => `${n} (Worker)`;
    const environment = "SIGNIN_CLIENT_SECRET (environment signin of kleidos-dev/cla)";
    for (const [fake, notStored, failure] of [
      [{ FAKE_WRANGLER_FAIL: "SIGNIN_CLIENT_ID" }, [worker("SIGNIN_CLIENT_ID")], "wrangler secret put SIGNIN_CLIENT_ID failed (exit 1); its output is not shown, as it could echo the value."],
      [{ FAKE_WRANGLER_DIE: "SIGNIN_CLIENT_SECRET" }, [worker("SIGNIN_CLIENT_SECRET")], "wrangler secret put SIGNIN_CLIENT_SECRET failed (exit 1); its output is not shown, as it could echo the value."],
      [{ FAKE_GH_FAIL: "secret" }, [environment], "gh secret set failed (exit 1); its output is not shown, as it could echo the value."],
      [{ FAKE_GH_DIE: "secret" }, [environment], "gh secret set failed (exit 1); its output is not shown, as it could echo the value."],
    ] as const) {
      const r = await complete(t, fake);
      assert.equal(r.code, 1, JSON.stringify(fake));
      const stored = [worker("SIGNIN_CLIENT_ID"), worker("SIGNIN_CLIENT_SECRET"), environment].filter((n) => !notStored.includes(n as never));
      assert.ok(r.out.lines.some((l) => l.stream === "err" && l.text === failure));
      assert.ok(r.out.lines.some((l) => l.stream === "out" && l.text === `Stored: ${stored.join(", ")}.`));
      assert.ok(r.out.lines.some((l) => l.stream === "err" && l.text === `NOT stored: ${notStored.join(", ")}. The secret is gone: on the app's settings page generate a new client secret and put it with \`npx wrangler secret put SIGNIN_CLIENT_SECRET\` in worker/ and \`gh secret set SIGNIN_CLIENT_SECRET --env signin --repo kleidos-dev/cla\`, both reading it from standard input.`));
      assert.equal(r.page.status, 500);
      assert.ok(r.page.html.includes(`<h1>Created, but not every secret was stored</h1><p>Stored: ${escapeHtml(stored.join(", "))}.</p><p>Not stored: ${escapeHtml(notStored.join(", "))}. See the terminal.</p>`));
      assert.ok(!r.out.text().includes(SECRETS.client_secret));
      cleanup(wlog, glog);
      t.mock.restoreAll();
    }
  });

  it("when no secret is stored it says nothing was", async (t) => {
    const fail = join(logs, "fails");
    writeFileSync(fail, `#!/bin/sh\ncat >/dev/null\n[ "$1 $2" = "secret put" ] && exit 3\nexit 0\n`);
    chmodSync(fail, 0o755);
    const r = await start(t, { ...base(), wrangler: fail }, { FAKE_GH_FAIL: "secret" });
    const page = await roundTrip(r.base!);
    assert.equal(await r.done, 1);
    assert.ok(r.out.lines.some((l) => l.text === "Stored: nothing."));
    assert.ok(page.html.includes("<p>Stored: nothing.</p><p>Not stored: SIGNIN_CLIENT_ID (Worker), SIGNIN_CLIENT_SECRET (Worker), SIGNIN_CLIENT_SECRET (environment signin of kleidos-dev/cla). See the terminal.</p>"));
    assert.ok(r.out.lines.some((l) => l.stream === "err" && l.text.startsWith("NOT stored: SIGNIN_CLIENT_ID (Worker), SIGNIN_CLIENT_SECRET (Worker), SIGNIN_CLIENT_SECRET (environment signin of kleidos-dev/cla). The secret is gone: ")));
  });

  it("nothing of GitHub's answer makes a line of its own on the terminal, and long text is cut", async (t) => {
    for (const answer of [{ slug: FORGED }, { owner: { id: FORGED } }, { id: FORGED }, { client_id: `Iv23liSIGNINMOCK${FORGED}` }, { slug: "s".repeat(5000) }]) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 4, r.out.text());
      assertPlain(r.out.text());
      assert.doesNotMatch(r.out.text(), /s{201}/);
      t.mock.restoreAll();
    }
    gh.answer = { html_url: FORGED, permissions: { [FORGED]: "write" }, events: [FORGED] };
    const r = await complete(t);
    assert.equal(r.code, 0);
    assertPlain(r.out.text());
  });
});

describe("the script, as the owner runs it", () => {
  const env = (): Record<string, string> => ({ CLA_TEST_GITHUB_WEB: gh.url, CLA_TEST_GITHUB_API: gh.url, CLA_TEST_WRANGLER: FAKE_WRANGLER, CLA_TEST_GH: FAKE_GH, FAKE_WRANGLER_LOG: wlog, FAKE_GH_LOG: glog });

  it("with --test, from any directory, stores what it must and leaks no secret to its output, an argument or a file", async () => {
    const r = await runChild(SCRIPT, ["--test"], env(), async (b) => void (await roundTrip(b)));
    try {
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, /^Test mode: GitHub web http:\/\/127\.0\.0\.1:\d+, API http:\/\/127\.0\.0\.1:\d+, wrangler .*fake-wrangler, gh .*fake-gh\.\n/);
      assert.deepEqual(puts().map((c) => c.input), [CLIENT_ID, SECRETS.client_secret]);
      for (const s of [SECRETS.client_secret, SECRETS.webhook_secret, SECRETS.pem.split("\n")[1]!]) {
        assert.ok(!r.out.includes(s), "a secret reached the script's output");
        for (const c of [...wcalls(), ...gcalls()]) assert.ok(!c.args.join(" ").includes(s), "a secret reached an argument list");
        for (const f of [...filesUnder(r.work), ...filesUnder(r.tmp)]) assert.ok(!readFileSync(f, "latin1").includes(s), `a secret reached ${f}`);
      }
    } finally {
      cleanup(r.work, r.tmp);
    }
  });

  it("a secret put or set that fails and echoes the value leaves it out of the script's output", async () => {
    const r = await runChild(SCRIPT, ["--test"], { ...env(), FAKE_WRANGLER_FAIL: "SIGNIN_CLIENT_SECRET", FAKE_GH_FAIL: "secret" }, async (b) => void (await roundTrip(b)));
    cleanup(r.work, r.tmp);
    assert.equal(r.code, 1, r.out);
    // Both fakes were handed the value and printed it on both of their outputs, which the script must not pass on.
    assert.equal(puts().find((c) => c.args[2] === "SIGNIN_CLIENT_SECRET")?.input, SECRETS.client_secret);
    assert.deepEqual(sets().map((c) => c.input), [SECRETS.client_secret]);
    assert.ok(r.stderr.includes("wrangler secret put SIGNIN_CLIENT_SECRET failed (exit 1); its output is not shown, as it could echo the value.\n"), r.out);
    assert.ok(r.stderr.includes("gh secret set failed (exit 1); its output is not shown, as it could echo the value.\n"), r.out);
    assert.ok(!r.stdout.includes(SECRETS.client_secret) && !r.stderr.includes(SECRETS.client_secret), "the client secret reached the script's output");
  });

  it("out of file descriptors, wrangler cannot start: exit 2 with the sign-in hint, no trace, nothing run", async () => {
    const r = await runChild(SCRIPT, ["--test"], { ...env(), BREAK_SPAWN: "descriptors" }, undefined, { preload: BREAK_SPAWN, descriptors: 256 });
    cleanup(r.work, r.tmp);
    assert.equal(r.code, 2, r.out);
    assert.equal(r.stderr, "wrangler is not signed in: run `npx wrangler login` in worker/ first, then this script again.\n");
    assert.deepEqual(wcalls(), []);
      assert.deepEqual(gcalls(), []);
  });

  it("a failure main() does not answer ends the run with its message on one line and exit 1", async () => {
    for (const [how, text] of [
      ["error", "spawn ENOMEM"],
      ["value", "unknown error"],
    ] as const) {
      const r = await runChild(SCRIPT, ["--test"], { ...env(), BREAK_SPAWN: how }, undefined, { preload: BREAK_SPAWN });
      cleanup(r.work, r.tmp);
      assert.equal(r.code, 1, r.out);
      assert.equal(r.stderr, `${text}\n`, how);
      assert.deepEqual(wcalls(), []);
      assert.deepEqual(gcalls(), []);
    }
  });

  it("without --test the test places are ignored and its exit code is main's", async () => {
    const r = await runChild(SCRIPT, [], { ...env(), PATH: "" });
    cleanup(r.work, r.tmp);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.out, /Test mode/);
    assert.deepEqual(wcalls(), []);
    assert.deepEqual(gcalls(), []);
  });
});
