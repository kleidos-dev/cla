// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// scripts/create-github-app.ts against a mocked GitHub (both github.com and
// api.github.com) and a fake wrangler: its parts one by one, main() in this
// process with settings of the test's own, and the script as the owner runs
// it, a child process with --test. Run with `node --test scripts/test/`.
import { createPublicKey, createSign, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { SECRET_NAMES, escapeHtml, exchange, main, manifest, printable, run, sameText, settings } from "../create-github-app.ts";
import type { Settings } from "../create-github-app.ts";
import { CODE, FAKE_WRANGLER, FORGED, ORG_ID, WORKER_DIR, assertPlain, capture, cleanup, filesUnder, here, localPage, mockGitHub, rawGet, readLog, roundTrip, runChild, scratch, setEnv } from "./support.ts";
import type { GitHub, Output } from "./support.ts";

const SCRIPT = join(here, "..", "create-github-app.ts");
const PINNED = join(WORKER_DIR, "node_modules", ".bin", "wrangler");
const NAMES = ["APP_ID", "APP_PRIVATE_KEY", "CLIENT_ID", "CLIENT_SECRET", "WEBHOOK_SECRET", "SESSION_KEY"];

const EXPECTED = {
  name: "kleidos-cla",
  url: "https://cla.kleidos.dev",
  description: "Checks that the authors of a pull request have accepted the Kleidos Contributor Agreement and lets them sign it at cla.kleidos.dev.",
  public: true,
  hook_attributes: { url: "https://cla.kleidos.dev/webhook", active: true },
  callback_urls: ["https://cla.kleidos.dev/auth/callback"],
  setup_url: "https://cla.kleidos.dev/setup",
  setup_on_update: false,
  request_oauth_on_install: false,
  default_permissions: { metadata: "read", contents: "read", pull_requests: "write", checks: "write", actions: "write" },
  default_events: ["pull_request", "check_run", "workflow_run"],
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC = createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString());
const SECRETS = { client_secret: `cs_${randomBytes(20).toString("hex")}`, webhook_secret: `wh_${randomBytes(20).toString("hex")}`, pem: PEM };
const ANSWER = { id: 4242, slug: "kleidos-cla", owner: { id: ORG_ID, login: "kleidos-dev" }, client_id: "Iv23liMOCK", html_url: "https://github.com/apps/kleidos-cla", ...SECRETS };

let gh: GitHub;
let logs: string;
let wlog: string;
before(async () => {
  gh = await mockGitHub(ANSWER);
});
after(async () => {
  await gh.close();
});
beforeEach(() => {
  logs = scratch("cla-log-");
  wlog = join(logs, "wrangler.jsonl");
  gh.answer = {};
  gh.status = 201;
  gh.hold = null;
  gh.conversions.length = 0;
  gh.manifests.length = 0;
});
afterEach(() => cleanup(logs));

const base = (): Settings => ({ test: false, web: gh.url, api: gh.url, wrangler: FAKE_WRANGLER, waitMs: 900_000 });
const calls = () => readLog(wlog);
const puts = () => calls().filter((c) => c.args[1] === "put");

/** main() in this process, the fake wrangler told `fake`; resolves once the page is up, or main has ended. */
async function start(t: TestContext, s: Settings = base(), fake: Record<string, string> = {}): Promise<{ out: Output; done: Promise<number>; base: string | null }> {
  const restore = setEnv({ FAKE_WRANGLER_LOG: wlog, FAKE_WRANGLER_FAIL: "", FAKE_WRANGLER_WHOAMI: "", FAKE_WRANGLER_LIST: "", FAKE_WRANGLER_DIE: "", ...fake });
  t.after(restore);
  const out = capture(t);
  const done = main(s);
  const opened = await Promise.race([out.waitFor(/^Open (http:\/\/127\.0\.0\.1:\d+\/) in your browser, signed in to GitHub as an owner of kleidos-dev\.$/).then((m) => m[1]!), done.then(() => null)]);
  return { out, done, base: opened };
}

/** main() through to its end with the browser's round trip. */
async function complete(t: TestContext, fake: Record<string, string> = {}): Promise<{ out: Output; code: number; page: { status: number; html: string }; port: number }> {
  const r = await start(t, base(), fake);
  assert.ok(r.base, r.out.text());
  const page = await roundTrip(r.base);
  return { out: r.out, code: await r.done, page, port: Number(new URL(r.base).port) };
}

describe("settings", () => {
  it("without --test the places are GitHub's and the pinned wrangler's, whatever the environment says", () => {
    const env = { CLA_TEST_GITHUB_WEB: "http://evil.example", CLA_TEST_GITHUB_API: "http://evil.example", CLA_TEST_WRANGLER: "/tmp/evil" };
    for (const argv of [[], ["--testing"], ["test"], ["-test"]]) assert.deepEqual(settings(argv, env), { test: false, web: "https://github.com", api: "https://api.github.com", wrangler: PINNED, waitMs: 900_000 }, argv.join(" "));
  });

  it("with --test anywhere the environment names the places, each without one trailing slash", () => {
    const env = { CLA_TEST_GITHUB_WEB: "http://127.0.0.1:1/", CLA_TEST_GITHUB_API: "http://127.0.0.1:2//", CLA_TEST_WRANGLER: "/x/wrangler/" };
    assert.deepEqual(settings(["a", "--test"], env), { test: true, web: "http://127.0.0.1:1", api: "http://127.0.0.1:2/", wrangler: "/x/wrangler/", waitMs: 900_000 });
  });

  it("with --test and nothing in the environment, the real places", () => {
    assert.deepEqual(settings(["--test"], {}), { test: true, web: "https://github.com", api: "https://api.github.com", wrangler: PINNED, waitMs: 900_000 });
  });
});

describe("the manifest", () => {
  it("is the bot's, with these permissions and events and no other, and the local port in redirect_url only", () => {
    assert.deepEqual(manifest(4321), { ...EXPECTED, redirect_url: "http://127.0.0.1:4321/callback" });
    assert.deepEqual(SECRET_NAMES, NAMES);
  });
});

describe("the small parts", () => {
  it("escapeHtml escapes the five characters of HTML and nothing else", () => {
    assert.equal(escapeHtml(`a&b<c>d"e'f é\n`), "a&amp;b&lt;c&gt;d&quot;e&#39;f é\n");
    assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  });

  it("sameText says equal only for the same bytes, and never throws on another length", () => {
    assert.equal(sameText("abc", "abc"), true);
    assert.equal(sameText("", ""), true);
    assert.equal(sameText("abc", "abx"), false);
    assert.equal(sameText("abc", "ab"), false);
    assert.equal(sameText("é", "ee"), false);
  });

  it("printable keeps visible ASCII, turns everything else into ?, and cuts at 200", () => {
    assert.equal(printable(" ~az09"), " ~az09");
    assert.equal(printable("a\x1fb\x7fc\u0080d e\r\n"), "a?b?c?d?e??");
    assert.equal(printable("s".repeat(200)), "s".repeat(200));
    assert.equal(printable("s".repeat(201)), "s".repeat(200));
    assert.equal(printable("é".repeat(300)), "?".repeat(200));
  });
});

describe("run", () => {
  it("runs the command in worker/ with the arguments and the standard input, and gives its exit code", async (t) => {
    t.after(setEnv({ FAKE_WRANGLER_LOG: wlog, FAKE_WRANGLER_FAIL: "X" }));
    assert.deepEqual(await run(FAKE_WRANGLER, ["secret", "put", "Y"], "value\n"), { code: 0 });
    assert.deepEqual(await run(FAKE_WRANGLER, ["secret", "put", "X"], "other"), { code: 1 });
    assert.deepEqual(await run(FAKE_WRANGLER, ["whoami"]), { code: 0 });
    assert.deepEqual(calls(), [
      { args: ["secret", "put", "Y"], input: "value\n", cwd: WORKER_DIR.replace(/\/$/, "") },
      { args: ["secret", "put", "X"], input: "other", cwd: WORKER_DIR.replace(/\/$/, "") },
      { args: ["whoami"], input: "", cwd: WORKER_DIR.replace(/\/$/, "") },
    ]);
  });

  it("a command that cannot start is 127, one killed by a signal is 1", async (t) => {
    t.after(setEnv({ FAKE_WRANGLER_LOG: wlog, FAKE_WRANGLER_DIE: "whoami" }));
    const plain = join(logs, "not-executable");
    writeFileSync(plain, "#!/bin/sh\nexit 0\n");
    chmodSync(plain, 0o644);
    assert.deepEqual(await run(join(logs, "missing"), ["whoami"]), { code: 127 });
    assert.deepEqual(await run(plain, ["whoami"]), { code: 127 });
    assert.deepEqual(await run(FAKE_WRANGLER, ["whoami"]), { code: 1 });
  });

  it("a command that dies before reading its input does not take the script down", async (t) => {
    t.after(setEnv({ FAKE_WRANGLER_LOG: wlog }));
    const quits = join(logs, "quits");
    writeFileSync(quits, "#!/bin/sh\nexit 6\n");
    chmodSync(quits, 0o755);
    assert.deepEqual(await run(quits, [], "x".repeat(4 << 20)), { code: 6 });
  });
});

describe("exchange", () => {
  it("posts the code to the conversion with GitHub's headers and gives back the answer", async () => {
    const c = await exchange(gh.url, CODE);
    assert.deepEqual(c, ANSWER);
    assert.equal(gh.conversions.length, 1);
    const sent = gh.conversions[0]!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, `/app-manifests/${CODE}/conversions`);
    assert.equal(sent.headers.accept, "application/vnd.github+json");
    assert.equal(sent.headers["x-github-api-version"], "2022-11-28");
    assert.equal(sent.headers["user-agent"], "kleidos-cla-setup");
  });

  it("the code is one segment of the path, whatever it holds", async () => {
    await exchange(gh.url, "a/../b?c#d");
    assert.deepEqual(gh.conversions.map((c) => c.path), ["/app-manifests/a%2F..%2Fb%3Fc%23d/conversions"]);
  });

  it("any status but 201 is refused with the status", async () => {
    for (const status of [200, 202, 401, 404, 422, 500]) {
      gh.status = status;
      await assert.rejects(exchange(gh.url, CODE), { message: `GitHub answered ${status} to the manifest conversion` });
    }
  });

  it("an answer that is not JSON is refused without being quoted", async () => {
    gh.answer = `{"client_secret": "${SECRETS.client_secret}"`;
    await assert.rejects(exchange(gh.url, CODE), { message: "the conversion is not JSON" });
  });

  it("an id that is not a positive safe integer is refused", async () => {
    for (const id of [undefined, null, "4242", 0, -1, 1.5, 2 ** 53, true]) {
      gh.answer = { id };
      await assert.rejects(exchange(gh.url, CODE), { message: "the conversion has no id" }, String(id));
    }
    gh.answer = { id: 1 };
    assert.equal((await exchange(gh.url, CODE)).id, 1);
    gh.answer = { id: 2 ** 53 - 1 };
    assert.equal((await exchange(gh.url, CODE)).id, 2 ** 53 - 1);
  });

  it("each text field must be a non-empty string", async () => {
    for (const k of ["slug", "client_id", "client_secret", "webhook_secret", "pem"]) {
      for (const v of [undefined, "", 7, ["x"]]) {
        gh.answer = { [k]: v };
        await assert.rejects(exchange(gh.url, CODE), { message: `the conversion has no ${k}` }, `${k}=${String(v)}`);
      }
    }
  });
});

