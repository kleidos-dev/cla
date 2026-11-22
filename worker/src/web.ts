// SPDX-License-Identifier: MIT
import { AGREEMENT_VERSION, FILES, NOTICES, checkIntegrity } from "./agreement";
import type { Assessment } from "./assess";
import { HeadMovedError, acceptedSentences, assess } from "./assess";
import type { Bot } from "./bot";
import type { ConfiguredEnv } from "./env";
import { GitHubError, NotAllowedError, WEB } from "./github";
import { escapeHtml, messagePage, page, redirect } from "./html";
import type { Keys } from "./keys";
import { csrfToken, csrfVerify } from "./keys";
import { log } from "./log";
import { renderMarkdown } from "./markdown";
import type { Config, SignatureRecord } from "./registry";
import { recordValid } from "./registry";
import type { Session } from "./session";
import { OAUTH_COOKIE, OAUTH_TTL, SESSION_COOKIE, SESSION_TTL, clearCookie, readSession, readTransaction, sessionCookie, transactionCookie } from "./session";
import { b64urlEncode, clientIp, isLogin, normalizeSentence, nowSeconds, randomB64url, readCapped, safeEqual, utf8 } from "./util";

export const MAX_FORM_BYTES = 4096;
const SIGN_PATH = /^\/sign\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/([1-9][0-9]{0,9})$/;

export interface Target {
  repo: string;
  pr: number;
  path: string;
}

export function parseSignPath(path: string): Target | null {
  const m = SIGN_PATH.exec(path);
  if (!m || m[2] === "." || m[2] === "..") return null;
  const pr = Number(m[3]);
  if (!Number.isSafeInteger(pr) || pr > 2_147_483_647) return null;
  return { repo: `${m[1]}/${m[2]}`, pr, path: `/sign/${m[1]}/${m[2]}/${pr}` };
}

/** The acceptance sentence of a version, built from its digest: what the signer ticks is what is posted. */
export function sentenceFor(version: number, setSha256: string): string {
  return `I have read and I accept the Kleidos Contributor Agreement, version ${version} (SHA-256 ${setSha256.slice(0, 12)}), made of the Contributor Agreement text and its Addendum. I understand that it lets José M. Requena Plens license my contributions under other terms as well, including paid commercial licences. I am of legal age and I am entitled to license what I contribute.`;
}

/** Signing is on only when the registry's current version, digest and sentence are the ones bundled here. */
export async function signingState(config: Config | null): Promise<{ on: boolean; reason?: string; setSha256: string }> {
  const integrity = await checkIntegrity();
  if (!integrity.ok) return { on: false, reason: "bundled texts do not match SHA256SUMS", setSha256: integrity.setSha256 };
  if (!config) return { on: false, reason: "registry not read", setSha256: integrity.setSha256 };
  const v = config.versions[String(config.current_version)];
  if (config.current_version !== AGREEMENT_VERSION || !v || v.set_sha256 !== integrity.setSha256 || v.sentence !== sentenceFor(AGREEMENT_VERSION, integrity.setSha256)) {
    return { on: false, reason: "version skew between the registry and this deployment", setSha256: integrity.setSha256 };
  }
  return { on: true, setSha256: integrity.setSha256 };
}

function prLink(t: Target): string {
  return `<a href="${WEB}/${escapeHtml(t.repo)}/pull/${t.pr}">${escapeHtml(t.repo)}#${t.pr}</a>`;
}

function filesUrl(env: ConfiguredEnv | { BUILD_COMMIT: string; REGISTRY_REPO: string }): string {
  const ref = /^[0-9a-f]{40}$/.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT : "main";
  return `https://github.com/${env.REGISTRY_REPO}/tree/${ref}/agreements/v${AGREEMENT_VERSION}`;
}

