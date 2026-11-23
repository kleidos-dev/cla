// SPDX-License-Identifier: MIT
import { vi } from "vitest";
import type { Env } from "../src/env";
import { resetGitHubCaches } from "../src/github";
import { handleFetch, handleQueue } from "../src/index";
import type { QueueMessage } from "../src/messages";
import { resetRegistryCache } from "../src/registry";
import { b64urlEncode, hex, utf8 } from "../src/util";
import type { FakePr, User } from "./fakegh";
import { APP_ID, CLIENT_ID, CLIENT_SECRET, FakeGitHub, ORG_ID, REGISTRY, commit, sha } from "./fakegh";
import configJson from "../../registry/config.json";

export const ORIGIN = "https://cla.kleidos.dev";
export const WEBHOOK_SECRET = "test-webhook-secret";
export const SANDBOX = "kleidos-dev/cla-sandbox";
export const CONFIG = configJson;

export interface Sent {
  body: QueueMessage;
  delaySeconds?: number;
}

export class FakeQueue {
  sent: Sent[] = [];
  async send(body: QueueMessage, opts?: { delaySeconds?: number }): Promise<void> {
    this.sent.push({ body: structuredClone(body), ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}) });
  }
  async sendBatch(msgs: { body: QueueMessage }[]): Promise<void> {
    for (const m of msgs) this.sent.push({ body: structuredClone(m.body) });
  }
}

export class FakeLimiter {
  allow = true;
  keys: string[] = [];
  async limit(o: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(o.key);
    return { success: this.allow };
  }
}

let keyPair: Promise<{ pem: string; publicKey: CryptoKey }> | null = null;
function appKey() {
  keyPair ??= (async () => {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
    const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
    return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: kp.publicKey };
  })();
  return keyPair;
}

export interface World {
  gh: FakeGitHub;
  env: Env;
  queue: FakeQueue;
  limiters: Record<string, FakeLimiter>;
  logs: string[];
}

export async function world(opts: { configure?: boolean } = {}): Promise<World> {
  resetGitHubCaches();
  resetRegistryCache();
  const { pem, publicKey } = await appKey();
  const gh = new FakeGitHub();
  await gh.init(publicKey);
  gh.setFile("main", "registry/config.json", JSON.stringify(configJson));
  gh.setFile("main", "registry/entities.json", JSON.stringify({ schema: 1, entities: [] }));
  const queue = new FakeQueue();
  const limiters = { RL_WEBHOOK: new FakeLimiter(), RL_AUTH: new FakeLimiter(), RL_SIGN: new FakeLimiter(), RL_AGREE_IP: new FakeLimiter(), RL_AGREE_ACCOUNT: new FakeLimiter() };
  const env: Env = {
    CLA_QUEUE: queue as unknown as Queue<QueueMessage>,
    ...(limiters as unknown as Pick<Env, "RL_WEBHOOK" | "RL_AUTH" | "RL_SIGN" | "RL_AGREE_IP" | "RL_AGREE_ACCOUNT">),
    ALLOWED_ACCOUNT_IDS: "357318718",
    REGISTRY_REPO: REGISTRY,
    PUBLIC_ORIGIN: ORIGIN,
    BUILD_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    ...(opts.configure === false
      ? {}
      : { APP_ID: String(APP_ID), APP_PRIVATE_KEY: pem, CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, SESSION_KEY: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))) }),
  };
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => gh.handle(new Request(input, init)));
  return { gh, env, queue, limiters, logs };
}