describe("main, before anything is shown", () => {
  it("says the test places only in test mode", async (t) => {
    const quiet = await start(t, { ...base(), wrangler: join(logs, "missing") });
    assert.equal(await quiet.done, 2);
    assert.deepEqual(quiet.out.lines.map((l) => l.stream), ["err"]);
    t.mock.restoreAll();
    const loud = await start(t, { ...base(), test: true, wrangler: join(logs, "missing") });
    assert.equal(await loud.done, 2);
    assert.equal(loud.out.lines[0]!.text, `Test mode: GitHub web ${gh.url}, API ${gh.url}, wrangler ${join(logs, "missing")}.`);
    assert.equal(loud.out.lines[0]!.stream, "out");
  });

  it("no wrangler at the pinned place: exit 2, nothing run", async (t) => {
    const r = await start(t, { ...base(), wrangler: join(logs, "missing") });
    assert.equal(await r.done, 2);
    assert.deepEqual(r.out.lines, [{ stream: "err", text: `No wrangler at ${join(logs, "missing")}: run \`npm ci\` in worker/ first, then this script again.` }]);
    assert.deepEqual(calls(), []);
  });

  it("wrangler not signed in, or killed: exit 2 before the Worker is asked", async (t) => {
    for (const fake of [{ FAKE_WRANGLER_WHOAMI: "fail" }, { FAKE_WRANGLER_DIE: "whoami" }]) {
      const r = await start(t, base(), fake);
      assert.equal(await r.done, 2);
      assert.deepEqual(r.out.lines, [{ stream: "err", text: "wrangler is not signed in: run `npx wrangler login` in worker/ first, then this script again." }]);
      assert.deepEqual(calls().map((c) => c.args), [["whoami"]]);
      cleanup(wlog);
      t.mock.restoreAll();
    }
  });

  it("a Worker wrangler cannot reach: exit 2 with wrangler's exit code, nothing created", async (t) => {
    const r = await start(t, base(), { FAKE_WRANGLER_LIST: "fail" });
    assert.equal(await r.done, 2);
    assert.deepEqual(r.out.lines, [{ stream: "err", text: "wrangler cannot reach the Worker kleidos-cla (exit 7): deploy it first with `npm run deploy` in worker/, then run this script again. Nothing was created." }]);
    assert.deepEqual(calls().map((c) => c.args), [["whoami"], ["secret", "list", "--name", "kleidos-cla"]]);
    assert.equal(gh.conversions.length, 0);
  });
});