async function versionLine(env: { BUILD_COMMIT: string; REGISTRY_REPO: string }): Promise<string> {
  const { setSha256 } = await checkIntegrity();
  const commit = /^[0-9a-f]{40}$/.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT.slice(0, 12) : "main";
  return `<p class="meta">Version ${AGREEMENT_VERSION} · SHA-256 <code>${setSha256}</code> · from <a href="${filesUrl(env)}">${escapeHtml(env.REGISTRY_REPO)}@<code>${escapeHtml(commit)}</code></a> · download: <a href="/agreement/v${AGREEMENT_VERSION}/individual.md" download>individual.md</a>, <a href="/agreement/v${AGREEMENT_VERSION}/addendum.md" download>addendum.md</a>, <a href="/agreement/v${AGREEMENT_VERSION}/SHA256SUMS" download>SHA256SUMS</a></p>`;
}

const SUMMARY = `<div class="box"><ul>
<li><strong>You keep</strong> your copyright and every right in your work.</li>
<li><strong>You grant</strong> José M. Requena Plens a non-exclusive licence, free of charge, to publish your contribution under the project's open-source licence and to license it under other terms.</li>
<li><strong>That includes paid commercial licences</strong> (commercial exceptions); each version that contains your contribution also stays available under an open-source licence (Addendum, clause 10).</li>
</ul></div>
<p lang="es">El texto que obliga es el inglés. <a href="/agreement/es">Resumen en español y traducción del Anexo</a>.</p>`;

function agreementText(kind: "individual" | "entity"): string {
  const opts = { headingShift: 1 };
  return `<section class="text" aria-label="Contributor Agreement">${renderMarkdown(FILES[`${kind}.md`]!, opts)}</section>
<section class="text" aria-label="Addendum">${renderMarkdown(FILES["addendum.md"]!, opts)}</section>`;
}

const BEFORE = `<h2 id="before">Before you accept</h2>
<ul>
<li>When you click "I agree", the acceptance sentence is posted as a comment on the pull request under your GitHub account. That comment is your signature, and the public register at <a href="https://github.com/kleidos-dev/cla">kleidos-dev/cla</a> records it.</li>
<li>Nothing is posted until you press the button. If you make a mistake afterwards, write to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.</li>
<li>The agreement can only be concluded in English. The Spanish texts are for information.</li>
<li>If you are signing for your employer or another organization, or you are under 18, do not sign here: see <a href="https://github.com/kleidos-dev/cla#who-signs">who signs</a>.</li>
</ul>
<p class="meta"><strong>Your data.</strong> José M. Requena Plens records your GitHub account id and login, the version you accepted, the time and a link to your acceptance comment. The record is public. No email, real name or IP address is stored. One cookie keeps you signed in for up to an hour. <a href="/privacy">Privacy notice</a>.</p>`;

const GITHUB_SCREEN = `<p class="meta">GitHub will ask you to authorize <strong>kleidos-cla</strong> and will list "Verify your GitHub identity", "Know which resources you can access" and "Act on your behalf": GitHub shows these lines for every GitHub App. This app reads your account id and login, and posts one acceptance line on this pull request when you click "I agree". The permission is revoked as soon as that is done.</p>`;

function signInLink(t: Target, label = "Sign in with GitHub to accept", sw = false): string {
  return `<p><a class="button" href="/auth/login?return=${encodeURIComponent(t.path)}${sw ? "&amp;switch=1" : ""}">${escapeHtml(label)}</a></p>`;
}

function whoami(s: Session, t: Target, logoutCsrf: string): string {
  return `<p>Signed in as <strong>@${escapeHtml(s.login)}</strong> (GitHub account id ${s.id}). Not you? <a href="/auth/login?return=${encodeURIComponent(t.path)}&amp;switch=1">Switch account</a></p>
<form class="inline" method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${logoutCsrf}"><button class="link" type="submit">Sign out</button></form>`;
}

