#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 José M. Requena Plens <jmrplens@kleidos.dev>
// SPDX-License-Identifier: MIT
//
// Creates the identity-only sign-in app of the Kleidos CLA from its
// manifest, and stores its client id and secret where they are used,
// without anybody copying a secret: the owner runs it once, on his own
// machine, after `npm ci` and `npx wrangler login` in worker/ and with the
// gh CLI signed in as an owner of kleidos-dev, from any directory:
//
//   node scripts/create-signin-app.ts
//
// The app is a GitHub App with no permission at all (no repository,
// organization or account permission, no event, no webhook): signing in
// with it only tells the Worker which account the signer is, and its
// token reaches nothing but what is public anyway. The Worker never posts
// anything with it; record.yml checks the token with GitHub ("Check a
// token", POST /applications/{client_id}/token) and then deletes the grant.
//
// Like scripts/create-github-app.ts it runs the wrangler pinned in worker/
// (never `npx`) inside worker/, and refuses to start unless `wrangler
// secret list` reaches the Worker and gh can administer kleidos-dev/cla:
// the one-time code GitHub returns cannot be spent on a target that is
// not there. Before it shows anything it makes sure the Actions
// environment `signin` of kleidos-dev/cla exists with a deployment branch
// policy of main only (the secret is readable by record.yml on main and
// nothing else).
//
// It listens on 127.0.0.1 on a random port and prints a local address.
// Opening it shows one button that posts the manifest to GitHub; GitHub
// asks to confirm, creates the app and redirects back here with a one-hour
// code. The code is exchanged for the app's client id and secret, which go
// to the standard input of `wrangler secret put SIGNIN_CLIENT_ID` and
// `SIGNIN_CLIENT_SECRET`, and the secret to the standard input of `gh secret
// set SIGNIN_CLIENT_SECRET --env signin`. The private key and the webhook
// secret the conversion also returns are dropped unread. Nothing secret is
// printed, logged, passed as an argument or written to disk.
//
// The Worker does not use the app until registry/config.json names its
// client id (`signin_client_id`, printed at the end: it is public) and
// makes a version whose flow is "signin" current: the live flow stays the
// version 1 one until then.
//
// Standard library only (Node 24 or later runs this TypeScript directly).
// Only with --test does it read CLA_TEST_GITHUB_WEB, CLA_TEST_GITHUB_API,
// CLA_TEST_WRANGLER and CLA_TEST_GH, and it prints them when it does: that
// is how scripts/test/create-signin-app.test.ts runs it against a mock.

import { spawn } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
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
const GH = override("CLA_TEST_GH") ?? "gh";
const ORIGIN = "https://cla.kleidos.dev";
const ORG = "kleidos-dev";
/** The organization's numeric id: the app must belong to it before anything is stored. */
const ORG_ID = 357318718;
const NAME = "Kleidos CLA sign-in";
const SLUG = "kleidos-cla-sign-in";
const WORKER = "kleidos-cla";
const REGISTRY = "kleidos-dev/cla";
const ENVIRONMENT = "signin";
const WAIT_MS = 15 * 60 * 1000;

export const WORKER_SECRETS = ["SIGNIN_CLIENT_ID", "SIGNIN_CLIENT_SECRET"] as const;

/** The manifest: no permission, no event, no webhook; only redirect_url depends on the local port. */
export function manifest(port: number) {
  return {
    name: NAME,
    url: ORIGIN,
    description: "Signs you in to cla.kleidos.dev to accept the Kleidos Contributor Agreement. It has no permission at all: it only tells the site which GitHub account you are, and posts nothing.",
    public: true,
    redirect_url: `http://127.0.0.1:${port}/callback`,
    callback_urls: [`${ORIGIN}/auth/callback`],
    request_oauth_on_install: false,
    default_permissions: {},
    default_events: [],
  };
}

/**
 * Runs a command with the given standard input. Its output is discarded
 * unless `keep`: a failing `secret put` or `secret set` could echo what it
 * was given, so only the exit code is reported.
 */
