// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// End-to-end test of scripts/create-github-app.ts against a mocked GitHub
// (both github.com and api.github.com) and a fake wrangler. Run with
// `node --test scripts/test/`.
import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, createSign, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "create-github-app.ts");
const FAKE = join(here, "fake-wrangler.mjs");
const WORKER_DIR = join(here, "..", "..", "worker");
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

interface Mock {
  server: Server;
  url: string;
  conversions: number;
  manifestErrors: string[];
  owner: { id: number; login: string };
  publicPem: string;
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
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const m: Mock = {
    server: null as never,
    url: "",
    conversions: 0,
    manifestErrors: [],
    owner: { id: 357318718, login: "kleidos-dev" },
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    secrets: { client_secret: `cs_${randomBytes(20).toString("hex")}`, webhook_secret: `wh_${randomBytes(20).toString("hex")}`, pem },
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
        res.end(typeof m.answer === "string" ? m.answer : JSON.stringify({ id: 4242, slug: "kleidos-cla", owner: m.owner, client_id: "Iv23liMOCK", html_url: "https://github.com/apps/kleidos-cla", ...m.secrets, ...m.answer }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", r));
  m.url = `http://127.0.0.1:${(m.server.address() as { port: number }).port}`;
  return m;
}

interface Run {
  code: number;
  out: string;
  calls: { args: string[]; input: string; cwd: string }[];
  work: string;
  tmp: string;
}

function rawGet(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface Opts {
  fail?: string;
  whoami?: string;
  list?: string;
  wrangler?: string;
  test?: boolean;
  /** PATH for the script's children; empty keeps a real wrangler from starting at all. */
  path?: string;
  /** Before the genuine redirect: a stray callback with a forged state, and a request under another Host. */
  stray?: boolean;
  hostProbe?: { status: number; body: string } | null;
}

async function runScript(mock: Mock, opts: Opts = {}): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "cla-work-"));
  const tmp = mkdtempSync(join(tmpdir(), "cla-tmp-"));
  const logDir = mkdtempSync(join(tmpdir(), "cla-log-"));
  const log = join(logDir, "wrangler.jsonl");
  // Run from an unrelated directory: the script must find worker/ by itself.
  const child = spawn(process.execPath, [SCRIPT, ...(opts.test === false ? [] : ["--test"])], {
    cwd: work,
    env: { PATH: opts.path ?? process.env.PATH, HOME: work, TMPDIR: tmp, CLA_TEST_GITHUB_WEB: mock.url, CLA_TEST_GITHUB_API: mock.url, CLA_TEST_WRANGLER: opts.wrangler ?? FAKE, FAKE_WRANGLER_LOG: log, FAKE_WRANGLER_FAIL: opts.fail ?? "", FAKE_WRANGLER_WHOAMI: opts.whoami ?? "", FAKE_WRANGLER_LIST: opts.list ?? "" },
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
    // The browser: load the page, post its form to "GitHub", follow the redirect back.
    const html = await (await fetch(local)).text();
    const action = /action="([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&");
    const manifest = /name="manifest" value="([^"]+)"/.exec(html)![1]!.replace(/&(quot|amp|lt|gt|#39);/g, (_, e: string) => ({ quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" })[e]!);
    if (opts.stray) {
      opts.hostProbe = await rawGet(local, "rebound.example:80");
      const forged = await fetch(`${local}callback?code=abc123def456&state=forged`);
      assert.equal(forged.status, 400);
    }
    const gh = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" });
    const back = gh.headers.get("location")!;
    await fetch(back).then((r) => r.text());
  }
  const code = await exited;
  let calls: Run["calls"] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run["calls"][number]);
  } catch {
    calls = [];
  }
  rmSync(logDir, { recursive: true, force: true });
  return { code, out, calls, work, tmp };
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

function b64url(s: Buffer): string {
  return s.toString("base64url");
}