async function signForm(s: Session, t: Target, keys: Keys, setSha256: string): Promise<string> {
  const csrf = await csrfToken(keys.csrf, [s.sid, "agree", `${t.repo}#${t.pr}`, String(AGREEMENT_VERSION)]);
  const [owner, repo] = t.repo.split("/") as [string, string];
  const sentence = sentenceFor(AGREEMENT_VERSION, setSha256);
  return `<h2 id="accept">Accept</h2>
<form method="post" action="/agree">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="owner" value="${escapeHtml(owner)}"> <input type="hidden" name="repo" value="${escapeHtml(repo)}">
<input type="hidden" name="pr" value="${t.pr}"> <input type="hidden" name="version" value="${AGREEMENT_VERSION}">
<input type="hidden" name="set_sha256" value="${setSha256}">
<p id="post-note">When you click the button, the line beside the checkbox is posted as a comment on pull request ${escapeHtml(t.repo)}#${t.pr} under your account @${escapeHtml(s.login)}. That comment is your signature.</p>
<p class="accept"><input type="checkbox" id="accept" name="accept" value="yes" required aria-describedby="post-note">
<label for="accept">${escapeHtml(sentence)}</label></p>
<p><button type="submit">I agree: post my acceptance on the pull request</button></p>
</form>`;
}

type SignerStatus = "must_sign" | "signed" | "exempt" | "entity" | "not_author" | "closed" | "locked" | "not_user" | "private";

async function signerStatus(bot: Bot, config: Config, t: Target, account: { id: number; type: string }): Promise<{ status: SignerStatus; a: Assessment; record?: SignatureRecord; entity?: string }> {
  const token = await bot.gh.token([t.repo], { pull_requests: "read", contents: "read" });
  const a = await assess(bot.gh, bot.registry, config, t.repo, t.pr, token);
  if (a.pr.base.repo.private) return { status: "private", a };
  if (a.pr.state !== "open") return { status: "closed", a };
  if (a.pr.locked) return { status: "locked", a };
  if (account.type !== "User") return { status: "not_user", a };
  if (a.exempt.some((e) => e.account.id === account.id)) return { status: "exempt", a };
  const ent = a.entityCovered.find((e) => e.account.id === account.id);
  if (ent) return { status: "entity", a, entity: ent.entity };
  const rec = a.signed.get(account.id);
  if (rec) return { status: "signed", a, record: rec };
  if (a.missing.some((m) => m.id === account.id)) return { status: "must_sign", a };
  return { status: "not_author", a };
}

function guard<T>(fn: () => Promise<T>): Promise<T | Response> {
  return fn().catch(async (e: unknown) => {
    if (e instanceof NotAllowedError) return messagePage(404, "Not served", "This repository is not served by the Kleidos CLA bot.");
    if (e instanceof HeadMovedError) return messagePage(503, "The pull request changed", "The pull request received new commits while it was being read. Nothing was posted. Reload this page.");
    if (e instanceof GitHubError) {
      log("github error", { status: e.status, reason: e.kind, request_id: e.requestId });
      if (e.kind === "rate_limited") return messagePage(429, "GitHub is rate limiting", "GitHub asked us to slow down. Wait a minute and reload this page.");
      if (e.kind === "not_found") return messagePage(404, "Not found", "GitHub does not know this pull request.");
      return messagePage(503, "GitHub unavailable", "GitHub did not answer as expected. Nothing was posted. Wait a minute and reload this page.");
    }
    throw e;
  });
}

async function servedTarget(bot: Bot, path: string): Promise<{ t: Target; config: Config } | null> {
  const t = parseSignPath(path);
  if (!t) return null;
  const config = await bot.registry.config();
  if (!config.served_repositories[t.repo]) return null;
  return { t, config };
}

