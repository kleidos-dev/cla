// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import type { ConfiguredEnv } from "./env";
import { allowedAccounts } from "./env";
import { b64urlDecode, b64urlEncode, byCodeUnits, must, nowSeconds, stripEnd, utf8 } from "./util";

export const API = "https://api.github.com";
export const WEB = "https://github.com";
const UA = "kleidos-cla (+https://cla.kleidos.dev)";

/** A GitHub failure, classified for the queue's retry policy. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly kind: "rate_limited" | "transient" | "unauthorized" | "not_found" | "unprocessable" | "forbidden" | "bad_response",
    readonly retryAfter?: number,
    readonly requestId?: string,
  ) {
    super(`GitHub ${status} ${kind}`);
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient" || this.kind === "unauthorized";
  }
}

export class NotAllowedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface Resp<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Every item a paginated list returned, typed at the call site like Resp<T>, and whether the page limit cut it. */
export interface Page<T> {
  items: T[];
  truncated: boolean;
}

type Auth = "jwt" | { token: string } | { basic: [string, string] };

export type Permissions = Partial<Record<"pull_requests" | "checks" | "contents" | "actions" | "metadata", "read" | "write">>;

interface CachedToken {
  token: string;
  expires: number;
}

/** Isolate-level caches: the app JWT, installation tokens, installations by repository. */
const state = {
  jwt: null as { token: string; expires: number; appId: string } | null,
  key: null as { pem: string; key: Promise<CryptoKey> } | null,
  tokens: new Map<string, CachedToken>(),
  installations: new Map<string, { id: number; account: number; expires: number }>(),
};

export function resetGitHubCaches(): void {
  state.jwt = null;
  state.key = null;
  state.tokens.clear();
  state.installations.clear();
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  if (pem.includes("BEGIN RSA PRIVATE KEY")) throw new Error("APP_PRIVATE_KEY must be PKCS#8");
  const bytes = b64urlDecode(stripEnd(body.replaceAll("+", "-").replaceAll("/", "_"), "="));
  if (!bytes) throw new Error("APP_PRIVATE_KEY is not PEM");
  return bytes;
}

async function signingKey(pem: string): Promise<CryptoKey> {
  if (state.key?.pem !== pem) {
    state.key = { pem, key: crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]) };
  }
  return state.key.key;
}

/** The app's JWT, made once per isolate for up to nine minutes. */
export async function appJwt(env: ConfiguredEnv): Promise<string> {
  const now = nowSeconds();
  if (state.jwt && state.jwt.appId === env.APP_ID && state.jwt.expires - 60 > now) return state.jwt.token;
  const header = b64urlEncode(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64urlEncode(utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.APP_ID })));
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(env.APP_PRIVATE_KEY), utf8(input)));
  const token = `${input}.${b64urlEncode(sig)}`;
  state.jwt = { token, expires: now + 540, appId: env.APP_ID };
  return token;
}

function classify(res: Response): GitHubError {
  const requestId = res.headers.get("x-github-request-id") ?? undefined;
  const retryAfter = Number.parseInt(String(res.headers.get("retry-after")), 10);
  const reset = Number.parseInt(String(res.headers.get("x-ratelimit-reset")), 10);
  if (res.status === 429 || (res.status === 403 && (Number.isFinite(retryAfter) || res.headers.get("x-ratelimit-remaining") === "0"))) {
    const delay = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : Number.isFinite(reset) ? Math.max(1, reset - nowSeconds()) : 60;
    return new GitHubError(res.status, "rate_limited", Math.min(delay, 3600), requestId);
  }
  if (res.status >= 500) return new GitHubError(res.status, "transient", undefined, requestId);
  if (res.status === 401) return new GitHubError(res.status, "unauthorized", undefined, requestId);
  if (res.status === 404) return new GitHubError(res.status, "not_found", undefined, requestId);
  if (res.status === 422) return new GitHubError(res.status, "unprocessable", undefined, requestId);
  if (res.status === 403) return new GitHubError(res.status, "forbidden", undefined, requestId);
  return new GitHubError(res.status, "bad_response", undefined, requestId);
}

export class GitHub {
  constructor(readonly env: ConfiguredEnv) {}

