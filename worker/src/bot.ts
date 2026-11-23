// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import type { Assessment, PullRequest } from "./assess";
import { CHECK_NAME, HeadMovedError, allClear, assess } from "./assess";
import type { ConfiguredEnv } from "./env";
import { allowedAccounts } from "./env";
import { GitHub, GitHubError, NotAllowedError } from "./github";
import { log } from "./log";
import type { QueueMessage } from "./messages";
import type { Config } from "./registry";
import { Registry } from "./registry";
import type { GithubState, TextContext } from "./texts";
import { checkOutput, commentBody, signUrl } from "./texts";

export const RECORD_DELAYS = [20, 40, 80, 160, 320];
export const RELEASE_DELAYS = [30, 60, 120];
const RECORD_AFTER_MS = 5 * 60 * 1000;
const LATE_AFTER_MS = 10 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
/** Labels of GitHub-hosted standard runners; any other label may be a self-hosted runner. */
const HOSTED_LABEL = /^(ubuntu|windows|macos)-[A-Za-z0-9._-]{1,40}$/;

export interface Bot {
  env: ConfiguredEnv;
  gh: GitHub;
  registry: Registry;
}

export function makeBot(env: ConfiguredEnv): Bot {
  const gh = new GitHub(env);
  return { env, gh, registry: new Registry(gh, env.REGISTRY_REPO) };
}

async function send(env: ConfiguredEnv, msg: QueueMessage, delaySeconds?: number): Promise<void> {
  await env.CLA_QUEUE.send(msg, delaySeconds ? { delaySeconds } : undefined);
}

function served(config: Config, repo: string): { auto_approve: boolean } | null {
  return config.served_repositories[repo] ?? null;
}

/** The `.github` entry of a commit's root tree (mode, type and object), null when there is none, undefined when it cannot be read. */
async function githubEntry(bot: Bot, repo: string, sha: string, token: string): Promise<string | null | undefined> {
  const t = (await bot.gh.request<{ truncated?: boolean; tree?: { path: string; mode: string; type: string; sha: string }[] }>("GET", `/repos/${repo}/git/trees/${sha}`, { token })).data;
  if (!Array.isArray(t.tree) || t.truncated) return undefined;
  const e = t.tree.find((x) => x.path === ".github");
  return e ? `${e.mode}:${e.type}:${e.sha}` : null;
}

/**
 * Whether the commit `sha` changes anything under `.github/` against its
 * merge base with `baseSha`. Read from the commit itself (the root trees of
 * the merge base and of `sha`), never from the pull request's live file
 * list, so a head that moves while this runs cannot change the answer for
 * `sha`. Renames out of `.github/` change the entry too. "unknown" when it
 * cannot be told.
 */
export async function githubState(bot: Bot, repo: string, baseSha: string, sha: string, token: string): Promise<GithubState> {
  try {
    const cmp = (await bot.gh.request<{ merge_base_commit?: { sha?: string } }>("GET", `/repos/${repo}/compare/${baseSha}...${sha}?per_page=1`, { token })).data;
    const base = cmp.merge_base_commit?.sha;
    if (!base || !SHA.test(base)) return "unknown";
    const before = await githubEntry(bot, repo, base, token);
    const after = await githubEntry(bot, repo, sha, token);
    if (before === undefined || after === undefined) return "unknown";
    return before === after ? "untouched" : "touched";
  } catch (e) {
    if (e instanceof GitHubError && (e.kind === "not_found" || e.kind === "unprocessable")) return "unknown";
    throw e;
  }
}

async function upsertCheck(bot: Bot, a: Assessment, ctx: TextContext, token: string): Promise<void> {
  const out = checkOutput(a, ctx);
  const sha = a.pr.head.sha;
  const existing = await bot.gh.request<{ check_runs: { id: number; app: { id: number } | null }[] }>(
    "GET",
    `/repos/${a.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${bot.env.APP_ID}&filter=latest`,
    { token },
  );
  const body = {
    name: CHECK_NAME,
    head_sha: sha,
    status: "completed",
    conclusion: out.conclusion,
    details_url: signUrl(ctx, a.repo, a.pr.number),
    external_id: `${a.pr.base.repo.id}#${a.pr.number}`,
    output: { title: out.title, summary: out.summary },
  };
  const run = existing.data.check_runs.find((r) => r.app?.id === Number(bot.env.APP_ID));
  if (run) await bot.gh.request("PATCH", `/repos/${a.repo}/check-runs/${run.id}`, { token }, body);
  else await bot.gh.request("POST", `/repos/${a.repo}/check-runs`, { token }, body);
}

