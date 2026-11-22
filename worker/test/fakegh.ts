// SPDX-License-Identifier: MIT
/**
 * An in-memory GitHub for the tests: the REST and GraphQL endpoints the
 * Worker calls, with the rules that matter enforced (the app JWT's RS256
 * signature, installation tokens narrowed to repositories and permissions,
 * user tokens narrowed to one repository, single-use OAuth codes bound to
 * a PKCE challenge, revoked grants). Every request is kept for assertions.
 */
import type { CommitNode } from "../src/authors";
import type { SignatureRecord } from "../src/registry";
import { b64urlDecode, b64urlEncode, sha256Hex, utf8 } from "../src/util";

export const ORG_ID = 357318718;
export const APP_ID = 1234567;
export const BOT_ID = 99999999;
export const CLIENT_ID = "Iv23liTESTCLIENT";
export const CLIENT_SECRET = "test-client-secret-value";
export const REGISTRY = "kleidos-dev/cla";

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
}

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
  installation?: number;
  repos?: string[];
  permissions?: Record<string, string>;
  user?: User;
  repositoryId?: number;
  revoked?: boolean;
}

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
  runs: { id: number; repo: string; head_sha: string; head_repository: string; status: string; approved: boolean }[] = [];
  dispatches: { kind: string; repo: string; pr: string; comment_id: string }[] = [];
  deletedInstallations: number[] = [];
  revokedGrants: string[] = [];
  deliveries: { id: number; guid: string; status_code: number; delivered_at: string; redelivery: boolean }[] = [];
  redelivered: number[] = [];
  tokens = new Map<string, Token>();
  codes = new Map<string, { user: User; challenge: string; used: boolean }>();
  requests: { method: string; url: string }[] = [];
  failNext: { match: RegExp; status: number; headers?: Record<string, string> } | null = null;
  private seq = 1000;

  async init(publicKey: CryptoKey): Promise<void> {
    this.publicKey = publicKey;
    this.installations.set(1, { account: ORG_ID });
    this.addRepo(REGISTRY);
    this.addRepo("kleidos-dev/cla-sandbox");
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
    const c = this.comments.find((x) => x.id === commentId)!;
    const config = JSON.parse(this.files.get("main:registry/config.json")!) as { versions: Record<string, { set_sha256: string }> };
    const rec: SignatureRecord = {
      schema: 1,
      kind: "individual",
      github_id: c.user.id,
      login_at_signing: c.user.login,
      agreement: "kleidos-ca",
      version,
      set_sha256: setSha256 ?? config.versions[String(version)]!.set_sha256,
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

  issueCode(user: User, challenge: string): string {
    const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(15)));
    this.codes.set(code, { user, challenge, used: false });
    return code;
  }

  private async verifyJwt(auth: string | null): Promise<boolean> {
    const m = auth ? /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(auth) : null;
    if (!m) return false;
    const sig = b64urlDecode(m[3]!);
    if (!sig) return false;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", this.publicKey, sig, utf8(`${m[1]}.${m[2]}`));
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2]!)!)) as { iss: string; exp: number };
    return payload.iss === String(APP_ID) && payload.exp > Date.now() / 1000;
  }

  private tokenOf(auth: string | null): Token | null {
    const m = auth ? /^Bearer (gh[su]_[A-Za-z0-9_-]+)$/.exec(auth) : null;
    if (!m) return null;
    const t = this.tokens.get(m[1]!);
    return t && !t.revoked ? t : null;
  }

  private can(t: Token | null, repo: string, perm: string, level: "read" | "write"): boolean {
    if (!t) return false;
    if (t.kind === "user") return this.repos.get(repo)?.id === t.repositoryId && perm === "pull_requests";
    return Boolean(t.repos?.includes(repo.split("/")[1]!) && (LEVEL[t.permissions?.[perm] ?? ""] ?? 0) >= LEVEL[level]!);
  }

  private prJson(p: FakePr) {
    const repo = this.repos.get(p.repo)!;
    return {
      number: p.number,
      state: p.state,
      merged: p.merged,
      locked: p.locked,
      html_url: `https://github.com/${p.repo}/pull/${p.number}`,
      user: { id: p.user.id, login: p.user.login, type: p.user.type },
      head: { sha: p.head.sha, repo: { full_name: p.head.repo } },
      base: { repo: { id: repo.id, full_name: p.repo, private: repo.private } },
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

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, url: url.pathname + url.search });
    if (this.failNext && this.failNext.match.test(`${req.method} ${url.pathname}`)) {
      const f = this.failNext;
      this.failNext = null;
      return json({ message: "injected" }, f.status, f.headers);
    }
    const auth = req.headers.get("authorization");
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (url.host === "github.com") {
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const entry = this.codes.get(String(data.code));
        if (!entry || entry.used || data.client_id !== CLIENT_ID || data.client_secret !== CLIENT_SECRET) return json({ error: "bad_verification_code" });
        entry.used = true;
        const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(String(data.code_verifier)))));
        if (challenge !== entry.challenge) return json({ error: "bad_verification_code" });
        const token = `ghu_${b64urlEncode(crypto.getRandomValues(new Uint8Array(18)))}`;
        this.tokens.set(token, { kind: "user", user: entry.user, repositoryId: Number(data.repository_id) });
        return json({ access_token: token, token_type: "bearer", scope: "", expires_in: 28800 });
      }
      return json({ message: "Not Found" }, 404);
    }
    if (url.host !== "api.github.com") return json({ message: "unknown host" }, 502);
    const p = url.pathname;
    let m: RegExpExecArray | null;

    // App endpoints, JWT
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(p))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      const r = this.repos.get(m[1]!);
      return r ? json({ id: r.installation, account: { id: r.account } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      const token = `ghs_${b64urlEncode(crypto.getRandomValues(new Uint8Array(18)))}`;
      this.tokens.set(token, { kind: "installation", installation: Number(m[1]), repos: data.repositories as string[], permissions: data.permissions as Record<string, string> });
      return json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(p))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      const id = Number(m[1]);
      const inst = this.installations.get(id);
      if (!inst) return json({ message: "Not Found" }, 404);
      if (req.method === "DELETE") {
        this.deletedInstallations.push(id);
        this.installations.delete(id);
        return new Response(null, { status: 204 });
      }
      return json({ id, account: { id: inst.account } });
    }
    if (p === "/app/installations") {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      return json([...this.installations.entries()].map(([id, i]) => ({ id, account: { id: i.account } })));
    }
    if (p === "/app/hook/deliveries") {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      return json(this.deliveries);
    }
    if ((m = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(p))) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad credentials" }, 401);
      this.redelivered.push(Number(m[1]));
      return json({}, 202);
    }
    if ((m = /^\/applications\/([^/]+)\/grant$/.exec(p)) && req.method === "DELETE") {
      if (auth !== `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}` || m[1] !== CLIENT_ID) return json({ message: "Bad credentials" }, 401);
      const t = this.tokens.get(String(data.access_token));
      if (!t || t.kind !== "user") return json({ message: "Not Found" }, 404);
      for (const [k, v] of this.tokens) if (v.kind === "user" && v.user?.id === t.user?.id) {
        v.revoked = true;
        this.revokedGrants.push(k);
      }
      return new Response(null, { status: 204 });
    }
    if (p === "/user") {
      const t = this.tokenOf(auth);
      if (!t || t.kind !== "user") return json({ message: "Bad credentials" }, 401);
      return json({ id: t.user!.id, login: t.user!.login, type: t.user!.type });
    }
    if (p === "/graphql") {
      const t = this.tokenOf(auth);
      const v = data.variables as { owner: string; name: string; number: number; cursor: string | null };
      const repo = `${v.owner}/${v.name}`;
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Resource not accessible by integration" }, 403);
      const pr = this.pulls.get(`${repo}#${v.number}`);
      if (!pr) return json({ data: { repository: { pullRequest: null } } });
      const start = v.cursor ? Number(v.cursor) : 0;
      const nodes = pr.commits.slice(start, start + 100).map((commit) => ({ commit }));
      const end = start + nodes.length;
      return json({ data: { repository: { pullRequest: { commits: { totalCount: pr.commits.length, pageInfo: { hasNextPage: end < pr.commits.length, endCursor: String(end) }, nodes } } } } });
    }

    // Repository endpoints, installation or user token
    if (!(m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p))) return json({ message: "Not Found" }, 404);
    const repo = m[1]!;
    const rest = m[2] ?? "";
    const t = this.tokenOf(auth);
    if (!this.repos.has(repo)) return json({ message: "Not Found" }, 404);
    if (!t) return json({ message: "Bad credentials" }, 401);

    if (rest === "" && req.method === "GET") {
      if (!this.can(t, repo, "metadata", "read") && !this.can(t, repo, "pull_requests", "read") && !this.can(t, repo, "contents", "read")) return json({ message: "Not Found" }, 404);
      const r = this.repos.get(repo)!;
      return json({ id: r.id, full_name: repo, private: r.private });
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      if (!this.can(t, repo, "contents", "read")) return json({ message: "Forbidden" }, 403);
      const content = this.files.get(`${url.searchParams.get("ref") ?? "main"}:${m[1]}`);
      return content === undefined ? json({ message: "Not Found" }, 404) : new Response(content, { headers: { "content-type": "application/vnd.github.raw+json" } });
    }
    if (rest === "/commits" && req.method === "GET") {
      if (!this.can(t, repo, "contents", "read")) return json({ message: "Forbidden" }, 403);
      const id = Number(/signatures\/individual\/(\d+)\.json/.exec(url.searchParams.get("path") ?? "")?.[1]);
      const sha = this.recordCommits.get(id);
      return json(sha ? [{ sha }] : []);
    }
    if ((m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest))) {
      if (!this.can(t, repo, "actions", "write")) return json({ message: "Forbidden" }, 403);
      this.dispatches.push(data.inputs as never);
      return new Response(null, { status: 204 });
    }
    if (rest === "/pulls" && req.method === "GET") {
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
      return json([...this.pulls.values()].filter((x) => x.repo === repo && x.state === "open").map((x) => this.prJson(x)));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
      const pr = this.pulls.get(`${repo}#${m[1]}`);
      return pr ? json(this.prJson(pr)) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(rest))) {
      if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
      return json(this.pulls.get(`${repo}#${m[1]}`)!.files);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const n = Number(m[1]);
      if (req.method === "GET") {
        if (!this.can(t, repo, "pull_requests", "read")) return json({ message: "Forbidden" }, 403);
        return json(this.comments.filter((c) => c.repo === repo && c.pr === n).map((c) => this.commentJson(c)));
      }
      if (!this.can(t, repo, "pull_requests", "write")) return json({ message: "Forbidden" }, 403);
      const pr = this.pulls.get(`${repo}#${n}`);
      if (!pr) return json({ message: "Not Found" }, 404);
      if (pr.locked && t.kind === "user") return json({ message: "locked" }, 403);
      const now = new Date().toISOString().slice(0, 19) + "Z";
      const user = t.kind === "user" ? t.user! : { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" as const };
      const c: FakeComment = { id: this.next(), repo, pr: n, body: String(data.body), user, created_at: now, updated_at: now, via_app: true };
      this.comments.push(c);
      return json(this.commentJson(c), 201);
    }
    if ((m = /^\/issues\/comments\/(\d+)$/.exec(rest)) && req.method === "PATCH") {
      if (!this.can(t, repo, "pull_requests", "write") || t.kind !== "installation") return json({ message: "Forbidden" }, 403);
      const c = this.comments.find((x) => x.id === Number(m![1]));
      if (!c) return json({ message: "Not Found" }, 404);
      c.body = String(data.body);
      c.updated_at = new Date(Date.now() + 1000).toISOString().slice(0, 19) + "Z";
      return json(this.commentJson(c));
    }
    if ((m = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest))) {
      if (!this.can(t, repo, "checks", "read")) return json({ message: "Forbidden" }, 403);
      const runs = this.checkRuns.filter((r) => r.repo === repo && r.head_sha === m![1] && r.name === url.searchParams.get("check_name"));
      return json({ check_runs: runs.map((r) => ({ id: r.id, conclusion: r.conclusion, app: { id: r.app_id } })) });
    }
    if (rest === "/check-runs" && req.method === "POST") {
      if (!this.can(t, repo, "checks", "write")) return json({ message: "Forbidden" }, 403);
      const out = data.output as { title: string; summary: string };
      this.checkRuns.push({ id: this.next(), repo, head_sha: String(data.head_sha), name: String(data.name), app_id: APP_ID, conclusion: String(data.conclusion), title: out.title, summary: out.summary, details_url: String(data.details_url), external_id: String(data.external_id) });
      return json({}, 201);
    }
    if ((m = /^\/check-runs\/(\d+)$/.exec(rest)) && req.method === "PATCH") {
      if (!this.can(t, repo, "checks", "write")) return json({ message: "Forbidden" }, 403);
      const r = this.checkRuns.find((x) => x.id === Number(m![1]))!;
      const out = data.output as { title: string; summary: string };
      Object.assign(r, { conclusion: String(data.conclusion), title: out.title, summary: out.summary });
      return json({});
    }
    if (rest === "/actions/runs" && req.method === "GET") {
      if (!this.can(t, repo, "actions", "read")) return json({ message: "Forbidden" }, 403);
      const runs = this.runs.filter((r) => r.repo === repo && r.head_sha === url.searchParams.get("head_sha") && r.status === "action_required" && !r.approved);
      return json({ workflow_runs: runs.map((r) => ({ id: r.id, head_sha: r.head_sha, head_repository: { full_name: r.head_repository } })) });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/approve$/.exec(rest))) {
      if (!this.can(t, repo, "actions", "write")) return json({ message: "Forbidden" }, 403);
      const r = this.runs.find((x) => x.id === Number(m![1]))!;
      r.approved = true;
      return json({}, 201);
    }
    return json({ message: `fake: no route ${req.method} ${p}` }, 404);
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