describe("main, the local page", () => {
  it("shows one form that posts the exact manifest to the organization's new-app page, with the state", async (t) => {
    const r = await start(t);
    const port = Number(new URL(r.base!).port);
    const p = await localPage(r.base!);
    assert.equal(p.status, 200);
    assert.deepEqual(Object.fromEntries(p.headers), {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-security-policy": `default-src 'none'; form-action ${gh.url}`,
      "content-type": "text/html; charset=utf-8",
      date: p.headers.get("date")!,
      "keep-alive": "timeout=5",
      "referrer-policy": "no-referrer",
      "transfer-encoding": "chunked",
    });
    const state = new URL(p.action).searchParams.get("state")!;
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(p.action, `${gh.url}/organizations/kleidos-dev/settings/apps/new?state=${state}`);
    assert.deepEqual(JSON.parse(p.manifest), manifest(port));
    assert.equal(
      p.html,
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>kleidos-cla setup</title><body><h1>Create the GitHub App kleidos-cla</h1><p>The button posts the app's manifest to GitHub, which shows it and asks you to confirm.</p><form method="post" action="${escapeHtml(p.action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest(port)))}"><button type="submit">Create the GitHub App on kleidos-dev</button></form></body></html>`,
    );
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
  });

  it("a request under any other Host gets nothing, not even the state", async (t) => {
    const r = await start(t);
    const port = new URL(r.base!).port;
    for (const host of ["rebound.example", `localhost:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`]) {
      const got = await rawGet(r.base!, host);
      assert.deepEqual(got, { status: 421, body: "wrong host\n", type: "text/plain" }, host);
    }
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
  });

  it("any other path or method is 404", async (t) => {
    const r = await start(t);
    for (const [method, path] of [["POST", ""], ["GET", "favicon.ico"], ["POST", "callback"], ["GET", "callback/"]] as const) {
      const res = await fetch(`${r.base!}${path}`, { method });
      assert.equal(res.status, 404, `${method} /${path}`);
      assert.equal(await res.text(), "");
    }
    assert.equal(gh.conversions.length, 0);
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
  });

  it("a callback whose state is not this run's is refused, and the genuine redirect still completes", async (t) => {
    const r = await start(t);
    const state = new URL((await localPage(r.base!)).action).searchParams.get("state")!;
    const forged = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    for (const query of [`code=${CODE}&state=${forged}`, `code=${CODE}&state=x`, `code=${CODE}`, `state=${forged}`]) {
      const res = await fetch(`${r.base!}callback?${query}`);
      assert.equal(res.status, 400, query);
      assert.match(await res.text(), /<p>Refused: this redirect did not start here\. Nothing was exchanged\.<\/p>/);
    }
    assert.equal(r.out.lines.filter((l) => l.text === "Refused a redirect whose state does not match; still waiting for GitHub's." && l.stream === "err").length, 4);
    assert.equal(gh.conversions.length, 0);
    const back = await roundTrip(r.base!);
    assert.equal(back.status, 200);
    assert.equal(await r.done, 0);
    assert.equal(gh.conversions.length, 1);
  });

  it("a code GitHub would not give is refused once: exit 3, nothing exchanged", async (t) => {
    for (const code of [null, "", "a b", "a.b", "é", "a".repeat(101)]) {
      const r = await start(t);
      const state = new URL((await localPage(r.base!)).action).searchParams.get("state")!;
      const res = await fetch(`${r.base!}callback?${new URLSearchParams(code === null ? { state } : { code, state })}`);
      assert.equal(res.status, 400);
      assert.match(await res.text(), /<p>Refused: no valid code\.<\/p>/);
      assert.equal(await r.done, 3, JSON.stringify(code));
      assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: "Refused: GitHub's redirect carried no valid code." });
      assert.equal(gh.conversions.length, 0);
      t.mock.restoreAll();
    }
  });

  it("a code of 100 characters of GitHub's alphabet is exchanged", async (t) => {
    const r = await start(t);
    const state = new URL((await localPage(r.base!)).action).searchParams.get("state")!;
    const code = "Az09_-".repeat(17).slice(0, 100);
    await fetch(`${r.base!}callback?${new URLSearchParams({ code, state })}`);
    assert.equal(await r.done, 0);
    assert.deepEqual(gh.conversions.map((c) => c.path), [`/app-manifests/${code}/conversions`]);
  });

  it("a second callback while the first is being exchanged is answered 'Already handled' and exchanges nothing", async (t) => {
    let release!: () => void;
    gh.hold = new Promise((r) => (release = r));
    const asked = new Promise<void>((r) => (gh.asked = r));
    const r = await start(t);
    const state = new URL((await localPage(r.base!)).action).searchParams.get("state")!;
    const first = fetch(`${r.base!}callback?code=${CODE}&state=${state}`);
    await asked;
    const second = await fetch(`${r.base!}callback?code=${CODE}&state=${state}`);
    assert.equal(second.status, 409);
    assert.match(await second.text(), /<body><p>Already handled\.<\/p><\/body>/);
    release();
    assert.equal((await first).status, 200);
    assert.equal(await r.done, 0);
    assert.equal(gh.conversions.length, 1);
  });

  it("waits fifteen minutes for GitHub's redirect, then exits 5 and stops listening", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = settings([], {});
    const r = await start(t, { ...base(), waitMs: s.waitMs });
    t.mock.timers.tick(15 * 60 * 1000 - 1);
    assert.ok(!r.out.lines.some((l) => /Timed out/.test(l.text)));
    t.mock.timers.tick(1);
    assert.equal(await r.done, 5);
    assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: "Timed out waiting for GitHub's redirect." });
    await assert.rejects(fetch(r.base!), /fetch failed/);
    assert.equal(gh.conversions.length, 0);
  });

  it("once done it stops listening and its timer no longer runs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const r = await start(t);
    await roundTrip(r.base!);
    assert.equal(await r.done, 0);
    const lines = r.out.lines.length;
    t.mock.timers.tick(900_000);
    assert.equal(r.out.lines.length, lines);
    await assert.rejects(fetch(r.base!), /fetch failed/);
  });
});