/** Runs queued messages until none is left (delays are not waited for), returning what ran. */
export async function drain(w: World, max = 50): Promise<QueueMessage[]> {
  const ran: QueueMessage[] = [];
  for (let i = 0; i < max && w.queue.sent.length; i++) {
    const { body } = w.queue.sent.shift()!;
    ran.push(body);
    let acked = false;
    let retried: number | undefined;
    const msg = { id: String(i), timestamp: new Date(), body, attempts: 1, ack: () => (acked = true), retry: (o?: { delaySeconds?: number }) => (retried = o?.delaySeconds ?? 0) };
    await handleQueue({ queue: "kleidos-cla", messages: [msg], ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<QueueMessage>, w.env);
    if (!acked && retried === undefined) throw new Error("message neither acked nor retried");
  }
  return ran;
}

export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, utf8(body)))}`;
}

export async function webhook(w: World, event: string, payload: unknown, opts: { secret?: string; signature?: string; delivery?: string; target?: string } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
    "x-github-hook-installation-target-id": opts.target ?? String(APP_ID),
    "x-hub-signature-256": opts.signature ?? (await sign(opts.secret ?? WEBHOOK_SECRET, body)),
  };
  return handleFetch(new Request(`${ORIGIN}/webhook`, { method: "POST", headers, body }), w.env);
}

export function prEvent(pr: FakePr, action: string, extra: Record<string, unknown> = {}) {
  return { action, number: pr.number, pull_request: { number: pr.number }, repository: { full_name: pr.repo, id: 1, owner: { id: ORG_ID } }, installation: { id: 1 }, ...extra };
}

export function openPr(w: World, opener: User, opts: { repo?: string; number?: number; commits?: FakePr["commits"]; files?: FakePr["files"]; fork?: string } = {}): FakePr {
  const repo = opts.repo ?? SANDBOX;
  const number = opts.number ?? w.gh.next();
  const pr: FakePr = {
    repo,
    number,
    state: "open",
    merged: false,
    locked: false,
    user: opener,
    head: { sha: sha(), repo: opts.fork ?? `${opener.login}/cla-sandbox` },
    files: opts.files ?? [{ filename: "README.md" }],
    commits: opts.commits ?? [commit(opener)],
  };
  w.gh.pulls.set(`${repo}#${number}`, pr);
  return pr;
}

/** A browser: a cookie jar over handleFetch, with GitHub's authorization page played by the fake. */
export class Browser {
  jar = new Map<string, string>();
  constructor(
    readonly w: World,
    readonly user: User,
  ) {}

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  keep(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/.test(c) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await handleFetch(new Request(`${ORIGIN}${path}`, { headers: { cookie: this.cookieHeader(), "cf-connecting-ip": "203.0.113.7", ...headers } }), this.w.env);
    this.keep(res);
    return res;
  }

  async post(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    const res = await handleFetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { cookie: this.cookieHeader(), origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: new URLSearchParams(form).toString(),
      }),
      this.w.env,
    );
    this.keep(res);
    return res;
  }

  /** Follows /auth/login to GitHub (the fake approves as this.user) and back through /auth/callback. */
  async signIn(signPath: string): Promise<{ authorize: URL; callback: Response; callbackUrl: string }> {
    const login = await this.get(`/auth/login?return=${encodeURIComponent(signPath)}`);
    if (login.status !== 302) throw new Error(`login answered ${login.status}`);
    const authorize = new URL(login.headers.get("location")!);
    const code = this.w.gh.issueCode(this.user, authorize.searchParams.get("code_challenge")!);
    const callbackUrl = `/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`;
    const callback = await this.get(callbackUrl);
    return { authorize, callback, callbackUrl };
  }

  /** Reads the acceptance form of the sign page into fields (the page's other form, sign-out, is not part of it). */
  static form(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    const agree = /<form[^>]*action="\/agree[^"]*"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
    for (const m of agree.matchAll(/<input type="hidden" name="([a-z0-9_]+)" value="([^"]*)">/g)) out[m[1]!] = m[2]!.replaceAll("&amp;", "&");
    return out;
  }
}

/** Spanish in a text, apart from the author's name in a licence notice; null when there is none. */
export function spanishIn(text: string): string | null {
  const m = /\b(?:firm\w*|acuerdo|español|falta|personas?|comprobaciones|mantiene|repositorio|hace)\b|lang=es|[ñ¿¡áéíóú]/i.exec(text.replaceAll("José M. Requena Plens", ""));
  return m ? m[0] : null;
}
