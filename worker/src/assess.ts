// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import type { Account, CommitNode } from "./authors";
import { commitAuthors } from "./authors";
import type { GitHub } from "./github";
import { GitHubError } from "./github";
import type { Config, Registry, SignatureRecord } from "./registry";
import { coveringEntity, recordValid } from "./registry";
import { must, normalizeSentence } from "./util";

export const CHECK_NAME = "📝 CLA";
export const MARKER = "<!-- kleidos-cla:v1 -->";
/** GitHub lists at most 250 commits of a pull request (REST and GraphQL alike); more cannot be checked. */
export const MAX_COMMITS = 250;

/** The pull request's head moved while it was being read: nothing read can be pinned to one commit. */
export class HeadMovedError extends Error {
  constructor() {
    super("head moved");
  }
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  locked: boolean;
  html_url: string;
  created_at: string;
  user: { id: number; login: string; type: string };
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { id: number; full_name: string; private: boolean } };
  changed_files?: number;
}

export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { id: number; login: string; type: string } | null;
  performed_via_github_app: { id: number } | null;
}

export interface Acceptance {
  commentId: number;
  commentUrl: string;
  account: number;
  createdAt: string;
  edited: boolean;
}

export interface Assessment {
  repo: string;
  pr: PullRequest;
  opener: Account;
  required: Account[];
  signed: Map<number, SignatureRecord>;
  missing: Account[];
  exempt: { account: Account; why: string }[];
  entityCovered: { account: Account; entity: string }[];
  unknownCommits: string[];
  unlistedBots: { login: string; commit: string }[];
  /** GitHub cut the list of commits, or of the open pull requests that may share the head: not everybody who must sign is known. */
  tooManyCommits: boolean;
  acceptances: Acceptance[];
  botComment: { id: number; body: string } | null;
  /** More comments than were read: the bot's own may be among the rest. */
  commentsCut?: boolean;
}

