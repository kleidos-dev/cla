// SPDX-License-Identifier: MIT
import type { Assessment, PullRequest } from "./assess";
import { CHECK_NAME, allClear, assess } from "./assess";
import type { ConfiguredEnv } from "./env";
import { allowedAccounts } from "./env";
import { GitHub, GitHubError, NotAllowedError } from "./github";
import { log } from "./log";
import type { QueueMessage } from "./messages";
import type { Config } from "./registry";
import { Registry } from "./registry";
import type { TextContext } from "./texts";
import { checkOutput, commentBody, signUrl } from "./texts";

export const RECORD_DELAYS = [20, 40, 80, 160, 320];
export const RELEASE_DELAYS = [30, 60, 120];
const RECORD_AFTER_MS = 5 * 60 * 1000;
const LATE_AFTER_MS = 10 * 60 * 1000;
const MAX_FILES = 3000;

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

/** Files under `.github/`, renames included; null when the list cannot be read completely. */
export async function touchesGithub(bot: Bot, repo: string, pr: PullRequest, token: string): Promise<boolean | null> {
  if ((pr.changed_files ?? 0) > MAX_FILES) return null;
  const files = await bot.gh.paginate<{ filename: string; previous_filename?: string }>(`/repos/${repo}/pulls/${pr.number}/files`, { token }, 30);
  if (files.truncated) return null;
  return files.items.some((f) => f.filename.startsWith(".github/") || (f.previous_filename ?? "").startsWith(".github/"));
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
    touchesGithub: false,
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
  const a = await assess(bot.gh, bot.registry, config, msg.repo, msg.pr, token);
  if (a.pr.state !== "open") {
    if (a.pr.merged) await send(bot.env, { kind: "coverage", repo: msg.repo, pr: msg.pr });
    log("evaluate closed", { repo: msg.repo, pr: msg.pr, outcome: a.pr.merged ? "merged" : "closed" });
    return;
  }
  const attempt = msg.attempt ?? 0;
  const now = Date.now();
  const late: number[] = [];
  let pendingRecord = false;
  for (const acc of a.acceptances) {
    const age = now - Date.parse(acc.createdAt);
    // Only a first look dispatches: the delayed re-checks that follow it just
    // watch for the record, so one acceptance means one recorder run per event.
    const asked = msg.record_comment === acc.commentId || age > RECORD_AFTER_MS;
    if (!acc.edited && attempt === 0 && asked) {
      await bot.registry.dispatchRecorder({ kind: "sign", repo: msg.repo, pr: msg.pr, comment_id: acc.commentId });
      log("recorder dispatched", { repo: msg.repo, pr: msg.pr, account: acc.account });
    }
    if (!acc.edited) pendingRecord = true;
    if (age > LATE_AFTER_MS) late.push(acc.account);
  }
  const clear = allClear(a);
  const github = clear ? await touchesGithub(bot, msg.repo, a.pr, token) : false;
  const ctx = await textContext(bot, config, a, { touchesGithub: github !== false, lateRecording: late });
  await upsertCheck(bot, a, ctx, token);
  await upsertComment(bot, a, ctx, token);
  if (clear && repoConf.auto_approve && github === false) {
    await send(bot.env, { kind: "release", repo: msg.repo, pr: msg.pr, sha: a.pr.head.sha });
  }
  if (!clear && pendingRecord && attempt < RECORD_DELAYS.length) {
    await send(bot.env, { kind: "evaluate", repo: msg.repo, pr: msg.pr, attempt: attempt + 1, ...(msg.record_comment ? { record_comment: msg.record_comment } : {}) }, RECORD_DELAYS[attempt]);
  }
  log("evaluated", { repo: msg.repo, pr: msg.pr, outcome: clear ? "success" : "action_required", count: a.missing.length, attempt });
}

/** Design section 9: approve the held runs of a pull request whose authors have all signed. */
export async function release(bot: Bot, msg: Extract<QueueMessage, { kind: "release" }>): Promise<void> {
  const config = await bot.registry.config();
  const repoConf = served(config, msg.repo);
  if (!repoConf?.auto_approve) return;
  const token = await bot.gh.token([msg.repo], { actions: "write", pull_requests: "read", checks: "read" });
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
  const github = await touchesGithub(bot, msg.repo, pr, token);
  if (github !== false) {
    log("release skipped", { repo: msg.repo, pr: msg.pr, reason: github === null ? "files_unreadable" : "touches_github" });
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
  if (inst.account && allowedAccounts(bot.env).has(inst.account.id)) return;
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

/** Every six hours: foreign installations, failed deliveries, open pull requests that are not green. */
export async function cron(bot: Bot): Promise<void> {
  const insts = await bot.gh.paginate<{ id: number; account: { id: number } | null }>("/app/installations", { jwt: true }, 3);
  for (const i of insts.items) if (!i.account || !allowedAccounts(bot.env).has(i.account.id)) await send(bot.env, { kind: "installation", installation: i.id });

  const since = Date.now() - 7 * 3600 * 1000;
  const deliveries = await bot.gh.request<{ id: number; guid: string; status_code: number; delivered_at: string; redelivery: boolean }[]>("GET", "/app/hook/deliveries?per_page=100", { jwt: true });
  const ok = new Set(deliveries.data.filter((d) => d.status_code >= 200 && d.status_code < 300).map((d) => d.guid));
  const failed = deliveries.data.filter((d) => !ok.has(d.guid) && !d.redelivery && Date.parse(d.delivered_at) > since);
  for (const d of failed.slice(0, 10)) await bot.gh.request("POST", `/app/hook/deliveries/${d.id}/attempts`, { jwt: true }).catch(() => undefined);

  const config = await bot.registry.config();
  for (const repo of Object.keys(config.served_repositories)) {
    try {
      const token = await bot.gh.token([repo], { pull_requests: "read" });
      const open = await bot.gh.paginate<PullRequest>(`/repos/${repo}/pulls?state=open`, { token }, 3);
      for (const pr of open.items) await send(bot.env, { kind: "evaluate", repo, pr: pr.number });
    } catch (e) {
      if (e instanceof NotAllowedError || (e instanceof GitHubError && e.kind === "not_found")) continue;
      throw e;
    }
  }
  log("cron done", { count: failed.length });
}
