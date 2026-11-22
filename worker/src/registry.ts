// SPDX-License-Identifier: MIT
import type { GitHub } from "./github";
import { GitHubError } from "./github";
import { nowSeconds } from "./util";

export interface VersionInfo {
  path: string;
  set_sha256: string;
  files: Record<string, string>;
  sentence: string;
}

export interface Config {
  schema: 1;
  agreement: string;
  current_version: number;
  accepted_versions: number[];
  versions: Record<string, VersionInfo>;
  served_repositories: Record<string, { auto_approve: boolean }>;
  exempt: { id: number; login: string; why: string }[];
  coverage_from?: string;
  app_id?: number | null;
}

export interface Entity {
  slug: string;
  name: string;
  version: number;
  set_sha256: string;
  signed_at: string;
  covered: { github_id: number; from: string; until?: string | null }[];
}

export interface SignatureRecord {
  schema: 1;
  kind: "individual";
  github_id: number;
  login_at_signing: string;
  agreement: string;
  version: number;
  set_sha256: string;
  accepted_at: string;
  method: "web" | "comment";
  evidence: { pr_url: string; comment_url: string; comment_id: number; comment_body_sha256: string };
  recorded_at: string;
  recorder_run_id: number;
}

export const CONFIG_PATH = "registry/config.json";
export const ENTITIES_PATH = "registry/entities.json";
export const SIGNATURES_BRANCH = "signatures";
export const RECORD_WORKFLOW = "record.yml";
/** github-actions[bot], the author of every commit the recorder makes. */
export const ACTIONS_BOT_ID = 41898282;

interface CommitFacts {
  sha: string;
  author: { id: number } | null;
  committer: { login: string } | null;
  commit?: { verification?: { verified: boolean; reason: string } };
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/;
const RECORD_KEYS = ["schema", "kind", "github_id", "login_at_signing", "agreement", "version", "set_sha256", "accepted_at", "method", "evidence", "recorded_at", "recorder_run_id"];
const EVIDENCE_KEYS = ["pr_url", "comment_url", "comment_id", "comment_body_sha256"];

function posInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function sameKeys(o: object, keys: string[]): boolean {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
}

/** registry/schema/individual.schema.json, checked field by field; registry/cla.py check_record does the same. */
export function isSignatureRecord(v: unknown, id: number): v is SignatureRecord {
  if (typeof v !== "object" || v === null || !sameKeys(v, RECORD_KEYS)) return false;
  const r = v as Record<string, unknown>;
  const e = r.evidence as Record<string, unknown> | null;
  if (typeof e !== "object" || e === null || !sameKeys(e, EVIDENCE_KEYS)) return false;
  return (
    r.schema === 1 &&
    r.kind === "individual" &&
    r.github_id === id &&
    typeof r.login_at_signing === "string" &&
    LOGIN.test(r.login_at_signing) &&
    r.agreement === "kleidos-ca" &&
    posInt(r.version) &&
    typeof r.set_sha256 === "string" &&
    HEX64.test(r.set_sha256) &&
    typeof r.accepted_at === "string" &&
    TIME.test(r.accepted_at) &&
    (r.method === "web" || r.method === "comment") &&
    typeof e.pr_url === "string" &&
    PR_URL.test(e.pr_url) &&
    posInt(e.comment_id) &&
    e.comment_url === `${e.pr_url}#issuecomment-${e.comment_id}` &&
    typeof e.comment_body_sha256 === "string" &&
    HEX64.test(e.comment_body_sha256) &&
    typeof r.recorded_at === "string" &&
    TIME.test(r.recorded_at) &&
    posInt(r.recorder_run_id)
  );
}

const cache = new Map<string, { value: unknown; expires: number }>();

export function resetRegistryCache(): void {
  cache.clear();
}

function isConfig(v: unknown): v is Config {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<Config>;
  return (
    c.schema === 1 &&
    typeof c.current_version === "number" &&
    Array.isArray(c.accepted_versions) &&
    typeof c.versions === "object" &&
    c.versions !== null &&
    typeof c.served_repositories === "object" &&
    c.served_repositories !== null &&
    Array.isArray(c.exempt) &&
    c.exempt.every((e) => typeof e?.id === "number")
  );
}

/** Reads the registry's files on main with an installation token of the registry (contents: read). */
export class Registry {
  constructor(
    readonly gh: GitHub,
    readonly repo: string,
  ) {}

  private async readToken(): Promise<string> {
    return this.gh.token([this.repo], { contents: "read" });
  }