  async request<T>(method: string, url: string, auth: Auth, body?: unknown, accept = "application/vnd.github+json"): Promise<Resp<T>> {
    const headers = new Headers({ "user-agent": UA, accept, "x-github-api-version": "2022-11-28" });
    if (auth === "jwt") headers.set("authorization", `Bearer ${await appJwt(this.env)}`);
    else if ("token" in auth) headers.set("authorization", `Bearer ${auth.token}`);
    else headers.set("authorization", `Basic ${btoa(`${auth.basic[0]}:${auth.basic[1]}`)}`);
    let payload: string | null = null;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    const full = url.startsWith("https://") ? url : `${API}${url}`;
    let res: Response;
    try {
      res = await fetch(full, { method, headers, body: payload, redirect: "manual" });
    } catch {
      throw new GitHubError(0, "transient");
    }
    if (res.status === 204) return { status: 204, data: undefined as T, headers: res.headers };
    if (!res.ok) {
      await res.body?.cancel();
      // The retry of a cached token GitHub no longer takes buys another instead of sending it again.
      if (res.status === 401) this.forgetToken(headers.get("authorization"));
      throw classify(res);
    }
    const text = await res.text().catch(() => {
      throw new GitHubError(res.status, "transient");
    });
    if (accept.includes("raw")) return { status: res.status, data: text as T, headers: res.headers };
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new GitHubError(res.status, "bad_response");
    }
    // Every read asks for something: an empty answer, or null, is one GitHub did not finish.
    if (method === "GET" && (data === undefined || data === null)) throw new GitHubError(res.status, "transient");
    return { status: res.status, data: data as T, headers: res.headers };
  }

  /** The installation that serves a repository, refused unless its account is on the allowlist. */
  async installationFor(repo: string): Promise<number> {
    const now = nowSeconds();
    const hit = state.installations.get(repo);
    let inst = hit && hit.expires > now ? hit : null;
    if (!inst) {
      const r = await this.request<{ id: number; account: { id: number } }>("GET", `/repos/${repo}/installation`, "jwt");
      inst = { id: r.data.id, account: r.data.account.id, expires: now + 600 };
      state.installations.set(repo, inst);
    }
    if (!allowedAccounts(this.env).has(inst.account)) throw new NotAllowedError("installation_not_allowed");
    return inst.id;
  }

  /** An installation token narrowed to the given repositories (names under the installation's account) and permissions. */
  async token(repos: string[], permissions: Permissions): Promise<string> {
    const installation = await this.installationFor(must(repos[0]));
    for (const r of repos) {
      if ((await this.installationFor(r)) !== installation) throw new NotAllowedError("repositories_span_installations");
    }
    const names = [...new Set(repos.map((r) => must(r.split("/")[1])))].sort(byCodeUnits);
    const key = `${installation}|${names.join(",")}|${JSON.stringify(Object.entries(permissions).sort((a, b) => byCodeUnits(a.join(), b.join())))}`;
    const now = nowSeconds();
    const hit = state.tokens.get(key);
    if (hit && hit.expires - 300 > now) return hit.token;
    const r = await this.request<{ token: string; expires_at: string }>("POST", `/app/installations/${installation}/access_tokens`, "jwt", { repositories: names, permissions });
    const end = Date.parse(r.data.expires_at);
    const expires = Number.isFinite(end) ? Math.floor(end / 1000) : now + 3600;
    state.tokens.set(key, { token: r.data.token, expires });
    return r.data.token;
  }

  private forgetToken(authorization: string | null): void {
    for (const [k, v] of state.tokens) if (`Bearer ${v.token}` === authorization) state.tokens.delete(k);
  }

  async graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await this.request<{ data?: T; errors?: { type?: string; message?: string }[] } | null | undefined>("POST", "/graphql", { token }, { query, variables });
    const answer = r.data;
    if (!answer) throw new GitHubError(r.status, "transient");
    if (answer.errors?.length) {
      if (answer.errors.some((e) => e.type === "RATE_LIMITED")) throw new GitHubError(200, "rate_limited", 60);
      if (answer.errors.some((e) => e.type === "NOT_FOUND")) throw new GitHubError(200, "not_found");
      throw new GitHubError(200, "bad_response");
    }
    if (!answer.data) throw new GitHubError(200, "bad_response");
    return answer.data;
  }

  /** Follows `Link: rel="next"` up to a page limit; returns every item and whether the list was cut. */
  async paginate<T>(path: string, auth: Auth, maxPages: number): Promise<Page<T>> {
    const items: T[] = [];
    let url: string | null = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
    for (let page = 0; url && page < maxPages; page++) {
      const r: Resp<unknown> = await this.request("GET", url, auth);
      if (!Array.isArray(r.data)) throw new GitHubError(r.status, "transient");
      items.push(...(r.data as T[]));
      url = nextLink(r.headers.get("link"));
    }
    return { items, truncated: url !== null };
  }
}

export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /^\s*<([^<>]+)>\s*;\s*rel="next"/.exec(part);
    if (m && must(m[1]).startsWith(`${API}/`)) return must(m[1]);
  }
  return null;
}