function run(cmd: string, args: string[], input?: string, opts: { cwd?: string; keep?: boolean } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? WORKER_DIR, stdio: ["pipe", opts.keep ? "pipe" : "ignore", "ignore"], env: process.env });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve({ code: 127, out: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

const wrangler = (args: string[], input?: string) => run(WRANGLER, args, input);
const gh = (args: string[], input?: string, keep = false) => run(GH, args, input, { keep });

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
  html_url?: string;
  permissions?: Record<string, string>;
  events?: string[];
}

async function exchange(code: string): Promise<Conversion> {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "kleidos-cla-setup" },
  });
  if (res.status !== 201) throw new Error(`GitHub answered ${res.status} to the manifest conversion`);
  // The private key and the webhook secret in the answer are never read: only these fields are kept.
  const all = (await res.json()) as Record<string, unknown>;
  const c: Partial<Conversion> = { id: all.id as number, slug: all.slug as string, owner: all.owner as Conversion["owner"], client_id: all.client_id as string, client_secret: all.client_secret as string, html_url: all.html_url as string, permissions: all.permissions as Record<string, string>, events: all.events as string[] };
  for (const k of ["id", "slug", "client_id", "client_secret"] as const) {
    if (!c[k]) throw new Error(`the conversion has no ${k}`);
  }
  return c as Conversion;
}