describe("main, after GitHub's redirect", () => {
  it("stores the six secrets in order, from GitHub's answer, a PKCS#8 key and a fresh session key", async (t) => {
    const r = await complete(t);
    assert.equal(r.code, 0, r.out.text());
    assert.deepEqual(gh.manifests, [manifest(r.port)]);
    assert.deepEqual(calls().map((c) => c.args), [["whoami"], ["secret", "list", "--name", "kleidos-cla"], ...NAMES.map((n) => ["secret", "put", n, "--name", "kleidos-cla"])]);
    const v = Object.fromEntries(puts().map((c) => [c.args[2]!, c.input]));
    assert.equal(v.APP_ID, "4242");
    assert.equal(v.CLIENT_ID, "Iv23liMOCK");
    assert.equal(v.CLIENT_SECRET, SECRETS.client_secret);
    assert.equal(v.WEBHOOK_SECRET, SECRETS.webhook_secret);
    assert.match(v.APP_PRIVATE_KEY!, /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/);
    assert.match(v.SESSION_KEY!, /^[A-Za-z0-9_-]{43}$/);
    // The PKCS#8 key signs what GitHub's public key verifies.
    const sig = createSign("RSA-SHA256").update("jwt").sign(v.APP_PRIVATE_KEY!);
    assert.ok(createVerify("RSA-SHA256").update("jwt").verify(PUBLIC, sig));
    assert.equal(r.page.status, 200);
    assert.match(r.page.html, /<body><h1>Done<\/h1><p>Stored: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, SESSION_KEY\.<\/p><p>You can close this tab and go back to the terminal\.<\/p><\/body>/);
    assert.deepEqual(r.out.lines.slice(1), [
      { stream: "out", text: `\nGitHub App created: kleidos-cla (app id 4242, ${gh.url}/apps/kleidos-cla).` },
      { stream: "out", text: "Stored in the Worker kleidos-cla: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, SESSION_KEY." },
      { stream: "out", text: `\nNext:\n  1. Install it on kleidos-dev, only on kleidos-dev/cla: ${gh.url}/apps/kleidos-cla/installations/new` },
      { stream: "out", text: '  2. On the app\'s page, check: "Expire user authorization tokens" on, "Enable Device Flow" off.' },
      { stream: "out", text: "  3. The app id for the rulesets' required check (integration_id) is 4242." },
      { stream: "out", text: '  4. In registry/config.json set "app_id": 4242, and add the bot account to "exempt": gh api users/kleidos-cla%5Bbot%5D --jq .id' },
    ]);
  });

  it("each run makes a session key of its own", async (t) => {
    await complete(t);
    const first = puts().find((c) => c.args[2] === "SESSION_KEY")!.input;
    t.mock.restoreAll();
    await complete(t);
    const keys = puts().filter((c) => c.args[2] === "SESSION_KEY").map((c) => c.input);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], first);
    assert.notEqual(keys[1], first);
  });

  it("an app that is not kleidos-cla of kleidos-dev stores nothing: owner and slug each alone", async (t) => {
    for (const [answer, shown] of [
      [{ owner: { id: 1, login: "kleidos-dev" } }, "slug kleidos-cla, owner id 1"],
      [{ owner: null }, "slug kleidos-cla, owner id none"],
      [{ owner: { login: "kleidos-dev" } }, "slug kleidos-cla, owner id none"],
      [{ owner: undefined }, "slug kleidos-cla, owner id none"],
      [{ slug: "kleidos-cla-2" }, "slug kleidos-cla-2, owner id 357318718"],
    ] as const) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 4, JSON.stringify(answer));
      assert.equal(r.page.status, 502);
      assert.match(r.page.html, /<p>Refused: this is not the kleidos-cla app of kleidos-dev\. Nothing was stored\. See the terminal\.<\/p>/);
      assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: `Refused: GitHub returned an app that is not kleidos-cla of kleidos-dev (${shown}). Nothing was stored; if you created an app by mistake, delete it on GitHub.` });
      assert.deepEqual(puts(), []);
      cleanup(wlog);
      t.mock.restoreAll();
    }
  });

  it("a failed exchange stores nothing and says why", async (t) => {
    for (const [answer, why] of [
      [{ id: "4242" }, "the conversion has no id"],
      [{ pem: "not a key" }, null],
      ["[", "the conversion is not JSON"],
    ] as const) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 4);
      assert.equal(r.page.status, 502);
      assert.match(r.page.html, /<p>The exchange with GitHub failed\. See the terminal\.<\/p>/);
      const last = r.out.lines.at(-1)!;
      assert.equal(last.stream, "err");
      if (why) assert.equal(last.text, `The exchange failed: ${why}. Nothing was stored.`);
      else assert.match(last.text, /^The exchange failed: .+\. Nothing was stored\.$/);
      assert.deepEqual(puts(), []);
      t.mock.restoreAll();
    }
  });

  it("GitHub answering with an error status stores nothing", async (t) => {
    gh.status = 422;
    const r = await complete(t);
    assert.equal(r.code, 4);
    assert.deepEqual(r.out.lines.at(-1), { stream: "err", text: "The exchange failed: GitHub answered 422 to the manifest conversion. Nothing was stored." });
  });

  it("a secret wrangler does not take is named, the rest are stored, and the value is not shown", async (t) => {
    for (const fake of [{ FAKE_WRANGLER_FAIL: "CLIENT_SECRET" }, { FAKE_WRANGLER_DIE: "CLIENT_SECRET" }]) {
      const r = await complete(t, fake);
      assert.equal(r.code, 1);
      assert.deepEqual(puts().map((c) => c.args[2]), NAMES);
      assert.equal(r.page.status, 500);
      assert.match(r.page.html, /<h1>Created, but not every secret was stored<\/h1><p>Stored: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, WEBHOOK_SECRET, SESSION_KEY\.<\/p><p>Not stored: CLIENT_SECRET\. See the terminal\.<\/p>/);
      const text = r.out.text();
      assert.ok(r.out.lines.some((l) => l.stream === "err" && l.text === `wrangler secret put CLIENT_SECRET failed (exit 1); its output is not shown, as it could echo the value.`));
      assert.ok(r.out.lines.some((l) => l.stream === "out" && l.text === "Stored in the Worker kleidos-cla: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, WEBHOOK_SECRET, SESSION_KEY."));
      assert.ok(r.out.lines.some((l) => l.stream === "err" && l.text.startsWith("NOT stored: CLIENT_SECRET. The values are gone: ")));
      assert.ok(!text.includes(SECRETS.client_secret));
      cleanup(wlog);
      t.mock.restoreAll();
    }
  });

  it("when no secret is stored it says nothing was", async (t) => {
    const fail = join(logs, "fails");
    writeFileSync(fail, `#!/bin/sh\ncat >/dev/null\ncase "$1" in secret) [ "$2" = list ] && exit 0; exit 3;; esac\nexit 0\n`);
    chmodSync(fail, 0o755);
    const r = await start(t, { ...base(), wrangler: fail });
    const page = await roundTrip(r.base!);
    assert.equal(await r.done, 1);
    assert.match(page.html, /<p>Stored: nothing\.<\/p><p>Not stored: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, SESSION_KEY\. See the terminal\.<\/p>/);
    assert.ok(r.out.lines.some((l) => l.text === "Stored in the Worker kleidos-cla: nothing."));
  });

  it("nothing of GitHub's answer makes a line of its own on the terminal", async (t) => {
    for (const answer of [{ slug: FORGED }, { owner: { id: FORGED } }, { id: FORGED }, { client_secret: 7 }]) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 4, r.out.text());
      assertPlain(r.out.text());
      assert.deepEqual(puts(), []);
      t.mock.restoreAll();
    }
    gh.answer = { html_url: FORGED };
    const r = await complete(t);
    assert.equal(r.code, 0);
    assertPlain(r.out.text());
  });

  it("what is shown of GitHub's answer is cut short", async (t) => {
    for (const answer of [{ slug: "s".repeat(5000) }, { owner: { id: "s".repeat(5000) } }]) {
      gh.answer = answer;
      const r = await complete(t);
      assert.equal(r.code, 4);
      assert.equal(/s{100,}/.exec(r.out.text())?.[0].length, 200);
      t.mock.restoreAll();
    }
  });
});

