#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
//
// Creates the GitHub App kleidos-cla from its manifest and stores its six
// secrets straight into the Worker with `wrangler secret put`. The owner
// runs it once, on his own machine, after `npm ci` and `npx wrangler login`
// in worker/ and the first `npm run deploy`, from any directory:
//
//   node scripts/create-github-app.ts
//
// It runs the wrangler pinned in worker/package-lock.json
// (worker/node_modules/.bin/wrangler, never `npx`), inside worker/ so that
// wrangler.jsonc names the account and the Worker, and it refuses to start
// unless `wrangler secret list` already reaches that Worker: the one-time
// code GitHub returns cannot be spent on a target that is not there.
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
// Only with --test does it read CLA_TEST_GITHUB_WEB, CLA_TEST_GITHUB_API and
// CLA_TEST_WRANGLER, and it prints them when it does: that is how
// scripts/test/create-github-app.test.ts runs it against a mock.

import { spawn } from "node:child_process";
import { createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const TEST = process.argv.slice(2).includes("--test");
const override = (name: string): string | undefined => (TEST ? process.env[name] : undefined);
const WEB = (override("CLA_TEST_GITHUB_WEB") ?? "https://github.com").replace(/\/$/, "");
const API = (override("CLA_TEST_GITHUB_API") ?? "https://api.github.com").replace(/\/$/, "");
const WORKER_DIR = fileURLToPath(new URL("../worker/", import.meta.url));
const WRANGLER = override("CLA_TEST_WRANGLER") ?? fileURLToPath(new URL("../worker/node_modules/.bin/wrangler", import.meta.url));
const ORIGIN = "https://cla.kleidos.dev";
const ORG = "kleidos-dev";
/** The organization's numeric id: the app must belong to it before anything is stored. */
const ORG_ID = 357318718;
const SLUG = "kleidos-cla";
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
    default_permissions: { metadata: "read", contents: "read", pull_requests: "write", checks: "write", actions: "write" },
    default_events: ["pull_request", "check_run", "workflow_run"],
  };
}

/**
 * Runs the pinned wrangler inside worker/. Its output is discarded: a
 * failing `secret put` could echo what it was given, so only the exit code
 * is reported.
 */
function run(args: string[], input?: string): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(WRANGLER, args, { cwd: WORKER_DIR, stdio: ["pipe", "ignore", "ignore"], env: process.env });
    child.on("error", () => resolve({ code: 127 }));
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.stdin.on("error", () => undefined);
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
  owner?: { id?: number; login?: string } | null;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
}

/** Text of GitHub's answer as visible ASCII, cut short: it can neither end a line of the terminal nor forge, hide or recolor one. */
function printable(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

async function exchange(code: string): Promise<Conversion> {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "kleidos-cla-setup" },
  });
  if (res.status !== 201) throw new Error(`GitHub answered ${res.status} to the manifest conversion`);
  // The parser's own error quotes the text it could not read, which holds the secrets.
  const c = (await res.json().catch(() => {
    throw new Error("the conversion is not JSON");
  })) as Partial<Conversion>;
  if (typeof c.id !== "number" || !Number.isSafeInteger(c.id) || c.id <= 0) throw new Error("the conversion has no id");
  for (const k of ["slug", "client_id", "client_secret", "webhook_secret", "pem"] as const) {
    if (typeof c[k] !== "string" || !c[k]) throw new Error(`the conversion has no ${k}`);
  }
  return c as Conversion;
}

