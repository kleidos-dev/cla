// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// End-to-end test of scripts/create-signin-app.ts against a mocked GitHub
// (both github.com and api.github.com), a fake wrangler and a fake gh. Run
// with `node --test scripts/test/`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "create-signin-app.ts");
const FAKE_WRANGLER = join(here, "fake-wrangler.mjs");
const FAKE_GH = join(here, "fake-gh.mjs");
const WORKER_DIR = join(here, "..", "..", "worker");

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

interface Mock {
  server: Server;
  url: string;
  conversions: number;
  manifestErrors: string[];
  owner: { id: number; login: string };
  slug: string;
  secrets: { client_secret: string; webhook_secret: string; pem: string };
  /** Fields that replace the answer's own, or the whole body of the answer. */
  answer: Record<string, unknown> | string;
}

/** What a hostile answer tries on the terminal: a line of its own, colors, an 8-bit control sequence, a line separator, reversed text. */
const FORGED = "x\r\nForged line \u001b[8m \u009b2J \u2028 \u202e";

/** Runs `check` while GitHub answers the conversion with `answer`. */
async function answering(m: Mock, answer: Mock["answer"], check: () => Promise<void>): Promise<void> {
  m.answer = answer;
  try {
    await check();
  } finally {
    m.answer = {};
  }
}

/** Nothing of GitHub's answer made a line of its own, and no character of the output is other than visible ASCII. */
function assertPlain(out: string): void {
  assert.doesNotMatch(out, /[^\n\x20-\x7e]/);
  assert.doesNotMatch(out, /^Forged line/m);
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString()));
    req.on("end", () => r(s));
  });
}

