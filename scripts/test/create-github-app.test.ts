// SPDX-License-Identifier: MIT
// End-to-end test of scripts/create-github-app.ts against a mocked GitHub
// (both github.com and api.github.com) and a fake wrangler. Run with
// `node --test scripts/test/`.
import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, createSign, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "create-github-app.ts");
const FAKE = join(here, "fake-wrangler.mjs");
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
  default_permissions: { metadata: "read", contents: "read", pull_requests: "write", checks: "write", statuses: "write", actions: "write" },
  default_events: ["pull_request", "check_run", "workflow_run"],
};

interface Mock {
  server: Server;
  url: string;
  conversions: number;
  manifestErrors: string[];
  publicPem: string;
  secrets: { client_secret: string; webhook_secret: string; pem: string };
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
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    secrets: { client_secret: `cs_${randomBytes(20).toString("hex")}`, webhook_secret: `wh_${randomBytes(20).toString("hex")}`, pem },
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
        res.end(JSON.stringify({ id: 4242, slug: "kleidos-cla", client_id: "Iv23liMOCK", html_url: "https://github.com/apps/kleidos-cla", ...m.secrets }));
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
  calls: { args: string[]; input: string }[];
  work: string;
  tmp: string;
}

async function runScript(mock: Mock, opts: { fail?: string; whoami?: string; tamperState?: boolean } = {}): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "cla-work-"));
  const tmp = mkdtempSync(join(tmpdir(), "cla-tmp-"));
  const logDir = mkdtempSync(join(tmpdir(), "cla-log-"));
  const log = join(logDir, "wrangler.jsonl");
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: work,
    env: { PATH: process.env.PATH, HOME: work, TMPDIR: tmp, GITHUB_WEB_URL: mock.url, GITHUB_API_URL: mock.url, WRANGLER_BIN: FAKE, FAKE_WRANGLER_LOG: log, FAKE_WRANGLER_FAIL: opts.fail ?? "", FAKE_WRANGLER_WHOAMI: opts.whoami ?? "" },
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
    const gh = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" });
    let back = gh.headers.get("location")!;
    if (opts.tamperState) back = back.replace(/state=[^&]+/, "state=forged");
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
    const puts = r.calls.filter((c) => c.args[0] === "secret");
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

  it("a wrong state aborts before the exchange", async () => {
    const before = mock.conversions;
    const r = await runScript(mock, { tamperState: true });
    assert.notEqual(r.code, 0);
    assert.equal(mock.conversions, before);
    assert.equal(r.calls.filter((c) => c.args[0] === "secret").length, 0);
    assert.match(r.out, /state of the redirect does not match/);
  });

  it("a failing wrangler exits non-zero and names what was not stored", async () => {
    const r = await runScript(mock, { fail: "CLIENT_SECRET" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /NOT stored: CLIENT_SECRET\./);
    assert.match(r.out, /Stored in the Worker kleidos-cla: APP_ID, APP_PRIVATE_KEY, CLIENT_ID, WEBHOOK_SECRET, SESSION_KEY\./);
    assert.ok(!r.out.includes(mock.secrets.client_secret));
  });

  it("refuses to start when wrangler is not signed in", async () => {
    const r = await runScript(mock, { whoami: "fail" });
    assert.equal(r.code, 2);
    assert.match(r.out, /wrangler login/);
  });
});
