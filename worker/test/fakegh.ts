// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * An in-memory GitHub for the tests: the REST and GraphQL endpoints the
 * Worker calls, with the rules that matter enforced (the app JWT's RS256
 * signature, installation tokens narrowed to repositories and permissions,
 * user tokens narrowed to one repository, single-use OAuth codes bound to
 * a PKCE challenge, revoked grants). Every request is kept for assertions.
 *
 * It is strict: a request with a method, header, token permission, query or
 * body the real GitHub would not accept from this app, or that no route
 * answers, is refused and kept in `strays`, and `world()` fails the test
 * that made it. A test that wants an odd answer asks for it with `answer()`.
 */
import type { CommitNode } from "../src/authors";
import type { SignatureRecord } from "../src/registry";
import { b64urlDecode, b64urlEncode, must, sha256Hex, utf8 } from "../src/util";
import { RECORD_INPUTS } from "./record-inputs";

export const ORG_ID = 357318718;
export const APP_ID = 1234567;
export const BOT_ID = 99999999;
export const CLIENT_ID = "Iv23liTESTCLIENT";
export const CLIENT_SECRET = "test-client-secret-value";
/** The identity-only sign-in app: no permission at all, so its tokens reach nothing but /user. */
export const SIGNIN_CLIENT_ID = "Iv23liSIGNINTEST0001";
export const SIGNIN_CLIENT_SECRET = "test-signin-secret-value";
export const REGISTRY = "kleidos-dev/cla";
export const USER_AGENT = "kleidos-cla (+https://cla.kleidos.dev)";
/** The permissions of the app's manifest (scripts/create-github-app.ts): a token can be narrowed to them, never widened. */
const APP_PERMISSIONS: Record<string, string> = { metadata: "read", contents: "read", pull_requests: "write", checks: "write", actions: "write" };
/** The one GraphQL query the Worker sends, as GitHub gets it. */
const COMMITS_QUERY = "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid message authoredDate parents{totalCount} authors(first:20){totalCount nodes{email user{databaseId login}}}}}}}}}";
/** GitHub's cap on the files one directory listing returns. */
const DIRECTORY_CAP = 1000;

export interface User {
  id: number;
  login: string;
  type: "User" | "Bot" | "Organization";
  email?: string;
}

export interface FakePr {
  repo: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  locked: boolean;
  user: User;
  head: { sha: string; repo: string };
  files: { filename: string; previous_filename?: string }[];
  commits: CommitNode[];
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
}

/** The `.github` tree object of every base commit in the fake. */
export const BASE_GITHUB_TREE = "9".repeat(40);
export const BASE_SHA = "b".repeat(40);

export interface FakeComment {
  id: number;
  repo: string;
  pr: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
  via_app: boolean;
}

interface Token {
  kind: "installation" | "user";
  /** For a user token: the app it was issued by. */
  app?: "bot" | "signin";
  installation?: number;
  repos?: string[];
  permissions?: Record<string, string>;
  user?: User;
  repositoryId?: number;
  revoked?: boolean;
  /** Milliseconds since the epoch; an installation token lasts one hour. */
  expires?: number;
}

/** A request as the fake received it. `auth` names the credential without quoting it. */
export interface Seen {
  method: string;
  url: string;
  auth: "none" | "jwt" | "basic" | "user" | "installation" | "unknown";
  /** For an installation token: what it was narrowed to. */
  permissions?: Record<string, string> | undefined;
  body?: unknown;
}

type Responder = (seen: Seen) => Response | Promise<Response>;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

const LEVEL: Record<string, number> = { read: 1, write: 2 };

