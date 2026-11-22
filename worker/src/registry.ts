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

  /** The signature of one account, or null. Not cached: a new record must show at once. */
  async signature(id: number): Promise<SignatureRecord | null> {
    const text = await this.raw(`signatures/individual/${id}.json`, SIGNATURES_BRANCH);
    if (text === null) return null;
    try {
      const rec = JSON.parse(text) as SignatureRecord;
      return rec.github_id === id && rec.kind === "individual" ? rec : null;
    } catch {
      return null;
    }
  }

  /** The commit on the signatures branch that added a record, for the confirmation link. */
  async recordCommit(id: number): Promise<string | null> {
    const r = await this.gh.request<{ sha: string }[]>("GET", `/repos/${this.repo}/commits?sha=${SIGNATURES_BRANCH}&path=signatures/individual/${id}.json&per_page=1`, { token: await this.readToken() });
    return r.data[0]?.sha ?? null;
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