function page(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; form-action " + WEB, "referrer-policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>kleidos-cla setup</title><body>${body}</body></html>`);
}

async function main(): Promise<number> {
  if (TEST) console.log(`Test mode: GitHub web ${WEB}, API ${API}, wrangler ${WRANGLER}.`);
  if (!existsSync(WRANGLER)) {
    console.error(`No wrangler at ${WRANGLER}: run \`npm ci\` in worker/ first, then this script again.`);
    return 2;
  }
  const who = await run(["whoami"]);
  if (who.code !== 0) {
    console.error("wrangler is not signed in: run `npx wrangler login` in worker/ first, then this script again.");
    return 2;
  }
  // A harmless call that needs the very target the secrets go to: the account of wrangler.jsonc and the deployed Worker.
  const target = await run(["secret", "list", "--name", WORKER]);
  if (target.code !== 0) {
    console.error(`wrangler cannot reach the Worker ${WORKER} (exit ${target.code}): deploy it first with \`npm run deploy\` in worker/, then run this script again. Nothing was created.`);
    return 2;
  }

  const state = randomBytes(32).toString("base64url");
  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => (finish = r));
  let handled = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const port = (server.address() as { port: number }).port;
    // Only this address: a page that rebinds a name to 127.0.0.1 sends its own Host and gets nothing, not even the state.
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(421, { "content-type": "text/plain" }).end("wrong host\n");
      return;
    }
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
      const code = url.searchParams.get("code") ?? "";
      const got = url.searchParams.get("state") ?? "";
      if (!sameText(got, state)) {
        // A stray request is refused and the script keeps waiting for GitHub's genuine redirect.
        page(res, 400, "<p>Refused: this redirect did not start here. Nothing was exchanged.</p>");
        console.error("Refused a redirect whose state does not match; still waiting for GitHub's.");
        return;
      }
      handled = true;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
        page(res, 400, "<p>Refused: no valid code.</p>");
        console.error("Refused: GitHub's redirect carried no valid code.");
        finish(3);
        return;
      }
      void (async () => {
        try {
          const c = await exchange(code);
          if (c.owner?.id !== ORG_ID || c.slug !== SLUG) {
            console.error(`Refused: GitHub returned an app that is not ${SLUG} of ${ORG} (slug ${printable(c.slug)}, owner id ${printable(String(c.owner?.id ?? "none"))}). Nothing was stored; if you created an app by mistake, delete it on GitHub.`);
            page(res, 502, "<p>Refused: this is not the kleidos-cla app of kleidos-dev. Nothing was stored. See the terminal.</p>");
            finish(4);
            return;
          }
          const pkcs8 = createPrivateKey(c.pem).export({ type: "pkcs8", format: "pem" }).toString();
          const values: Record<(typeof SECRET_NAMES)[number], string> = {
            APP_ID: String(c.id),
            APP_PRIVATE_KEY: pkcs8,
            CLIENT_ID: c.client_id,
            CLIENT_SECRET: c.client_secret,
            WEBHOOK_SECRET: c.webhook_secret,
            SESSION_KEY: randomBytes(32).toString("base64url"),
          };
          const stored: string[] = [];
          const failed: string[] = [];
          for (const name of SECRET_NAMES) {
            const r = await run(["secret", "put", name, "--name", WORKER], values[name]);
            if (r.code === 0) stored.push(name);
            else {
              failed.push(name);
              console.error(`wrangler secret put ${name} failed (exit ${r.code}); its output is not shown, as it could echo the value.`);
            }
          }
          const id = printable(String(c.id));
          console.log(`\nGitHub App created: ${SLUG} (app id ${id}, ${WEB}/apps/${SLUG}).`);
          console.log(`Stored in the Worker ${WORKER}: ${stored.join(", ") || "nothing"}.`);
          if (failed.length) {
            console.error(`NOT stored: ${failed.join(", ")}. The values are gone: on the app's settings page generate a new private key, reset the client secret or change the webhook secret as needed, and put them with \`npx wrangler secret put <NAME>\` in worker/.`);
          }
          console.log(`\nNext:\n  1. Install it on ${ORG}, only on kleidos-dev/cla: ${WEB}/apps/${SLUG}/installations/new`);
          console.log(`  2. On the app's page, check: "Expire user authorization tokens" on, "Enable Device Flow" off.`);
          console.log(`  3. The app id for the rulesets' required check (integration_id) is ${id}.`);
          console.log(`  4. In registry/config.json set "app_id": ${id}, and add the bot account to "exempt": gh api users/${SLUG}%5Bbot%5D --jq .id`);
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