export class FakeGitHub {
  publicKey!: CryptoKey;
  users = new Map<number, User>();
  repos = new Map<string, { id: number; private: boolean; account: number; installation: number }>();
  installations = new Map<number, { account: number }>();
  pulls = new Map<string, FakePr>();
  comments: FakeComment[] = [];
  checkRuns: { id: number; repo: string; head_sha: string; name: string; app_id: number; conclusion: string; title: string; summary: string; details_url: string; external_id: string }[] = [];
  files = new Map<string, string>();
  recordCommits = new Map<number, string>();
  /** Records whose last commit was pushed by somebody other than the recorder. */
  forgedRecords = new Set<number>();
  runs: { id: number; repo: string; head_sha: string; head_repository: string; status: string; approved: boolean; jobs?: { labels?: string[]; runner_group_name?: string | null }[] }[] = [];
  /** The `.github` tree object of a commit, when a test pins it (otherwise derived from the pull request's files). */
  githubTrees = new Map<string, string | null>();
  /** Called before every request is answered, to move state mid-flight. */
  onRequest: ((method: string, path: string) => void) | null = null;
  /** GitHub's cap on the commits it lists for one pull request. */
  commitCap = 250;
  dispatches: { kind: string; repo: string; pr: string; comment_id?: string; github_id?: string; version?: string; lang?: string; site_commit?: string; signin_token?: string }[] = [];
  /** record.yml's runs as the Actions API lists them, newest first. */
  recordRuns: { display_title: string; created_at: string; status: string; conclusion: string | null; head_branch: string }[] = [];
  deletedInstallations: number[] = [];
  revokedGrants: string[] = [];
  deliveries: { id: number; guid: string; status_code: number; delivered_at: string; redelivery: boolean }[] = [];
  redelivered: number[] = [];
  tokens = new Map<string, Token>();
  codes = new Map<string, { user: User; challenge: string; used: boolean; clientId: string }>();
  requests: Seen[] = [];
  /** Requests the fake refused: see the note at the top of this file. */
  strays: string[] = [];
  private answers: { match: RegExp; respond: Responder; times: number }[] = [];
  failNext: { match: RegExp; status: number; headers?: Record<string, string> } | null = null;
  private seq = 1000;

  init(publicKey: CryptoKey): Promise<void> {
    this.publicKey = publicKey;
    this.installations.set(1, { account: ORG_ID });
    this.addRepo(REGISTRY);
    this.addRepo("kleidos-dev/cla-sandbox");
    return Promise.resolve();
  }

  /** Answers the next `times` requests that match "METHOD /path?query" with `respond` instead of a route. */
  answer(match: RegExp, respond: Responder, times = Infinity): void {
    this.answers.push({ match, respond, times });
  }

  /** The requests that match "METHOD /path?query", in order. */
  seen(match: RegExp): Seen[] {
    return this.requests.filter((r) => match.test(`${r.method} ${r.url}`));
  }

  /** Every request but the ones that only buy or read: tokens, installations and the registry's files. */
  writes(): string[] {
    return this.requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/access_tokens") && r.url !== "/graphql").map((r) => `${r.method} ${r.url}`);
  }

  next(): number {
    return ++this.seq;
  }

  addUser(u: User): User {
    this.users.set(u.id, u);
    return u;
  }

  addRepo(name: string, opts: { private?: boolean; installation?: number; account?: number } = {}): void {
    this.repos.set(name, { id: this.next(), private: opts.private ?? false, account: opts.account ?? ORG_ID, installation: opts.installation ?? 1 });
  }

  setFile(ref: string, path: string, content: string): void {
    this.files.set(`${ref}:${path}`, content);
  }

  /** What record.yml does after re-reading the comment: write the record on the signatures branch. */
  async record(commentId: number, version = 1, setSha256?: string): Promise<SignatureRecord> {
    const c = must(this.comments.find((x) => x.id === commentId));
    const config = JSON.parse(must(this.files.get("main:registry/config.json"))) as { versions: Record<string, { set_sha256: string }> };
    const rec: SignatureRecord = {
      schema: 1,
      kind: "individual",
      github_id: c.user.id,
      login_at_signing: c.user.login,
      agreement: "kleidos-ca",
      version,
      set_sha256: setSha256 ?? must(config.versions[String(version)]).set_sha256,
      accepted_at: c.created_at,
      method: c.via_app ? "web" : "comment",
      evidence: {
        pr_url: `https://github.com/${c.repo}/pull/${c.pr}`,
        comment_url: `https://github.com/${c.repo}/pull/${c.pr}#issuecomment-${c.id}`,
        comment_id: c.id,
        comment_body_sha256: await sha256Hex(c.body),
      },
      recorded_at: new Date().toISOString().slice(0, 19) + "Z",
      recorder_run_id: this.next(),
    };
    this.setFile("signatures", `signatures/individual/${c.user.id}.json`, JSON.stringify(rec));
    this.recordCommits.set(c.user.id, (await sha256Hex(`record-${c.user.id}`)).slice(0, 40));
    return rec;
  }