describe("create-github-app.ts", () => {
  let mock: Mock;
  before(async () => {
    mock = await mockGitHub();
  });
  after(() => mock.server.close());

  it("posts the exact manifest, exchanges the code and pipes six secrets into wrangler without leaking one", async () => {
    const r = await runScript(mock);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(mock.manifestErrors, []);
    assert.equal(r.calls[0]!.args[0], "whoami");
    const puts = r.calls.filter((c) => c.args[0] === "secret" && c.args[1] === "put");
    assert.deepEqual(puts.map((c) => c.args), NAMES.map((n) => ["secret", "put", n, "--name", "kleidos-cla"]));
    const v = Object.fromEntries(puts.map((c) => [c.args[2]!, c.input]));
    assert.equal(v.APP_ID, "4242");
    assert.equal(v.CLIENT_ID, "Iv23liMOCK");
    assert.equal(v.CLIENT_SECRET, mock.secrets.client_secret);
    assert.equal(v.WEBHOOK_SECRET, mock.secrets.webhook_secret);
    assert.match(v.APP_PRIVATE_KEY!, /^-----BEGIN PRIVATE KEY-----\n/);
    assert.equal(Buffer.from(v.SESSION_KEY!, "base64url").length, 32);

    // The PKCS#8 key signs a JWT that the mock's public key verifies.
    const input = `${b64url(Buffer.from('{"alg":"RS256","typ":"JWT"}'))}.${b64url(Buffer.from('{"iss":"4242"}'))}`;
    const sig = createSign("RSA-SHA256").update(input).sign(v.APP_PRIVATE_KEY!);
    assert.ok(createVerify("RSA-SHA256").update(input).verify(createPublicKey(mock.publicPem), sig));

    const secrets = [mock.secrets.client_secret, mock.secrets.webhook_secret, v.SESSION_KEY!, ...v.APP_PRIVATE_KEY!.split("\n").filter((l) => l.length > 40), ...mock.secrets.pem.split("\n").filter((l) => l.length > 40)];
    for (const s of secrets) {
      assert.ok(!r.out.includes(s), "a secret reached the script's output");
      for (const c of r.calls) assert.ok(!c.args.join(" ").includes(s), "a secret reached an argument list");
      for (const f of [...filesUnder(r.work), ...filesUnder(r.tmp)]) assert.ok(!readFileSync(f, "latin1").includes(s), `a secret reached ${f}`);
    }
    assert.match(r.out, /app id 4242/);
    assert.match(r.out, /apps\/kleidos-cla\/installations\/new/);
  });

  it("runs the pinned wrangler inside worker/, whatever the caller's directory", async () => {
    const r = await runScript(mock);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.length > 0);
    for (const c of r.calls) assert.equal(c.cwd, WORKER_DIR);
    assert.deepEqual(r.calls.slice(0, 2).map((c) => c.args), [["whoami"], ["secret", "list", "--name", "kleidos-cla"]]);
  });

  it("refuses before showing anything when wrangler is missing or cannot reach the Worker", async () => {
    const missing = await runScript(mock, { wrangler: join(here, "no-such-wrangler") });
    assert.equal(missing.code, 2);
    assert.match(missing.out, /npm ci/);
    assert.doesNotMatch(missing.out, /Open http/);
    const unreachable = await runScript(mock, { list: "fail" });
    assert.equal(unreachable.code, 2);
    assert.match(unreachable.out, /cannot reach the Worker kleidos-cla/);
    assert.doesNotMatch(unreachable.out, /Open http/);
  });

  it("without --test the test endpoints are ignored", async () => {
    // It then looks for the real wrangler of worker/ (kept from starting by an empty PATH) and never for the fake.
    const before = mock.conversions;
    const r = await runScript(mock, { test: false, path: "" });
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.out, /Test mode/);
    assert.match(r.out, /npm ci|wrangler login/);
    assert.equal(mock.conversions, before);
    assert.equal(r.calls.length, 0);
  });

  it("a stray callback or another Host is refused and the genuine redirect still completes", async () => {
    const before = mock.conversions;
    const opts: Opts = { stray: true };
    const r = await runScript(mock, opts);
    assert.equal(r.code, 0, r.out);
    assert.equal(opts.hostProbe?.status, 421);
    assert.doesNotMatch(opts.hostProbe?.body ?? "", /state=/);
    assert.equal(mock.conversions, before + 1);
    assert.equal(r.calls.filter((c) => c.args[0] === "secret" && c.args[1] === "put").length, 6);
    assert.match(r.out, /Refused a redirect whose state does not match/);
  });

  it("an app that is not kleidos-cla of kleidos-dev stores nothing", async () => {
    mock.owner = { id: 1, login: "someone-else" };
    try {
      const r = await runScript(mock);
      assert.notEqual(r.code, 0);
      assert.equal(r.calls.filter((c) => c.args[0] === "secret" && c.args[1] === "put").length, 0);
      assert.doesNotMatch(r.out, /installations\/new/);
      assert.match(r.out, /Nothing was stored/);
    } finally {
      mock.owner = { id: 357318718, login: "kleidos-dev" };
    }
  });

  it("nothing of GitHub's answer makes a line of its own on the terminal", async () => {
    for (const answer of [{ slug: FORGED }, { owner: { id: FORGED } }, { id: FORGED }, { id: "4242" }, { id: -1 }, { client_secret: 7 }])
      await answering(mock, answer, async () => {
        const r = await runScript(mock);
        assert.equal(r.code, 4, r.out);
        assertPlain(r.out);
        assert.match(r.out, /Nothing was stored/);
        assert.equal(r.calls.filter((c) => c.args[1] === "put").length, 0);
      });
    await answering(mock, { html_url: FORGED }, async () => {
      const r = await runScript(mock);
      assert.equal(r.code, 0, r.out);
      assertPlain(r.out);
      assert.match(r.out, /app id 4242, http:\/\/127\.0\.0\.1:\d+\/apps\/kleidos-cla\)/);
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

  it("a failing wrangler exits non-zero and names what was not stored", async () => {
    const r = await runScript(mock, { fail: "CLIENT_SECRET" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /NOT stored: CLIENT_SECRET\./);
    assert.match(r.out, /Stored in the Worker kleidos-cla: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, WEBHOOK_SECRET, SESSION_KEY\./);
    // The fake wrangler echoed the value it refused: none of it reaches the output.
    assert.ok(!r.out.includes(mock.secrets.client_secret));
  });

  it("refuses to start when wrangler is not signed in", async () => {
    const r = await runScript(mock, { whoami: "fail" });
    assert.equal(r.code, 2);
    assert.match(r.out, /wrangler login/);
  });
});