describe("the script, as the owner runs it", () => {
  const env = (): Record<string, string> => ({ CLA_TEST_GITHUB_WEB: gh.url, CLA_TEST_GITHUB_API: gh.url, CLA_TEST_WRANGLER: FAKE_WRANGLER, FAKE_WRANGLER_LOG: wlog });

  it("with --test, from any directory, stores the six secrets and leaks none to its output, an argument or a file", async () => {
    const r = await runChild(SCRIPT, ["--test"], env(), async (b) => void (await roundTrip(b)));
    try {
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, /^Test mode: GitHub web http:\/\/127\.0\.0\.1:\d+, API http:\/\/127\.0\.0\.1:\d+, wrangler .*fake-wrangler\.\n/);
      const v = Object.fromEntries(puts().map((c) => [c.args[2]!, c.input]));
      assert.deepEqual(Object.keys(v), NAMES);
      const secrets = [SECRETS.client_secret, SECRETS.webhook_secret, v.SESSION_KEY!, ...v.APP_PRIVATE_KEY!.split("\n").filter((l) => l.length > 40), ...PEM.split("\n").filter((l) => l.length > 40)];
      for (const s of secrets) {
        assert.ok(!r.out.includes(s), "a secret reached the script's output");
        for (const c of calls()) assert.ok(!c.args.join(" ").includes(s), "a secret reached an argument list");
        for (const f of [...filesUnder(r.work), ...filesUnder(r.tmp)]) assert.ok(!readFileSync(f, "latin1").includes(s), `a secret reached ${f}`);
      }
    } finally {
      cleanup(r.work, r.tmp);
    }
  });

  it("without --test the test places are ignored and its exit code is main's", async () => {
    // It then looks for the real wrangler of worker/ (kept from starting by an empty PATH) and never for the fake.
    const r = await runChild(SCRIPT, [], { ...env(), PATH: "" });
    cleanup(r.work, r.tmp);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.out, /Test mode/);
    assert.match(r.out, /npm ci|wrangler login/);
    assert.equal(gh.conversions.length, 0);
    assert.deepEqual(calls(), []);
  });
});