export async function signPage(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys, path: string): Promise<Response> {
  if (!(await env.RL_SIGN.limit({ key: clientIp(req) })).success) return messagePage(429, "Too many requests", "Too many requests from your network. Wait a minute and reload this page.");
  let replaced: string | null = null;
  const r = await guard(async () => {
    const st = await servedTarget(bot, path);
    if (!st) return messagePage(404, "Not found", "There is no pull request to sign for at this address.");
    const { t, config } = st;
    const session = await readSession(req, keys);
    const signing = await signingState(config);
    const head = `<h1>Kleidos Contributor Agreement</h1>\n<p>Pull request ${prLink(t)}</p>`;
    const off = signing.on ? "" : `<div class="box alert" role="alert"><p>The agreement is being updated, so signing is paused for a moment. The checks keep working. Come back later, or write to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.</p></div>`;
    if (!session) {
      return page(`${head}\n${off}\n${SUMMARY}\n${await versionLine(env)}\n<p><a href="#before">Jump to the acceptance</a></p>\n${signing.on ? signInLink(t) + GITHUB_SCREEN : ""}\n${agreementText("individual")}\n${BEFORE}\n${signing.on ? signInLink(t) : ""}`, { title: `Sign the Kleidos Contributor Agreement · ${t.repo}#${t.pr}` });
    }
    const logoutCsrf = await csrfToken(keys.csrf, [session.sid, "logout"]);
    let notice = "";
    if (session.pending && session.pending.repo === t.repo && session.pending.pr === t.pr) {
      const rec = await bot.registry.signature(session.id);
      const recorded = recordValid(config, rec);
      if (recorded || (await acceptanceStands(bot, config, t, session.id, session.pending.comment_id))) {
        const commit = recorded ? await bot.registry.recordCommit(session.id).catch(() => null) : null;
        const path2 = `signatures/individual/${session.id}.json`;
        const entry = recorded
          ? `<a href="https://github.com/${escapeHtml(env.REGISTRY_REPO)}/blob/${commit ?? "signatures"}/${path2}">${path2}</a>`
          : `being recorded, usually within a minute. <a href="${escapeHtml(t.path)}">Check again</a>`;
        return page(
          `<h1>Your acceptance</h1>
<div class="box ok" role="status">
<p>You accepted the Kleidos Contributor Agreement.</p>
<ul>
<li>Account: @${escapeHtml(session.login)} (GitHub account id ${session.id})</li>
<li>Version ${AGREEMENT_VERSION}, SHA-256 <code>${signing.setSha256}</code></li>
<li>Accepted (UTC): ${escapeHtml(recorded ? rec.accepted_at : session.pending.at)}</li>
<li>Acceptance comment: <a href="${escapeHtml(session.pending.comment_url)}">${escapeHtml(session.pending.comment_url)}</a></li>
<li>Register entry: ${entry}</li>
</ul>
</div>
<p>This page is your confirmation: save or print it. The full text you accepted stays at <a href="/agreement">cla.kleidos.dev/agreement</a>, and the check on ${prLink(t)} turns green by itself once the entry is recorded.</p>
${whoami(session, t, logoutCsrf)}`,
          { title: "Your acceptance · Kleidos Contributor Agreement" },
        );
      }
      // The acceptance comment was edited or deleted, so the recorder will refuse it: say so and let the signer sign again.
      const rest: Session = { ...session };
      delete rest.pending;
      replaced = await sessionCookie(keys, rest);
      notice = `<div class="box alert" role="alert"><p>Your acceptance comment on this pull request was edited or deleted, so it cannot be recorded. Nothing is kept from it. To accept, sign in again below.</p></div>`;
    }
    const s = await signerStatus(bot, config, t, session);
    const who = notice + whoami(session, t, logoutCsrf);
    switch (s.status) {
      case "private":
        return messagePage(404, "Not found", "There is no pull request to sign for at this address.");
      case "closed":
        return messagePage(409, "Pull request closed", "This pull request is closed, so there is nothing to sign on it. Open or reopen a pull request and follow its link.", { href: `${WEB}/${t.repo}/pull/${t.pr}`, label: "Back to the pull request" });
      case "locked":
        return messagePage(409, "Pull request locked", "This pull request is locked, so no acceptance can be posted on it. Write to mail@kleidos.dev.", { href: `${WEB}/${t.repo}/pull/${t.pr}`, label: "Back to the pull request" });
      case "not_user":
        return page(`${head}\n<div class="box alert" role="alert"><p>Only a personal account can sign. @${escapeHtml(session.login)} is not one.</p></div>\n${who}`, { title: "Only a personal account can sign", status: 403 });
      case "exempt":
        return page(`${head}\n<div class="box ok" role="status"><p>@${escapeHtml(session.login)} is on the Kleidos exemption list: nothing to sign.</p></div>\n${who}`, { title: "Nothing to sign" });
      case "entity":
        return page(`${head}\n<div class="box ok" role="status"><p>@${escapeHtml(session.login)} is covered by the agreement of ${escapeHtml(s.entity ?? "an entity")}: nothing to sign.</p></div>\n${who}`, { title: "Nothing to sign" });
      case "signed":
        await env.CLA_QUEUE.send({ kind: "evaluate", repo: t.repo, pr: t.pr });
        return page(
          `${head}\n<div class="box ok" role="status"><p>You accepted version ${s.record!.version} on ${escapeHtml(s.record!.accepted_at.slice(0, 10))}. Nothing to do: the pull request is being checked again. <a href="https://github.com/${escapeHtml(env.REGISTRY_REPO)}/blob/signatures/signatures/individual/${session.id}.json">Register entry</a>.</p></div>\n${who}`,
          { title: "Already signed" },
        );
      case "not_author":
        return page(`${head}\n<div class="box" role="status"><p>@${escapeHtml(session.login)} is not listed as an author of this pull request, so there is nothing to sign here.</p></div>\n${who}`, { title: "Nothing to sign here" });
      case "must_sign": {
        const canSign = signing.on && session.token && session.for === `${t.repo}#${t.pr}`;
        const action = canSign ? await signForm(session, t, keys, signing.setSha256) : signing.on ? signInLink(t, "Sign in with GitHub again to accept") : "";
        return page(`${head}\n${who}\n${off}\n${SUMMARY}\n${await versionLine(env)}\n<p><a href="#accept">Jump to the acceptance</a></p>\n${agreementText("individual")}\n${BEFORE}\n${action}`, { title: `Sign the Kleidos Contributor Agreement · ${t.repo}#${t.pr}` });
      }
    }
  });
  if (replaced) r.headers.append("set-cookie", replaced);
  return r;
}