async function upsertComment(bot: Bot, a: Assessment, ctx: TextContext, token: string): Promise<void> {
  if (allClear(a) && !a.botComment) return;
  const body = commentBody(a, ctx);
  if (a.botComment) {
    if (a.botComment.body !== body) await bot.gh.request("PATCH", `/repos/${a.repo}/issues/comments/${a.botComment.id}`, { token }, { body });
  } else {
    await bot.gh.request("POST", `/repos/${a.repo}/issues/${a.pr.number}/comments`, { token }, { body });
  }
}

export async function textContext(bot: Bot, config: Config, a: Assessment | null, extra: Partial<TextContext> = {}): Promise<TextContext> {
  const recordCommits = new Map<number, string | null>();
  if (a) for (const id of a.signed.keys()) recordCommits.set(id, await bot.registry.recordCommit(id).catch(() => null));
  return {
    origin: bot.env.PUBLIC_ORIGIN,
    registry: bot.env.REGISTRY_REPO,
    buildCommit: bot.env.BUILD_COMMIT,
    config,
    recordCommits,
    github: "untouched",
    autoApprove: false,
    lateRecording: [],
    now: new Date(),
    ...extra,
  };
}

/** Design section 8: one evaluation of one pull request. */
export async function evaluate(bot: Bot, msg: Extract<QueueMessage, { kind: "evaluate" }>): Promise<void> {
  const config = await bot.registry.config();
  const repoConf = served(config, msg.repo);
  if (!repoConf) {
    log("evaluate skipped", { repo: msg.repo, reason: "not_served" });
    return;
  }
  const token = await bot.gh.token([msg.repo], { pull_requests: "write", checks: "write", contents: "read" });
  let a: Assessment;
  try {
    a = await assess(bot.gh, bot.registry, config, msg.repo, msg.pr, token);
  } catch (e) {
    if (!(e instanceof HeadMovedError)) throw e;
    // Nothing is written for a head that moved mid-read; the new head is assessed shortly.
    await send(bot.env, msg, 15);
    log("evaluate deferred", { repo: msg.repo, pr: msg.pr, reason: "head_moved" });
    return;
  }
  if (a.pr.state !== "open") {
    if (a.pr.merged) await send(bot.env, { kind: "coverage", repo: msg.repo, pr: msg.pr });
    // A twin pull request with the same head may have been blocking the shared check: recompute the others now.
    await send(bot.env, { kind: "held", repo: msg.repo, sha: a.pr.head.sha });
    log("evaluate closed", { repo: msg.repo, pr: msg.pr, outcome: a.pr.merged ? "merged" : "closed" });
    return;
  }
  const attempt = msg.attempt ?? 0;
  const now = Date.now();
  const late = new Set<number>();
  let pendingRecord = false;
  // One recorder run per account and evaluation: the acceptance just posted, or else the earliest unedited one.
  const byAccount = new Map<number, Assessment["acceptances"][number]>();
  for (const acc of a.acceptances) {
    if (acc.edited) continue;
    pendingRecord = true;
    if (now - Date.parse(acc.createdAt) > LATE_AFTER_MS) late.add(acc.account);
    const chosen = byAccount.get(acc.account);
    if (!chosen || (acc.commentId === msg.record_comment && chosen.commentId !== msg.record_comment)) byAccount.set(acc.account, acc);
  }
  // A sign-in handed to the recorder posts no comment: the account the sign page named is waited for until its record shows.
  if (msg.await_signin && a.missing.some((m) => m.id === msg.await_signin)) pendingRecord = true;
  for (const acc of byAccount.values()) {
    // Only a first look dispatches: the delayed re-checks that follow it just watch for the record.
    const asked = msg.record_comment === acc.commentId || now - Date.parse(acc.createdAt) > RECORD_AFTER_MS;
    if (attempt === 0 && asked) {
      await bot.registry.dispatchRecorder({ kind: "sign", repo: msg.repo, pr: msg.pr, comment_id: acc.commentId });
      log("recorder dispatched", { repo: msg.repo, pr: msg.pr });
    }
  }
  const clear = allClear(a);
  const github: GithubState = clear ? await githubState(bot, msg.repo, a.pr.base.sha, a.pr.head.sha, token) : "untouched";
  const ctx = await textContext(bot, config, a, { github, autoApprove: repoConf.auto_approve, lateRecording: [...late] });
  await upsertCheck(bot, a, ctx, token);
  await upsertComment(bot, a, ctx, token);
  if (clear && repoConf.auto_approve && github === "untouched") {
    await send(bot.env, { kind: "release", repo: msg.repo, pr: msg.pr, sha: a.pr.head.sha });
  }
  if (!clear && pendingRecord && attempt < RECORD_DELAYS.length) {
    await send(
      bot.env,
      { kind: "evaluate", repo: msg.repo, pr: msg.pr, attempt: attempt + 1, ...(msg.record_comment ? { record_comment: msg.record_comment } : {}), ...(msg.await_signin ? { await_signin: msg.await_signin } : {}) },
      RECORD_DELAYS[attempt],
    );
  }
  log("evaluated", { repo: msg.repo, pr: msg.pr, outcome: clear ? "success" : "action_required", count: a.missing.length, attempt });
}

