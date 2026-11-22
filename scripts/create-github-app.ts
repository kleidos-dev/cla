#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Creates the GitHub App kleidos-cla from its manifest and stores its six
// secrets straight into the Worker with `wrangler secret put`. The owner
// runs it once, on his own machine, after `npx wrangler login`:
//
//   node scripts/create-github-app.ts
//
// It listens on 127.0.0.1 on a random port and prints a local address.
// Opening it shows one button that posts the manifest to GitHub; GitHub
// asks to confirm, creates the app and redirects back here with a one-hour
// code. The code is exchanged for the app id, the private key, the client
// id and secret and the webhook secret; the key is converted to PKCS#8 in
// memory and a fresh 32-byte SESSION_KEY is generated. Each value goes to
// the standard input of `wrangler secret put <NAME> --name kleidos-cla`:
// none is printed, logged, passed as an argument or written to disk.
//
// Standard library only (Node 24 or later runs this TypeScript directly).
// GITHUB_WEB_URL, GITHUB_API_URL and WRANGLER_BIN can be overridden, which
// is how scripts/test/create-github-app.test.ts runs it against a mock.

import { spawn } from "node:child_process";
import { createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const WEB = (process.env.GITHUB_WEB_URL ?? "https://github.com").replace(/\/$/, "");
const API = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const ORIGIN = "https://cla.kleidos.dev";
const ORG = "kleidos-dev";
const WORKER = "kleidos-cla";
const WAIT_MS = 15 * 60 * 1000;

export const SECRET_NAMES = ["APP_ID", "APP_PRIVATE_KEY", "CLIENT_ID", "CLIENT_SECRET", "WEBHOOK_SECRET", "SESSION_KEY"] as const;

/** The manifest of design section 4.1; only redirect_url depends on the local port. */
export function manifest(port: number) {
  return {
    name: "kleidos-cla",
    url: ORIGIN,
    description: "Checks that the authors of a pull request have accepted the Kleidos Contributor Agreement and lets them sign it at cla.kleidos.dev.",
    public: true,
    hook_attributes: { url: `${ORIGIN}/webhook`, active: true },
    redirect_url: `http://127.0.0.1:${port}/callback`,
    callback_urls: [`${ORIGIN}/auth/callback`],
    setup_url: `${ORIGIN}/setup`,
    setup_on_update: false,
    request_oauth_on_install: false,
    default_permissions: { metadata: "read", contents: "read", pull_requests: "write", checks: "write", statuses: "write", actions: "write" },
    default_events: ["pull_request", "check_run", "workflow_run"],
  };
}

function wrangler(args: string[]): { cmd: string; args: string[] } {
  const bin = process.env.WRANGLER_BIN;
  return bin ? { cmd: bin, args } : { cmd: "npx", args: ["wrangler", ...args] };
}

function run(args: string[], input?: string, redact: string[] = []): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const w = wrangler(args);
    const child = spawn(w.cmd, w.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let err = "";
    const keep = (b: Buffer) => {
      let s = b.toString("utf8");
      for (const r of redact) if (r) s = s.split(r).join("[redacted]");
      err += s;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", () => resolve({ code: 127, err: `could not start ${w.cmd}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, err: err.slice(-2000) }));
    child.stdin.end(input ?? "");
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Conversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url?: string;
}

async function exchange(code: string): Promise<Conversion> {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "kleidos-cla-setup" },
  });
  if (res.status !== 201) throw new Error(`GitHub answered ${res.status} to the manifest conversion`);
  const c = (await res.json()) as Partial<Conversion>;
  for (const k of ["id", "slug", "client_id", "client_secret", "webhook_secret", "pem"] as const) {
    if (!c[k]) throw new Error(`the conversion has no ${k}`);
  }
  return c as Conversion;
}