const COMMITS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid message authoredDate parents{totalCount} authors(first:20){totalCount nodes{email user{databaseId login}}}}}}}}}`;

interface CommitsPage {
  repository: {
    pullRequest: {
      headRefOid: string;
      commits: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { commit: CommitNode }[] };
    } | null;
  } | null;
}

function accountOf(u: { id: number; login: string; type: string }): Account {
  return { id: u.id, login: u.login, type: u.type === "Bot" ? "Bot" : u.type === "Organization" ? "Organization" : "User" };
}

export function acceptedSentences(config: Config): Set<string> {
  const out = new Set<string>();
  for (const v of config.accepted_versions) {
    const info = config.versions[String(v)];
    if (info) out.add(normalizeSentence(info.sentence));
  }
  return out;
}

export function isBotComment(c: IssueComment, appId: number): boolean {
  return c.user?.type === "Bot" && c.performed_via_github_app?.id === appId && c.body.startsWith(MARKER);
}

/**
 * Reads, without changing anything, who must sign a pull request and who
 * has: the opener, every commit author and co-author, less the exempt ids
 * and the accounts an entity covers on the commit's date, plus the openers
 * of other open pull requests with the same head commit (a check belongs to
 * a commit). Every fact comes from GitHub at this moment, and every page
 * of commits is checked against the head commit read first, so what is
 * assessed is that one commit (HeadMovedError otherwise).
 *
 * The opener is dated by the pull request's creation, every author by the
 * commit's authored date; the recorder (registry/cla.py) uses the same rule.
 */
export async function assess(gh: GitHub, registry: Registry, config: Config, repo: string, prNumber: number, token: string): Promise<Assessment> {
  const appId = Number(gh.env.APP_ID);
  const [owner, name] = repo.split("/") as [string, string];
  const pr = (await gh.request<PullRequest>("GET", `/repos/${repo}/pulls/${prNumber}`, { token })).data;
  const opener = accountOf(pr.user);
  const exemptIds = new Map(config.exempt.map((e) => [e.id, e.why]));
  const entities = await registry.entities();

  const authorsById = new Map<number, { account: Account; dates: string[] }>();
  const add = (a: Account, date: string) => {
    const hit = authorsById.get(a.id);
    if (hit) hit.dates.push(date);
    else authorsById.set(a.id, { account: a, dates: [date] });
  };
  add(opener, pr.created_at.slice(0, 10));

  const unknownCommits: string[] = [];
  let tooManyCommits = false;
  let cursor: string | null = null;
  let seen = 0;
  for (;;) {
    const page: CommitsPage = await gh.graphql<CommitsPage>(token, COMMITS_QUERY, { owner, name, number: prNumber, cursor });
    const pull = page.repository?.pullRequest;
    if (!pull?.commits) throw new GitHubError(200, "bad_response");
    if (pull.headRefOid !== pr.head.sha) throw new HeadMovedError();
    const commits = pull.commits;
    if (commits.totalCount > MAX_COMMITS) {
      tooManyCommits = true;
      break;
    }
    for (const { commit } of commits.nodes) {
      seen++;
      // Merge commits count like any other: a merge can carry changes of its own.
      const ca = commitAuthors(commit);
      if (ca.unidentified > 0 || ca.tooMany) unknownCommits.push(commit.oid.slice(0, 7));
      for (const a of ca.accounts) add(a, ca.date);
    }
    cursor = commits.pageInfo.hasNextPage ? commits.pageInfo.endCursor : null;
    // A page that is empty, or that does not say where the next one starts, ends the list whatever it promises.
    if (cursor === null || commits.nodes.length === 0 || seen >= MAX_COMMITS) {
      // Fewer commits seen than GitHub counts: the list was cut, so not every author is known.
      if (seen < commits.totalCount) tooManyCommits = true;
      break;
    }
  }

  if (pr.state === "open") {
    const open = await gh.paginate<PullRequest>(`/repos/${repo}/pulls?state=open`, { token }, 3);
    if (open.truncated) tooManyCommits = true;
    for (const other of open.items) {
      // The pull request itself is among them, opened by the same account on the same date.
      if (other.head.sha === pr.head.sha) add(accountOf(other.user), other.created_at.slice(0, 10));
    }
  }

  const required: Account[] = [];
  const exempt: Assessment["exempt"] = [];
  const entityCovered: Assessment["entityCovered"] = [];
  const unlistedBots: Assessment["unlistedBots"] = [];
  for (const { account, dates } of authorsById.values()) {
    const why = exemptIds.get(account.id);
    if (why !== undefined) {
      exempt.push({ account, why });
      continue;
    }
    const entity = dates.map((d) => coveringEntity(entities, config, account.id, d));
    if (entity.every((e) => e !== null)) {
      entityCovered.push({ account, entity: must(entity[0]).name });
      continue;
    }
    if (account.type !== "User") {
      unlistedBots.push({ login: account.login, commit: "" });
      continue;
    }
    required.push(account);
  }

  const signed = new Map<number, SignatureRecord>();
  for (const a of required) {
    const rec = await registry.signature(a.id);
    if (recordValid(config, rec)) signed.set(a.id, rec);
  }
  const missing = required.filter((a) => !signed.has(a.id));
  const missingIds = new Set(missing.map((a) => a.id));

  const sentences = acceptedSentences(config);
  const comments = await gh.paginate<IssueComment>(`/repos/${repo}/issues/${prNumber}/comments`, { token }, 5);
  let botComment: Assessment["botComment"] = null;
  const acceptances: Acceptance[] = [];
  for (const c of comments.items) {
    if (!botComment && isBotComment(c, appId)) botComment = { id: c.id, body: c.body };
    if (c.user?.type === "User" && missingIds.has(c.user.id) && sentences.has(normalizeSentence(c.body))) {
      acceptances.push({ commentId: c.id, commentUrl: c.html_url, account: c.user.id, createdAt: c.created_at, edited: c.updated_at !== c.created_at });
    }
  }

  return { repo, pr, opener, required, signed, missing, exempt, entityCovered, unknownCommits, unlistedBots, tooManyCommits, acceptances, botComment, commentsCut: comments.truncated };
}

/** Whether everything that blocks the check is cleared. */
export function allClear(a: Assessment): boolean {
  return a.missing.length === 0 && a.unknownCommits.length === 0 && a.unlistedBots.length === 0 && !a.tooManyCommits;
}