/** Whether a held run may target a self-hosted runner: any job whose labels are not all GitHub-hosted standard labels. */
async function mayRunSelfHosted(bot: Bot, repo: string, runId: number, token: string): Promise<boolean> {
  const jobs = (await bot.gh.request<{ jobs?: { labels?: string[]; runner_group_name?: string | null }[] }>("GET", `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, { token })).data.jobs ?? [];
  return jobs.some((j) => (j.labels ?? []).some((l) => !HOSTED_LABEL.test(l)) || (j.runner_group_name != null && j.runner_group_name !== "GitHub Actions"));
}

/**
 * Design section 9: approve the held runs of a pull request whose authors
 * have all signed. Every fact is pinned to `msg.sha`: the check on that
 * commit, the `.github/` comparison of that commit, the runs of that commit.
 */
export async function release(bot: Bot, msg: Extract<QueueMessage, { kind: "release" }>): Promise<void> {
  const config = await bot.registry.config();
  const repoConf = served(config, msg.repo);
  if (!repoConf?.auto_approve) return;
  const token = await bot.gh.token([msg.repo], { actions: "write", pull_requests: "read", checks: "read", contents: "read" });
  const pr = (await bot.gh.request<PullRequest>("GET", `/repos/${msg.repo}/pulls/${msg.pr}`, { token })).data;
  if (pr.state !== "open" || pr.head.sha !== msg.sha) {
    log("release skipped", { repo: msg.repo, pr: msg.pr, reason: "head_moved_or_closed" });
    return;
  }
  const checks = await bot.gh.request<{ check_runs: { conclusion: string | null; app: { id: number } | null }[] }>(
    "GET",
    `/repos/${msg.repo}/commits/${msg.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${bot.env.APP_ID}&filter=latest`,
    { token },
  );
  const mine = checks.data.check_runs.find((r) => r.app?.id === Number(bot.env.APP_ID));
  if (mine?.conclusion !== "success") {
    log("release skipped", { repo: msg.repo, pr: msg.pr, reason: "check_not_success" });
    return;
  }
  const github = await githubState(bot, msg.repo, pr.base.sha, msg.sha, token);
  if (github !== "untouched") {
    log("release skipped", { repo: msg.repo, pr: msg.pr, reason: github === "unknown" ? "github_unknown" : "touches_github" });
    return;
  }
  const runs = await bot.gh.request<{ workflow_runs: { id: number; head_sha: string; head_repository: { full_name: string } | null }[] }>(
    "GET",
    `/repos/${msg.repo}/actions/runs?head_sha=${msg.sha}&event=pull_request&status=action_required&per_page=100`,
    { token },
  );
  const fork = pr.head.repo?.full_name;
  const held = runs.data.workflow_runs.filter((r) => r.head_sha === msg.sha && fork && r.head_repository?.full_name === fork);
  for (const r of held) {
    if (await mayRunSelfHosted(bot, msg.repo, r.id, token)) {
      log("approve refused", { repo: msg.repo, pr: msg.pr, reason: "self_hosted" });
      continue;
    }
    try {
      await bot.gh.request("POST", `/repos/${msg.repo}/actions/runs/${r.id}/approve`, { token });
    } catch (e) {
      if (!(e instanceof GitHubError) || (e.kind !== "unprocessable" && e.kind !== "forbidden")) throw e;
      log("approve refused", { repo: msg.repo, pr: msg.pr, status: e.status });
    }
  }
  const attempt = msg.attempt ?? 0;
  if (held.length === 0 && attempt < RELEASE_DELAYS.length) {
    await send(bot.env, { kind: "release", repo: msg.repo, pr: msg.pr, sha: msg.sha, attempt: attempt + 1 }, RELEASE_DELAYS[attempt]);
  }
  log("released", { repo: msg.repo, pr: msg.pr, count: held.length, attempt });
}

/** A held run reported by workflow_run: find its open pull requests and evaluate them. */
export async function held(bot: Bot, msg: Extract<QueueMessage, { kind: "held" }>): Promise<void> {
  const config = await bot.registry.config();
  if (!served(config, msg.repo)) return;
  const token = await bot.gh.token([msg.repo], { pull_requests: "read" });
  const open = await bot.gh.paginate<PullRequest>(`/repos/${msg.repo}/pulls?state=open`, { token }, 3);
  for (const pr of open.items) if (pr.head.sha === msg.sha) await send(bot.env, { kind: "evaluate", repo: msg.repo, pr: pr.number });
}

export async function coverage(bot: Bot, msg: Extract<QueueMessage, { kind: "coverage" }>): Promise<void> {
  const config = await bot.registry.config();
  if (!served(config, msg.repo)) return;
  await bot.registry.dispatchRecorder({ kind: "coverage", repo: msg.repo, pr: msg.pr });
}

/** An installation on an account that is not on the allowlist is removed. */
export async function installation(bot: Bot, msg: Extract<QueueMessage, { kind: "installation" }>): Promise<void> {
  const inst = (await bot.gh.request<{ id: number; account: { id: number } | null }>("GET", `/app/installations/${msg.installation}`, { jwt: true })).data;
  // allowedAccounts throws on an empty allowlist, so a misconfiguration never removes anything.
  const allowed = allowedAccounts(bot.env);
  if (inst.account && allowed.has(inst.account.id)) return;
  await bot.gh.request("DELETE", `/app/installations/${msg.installation}`, { jwt: true });
  log("installation removed", { installation: msg.installation });
}

export async function handleMessage(bot: Bot, msg: QueueMessage): Promise<void> {
  switch (msg.kind) {
    case "evaluate":
      return evaluate(bot, msg);
    case "release":
      return release(bot, msg);
    case "held":
      return held(bot, msg);
    case "coverage":
      return coverage(bot, msg);
    case "installation":
      return installation(bot, msg);
  }
}

const MAX_REDELIVERIES = 50;
const COVERAGE_WINDOW_MS = 7 * 86400 * 1000;
const COVERAGE_SETTLE_MS = 30 * 60 * 1000;

/**
 * Every six hours: foreign installations, failed deliveries, open pull
 * requests that are not green, and merged pull requests whose coverage
 * record is missing (a recorder run that failed or never started).
 */
export async function cron(bot: Bot): Promise<void> {
  const allowed = allowedAccounts(bot.env);
  const insts = await bot.gh.paginate<{ id: number; account: { id: number } | null }>("/app/installations", { jwt: true }, 3);
  for (const i of insts.items) if (!i.account || !allowed.has(i.account.id)) await send(bot.env, { kind: "installation", installation: i.id });

  const since = Date.now() - 7 * 3600 * 1000;
  const deliveries = await bot.gh.paginate<{ id: number; guid: string; status_code: number; delivered_at: string; redelivery: boolean }>("/app/hook/deliveries", { jwt: true }, 5);
  const ok = new Set(deliveries.items.filter((d) => d.status_code >= 200 && d.status_code < 300).map((d) => d.guid));
  const failed = deliveries.items.filter((d) => !ok.has(d.guid) && !d.redelivery && Date.parse(d.delivered_at) > since);
  const retried = new Set<string>();
  for (const d of failed) {
    if (retried.size >= MAX_REDELIVERIES) break;
    if (retried.has(d.guid)) continue;
    retried.add(d.guid);
    await bot.gh.request("POST", `/app/hook/deliveries/${d.id}/attempts`, { jwt: true }).catch(() => undefined);
  }

  const config = await bot.registry.config();
  const coverageFrom = config.coverage_from ?? "";
  let missingCoverage = 0;
  for (const repo of Object.keys(config.served_repositories)) {
    try {
      const token = await bot.gh.token([repo], { pull_requests: "read" });
      const open = await bot.gh.paginate<PullRequest>(`/repos/${repo}/pulls?state=open`, { token }, 3);
      for (const pr of open.items) await send(bot.env, { kind: "evaluate", repo, pr: pr.number });
      const closed = await bot.gh.request<{ number: number; merged_at: string | null }[]>("GET", `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, { token });
      const now = Date.now();
      const merged = closed.data.filter((p) => p.merged_at && now - Date.parse(p.merged_at) < COVERAGE_WINDOW_MS && now - Date.parse(p.merged_at) > COVERAGE_SETTLE_MS && p.merged_at.slice(0, 10) >= coverageFrom);
      if (merged.length) {
        const have = await bot.registry.coverageNumbers(repo);
        for (const p of merged) {
          if (have.has(p.number)) continue;
          missingCoverage++;
          await send(bot.env, { kind: "coverage", repo, pr: p.number });
        }
      }
    } catch (e) {
      if (e instanceof NotAllowedError || (e instanceof GitHubError && e.kind === "not_found")) continue;
      throw e;
    }
  }
  log("cron done", { count: retried.size, outcome: `coverage_${missingCoverage}` });
}