  async signDirectly(user: User, version = 1): Promise<void> {
    const c: FakeComment = { id: this.next(), repo: "kleidos-dev/cla-sandbox", pr: 1, body: "x", user, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", via_app: true };
    this.comments.push(c);
    await this.record(c.id, version);
    this.comments = this.comments.filter((x) => x.id !== c.id);
  }

  issueCode(user: User, challenge: string, clientId = CLIENT_ID): string {
    const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(15)));
    this.codes.set(code, { user, challenge, used: false, clientId });
    return code;
  }

  /** What record.yml does for a sign-in once GitHub vouched for its token: a schema 2 record (and the grant gone). */
  async recordSignin(user: User, version = 2): Promise<SignatureRecord> {
    const config = JSON.parse(must(this.files.get("main:registry/config.json"))) as { versions: Record<string, { set_sha256: string; sentence: string }> };
    const rec: SignatureRecord = {
      schema: 2,
      kind: "individual",
      github_id: user.id,
      login_at_signing: user.login,
      agreement: "kleidos-ca",
      version,
      set_sha256: must(config.versions[String(version)]).set_sha256,
      sentence_sha256: await sha256Hex(must(config.versions[String(version)]).sentence),
      accepted_at: "2026-11-23T10:00:05Z",
      method: "signin",
      evidence: { authorized_at: "2026-11-23T10:00:00Z", signin_client_id: SIGNIN_CLIENT_ID, context_pr_url: "https://github.com/kleidos-dev/cla-sandbox/pull/1", site_commit: "0123456789abcdef0123456789abcdef01234567", lang: "en" },
      recorded_at: "2026-11-23T10:00:09Z",
      recorder_run_id: this.next(),
      recorder_commit: "c".repeat(40),
    };
    this.setFile("signatures", `signatures/individual/${user.id}.json`, JSON.stringify(rec));
    this.recordCommits.set(user.id, (await sha256Hex(`record-${user.id}`)).slice(0, 40));
    for (const [k, v] of this.tokens) if (v.kind === "user" && v.app === "signin" && v.user?.id === user.id) {
      v.revoked = true;
      this.revokedGrants.push(k);
    }
    return rec;
  }

  private async verifyJwt(auth: string | null): Promise<boolean> {
    const m = auth ? /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(auth) : null;
    if (!m) return false;
    const sig = b64urlDecode(must(m[3]));
    if (!sig) return false;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", this.publicKey, sig, utf8(`${m[1]}.${m[2]}`));
    if (!ok) return false;
    const part = (x: string | undefined) => JSON.parse(new TextDecoder().decode(must(b64urlDecode(must(x))))) as { alg?: string; typ?: string; iss?: string; iat?: number; exp?: number };
    const { alg, typ } = part(m[1]);
    const { iss, iat = NaN, exp = NaN } = part(m[2]);
    const now = Date.now() / 1000;
    // GitHub refuses a JWT made in the future, expired, or that lasts more than ten minutes.
    return alg === "RS256" && typ === "JWT" && iss === String(APP_ID) && iat <= now && exp > now && exp - now <= 600;
  }

  private tokenOf(auth: string | null): Token | null {
    const m = auth ? /^Bearer (gh[su]_[A-Za-z0-9_-]+)$/.exec(auth) : null;
    if (!m) return null;
    const t = this.tokens.get(must(m[1]));
    return t && !t.revoked && (t.expires ?? Infinity) > Date.now() ? t : null;
  }

  private can(t: Token | null, repo: string, perm: string, level: "read" | "write"): boolean {
    if (!t) return false;
    if (t.kind === "user") return t.app !== "signin" && this.repos.get(repo)?.id === t.repositoryId && perm === "pull_requests";
    return Boolean(t.repos?.includes(must(repo.split("/")[1])) && (LEVEL[t.permissions?.[perm] ?? ""] ?? 0) >= must(LEVEL[level]));
  }

  private prJson(p: FakePr) {
    const repo = must(this.repos.get(p.repo));
    return {
      number: p.number,
      state: p.state,
      merged: p.merged,
      locked: p.locked,
      html_url: `https://github.com/${p.repo}/pull/${p.number}`,
      user: { id: p.user.id, login: p.user.login, type: p.user.type },
      created_at: p.created_at ?? "2026-11-20T09:00:00Z",
      head: { sha: p.head.sha, repo: { full_name: p.head.repo } },
      base: { sha: BASE_SHA, repo: { id: repo.id, full_name: p.repo, private: repo.private } },
      changed_files: p.files.length,
    };
  }

  private commentJson(c: FakeComment) {
    return {
      id: c.id,
      body: c.body,
      html_url: `https://github.com/${c.repo}/pull/${c.pr}#issuecomment-${c.id}`,
      created_at: c.created_at,
      updated_at: c.updated_at,
      user: { id: c.user.id, login: c.user.login, type: c.user.type },
      performed_via_github_app: c.via_app ? { id: APP_ID } : null,
    };
  }

  private stray(req: Request, why: string): Response {
    const url = new URL(req.url);
    this.strays.push(`${req.method} ${url.host}${url.pathname}${url.search}: ${why}`);
    return json({ message: `fake: ${why}` }, 501);
  }

  private describe(auth: string | null, path: string): Pick<Seen, "auth" | "permissions"> {
    if (auth === null) return { auth: "none" };
    if (auth.startsWith("Basic ")) return { auth: "basic" };
    const t = this.tokens.get(auth.replace(/^Bearer /, ""));
    if (t) return t.kind === "user" ? { auth: "user" } : { auth: "installation", permissions: t.permissions };
    return { auth: /^Bearer [^.]+\.[^.]+\.[^.]+$/.test(auth) && /^\/(app\b|repos\/[^/]+\/[^/]+\/installation$)/.test(path) ? "jwt" : "unknown" };
  }

  /** One page of a list as GitHub cuts it: `per_page` (30 unless given, 100 at most) and a `Link` header while more follow. */
  private page(url: URL, items: unknown[]): Response {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    const first = new URL(url);
    first.searchParams.set("page", "1");
    const link = [`<${first.href}>; rel="first"`, ...(page * per < items.length ? [`<${next.href}>; rel="next"`] : [])].join(", ");
    return json(items.slice((page - 1) * per, page * per), 200, { link });
  }

  /** Why GitHub would not take the request as this app sends it, whatever its address; null when it would. */
  private malformed(req: Request): string | null {
    const h = req.headers;
    const url = new URL(req.url);
    // A test's own request, which plays somebody else: only its credential counts.
    if (!h.has("user-agent") && !h.has("accept") && !h.has("x-github-api-version")) return null;
    if ((req.body !== null) !== (h.get("content-type") === "application/json")) return "content-type does not match the body";
    if (url.host === "github.com") return h.get("accept") === "application/json" && h.get("user-agent") === "kleidos-cla" ? null : "headers of the OAuth exchange";
    if (url.host !== "api.github.com") return "unknown host";
    if (req.redirect !== "manual") return "a redirect would be followed";
    if (h.get("user-agent") !== USER_AGENT) return `user-agent ${h.get("user-agent")}`;
    if (h.get("x-github-api-version") !== "2022-11-28") return `api version ${h.get("x-github-api-version")}`;
    const raw = /^\/repos\/[^/]+\/[^/]+\/contents\/(?!coverage\/[^/]+\/[^/]+$)/.test(url.pathname);
    if (h.get("accept") !== (raw ? "application/vnd.github.raw+json" : "application/vnd.github+json")) return `accept ${h.get("accept")}`;
    return null;
  }

  /** What the Worker's `fetch` reaches: the request is checked as GitHub's front door would, then answered. */
  async fetch(req: Request): Promise<Response> {
    const malformed = this.malformed(req);
    return malformed ? this.stray(req, malformed) : this.handle(req);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const seen: Seen = { method: req.method, url: url.pathname + url.search, ...this.describe(auth, url.pathname), ...(body ? { body: data } : {}) };
    this.requests.push(seen);
    this.onRequest?.(req.method, url.pathname);
    if (this.failNext && this.failNext.match.test(`${req.method} ${url.pathname}`)) {
      const f = this.failNext;
      this.failNext = null;
      return json({ message: "injected" }, f.status, f.headers);
    }
    const asked = this.answers.find((a) => a.times > 0 && a.match.test(`${seen.method} ${seen.url}`));
    if (asked) {
      asked.times--;
      return asked.respond(seen);
    }
    return this.route(req, url, auth, data);
  }

  private async route(req: Request, url: URL, auth: string | null, data: Record<string, unknown>): Promise<Response> {
    const p = url.pathname;
    const at = `${req.method} ${p}`;
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    /** Whether the query is exactly the one the route documents. */
    const query = (want: Record<string, string>) => [...q.keys()].every((k) => k in want || k === "page") && Object.entries(want).every(([k, v]) => q.get(k) === v);
    const odd = () => this.stray(req, "a query no route documents");

    if (url.host === "github.com") {
      if (at === "POST /login/oauth/access_token") {
        const entry = this.codes.get(String(data.code));
        const secret = entry?.clientId === SIGNIN_CLIENT_ID ? SIGNIN_CLIENT_SECRET : CLIENT_SECRET;
        // A code is issued to one app and exchanged only with that app's own id and secret.
        if (!entry || entry.used || data.client_id !== entry.clientId || data.client_secret !== secret) return json({ error: "bad_verification_code" });
        entry.used = true;
        const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(String(data.code_verifier)))));
        if (challenge !== entry.challenge) return json({ error: "bad_verification_code" });
        const token = `ghu_${b64urlEncode(crypto.getRandomValues(new Uint8Array(18)))}`;
        const app = entry.clientId === SIGNIN_CLIENT_ID ? "signin" : "bot";
        this.tokens.set(token, { kind: "user", app, user: entry.user, ...(app === "bot" ? { repositoryId: Number(data.repository_id) } : {}) });
        return json({ access_token: token, token_type: "bearer", scope: "", expires_in: 28800, refresh_token: `ghr_${b64urlEncode(crypto.getRandomValues(new Uint8Array(18)))}`, refresh_token_expires_in: 15897600 });
      }
      return this.stray(req, "no such page");
    }

    // App endpoints, JWT
    if ((m = /^GET \/repos\/([^/]+\/[^/]+)\/installation$/.exec(at))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      const r = this.repos.get(must(m[1]));
      return r ? json({ id: r.installation, account: { id: r.account } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^POST \/app\/installations\/(\d+)\/access_tokens$/.exec(at))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      const installation = Number(m[1]);
      const repos = data.repositories as string[] | undefined;
      const permissions = data.permissions as Record<string, string> | undefined;
      // A token of every repository, or with every permission, is never asked for: an omitted list means all of them.
      if (!repos?.length || !permissions || Object.keys(permissions).length === 0) return this.stray(req, "a token that is not narrowed");
      if (repos.some((r) => ![...this.repos].some(([name, x]) => name.endsWith(`/${r}`) && x.installation === installation))) return json({ message: "repositories not in the installation" }, 422);
      if (Object.entries(permissions).some(([k, v]) => !((LEVEL[v] ?? 9) <= (LEVEL[APP_PERMISSIONS[k] ?? ""] ?? 0)))) return this.stray(req, "a permission the app does not have");
      const token = `ghs_${b64urlEncode(crypto.getRandomValues(new Uint8Array(18)))}`;
      const expires = Date.now() + 3600_000;
      this.tokens.set(token, { kind: "installation", installation, repos, permissions, expires });
      return json({ token, expires_at: new Date(expires).toISOString() }, 201);
    }
    if ((m = /^(GET|DELETE) \/app\/installations\/(\d+)$/.exec(at))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      const id = Number(m[2]);
      const inst = this.installations.get(id);
      if (!inst) return json({ message: "Not Found" }, 404);
      if (m[1] === "DELETE") {
        this.deletedInstallations.push(id);
        this.installations.delete(id);
        return new Response(null, { status: 204 });
      }
      return json({ id, account: { id: inst.account } });
    }
    if (at === "GET /app/installations") {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      if (!query({ per_page: "100" })) return odd();
      return this.page(url, [...this.installations.entries()].map(([id, i]) => ({ id, account: { id: i.account } })));
    }
    if (at === "GET /app/hook/deliveries") {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      if (!query({ per_page: "100" })) return odd();
      return this.page(url, this.deliveries);
    }
    if ((m = /^POST \/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(at))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      this.redelivered.push(Number(m[1]));
      return json({}, 202);
    }
    if ((m = /^DELETE \/applications\/([^/]+)\/grant$/.exec(at))) {
      const app = m[1] === SIGNIN_CLIENT_ID ? "signin" : "bot";
      const basic = app === "signin" ? `Basic ${btoa(`${SIGNIN_CLIENT_ID}:${SIGNIN_CLIENT_SECRET}`)}` : `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
      if (auth !== basic || (m[1] !== CLIENT_ID && m[1] !== SIGNIN_CLIENT_ID)) return json({ message: "Bad credentials" }, 401);
      const t = this.tokens.get(String(data.access_token));
      if (!t || t.kind !== "user" || (t.app ?? "bot") !== app) return json({ message: "Not Found" }, 404);
      for (const [k, v] of this.tokens) if (v.kind === "user" && (v.app ?? "bot") === app && v.user?.id === t.user?.id) {
        v.revoked = true;
        this.revokedGrants.push(k);
      }
      return new Response(null, { status: 204 });
    }
    if (at === "GET /user") {
      const t = this.tokenOf(auth);
      if (!t || t.kind !== "user") return json({ message: "Bad credentials" }, 401);
      return json({ id: must(t.user).id, login: must(t.user).login, type: must(t.user).type });
    }
    if (at === "POST /graphql") {
      const t = this.tokenOf(auth);
      if (!t) return json({ message: "Bad credentials" }, 401);
      if (data.query !== COMMITS_QUERY) return this.stray(req, "a query the fake does not know");
      const v = data.variables as { owner: string; name: string; number: number; cursor: string | null };
      const repo = `${v.owner}/${v.name}`;
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Resource not accessible by integration" }, 403);
      const pr = this.pulls.get(`${repo}#${v.number}`);
      if (!pr) return json({ data: { repository: { pullRequest: null } } });
      const start = v.cursor ? Number(v.cursor) : 0;
      const listed = pr.commits.slice(0, this.commitCap);
      // authors(first:20): more than twenty are counted and not listed.
      const nodes = listed.slice(start, start + 100).map((c) => ({ commit: { ...c, authors: { ...c.authors, nodes: c.authors.nodes.slice(0, 20) } } }));
      const end = start + nodes.length;
      return json({ data: { repository: { pullRequest: { headRefOid: pr.head.sha, commits: { totalCount: pr.commits.length, pageInfo: { hasNextPage: end < listed.length, endCursor: String(end) }, nodes } } } } });
    }

    // Repository endpoints, installation or user token
    if (!(m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p))) return this.stray(req, "no route");
    const repo = must(m[1]);
    const rest = `${req.method} ${m[2] ?? ""}`;
    const t = this.tokenOf(auth);
    if (!t) return json({ message: "Bad credentials" }, 401);
    if (!this.repos.has(repo)) return json({ message: "Not Found" }, 404);

    if (rest === "GET ") {
      if (!this.can(t, repo, "metadata", "read") && !this.can(t, repo, "pull_requests", "read") && !this.can(t, repo, "contents", "read")) return json({ message: "Not Found" }, 404);
      const r = must(this.repos.get(repo));
      return json({ id: r.id, full_name: repo, private: r.private });
    }
    if ((m = /^GET \/contents\/(.+)$/.exec(rest))) {
      if (!this.can(t, repo, "contents", "read")) return json({ message: "Forbidden" }, 403);
      const ref = q.get("ref");
      if (repo !== REGISTRY || !ref || !query({ ref })) return odd();
      const content = this.files.get(`${ref}:${m[1]}`);
      if (content === undefined) {
        const prefix = `${ref}:${m[1]}/`;
        const names = [...this.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => ({ name: k.slice(prefix.length), type: "file" }));
        return names.length ? json(names.slice(0, DIRECTORY_CAP)) : json({ message: "Not Found" }, 404);
      }
      if (req.headers.get("accept") !== "application/vnd.github.raw+json") return json({ type: "file", encoding: "base64", content: btoa(String.fromCharCode(...utf8(content))) });
      return new Response(content, { headers: { "content-type": "application/vnd.github.raw+json" } });
    }
    if (rest === "GET /commits") {
      if (!this.can(t, repo, "contents", "read")) return json({ message: "Forbidden" }, 403);
      const path = q.get("path") ?? "";
      const id = Number(/^signatures\/individual\/(\d+)\.json$/.exec(path)?.[1]);
      if (repo !== REGISTRY || Number.isNaN(id) || !query({ sha: "signatures", path, per_page: "1" })) return odd();
      const sha = this.recordCommits.get(id);
      const forged = this.forgedRecords.has(id);
      return json(sha ? [{ sha, author: { id: forged ? 666666 : 41898282 }, committer: { login: forged ? "mallory" : "web-flow" }, commit: { verification: { verified: true, reason: "valid" } } }] : []);
    }
    if (rest === "GET /actions/workflows/record.yml/runs") {
      if (!this.can(t, repo, "actions", "read")) return json({ message: "Forbidden" }, 403);
      if (repo !== REGISTRY || !query({ event: "workflow_dispatch", branch: "main", per_page: "30" })) return odd();
      return json({ total_count: this.recordRuns.length, workflow_runs: this.recordRuns.slice(0, 30) });
    }
    if (rest === "POST /actions/workflows/record.yml/dispatches") {
      if (!this.can(t, repo, "actions", "write")) return json({ message: "Forbidden" }, 403);
      // workflow_dispatch takes string inputs only, and the recorder is run from the registry's main.
      if (repo !== REGISTRY || data.ref !== "main" || Object.values(data.inputs as object).some((x) => typeof x !== "string")) return this.stray(req, "not a dispatch of the recorder");
      // GitHub answers 422 to an input the workflow does not declare, a choice off its options, and a missing kind.
      const given = data.inputs as Record<string, string>;
      const declared = ([k, v]: [string, string]) => Object.hasOwn(RECORD_INPUTS, k) && (RECORD_INPUTS[k] ?? [v]).includes(v);
      if (!Object.hasOwn(given, "kind") || !Object.entries(given).every(declared)) return this.stray(req, "inputs record.yml does not declare");
      this.dispatches.push(data.inputs as never);
      return new Response(null, { status: 204 });
    }
    if (rest === "GET /pulls") {
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
      const state = q.get("state");
      const newestFirst = { sort: "updated", direction: "desc" };
      if (!(state === "open" && query({ state, per_page: "100" })) && !(state === "closed" && query({ state, ...newestFirst, per_page: "100" }))) return odd();
      const list = [...this.pulls.values()].filter((x) => x.repo === repo && x.state === state).map((x) => ({ ...this.prJson(x), merged_at: x.merged_at ?? null, updated_at: x.updated_at ?? "2026-11-20T09:00:00Z" }));
      return this.page(url, state === "closed" ? list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)) : list);
    }
    if ((m = /^GET \/pulls\/(\d+)$/.exec(rest))) {
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
      const pr = this.pulls.get(`${repo}#${m[1]}`);
      return pr ? json(this.prJson(pr)) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^(GET|POST) \/issues\/(\d+)\/comments$/.exec(rest))) {
      const n = Number(m[2]);
      if (m[1] === "GET") {
        if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
        if (!query({ per_page: "100" })) return odd();
        return this.page(url, this.comments.filter((c) => c.repo === repo && c.pr === n).map((c) => this.commentJson(c)));
      }
      if (!this.can(t, repo, "pull_requests", "write")) return json({ message: "Forbidden" }, 403);
      const pr = this.pulls.get(`${repo}#${n}`);
      if (!pr) return json({ message: "Not Found" }, 404);
      if (pr.locked && t.kind === "user") return json({ message: "locked" }, 403);
      if (typeof data.body !== "string" || data.body === "") return json({ message: "Validation Failed" }, 422);
      const now = new Date().toISOString().slice(0, 19) + "Z";
      const user = t.kind === "user" ? must(t.user) : { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" as const };
      const c: FakeComment = { id: this.next(), repo, pr: n, body: data.body, user, created_at: now, updated_at: now, via_app: true };
      this.comments.push(c);
      return json(this.commentJson(c), 201);
    }
    if ((m = /^(GET|PATCH) \/issues\/comments\/(\d+)$/.exec(rest))) {
      const id = Number(m[2]);
      const write = m[1] === "PATCH";
      if (!this.can(t, repo, "pull_requests", write ? "write" : "read") || (write && t.kind !== "installation")) return json({ message: "Forbidden" }, 403);
      const c = this.comments.find((x) => x.id === id && x.repo === repo);
      if (!c) return json({ message: "Not Found" }, 404);
      if (write) {
        if (typeof data.body !== "string" || data.body === "") return json({ message: "Validation Failed" }, 422);
        c.body = data.body;
        c.updated_at = new Date(Date.now() + 1000).toISOString().slice(0, 19) + "Z";
      }
      return json(this.commentJson(c));
    }
    if ((m = /^GET \/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest))) {
      if (!this.can(t, repo, "checks", "read")) return json({ message: "Forbidden" }, 403);
      const head = must(m[1]);
      const name = q.get("check_name") ?? "";
      if (!query({ check_name: name, app_id: String(APP_ID), filter: "latest" })) return odd();
      const runs = this.checkRuns.filter((r) => r.repo === repo && r.head_sha === head && r.name === name);
      return json({ check_runs: runs.map((r) => ({ id: r.id, conclusion: r.conclusion, app: { id: r.app_id } })) });
    }
    if (rest === "POST /check-runs") {
      if (!this.can(t, repo, "checks", "write")) return json({ message: "Forbidden" }, 403);
      if (data.status !== "completed" || typeof data.name !== "string" || typeof data.head_sha !== "string") return json({ message: "Validation Failed" }, 422);
      const out = data.output as { title: string; summary: string };
      this.checkRuns.push({ id: this.next(), repo, head_sha: data.head_sha, name: data.name, app_id: APP_ID, conclusion: String(data.conclusion), title: out.title, summary: out.summary, details_url: String(data.details_url), external_id: String(data.external_id) });
      return json({}, 201);
    }
    if ((m = /^PATCH \/check-runs\/(\d+)$/.exec(rest))) {
      if (!this.can(t, repo, "checks", "write")) return json({ message: "Forbidden" }, 403);
      const id = Number(m[1]);
      const r = this.checkRuns.find((x) => x.id === id && x.repo === repo);
      if (!r) return json({ message: "Not Found" }, 404);
      const out = data.output as { title: string; summary: string };
      Object.assign(r, { conclusion: String(data.conclusion), title: out.title, summary: out.summary });
      return json({});
    }
    if ((m = /^GET \/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      if (!this.can(t, repo, "contents", "read")) return json({ message: "Forbidden" }, 403);
      if (!query({ per_page: "1" })) return odd();
      return m[1] === BASE_SHA ? json({ merge_base_commit: { sha: BASE_SHA } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^GET \/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      if (!this.can(t, repo, "contents", "read")) return json({ message: "Forbidden" }, 403);
      const tree = this.githubTreeOf(must(m[1]));
      return json({ sha: m[1], truncated: false, tree: [{ path: "README.md", mode: "100644", type: "blob", sha: "1".repeat(40) }, ...(tree ? [{ path: ".github", mode: "040000", type: "tree", sha: tree }] : [])] });
    }
    if ((m = /^GET \/actions\/runs\/(\d+)\/jobs$/.exec(rest))) {
      if (!this.can(t, repo, "actions", "read")) return json({ message: "Forbidden" }, 403);
      if (!query({ per_page: "100" })) return odd();
      const id = Number(m[1]);
      return json({ jobs: this.runs.find((x) => x.id === id && x.repo === repo)?.jobs ?? [] });
    }
    if (rest === "GET /actions/runs") {
      if (!this.can(t, repo, "actions", "read")) return json({ message: "Forbidden" }, 403);
      const head = q.get("head_sha") ?? "";
      if (!query({ head_sha: head, event: "pull_request", status: "action_required", per_page: "100" })) return odd();
      const runs = this.runs.filter((r) => r.repo === repo && r.head_sha === head && r.status === "action_required" && !r.approved);
      return json({ workflow_runs: runs.map((r) => ({ id: r.id, head_sha: r.head_sha, head_repository: { full_name: r.head_repository } })) });
    }
    if ((m = /^POST \/actions\/runs\/(\d+)\/approve$/.exec(rest))) {
      if (!this.can(t, repo, "actions", "write")) return json({ message: "Forbidden" }, 403);
      const id = Number(m[1]);
      const r = this.runs.find((x) => x.id === id && x.repo === repo);
      if (!r) return json({ message: "Not Found" }, 404);
      r.approved = true;
      return json({}, 201);
    }
    return this.stray(req, "no route");
  }

  /** The `.github` tree of a commit: pinned by a test, else the base's, changed when the pull request with that head touches `.github/`. */
  githubTreeOf(sha: string): string | null {
    if (this.githubTrees.has(sha)) return must(this.githubTrees.get(sha));
    const pr = [...this.pulls.values()].find((x) => x.head.sha === sha);
    const touched = pr?.files.some((f) => f.filename.startsWith(".github/") || (f.previous_filename ?? "").startsWith(".github/"));
    return touched ? "8".repeat(40) : BASE_GITHUB_TREE;
  }

  /** The latest check run of the app on a commit. */
  check(repo: string, sha: string) {
    return this.checkRuns.filter((r) => r.repo === repo && r.head_sha === sha).at(-1);
  }

  botComments(repo: string, pr: number): FakeComment[] {
    return this.comments.filter((c) => c.repo === repo && c.pr === pr && c.user.id === BOT_ID);
  }
}

let shaSeq = 0;
export function sha(): string {
  shaSeq++;
  return shaSeq.toString(16).padStart(40, "a");
}

export function commit(author: User | { email: string; name?: string }, opts: { message?: string; coAuthors?: (User | { email: string })[]; date?: string; merge?: boolean } = {}): CommitNode {
  const actor = (a: User | { email: string }) =>
    "id" in a ? { email: a.email ?? `${a.id}+${a.login}@users.noreply.github.com`, user: a.type === "User" ? { databaseId: a.id, login: a.login } : null } : { email: a.email, user: null };
  const coAuthors = opts.coAuthors ?? [];
  const trailers = coAuthors.map((c) => `Co-authored-by: Someone <${"id" in c ? (c.email ?? `${c.id}+${c.login}@users.noreply.github.com`) : c.email}>`).join("\n");
  return {
    oid: sha(),
    message: `${opts.message ?? "Change something"}${trailers ? `\n\n${trailers}` : ""}`,
    authoredDate: opts.date ?? "2026-11-20T10:00:00Z",
    parents: { totalCount: opts.merge ? 2 : 1 },
    authors: { totalCount: 1 + coAuthors.length, nodes: [actor(author), ...coAuthors.map(actor)] },
  };
}