function page(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; form-action " + WEB, "referrer-policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Kleidos CLA sign-in setup</title><body>${body}</body></html>`);
}

/** The environment `signin` of the register, with main as its only deployment branch; true when it is so. */
async function ensureEnvironment(): Promise<boolean> {
  const put = await gh(["api", "-X", "PUT", `repos/${REGISTRY}/environments/${ENVIRONMENT}`, "--input", "-"], JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
  if (put.code !== 0) return false;
  const list = await gh(["api", `repos/${REGISTRY}/environments/${ENVIRONMENT}/deployment-branch-policies`, "--jq", "[.branch_policies[] | .name + \":\" + (.type // \"branch\")] | join(\",\")"], undefined, true);
  if (list.code !== 0) return false;
  const names = list.out.trim().split(",").filter(Boolean);
  if (names.some((n) => n !== "main:branch")) {
    console.error(`The environment ${ENVIRONMENT} of ${REGISTRY} allows other branches than main (${names.join(", ")}): remove them in its settings, then run this script again.`);
    return false;
  }
  if (names.length === 0) {
    const add = await gh(["api", "-X", "POST", `repos/${REGISTRY}/environments/${ENVIRONMENT}/deployment-branch-policies`, "--input", "-"], JSON.stringify({ name: "main", type: "branch" }));
    if (add.code !== 0) return false;
  }
  return true;
}

async function main(): Promise<number> {
  if (TEST) console.log(`Test mode: GitHub web ${WEB}, API ${API}, wrangler ${WRANGLER}, gh ${GH}.`);
  if (!existsSync(WRANGLER)) {
    console.error(`No wrangler at ${WRANGLER}: run \`npm ci\` in worker/ first, then this script again.`);
    return 2;
  }
  if ((await wrangler(["whoami"])).code !== 0) {
    console.error("wrangler is not signed in: run `npx wrangler login` in worker/ first, then this script again.");
    return 2;
  }
  const target = await wrangler(["secret", "list", "--name", WORKER]);
  if (target.code !== 0) {
    console.error(`wrangler cannot reach the Worker ${WORKER} (exit ${target.code}): deploy it first with \`npm run deploy\` in worker/, then run this script again. Nothing was created.`);
    return 2;
  }
  const admin = await gh(["api", `repos/${REGISTRY}`, "--jq", ".permissions.admin"], undefined, true);
  if (admin.code !== 0 || admin.out.trim() !== "true") {
    console.error(`gh cannot administer ${REGISTRY}: sign in with \`gh auth login\` as an owner of ${ORG}, then run this script again. Nothing was created.`);
    return 2;
  }
  if (!(await ensureEnvironment())) {
    console.error(`The Actions environment ${ENVIRONMENT} of ${REGISTRY} could not be set to main only. Nothing was created.`);
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
        `<h1>Create the GitHub App ${escapeHtml(NAME)}</h1><p>An app with no permission at all, only to sign in. The button posts its manifest to GitHub, which shows it and asks you to confirm.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest(port)))}"><button type="submit">Create the GitHub App on ${escapeHtml(ORG)}</button></form>`,
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/callback") {
      if (handled) return page(res, 409, "<p>Already handled.</p>");
      const code = url.searchParams.get("code") ?? "";
      const got = url.searchParams.get("state") ?? "";
      if (!sameText(got, state)) {
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
            console.error(`Refused: GitHub returned an app that is not ${SLUG} of ${ORG} (slug ${JSON.stringify(c.slug)}, owner id ${c.owner?.id ?? "none"}). Nothing was stored; if you created an app by mistake, delete it on GitHub.`);
            page(res, 502, "<p>Refused: this is not the sign-in app of kleidos-dev. Nothing was stored. See the terminal.</p>");
            finish(4);
            return;
          }
          const granted = Object.keys(c.permissions ?? {}).length + (c.events ?? []).length;
          if (granted > 0) console.error(`Warning: GitHub gave the app permissions or events (${JSON.stringify(c.permissions ?? {})}, ${JSON.stringify(c.events ?? [])}): remove them on its settings page.`);
          const stored: string[] = [];
          const failed: string[] = [];
          const values: Record<(typeof WORKER_SECRETS)[number], string> = { SIGNIN_CLIENT_ID: c.client_id, SIGNIN_CLIENT_SECRET: c.client_secret };
          for (const name of WORKER_SECRETS) {
            const r = await wrangler(["secret", "put", name, "--name", WORKER], values[name]);
            if (r.code === 0) stored.push(`${name} (Worker)`);
            else {
              failed.push(`${name} (Worker)`);
              console.error(`wrangler secret put ${name} failed (exit ${r.code}); its output is not shown, as it could echo the value.`);
            }
          }
          const set = await gh(["secret", "set", "SIGNIN_CLIENT_SECRET", "--env", ENVIRONMENT, "--repo", REGISTRY], c.client_secret);
          if (set.code === 0) stored.push(`SIGNIN_CLIENT_SECRET (environment ${ENVIRONMENT} of ${REGISTRY})`);
          else {
            failed.push(`SIGNIN_CLIENT_SECRET (environment ${ENVIRONMENT} of ${REGISTRY})`);
            console.error(`gh secret set failed (exit ${set.code}); its output is not shown, as it could echo the value.`);
          }
          console.log(`\nGitHub App created: ${c.slug} (app id ${c.id}${c.html_url ? `, ${c.html_url}` : ""}).`);
          console.log(`Stored: ${stored.join(", ") || "nothing"}.`);
          if (failed.length) {
            console.error(`NOT stored: ${failed.join(", ")}. The secret is gone: on the app's settings page generate a new client secret and put it with \`npx wrangler secret put SIGNIN_CLIENT_SECRET\` in worker/ and \`gh secret set SIGNIN_CLIENT_SECRET --env ${ENVIRONMENT} --repo ${REGISTRY}\`, both reading it from standard input.`);
          }
          console.log(`\nThe client id (public): ${c.client_id}`);
          console.log(`\nNext:\n  1. On ${WEB}/organizations/${ORG}/settings/apps/${c.slug}: "Expire user authorization tokens" on, "Enable Device Flow" off, webhook inactive, no permission and no event; under "Private keys" delete the key GitHub generated (nothing uses it).`);
          console.log(`  2. Do not install it anywhere: signing in needs no installation.`);
          console.log(`  3. In registry/config.json set "signin_client_id": "${c.client_id}" (a signed commit on main). The site signs in with this app only once a version whose flow is "signin" is current.`);
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