/** Whether an acceptance comment still exists, is the account's own, unedited, and is an accepted sentence: what the recorder will check. */
async function acceptanceStands(bot: Bot, config: Config, t: Target, account: number, commentId: number): Promise<boolean> {
  const token = await bot.gh.token([t.repo], { pull_requests: "read" });
  try {
    const c = (await bot.gh.request<{ body: string; created_at: string; updated_at: string; user: { id: number } | null }>("GET", `/repos/${t.repo}/issues/comments/${commentId}`, { token })).data;
    return c.user?.id === account && c.updated_at === c.created_at && acceptedSentences(config).has(normalizeSentence(c.body));
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not_found") return false;
    throw e;
  }
}

async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
}

export async function login(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys, url: URL): Promise<Response> {
  if (!(await env.RL_AUTH.limit({ key: clientIp(req) })).success) return messagePage(429, "Too many requests", "Too many sign-in attempts from your network. Wait a minute and try again.");
  const ret = url.searchParams.get("return") ?? "";
  const st = await guard(() => servedTarget(bot, ret));
  if (st instanceof Response) return st;
  if (!st || st.t.path !== ret) return messagePage(400, "Bad link", "This sign-in link is not valid. Go back to the pull request and follow its link again.");
  const t: { state: string; verifier: string } = { state: randomB64url(32), verifier: randomB64url(32) };
  const authorize = new URL(`${WEB}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", env.CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/auth/callback`);
  authorize.searchParams.set("state", t.state);
  authorize.searchParams.set("code_challenge", await pkceChallenge(t.verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");
  if (url.searchParams.get("switch") === "1") authorize.searchParams.set("prompt", "select_account");
  const cookie = await transactionCookie(keys, { v: 1, state: t.state, verifier: t.verifier, return: st.t.path, exp: nowSeconds() + OAUTH_TTL });
  return redirect(authorize.toString(), 302, [cookie]);
}

async function revokeGrant(env: ConfiguredEnv, bot: Bot, token: string): Promise<void> {
  try {
    await bot.gh.request("DELETE", `/applications/${env.CLIENT_ID}/grant`, { basic: [env.CLIENT_ID, env.CLIENT_SECRET] }, { access_token: token });
  } catch (e) {
    log("grant revocation failed", { status: e instanceof GitHubError ? e.status : 0 });
  }
}

export async function callback(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys, url: URL): Promise<Response> {
  if (!(await env.RL_AUTH.limit({ key: clientIp(req) })).success) return messagePage(429, "Too many requests", "Too many sign-in attempts from your network. Wait a minute and try again.");
  const clear = clearCookie(OAUTH_COOKIE);
  const tx = await readTransaction(req, keys);
  if (!tx) return messagePage(400, "Session expired", "The sign-in took too long or was already used. Go back to the pull request and follow its link again.", undefined, [clear]);
  const back = { href: tx.return, label: "Back to the sign page" };
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  // The state is compared before anything else, the error branch included:
  // a redirect that did not come from this sign-in leaves it untouched.
  if (!safeEqual(state, tx.state)) {
    log("oauth refused", { reason: "state" });
    return messagePage(400, "Sign-in refused", "This sign-in did not start here. Nothing was signed. Follow the pull request's link again.", url.searchParams.get("error") ? back : undefined);
  }
  if (url.searchParams.get("error")) return messagePage(400, "Authorization cancelled", "GitHub's authorization was cancelled, so nothing was signed or posted.", back, [clear]);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return messagePage(400, "Sign-in refused", "GitHub's answer was not valid. Follow the pull request's link again.", undefined, [clear]);
  const r = await guard(async () => {
    const st = await servedTarget(bot, tx.return);
    if (!st) return messagePage(400, "Bad link", "This sign-in link is not valid.", undefined, [clear]);
    const repoToken = await bot.gh.token([st.t.repo], { pull_requests: "read", contents: "read" });
    const repo = (await bot.gh.request<{ id: number; private: boolean }>("GET", `/repos/${st.t.repo}`, { token: repoToken })).data;
    if (repo.private) return messagePage(404, "Not found", "There is no pull request to sign for at this address.", undefined, [clear]);
    const exchange = await fetch(`${WEB}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "kleidos-cla" },
      body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`, code_verifier: tx.verifier, repository_id: repo.id }),
    });
    const body = (await exchange.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!exchange.ok || !body.access_token || body.error) {
      log("oauth exchange refused", { status: exchange.status, reason: typeof body.error === "string" ? body.error.slice(0, 40) : "none" });
      return messagePage(400, "Sign-in refused", "GitHub did not accept this sign-in (it may have been used already). Follow the pull request's link again.", back, [clear]);
    }
    const token = body.access_token;
    const user = (await bot.gh.request<{ id: number; login: string; type: string }>("GET", "/user", { token })).data;
    if (!isLogin(user.login) || typeof user.id !== "number") {
      await revokeGrant(env, bot, token);
      return messagePage(400, "Sign-in refused", "GitHub's answer was not valid.", undefined, [clear]);
    }
    const s = await signerStatus(bot, st.config, st.t, user);
    const keep = s.status === "must_sign";
    if (!keep) await revokeGrant(env, bot, token);
    const session: Session = { v: 1, sid: randomB64url(16), id: user.id, login: user.login, type: user.type, exp: nowSeconds() + SESSION_TTL, ...(keep ? { token, for: `${st.t.repo}#${st.t.pr}` } : {}) };
    log("signed in", { repo: st.t.repo, pr: st.t.pr, outcome: s.status });
    return redirect(st.t.path, 303, [clear, await sessionCookie(keys, session)]);
  });
  return r;
}