function page(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; form-action " + WEB, "referrer-policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>kleidos-cla setup</title><body>${body}</body></html>`);
}

async function main(): Promise<number> {
  const who = await run(["whoami"]);
  if (who.code !== 0) {
    console.error("wrangler is not signed in: run `npx wrangler login` first, then this script again.");
    return 2;
  }

  const state = randomBytes(32).toString("base64url");
  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => (finish = r));
  let handled = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const port = (server.address() as { port: number }).port;
    if (req.method === "GET" && url.pathname === "/") {
      const action = `${WEB}/organizations/${ORG}/settings/apps/new?state=${encodeURIComponent(state)}`;
      page(
        res,
        200,
        `<h1>Create the GitHub App kleidos-cla</h1><p>The button posts the app's manifest to GitHub, which shows it and asks you to confirm.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest(port)))}"><button type="submit">Create the GitHub App on ${escapeHtml(ORG)}</button></form>`,
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/callback") {
      if (handled) return page(res, 409, "<p>Already handled.</p>");
      handled = true;
      const code = url.searchParams.get("code") ?? "";
      const got = url.searchParams.get("state") ?? "";
      if (!sameText(got, state)) {
        page(res, 400, "<p>Refused: this redirect did not start here. Nothing was exchanged.</p>");
        console.error("Refused: the state of the redirect does not match. Nothing was exchanged; run the script again.");
        finish(3);
        return;
      }
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
        page(res, 400, "<p>Refused: no valid code.</p>");
        console.error("Refused: GitHub's redirect carried no valid code.");
        finish(3);
        return;
      }
      void (async () => {
        try {
          const c = await exchange(code);
          const pkcs8 = createPrivateKey(c.pem).export({ type: "pkcs8", format: "pem" }).toString();
          const values: Record<(typeof SECRET_NAMES)[number], string> = {
            APP_ID: String(c.id),
            APP_PRIVATE_KEY: pkcs8,
            CLIENT_ID: c.client_id,
            CLIENT_SECRET: c.client_secret,
            WEBHOOK_SECRET: c.webhook_secret,
            SESSION_KEY: randomBytes(32).toString("base64url"),
          };
          const redact = [c.pem, pkcs8, c.client_secret, c.webhook_secret, values.SESSION_KEY];
          const stored: string[] = [];
          const failed: string[] = [];
          for (const name of SECRET_NAMES) {
            const r = await run(["secret", "put", name, "--name", WORKER], values[name], redact);
            if (r.code === 0) stored.push(name);
            else {
              failed.push(name);
              console.error(`wrangler secret put ${name} failed (exit ${r.code}):\n${r.err}`);
            }
          }
          console.log(`\nGitHub App created: ${c.slug} (app id ${c.id}${c.html_url ? `, ${c.html_url}` : ""}).`);
          console.log(`Stored in the Worker ${WORKER}: ${stored.join(", ") || "nothing"}.`);
          if (failed.length) {
            console.error(`NOT stored: ${failed.join(", ")}. The values are gone: on the app's settings page generate a new private key, reset the client secret or change the webhook secret as needed, and put them with \`npx wrangler secret put <NAME> --name ${WORKER}\`.`);
          }
          console.log(`\nNext:\n  1. Install it on ${ORG}, only on kleidos-dev/cla and kleidos-dev/cla-sandbox: ${WEB}/apps/${c.slug}/installations/new`);
          console.log(`  2. On the app's page, check: "Expire user authorization tokens" on, "Enable Device Flow" off.`);
          console.log(`  3. The app id for the rulesets' required check (integration_id) is ${c.id}.`);
          console.log(`  4. Add the bot account to registry/config.json "exempt": gh api users/${c.slug}%5Bbot%5D --jq .id`);
          page(res, failed.length ? 500 : 200, `<h1>${failed.length ? "Created, but not every secret was stored" : "Done"}</h1><p>Stored: ${escapeHtml(stored.join(", ") || "nothing")}.</p>${failed.length ? `<p>Not stored: ${escapeHtml(failed.join(", "))}. See the terminal.</p>` : "<p>You can close this tab and go back to the terminal.</p>"}`);
          finish(failed.length ? 1 : 0);
        } catch (e) {
          console.error(`The exchange failed: ${e instanceof Error ? e.message : "unknown error"}. Nothing was stored.`);
          page(res, 502, "<p>The exchange with GitHub failed. See the terminal.</p>");
          finish(4);
        }
      })();
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  console.log(`Open http://127.0.0.1:${port}/ in your browser, signed in to GitHub as an owner of ${ORG}.`);
  const timer = setTimeout(() => {
    console.error("Timed out waiting for GitHub's redirect.");
    finish(5);
  }, WAIT_MS);
  const code = await done;
  clearTimeout(timer);
  server.close();
  return code;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : "unknown error");
      process.exit(1);
    },
  );
}
