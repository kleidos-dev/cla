// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The deployed Worker, as wrangler builds it from worker/wrangler.jsonc
 * (its flags, no nodejs_compat added), in workerd, with made-up secrets.
 * Every request the Worker makes leaves through Node's fetch, which this
 * module replaces: a request to GitHub goes to worker/test/fakegh.ts (the
 * Worker tests' strict fake, bundled by esbuild), any other is refused and
 * kept in `outside`, and only the harness's own loopback requests pass.
 */
import { createPrivateKey, webcrypto as crypto } from "node:crypto";
import type { webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../workflows/support.mts";

const WORKER = join(ROOT, "worker");
const fromWorker = createRequire(join(WORKER, "package.json"));

// No telemetry from wrangler while a test runs it.
process.env.WRANGLER_SEND_METRICS = "false";

interface Harness {
  listen(): Promise<{ url: URL }>;
  close(): Promise<void>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
const wrangler = fromWorker("wrangler") as { createTestHarness: (o: unknown) => Harness; experimental_readRawConfig: (o: { config: string }) => { rawConfig: Record<string, unknown> } };
const { build } = fromWorker("esbuild") as { build: (o: unknown) => Promise<unknown> };

/** What this suite uses of worker/test/fakegh.ts (its own types would pull the Worker's sources into this project). */
interface FakeUser {
  id: number;
  login: string;
  type: "User" | "Bot" | "Organization";
}
interface FakePr {
  repo: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  locked: boolean;
  user: FakeUser;
  head: { sha: string; repo: string };
  files: { filename: string }[];
  commits: unknown[];
}
interface FakeGitHub {
  init(publicKey: webcrypto.CryptoKey): Promise<void>;
  setFile(ref: string, path: string, content: string): void;
  issueCode(user: FakeUser, challenge: string, clientId: string): string;
  seen(match: RegExp): { method: string; url: string; body?: unknown }[];
  fetch(req: Request): Promise<Response>;
  pulls: Map<string, FakePr>;
  strays: string[];
}
interface FakeModule {
  FakeGitHub: new () => FakeGitHub;
  APP_ID: number;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  SIGNIN_CLIENT_ID: string;
  SIGNIN_CLIENT_SECRET: string;
  sha(): string;
  commit(author: FakeUser): unknown;
}

const scratch = mkdtempSync(join(tmpdir(), "cla-pages-"));
await build({ entryPoints: [join(WORKER, "test", "fakegh.ts")], bundle: true, format: "esm", platform: "node", outfile: join(scratch, "fakegh.mjs"), logLevel: "error" });
export const fake = (await import(pathToFileURL(join(scratch, "fakegh.mjs")).href)) as FakeModule;

const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
// The app's key as the Worker's secret holds it, PKCS#8 PEM, made for this run.
const pem = createPrivateKey({ key: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), format: "der", type: "pkcs8" }).export({ type: "pkcs8", format: "pem" }).toString();

export const SANDBOX = "kleidos-dev/cla-sandbox";
export const ORIGIN = "https://cla.kleidos.dev";
export const gh = new fake.FakeGitHub();
await gh.init(pair.publicKey);
const live = JSON.parse(readFileSync(join(ROOT, "registry", "config.json"), "utf8")) as { served_repositories: Record<string, unknown>; versions: Record<string, { sentence: string }> };
/** The register's configuration with version 2 (sign in) current and a made-up served repository. */
export const config = { ...live, served_repositories: { ...live.served_repositories, [SANDBOX]: { auto_approve: true } }, current_version: 2, accepted_versions: [1, 2], signin_client_id: fake.SIGNIN_CLIENT_ID };
gh.setFile("main", "registry/config.json", JSON.stringify(config));
gh.setFile("main", "registry/entities.json", JSON.stringify({ schema: 1, entities: [] }));

/** Every request the Worker tried to make to a host that is not GitHub's. */
export const outside: string[] = [];
const loopback = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return loopback(input, init);
  // workerd follows a redirect itself when the Worker asks it to: the outbound hop answers raw, as a server does.
  if (url.hostname === "api.github.com" || url.hostname === "github.com") return gh.fetch(new Request(req, { redirect: "manual" }));
  outside.push(`${req.method} ${url.host}${url.pathname}`);
  return new Response("refused by the test", { status: 599 });
};

export const SESSION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
/**
 * worker/wrangler.jsonc as it is, but for its dev section: served as https, as in production. Over http the
 * harness rewrites the request to http and its Origin with it (the Worker then refuses every form, rightly)
 * and replaces CF-Connecting-IP with 127.0.0.1.
 */
const { rawConfig } = wrangler.experimental_readRawConfig({ config: join(WORKER, "wrangler.jsonc") });
export const server = wrangler.createTestHarness({
  root: WORKER,
  workers: [
    {
      config: { ...rawConfig, dev: { ...(rawConfig.dev as object | undefined), upstream_protocol: "https" } },
      secrets: { APP_ID: String(fake.APP_ID), APP_PRIVATE_KEY: pem, CLIENT_ID: fake.CLIENT_ID, CLIENT_SECRET: fake.CLIENT_SECRET, WEBHOOK_SECRET: "made-up-webhook-secret", SESSION_KEY, SIGNIN_CLIENT_ID: fake.SIGNIN_CLIENT_ID, SIGNIN_CLIENT_SECRET: fake.SIGNIN_CLIENT_SECRET },
      vars: { BUILD_COMMIT },
    },
  ],
});

export function cleanup(): void {
  rmSync(scratch, { recursive: true, force: true });
  globalThis.fetch = loopback;
}