function sameOrigin(req: Request, env: ConfiguredEnv): boolean {
  if (req.headers.get("origin") !== env.PUBLIC_ORIGIN) return false;
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const buf = await readCapped(req, MAX_FORM_BYTES);
  if (!buf) return null;
  return new URLSearchParams(new TextDecoder().decode(buf));
}

export async function logout(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(403, "Refused", "This form did not come from cla.kleidos.dev.");
  const form = await readForm(req);
  const session = await readSession(req, keys);
  if (!form || !session) return redirect("/agreement", 303, [clearCookie(SESSION_COOKIE)]);
  if (!(await csrfVerify(keys.csrf, [session.sid, "logout"], form.get("csrf") ?? ""))) return messagePage(403, "Refused", "This form is out of date. Reload the page and try again.");
  if (session.token) await revokeGrant(env, bot, session.token);
  return redirect("/agreement", 303, [clearCookie(SESSION_COOKIE)]);
}

/** Design 6.3: the signature. Stops at the first failure with nothing posted. */
export async function agree(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(403, "Refused", "This form did not come from cla.kleidos.dev, so nothing was posted.");
  const form = await readForm(req);
  if (!form) return messagePage(400, "Refused", "The form could not be read, so nothing was posted. Reload the page and try again.");
  const session = await readSession(req, keys);
  if (!session) return messagePage(401, "Session expired", "Your sign-in has expired, so nothing was posted. Go back to the pull request and follow its link again.");
  const t = parseSignPath(`/sign/${form.get("owner") ?? ""}/${form.get("repo") ?? ""}/${form.get("pr") ?? ""}`);
  if (!t) return messagePage(400, "Refused", "The form is not valid, so nothing was posted.");
  const version = Number(form.get("version"));
  const csrfOk = await csrfVerify(keys.csrf, [session.sid, "agree", `${t.repo}#${t.pr}`, String(version)], form.get("csrf") ?? "");
  if (!csrfOk) {
    log("agree refused", { reason: "csrf" });
    return messagePage(403, "Refused", "This form is out of date or was not made for you, so nothing was posted. Reload the sign page and try again.", { href: t.path, label: "Back to the sign page" });
  }
  if (form.get("accept") !== "yes") return messagePage(400, "Not accepted", "The box was not ticked, so nothing was posted.", { href: t.path, label: "Back to the sign page" });
  if (!session.token || session.for !== `${t.repo}#${t.pr}`) return messagePage(401, "Sign in again", "Sign in again on this pull request's page to accept. Nothing was posted.", { href: t.path, label: "Back to the sign page" });
  const r = await guard(async () => {
    const config = await bot.registry.config();
    if (!config.served_repositories[t.repo]) return messagePage(404, "Not served", "This repository is not served by the Kleidos CLA bot.");
    const signing = await signingState(config);
    if (!signing.on) return messagePage(503, "Signing paused", "The agreement is being updated, so signing is paused. Nothing was posted. Try again later.");
    if (version !== AGREEMENT_VERSION || form.get("set_sha256") !== signing.setSha256) return messagePage(409, "The agreement changed", "The text on your page is not the current one, so nothing was posted. Reload the sign page.", { href: t.path, label: "Back to the sign page" });
    if (!(await env.RL_AGREE_IP.limit({ key: clientIp(req) })).success || !(await env.RL_AGREE_ACCOUNT.limit({ key: String(session.id) })).success) {
      return messagePage(429, "Too many requests", "Too many attempts. Wait a minute and try again. Nothing was posted.");
    }
    const s = await signerStatus(bot, config, t, session);
    if (s.status !== "must_sign") {
      log("agree refused", { reason: s.status, repo: t.repo, pr: t.pr });
      const why: Record<string, [number, string]> = {
        closed: [409, "This pull request is closed, so nothing was posted."],
        locked: [409, "This pull request is locked, so nothing was posted."],
        private: [404, "There is no pull request to sign for at this address."],
        not_user: [403, "Only a personal account can sign. Nothing was posted."],
        signed: [409, "You have already accepted this agreement. Nothing was posted."],
      };
      const [status, sentence] = why[s.status] ?? [403, `@${session.login} does not need to sign on this pull request, so nothing was posted.`];
      return messagePage(status, "Nothing posted", sentence, { href: t.path, label: "Back to the sign page" });
    }
    const confirm = async (c: { id: number; html_url: string; created_at: string }, queue: boolean): Promise<Response> => {
      const next: Session = { v: 1, sid: session.sid, id: session.id, login: session.login, type: session.type, exp: session.exp, pending: { repo: t.repo, pr: t.pr, comment_id: c.id, comment_url: c.html_url, at: c.created_at } };
      if (queue) {
        try {
          await env.CLA_QUEUE.send({ kind: "evaluate", repo: t.repo, pr: t.pr, record_comment: c.id });
        } catch {
          log("enqueue failed", { repo: t.repo, pr: t.pr });
        }
      }
      return redirect(t.path, 303, [await sessionCookie(keys, next)]);
    };
    // A second submission (a double click, a reload of the post) finds the first acceptance and confirms it.
    const already = (assessed: Assessment) => assessed.acceptances.find((x) => x.account === session.id && !x.edited);
    const earlier = already(s.a);
    if (earlier) {
      await revokeGrant(env, bot, session.token!);
      return confirm({ id: earlier.commentId, html_url: earlier.commentUrl, created_at: earlier.createdAt }, false);
    }
    const sentence = sentenceFor(AGREEMENT_VERSION, signing.setSha256);
    let posted: { id: number; html_url: string; created_at: string };
    try {
      posted = (await bot.gh.request<{ id: number; html_url: string; created_at: string }>("POST", `/repos/${t.repo}/issues/${t.pr}/comments`, { token: session.token! }, { body: sentence })).data;
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "unauthorized" || e.kind === "forbidden" || e.kind === "not_found")) {
        log("agree refused", { reason: "github_" + e.kind, repo: t.repo, pr: t.pr });
        // The grant may have been revoked by a first submission that did post: look before saying nothing was posted.
        const again = already((await signerStatus(bot, config, t, session)).a);
        if (again) return confirm({ id: again.commentId, html_url: again.commentUrl, created_at: again.createdAt }, false);
        return messagePage(401, "Sign in again", "GitHub did not accept the comment with your sign-in (it may have expired or been revoked). Nothing was posted.", { href: t.path, label: "Back to the sign page" }, [clearCookie(SESSION_COOKIE)]);
      }
      throw e;
    }
    await revokeGrant(env, bot, session.token!);
    log("signed", { repo: t.repo, pr: t.pr });
    return confirm(posted, true);
  });
  return r;
}