  private async raw(path: string, ref: string): Promise<string | null> {
    try {
      const r = await this.gh.request<string>("GET", `/repos/${this.repo}/contents/${path}?ref=${ref}`, { token: await this.readToken() }, undefined, "application/vnd.github.raw+json");
      return r.data;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  private async cachedJson(path: string, ref: string, ttl: number): Promise<unknown> {
    const key = `${ref}:${path}`;
    const hit = cache.get(key);
    const now = nowSeconds();
    if (hit && hit.expires > now) return hit.value;
    const text = await this.raw(path, ref);
    let value: unknown = null;
    if (text !== null) {
      try {
        value = JSON.parse(text);
      } catch {
        throw new GitHubError(200, "bad_response");
      }
    }
    cache.set(key, { value, expires: now + ttl });
    return value;
  }

  async config(): Promise<Config> {
    const v = await this.cachedJson(CONFIG_PATH, "main", 60);
    if (!isConfig(v)) throw new GitHubError(200, "bad_response");
    return v;
  }

  async entities(): Promise<Entity[]> {
    const v = (await this.cachedJson(ENTITIES_PATH, "main", 60)) as { entities?: Entity[] } | null;
    return Array.isArray(v?.entities) ? v.entities : [];
  }

  /**
   * The signature of one account, or null. Not cached: a new record must
   * show at once. A record counts only when it has the schema's exact shape
   * and the last commit that touched it is the recorder's: authored by
   * github-actions[bot], committed by GitHub (web-flow) and carrying a
   * valid signature. A file pushed by anybody else is not a signature.
   */
  async signature(id: number): Promise<SignatureRecord | null> {
    const text = await this.raw(`signatures/individual/${id}.json`, SIGNATURES_BRANCH);
    if (text === null) return null;
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isSignatureRecord(rec, id)) return null;
    const commit = await this.lastCommit(id);
    return commit?.byRecorder ? rec : null;
  }

  private commits = new Map<number, Promise<{ sha: string; byRecorder: boolean } | null>>();

  /** The commit on the signatures branch that last touched a record, and whether it is the recorder's. */
  private lastCommit(id: number): Promise<{ sha: string; byRecorder: boolean } | null> {
    let hit = this.commits.get(id);
    if (!hit) {
      hit = (async () => {
        const r = await this.gh.request<CommitFacts[]>("GET", `/repos/${this.repo}/commits?sha=${SIGNATURES_BRANCH}&path=signatures/individual/${id}.json&per_page=1`, { token: await this.readToken() });
        const c = r.data[0];
        if (!c || !/^[0-9a-f]{40}$/.test(c.sha)) return null;
        const v = c.commit?.verification;
        return { sha: c.sha, byRecorder: c.author?.id === ACTIONS_BOT_ID && c.committer?.login === "web-flow" && v?.verified === true && v.reason === "valid" };
      })();
      hit.catch(() => this.commits.delete(id));
      this.commits.set(id, hit);
    }
    return hit;
  }

  /** The commit on the signatures branch that added a record, for the confirmation link. */
  async recordCommit(id: number): Promise<string | null> {
    return (await this.lastCommit(id))?.sha ?? null;
  }

  /** The pull request numbers of a repository that have a coverage record (one directory listing). */
  async coverageNumbers(repo: string): Promise<Set<number>> {
    try {
      const r = await this.gh.request<{ name: string; type: string }[]>("GET", `/repos/${this.repo}/contents/coverage/${repo}?ref=${SIGNATURES_BRANCH}`, { token: await this.readToken() });
      const out = new Set<number>();
      for (const f of Array.isArray(r.data) ? r.data : []) {
        const m = /^([1-9][0-9]{0,9})\.json$/.exec(f.name);
        if (m && f.type === "file") out.add(Number(m[1]));
      }
      return out;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return new Set();
      throw e;
    }
  }

  /** Dispatches the registry's recorder; it re-reads everything from GitHub itself. */
  async dispatchRecorder(inputs: { kind: "sign" | "coverage"; repo: string; pr: number; comment_id?: number }): Promise<void> {
    const token = await this.gh.token([this.repo], { actions: "write" });
    await this.gh.request("POST", `/repos/${this.repo}/actions/workflows/${RECORD_WORKFLOW}/dispatches`, { token }, {
      ref: "main",
      inputs: { kind: inputs.kind, repo: inputs.repo, pr: String(inputs.pr), comment_id: inputs.comment_id ? String(inputs.comment_id) : "" },
    });
  }
}

/** A record counts when its version is accepted and its digest is that version's. */
export function recordValid(config: Config, rec: SignatureRecord | null): rec is SignatureRecord {
  if (!rec) return false;
  const v = config.versions[String(rec.version)];
  return Boolean(v && config.accepted_versions.includes(rec.version) && v.set_sha256 === rec.set_sha256);
}

/** The entity, if any, that covers an account on a given date (YYYY-MM-DD). */
export function coveringEntity(entities: Entity[], config: Config, id: number, date: string): Entity | null {
  for (const e of entities) {
    const v = config.versions[String(e.version)];
    if (!v || !config.accepted_versions.includes(e.version) || v.set_sha256 !== e.set_sha256) continue;
    for (const c of e.covered) {
      if (c.github_id === id && c.from <= date && (!c.until || date <= c.until)) return e;
    }
  }
  return null;
}