async function mockGitHub(): Promise<Mock> {
  const m: Mock = {
    server: null as never,
    url: "",
    conversions: 0,
    manifestErrors: [],
    owner: { id: 357318718, login: "kleidos-dev" },
    slug: "kleidos-cla-sign-in",
    // The conversion of any GitHub App also returns a private key and a webhook secret: the script must drop both.
    secrets: { client_secret: `cs_${randomBytes(20).toString("hex")}`, webhook_secret: `wh_${randomBytes(20).toString("hex")}`, pem: `-----BEGIN RSA PRIVATE KEY-----\n${randomBytes(48).toString("base64")}\n-----END RSA PRIVATE KEY-----\n` },
    answer: {},
  };
  m.server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST" && url.pathname === "/organizations/kleidos-dev/settings/apps/new") {
        const form = new URLSearchParams(await body(req));
        const manifest = JSON.parse(form.get("manifest") ?? "{}") as Record<string, unknown>;
        const { redirect_url, ...rest } = manifest;
        try {
          assert.deepEqual(rest, EXPECTED);
          assert.match(String(redirect_url), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        } catch (e) {
          m.manifestErrors.push(String(e));
        }
        res.writeHead(302, { location: `${String(redirect_url)}?code=abc123def456&state=${url.searchParams.get("state") ?? ""}` }).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/app-manifests/abc123def456/conversions") {
        m.conversions++;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(typeof m.answer === "string" ? m.answer : JSON.stringify({ id: 4343, slug: m.slug, owner: m.owner, client_id: "Iv23liSIGNINMOCK0001", html_url: `https://github.com/apps/${m.slug}`, permissions: {}, events: [], ...m.secrets, ...m.answer }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", r));
  m.url = `http://127.0.0.1:${(m.server.address() as { port: number }).port}`;
  return m;
}

interface Call {
  args: string[];
  input: string;
  cwd?: string;
}

interface Run {
  code: number;
  out: string;
  wrangler: Call[];
  gh: Call[];
  work: string;
  tmp: string;
}

interface Opts {
  admin?: string;
  policies?: string;
  ghFail?: string;
  list?: string;
}

function readLog(path: string): Call[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  } catch {
    return [];
  }
}

async function runScript(mock: Mock, opts: Opts = {}): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "cla-work-"));
  const tmp = mkdtempSync(join(tmpdir(), "cla-tmp-"));
  const logDir = mkdtempSync(join(tmpdir(), "cla-log-"));
  const wlog = join(logDir, "wrangler.jsonl");
  const glog = join(logDir, "gh.jsonl");
  const child = spawn(process.execPath, [SCRIPT, "--test"], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: work,
      TMPDIR: tmp,
      CLA_TEST_GITHUB_WEB: mock.url,
      CLA_TEST_GITHUB_API: mock.url,
      CLA_TEST_WRANGLER: FAKE_WRANGLER,
      CLA_TEST_GH: FAKE_GH,
      FAKE_WRANGLER_LOG: wlog,
      FAKE_WRANGLER_LIST: opts.list ?? "",
      FAKE_GH_LOG: glog,
      FAKE_GH_ADMIN: opts.admin ?? "true",
      FAKE_GH_POLICIES: opts.policies ?? "",
      FAKE_GH_FAIL: opts.ghFail ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number>((r) => child.on("close", (c) => r(c ?? 1)));
  const local = await new Promise<string | null>((resolve) => {
    const t = setInterval(() => {
      const m = /Open (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearInterval(t);
        resolve(m[1]!);
      }
    }, 20);
    void exited.then(() => {
      clearInterval(t);
      resolve(null);
    });
  });
  if (local) {
    const html = await (await fetch(local)).text();
    const action = /action="([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&");
    const manifest = /name="manifest" value="([^"]+)"/.exec(html)![1]!.replace(/&(quot|amp|lt|gt|#39);/g, (_, e: string) => ({ quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" })[e]!);
    const gh = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" });
    await fetch(gh.headers.get("location")!).then((r) => r.text());
  }
  const code = await exited;
  const run = { code, out, wrangler: readLog(wlog), gh: readLog(glog), work, tmp };
  rmSync(logDir, { recursive: true, force: true });
  return run;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("create-signin-app.ts", () => {
  let mock: Mock;
  before(async () => {
    mock = await mockGitHub();
  });
  after(() => mock.server.close());

  it("posts a manifest with no permission, event or webhook, and stores the client id and secret without leaking one", async () => {
    const r = await runScript(mock);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(mock.manifestErrors, []);
    const puts = r.wrangler.filter((c) => c.args[0] === "secret" && c.args[1] === "put");
    assert.deepEqual(puts.map((c) => c.args), [["secret", "put", "SIGNIN_CLIENT_ID", "--name", "kleidos-cla"], ["secret", "put", "SIGNIN_CLIENT_SECRET", "--name", "kleidos-cla"]]);
    assert.deepEqual(puts.map((c) => c.input), ["Iv23liSIGNINMOCK0001", mock.secrets.client_secret]);
    for (const c of r.wrangler) assert.equal(c.cwd, WORKER_DIR);
    const set = r.gh.filter((c) => c.args[0] === "secret");
    assert.deepEqual(set.map((c) => c.args), [["secret", "set", "SIGNIN_CLIENT_SECRET", "--env", "signin", "--repo", "kleidos-dev/cla"]]);
    assert.equal(set[0]!.input, mock.secrets.client_secret);
    // The environment exists and is limited to main before anything is shown.
    assert.ok(r.gh.some((c) => c.args.includes("PUT") && c.args.includes("repos/kleidos-dev/cla/environments/signin") && JSON.parse(c.input).deployment_branch_policy.custom_branch_policies === true));
    assert.ok(r.gh.some((c) => c.args.includes("POST") && c.args.at(-3)?.endsWith("/deployment-branch-policies") && JSON.parse(c.input).name === "main"));
    // The secret, the private key and the webhook secret reach no output, argument or file; the last two go nowhere at all.
    for (const s of [mock.secrets.client_secret, mock.secrets.webhook_secret, mock.secrets.pem.split("\n")[1]!]) {
      assert.ok(!r.out.includes(s), "a secret reached the script's output");
      for (const c of [...r.wrangler, ...r.gh]) assert.ok(!c.args.join(" ").includes(s), "a secret reached an argument list");
      for (const f of [...filesUnder(r.work), ...filesUnder(r.tmp)]) assert.ok(!readFileSync(f, "latin1").includes(s), `a secret reached ${f}`);
    }
    for (const s of [mock.secrets.webhook_secret, mock.secrets.pem.split("\n")[1]!]) for (const c of [...r.wrangler, ...r.gh]) assert.ok(!c.input.includes(s));
    assert.match(r.out, /The client id \(public\): Iv23liSIGNINMOCK0001/);
    assert.match(r.out, /"signin_client_id": "Iv23liSIGNINMOCK0001"/);
    assert.match(r.out, /Do not install it anywhere/);
  });

  it("an existing main-only policy is kept, another branch stops it before anything is created", async () => {
    const kept = await runScript(mock, { policies: "main:branch" });
    assert.equal(kept.code, 0, kept.out);
    assert.ok(!kept.gh.some((c) => c.args.includes("POST")));
    const before = mock.conversions;
    const wider = await runScript(mock, { policies: "main:branch,release/*:branch" });
    assert.equal(wider.code, 2);
    assert.match(wider.out, /allows other branches than main/);
    assert.doesNotMatch(wider.out, /Open http/);
    assert.equal(mock.conversions, before);
    const hostile = await runScript(mock, { policies: `main:branch,${FORGED}${"s".repeat(5000)}:branch` });
    assert.equal(hostile.code, 2);
    assert.match(hostile.out, /allows other branches than main \(main:branch, x/);
    assertPlain(hostile.out);
    assert.doesNotMatch(hostile.out, /s{200}/);
  });

  it("refuses before showing anything when gh cannot administer the register or wrangler cannot reach the Worker", async () => {
    const noAdmin = await runScript(mock, { admin: "false" });
    assert.equal(noAdmin.code, 2);
    assert.match(noAdmin.out, /gh cannot administer kleidos-dev\/cla/);
    assert.doesNotMatch(noAdmin.out, /Open http/);
    const unreachable = await runScript(mock, { list: "fail" });
    assert.equal(unreachable.code, 2);
    assert.match(unreachable.out, /cannot reach the Worker kleidos-cla/);
  });

  it("an app that is not the sign-in app of kleidos-dev stores nothing", async () => {
    mock.slug = "kleidos-cla";
    try {
      const r = await runScript(mock);
      assert.notEqual(r.code, 0);
      assert.equal(r.wrangler.filter((c) => c.args[1] === "put").length, 0);
      assert.equal(r.gh.filter((c) => c.args[0] === "secret").length, 0);
      assert.match(r.out, /Nothing was stored/);
    } finally {
      mock.slug = "kleidos-cla-sign-in";
    }
  });

  it("nothing of GitHub's answer makes a line of its own on the terminal", async () => {
    for (const answer of [{ slug: FORGED }, { owner: { id: FORGED } }, { id: FORGED }, { id: -1 }, { client_id: `Iv23liSIGNINMOCK${FORGED}` }, { client_id: "Iv23liSIGNINMOCK\n" }])
      await answering(mock, answer, async () => {
        const r = await runScript(mock);
        assert.equal(r.code, 4, r.out);
        assertPlain(r.out);
        assert.match(r.out, /Nothing was stored/);
        assert.equal(r.wrangler.filter((c) => c.args[1] === "put").length, 0);
        assert.equal(r.gh.filter((c) => c.args[0] === "secret").length, 0);
      });
    await answering(mock, { html_url: FORGED, permissions: { [FORGED]: "write" }, events: [FORGED] }, async () => {
      const r = await runScript(mock);
      assert.equal(r.code, 0, r.out);
      assertPlain(r.out);
      assert.match(r.out, /Warning: GitHub gave the app permissions or events/);
      assert.match(r.out, /app id 4343, http:\/\/127\.0\.0\.1:\d+\/apps\/kleidos-cla-sign-in\)/);
    });
  });

  it("what is shown of GitHub's answer is cut short", async () => {
    for (const answer of [{ slug: "s".repeat(5000) }, { owner: { id: "s".repeat(5000) } }])
      await answering(mock, answer, async () => {
        const r = await runScript(mock);
        assert.equal(r.code, 4, r.out);
        assert.equal(/s{100,}/.exec(r.out)?.[0].length, 200, r.out);
      });
  });

  it("an answer that is not JSON is not quoted", async () => {
    await answering(mock, `{"client_secret": ${mock.secrets.client_secret}`, async () => {
      const r = await runScript(mock);
      assert.equal(r.code, 4, r.out);
      assert.match(r.out, /the conversion is not JSON/);
      assert.ok(!r.out.includes(mock.secrets.client_secret.slice(0, 8)), r.out);
    });
  });

  it("a failing gh secret set exits non-zero, names what was not stored and echoes nothing", async () => {
    const r = await runScript(mock, { ghFail: "secret" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /NOT stored: SIGNIN_CLIENT_SECRET \(environment signin of kleidos-dev\/cla\)\./);
    assert.ok(!r.out.includes(mock.secrets.client_secret));
  });
});