export function agreementPage(kind: "individual" | "entity", env: { BUILD_COMMIT: string; REGISTRY_REPO: string }): Promise<Response> {
  return (async () => {
    const entityNote =
      kind === "entity"
        ? `<div class="box"><p>The entity version is signed outside this site: as a PDF with an electronic signature, or by email from the entity's domain to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>, with the list of the GitHub account ids it authorizes. Accounts it covers sign nothing here.</p></div>`
        : `<p>For a company or other organization: <a href="/agreement/entity">the entity version</a>.</p>`;
    return page(
      `<h1>Kleidos Contributor Agreement${kind === "entity" ? " (entity version)" : ""}</h1>\n${SUMMARY}\n${await versionLine(env)}\n${entityNote}\n<p>To sign, open a pull request in a Kleidos repository and follow the link the bot posts on it.</p>\n${agreementText(kind)}`,
      { title: `Kleidos Contributor Agreement${kind === "entity" ? " (entity version)" : ""}`, cache: "public" },
    );
  })();
}

export async function spanishPage(): Promise<Response> {
  const opts = { headingShift: 1 };
  return page(
    `<h1>Acuerdo de Contribución de Kleidos: textos en español</h1>
<div class="box"><p>Estos textos son informativos. El acuerdo se celebra en inglés y solo el texto inglés obliga: <a href="/agreement" hreflang="en" lang="en">Kleidos Contributor Agreement</a>.</p></div>
<section class="text">${renderMarkdown(FILES["summary.es.md"]!, opts)}</section>
<section class="text">${renderMarkdown(FILES["addendum.es.md"]!, opts)}</section>`,
    { title: "Acuerdo de Contribución de Kleidos: textos en español", lang: "es", cache: "public" },
  );
}

export function privacyPage(lang: "en" | "es"): Promise<Response> {
  const src = lang === "es" ? NOTICES.privacyEs : NOTICES.privacy;
  return page(renderMarkdown(src, { links: { "PRIVACY.es.md": "/privacy/es", "PRIVACY.md": "/privacy" } }), {
    title: lang === "es" ? "Aviso de privacidad · Acuerdo de Contribución de Kleidos" : "Privacy notice · Kleidos Contributor Agreement",
    lang,
    cache: "public",
  });
}

export function setupPage(): Promise<Response> {
  return page(`<h1>kleidos-cla installed</h1>\n<p>The app is installed. It serves only the Kleidos repositories; an installation on any other account is removed automatically.</p>`, { title: "kleidos-cla installed" });
}
