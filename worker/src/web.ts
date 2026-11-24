// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { FALLBACK_VERSION, NOTICES, checkIntegrity, filesOf, isBundled } from "./agreement";
import type { Assessment } from "./assess";
import { HeadMovedError, acceptedSentences, allClear, assess } from "./assess";
import type { Bot } from "./bot";
import type { ConfiguredEnv, OAuthApp } from "./env";
import { botApp, signinApp } from "./env";
import { GitHubError, NotAllowedError, WEB } from "./github";
import { escapeHtml, messagePage, page, redirect } from "./html";
import type { Lang, Strings } from "./i18n";
import { BACK, S, isLang, pickLang } from "./i18n";
import type { Keys } from "./keys";
import { csrfToken, csrfVerify } from "./keys";
import { log } from "./log";
import type { Heading, Rendered } from "./markdown";
import { renderMarkdown } from "./markdown";
import type { Config, SignatureRecord } from "./registry";
import { flowOf, recordValid } from "./registry";
import type { Session } from "./session";
import { OAUTH_COOKIE, OAUTH_TTL, SESSION_COOKIE, SESSION_TTL, clearCookie, isPendingSignin, readSession, readTransaction, sessionCookie, transactionCookie } from "./session";
import { b64urlEncode, clientIp, isLogin, must, normalizeSentence, nowSeconds, randomB64url, readCapped, safeEqual, utf8 } from "./util";

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
  // At most ten digits, so always a safe integer.
  const pr = Number(m[3]);
  if (pr > 2_147_483_647) return null;
  return { repo: `${m[1]}/${m[2]}`, pr, path: `/sign/${m[1]}/${m[2]}/${pr}` };
}

/** The acceptance sentence of a version, built from its digest: what the signer ticks is what is posted. */
export function sentenceFor(version: number, setSha256: string): string {
  return `I have read and I accept the Kleidos Contributor Agreement, version ${version} (SHA-256 ${setSha256.slice(0, 12)}), made of the Contributor Agreement text and its Addendum. I understand that it lets José M. Requena Plens license my contributions under other terms as well, including paid commercial licences. I am of legal age and I am entitled to license what I contribute.`;
}

interface SigningFacts {
  /** The version offered: the registry's current_version. */
  version: number;
  setSha256: string;
  /** How it is accepted: kleidos-cla posts the sentence ("comment") or the signer signs in with the identity-only app ("signin"). */
  flow: "comment" | "signin";
}

/** Signing on, with the app the signer signs in with, or off, with why. */
export type Signing = (SigningFacts & { on: true; app: OAuthApp }) | (SigningFacts & { on: false; reason: string; app: null });

/** The state of a signing that is on. */
type SigningOn = Extract<Signing, { on: true }>;

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Signing is on only when the registry's current version is bundled here
 * with the same digest and sentence, and the app its flow signs in with
 * is configured: kleidos-cla for "comment", the identity-only app (both
 * secrets, and the client id the registry names) for "signin". Making
 * version 2 current is therefore the one switch: until the registry says
 * so, the site keeps the version 1 flow, and a "signin" version with no
 * sign-in app is paused rather than signed any other way.
 */
export async function signingState(config: Config | null, env: ConfiguredEnv): Promise<Signing> {
  const version = config?.current_version ?? FALLBACK_VERSION;
  const integrity = await checkIntegrity(version);
  const off = (reason: string): Signing => ({ on: false, reason, version, setSha256: integrity.setSha256, flow: config ? flowOf(config, version) : "comment", app: null });
  if (!config) return off("registry not read");
  if (!isBundled(version)) return off("version skew between the registry and this deployment");
  if (!integrity.ok) return off("bundled texts do not match SHA256SUMS");
  const v = config.versions[String(version)];
  if (!v || v.set_sha256 !== integrity.setSha256 || v.sentence !== sentenceFor(version, integrity.setSha256)) return off("version skew between the registry and this deployment");
  const flow = flowOf(config, version);
  if (flow === "signin") {
    const app = signinApp(env, config.signin_client_id);
    if (!app) return off("the sign-in app is not configured");
    // The recorder names the commit the sign page was built from; a build without it cannot take a signature.
    if (!COMMIT.test(env.BUILD_COMMIT)) return off("build commit unknown");
    return { on: true, version, setSha256: integrity.setSha256, flow, app };
  }
  return { on: true, version, setSha256: integrity.setSha256, flow, app: botApp(env) };
}

/** The credentials to revoke a token of a session with: its own app, whether or not that app still signs. */
function sessionApp(env: ConfiguredEnv, kind: "bot" | "signin" | undefined): OAuthApp | null {
  // The sign-in app as the Worker holds it, whether or not the register still names it.
  return kind === "signin" ? signinApp(env, env.SIGNIN_CLIENT_ID) : botApp(env);
}

// ---------------------------------------------------------------------------
// Pieces of the pages

function prName(t: Target): string {
  return `${escapeHtml(t.repo)}#${t.pr}`;
}

function prUrl(t: Target): string {
  return `${WEB}/${escapeHtml(t.repo)}/pull/${t.pr}`;
}

function prLink(t: Target): string {
  return `<a href="${prUrl(t)}">${prName(t)}</a>`;
}

/** The eyebrow naming the step, and its two bars (decoration: the words carry it). */
function progress(lang: Lang, step: 1 | 2 | 3): string {
  const bars = [1, 2].map((n) => `<span class="${n < step ? "done" : n === step ? "current" : ""}"></span>`).join("");
  return `<div class="progress"><p class="eyebrow">${S[lang].steps[step - 1]}</p><span class="bars" aria-hidden="true">${bars}</span></div>`;
}

function where(html: string): string {
  return `<p class="where">${html}</p>`;
}

function loginHref(t: Target, lang: Lang, sw = false): string {
  return `/auth/login?return=${encodeURIComponent(t.path)}${sw ? "&amp;switch=1" : ""}&amp;lang=${lang}`;
}

function filesUrl(env: { BUILD_COMMIT: string; REGISTRY_REPO: string }, version: number): string {
  const ref = COMMIT.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT : "main";
  return `https://github.com/${env.REGISTRY_REPO}/tree/${ref}/agreements/v${version}`;
}

async function metaLine(lang: Lang, env: { BUILD_COMMIT: string; REGISTRY_REPO: string }, version: number, kind: "individual" | "entity" = "individual"): Promise<string> {
  const { setSha256 } = await checkIntegrity(version);
  const commit = COMMIT.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT.slice(0, 12) : "main";
  const v = version;
  return `<p class="meta"><span>${S[lang].meta(v, setSha256)}</span><span><a href="${filesUrl(env, version)}">${escapeHtml(env.REGISTRY_REPO)}@<code>${escapeHtml(commit)}</code></a></span><span>${S[lang].downloads}: <a href="/agreement/v${v}/${kind}.md" download>${kind}.md</a>, <a href="/agreement/v${v}/addendum.md" download>addendum.md</a>, <a href="/agreement/v${v}/SHA256SUMS" download>SHA256SUMS</a></span></p>`;
}

function summaryList(lang: Lang): string {
  const a = S[lang].accept;
  return `<ul class="summary" aria-label="${a.summaryLabel}">${a.summary.map(([k, v]) => `<li><strong>${k}</strong> ${v}</li>`).join("")}</ul>`;
}

/** A Markdown text with ids on its headings; a leading comment (a file's licence header) is not part of the text. */
function rendered(src: string, prefix: string): Rendered {
  return renderMarkdown(src.replace(/^<!--[\s\S]*?-->\s*/, ""), { headingShift: 1, idPrefix: prefix });
}

/**
 * The two texts of the agreement. In Spanish: the informative translations
 * of the Contributor Agreement and of the Addendum (the entity version has
 * none, so it stays in English, marked as such).
 */
function agreementTexts(lang: Lang, kind: "individual" | "entity", prefix: string, version: number): { html: string; parts: [Heading[], Heading[]] } {
  const spanish = lang === "es";
  const files = filesOf(version);
  const ca = rendered(spanish && kind === "individual" ? must(files["individual.es.md"]) : must(files[`${kind}.md`]), `${prefix}ca`);
  const ad = rendered(spanish ? must(files["addendum.es.md"]) : must(files["addendum.md"]), `${prefix}ad`);
  const caLang = spanish && kind === "individual" ? "es" : "en";
  const label = spanish ? ["Acuerdo", "Anexo"] : ["Contributor Agreement", "Addendum"];
  return {
    html: `<section class="prose" lang="${caLang}" aria-label="${label[0]}">${ca.html}</section>\n<section class="prose" lang="${lang}" aria-label="${label[1]}">${ad.html}</section>`,
    parts: [ca.headings, ad.headings],
  };
}

function toc(t: Strings, parts: [Heading[], Heading[]], labels: [string, string]): string {
  // Every bundled text opens with its title, so each part has a first heading.
  const [ca, ad] = parts;
  const li = (h: Heading) => `<li><a href="#${h.id}">${h.html}</a></li>`;
  return `<details class="toc" open><summary class="eyebrow">${t.agreement.toc}</summary><ol>
<li><a href="#${must(ca[0]).id}">${labels[0]}</a><ol>${ca.filter((h) => h.level === 4).map(li).join("")}</ol></li>
<li><a href="#${must(ad[0]).id}">${labels[1]}</a><ol>${ad.filter((h) => h.level === 3).map(li).join("")}</ol></li>
</ol></details>`;
}

function whoRow(lang: Lang, s: Session, t: Target, logoutCsrf: string): string {
  const a = S[lang].accept;
  return `<div class="who"><span>${a.signedInAs} <strong>@${escapeHtml(s.login)}</strong></span><a href="${loginHref(t, lang, true)}">${a.switch}</a><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${logoutCsrf}"><input type="hidden" name="lang" value="${lang}"><button class="link-btn" type="submit">${a.signOut}</button></form></div>`;
}

function alertCard(html: string): string {
  return `<div class="card is-pending" role="alert"><p>${html}</p></div>`;
}

/** Step 1: what this is and who still signs, and one button. No legal text: that comes once signed in. */
function startBody(lang: Lang, t: Target, a: Assessment, signing: Signing, extra: { again?: boolean; notice?: string; who?: string } = {}): string {
  const s = S[lang].start;
  const signingOn = signing.on;
  const still = a.missing.length ? a.missing.map((m) => `@${escapeHtml(m.login)}`).join(", ") : allClear(a) ? s.nobody : "—";
  const action = signingOn
    ? `<a class="btn btn-primary btn-block" href="${loginHref(t, lang)}">${extra.again ? s.buttonAgain : s.button}</a>\n<p class="note">${s.note}</p>`
    : alertCard(S[lang].status.paused);
  return `${progress(lang, 1)}
<h1 class="h-task">${s.h1}</h1>
${where(s.where)}
${extra.notice ?? ""}
<p class="lede">${s.lede}</p>
<div class="card">
<p class="card-row"><span class="eyebrow">${S[lang].prLabel}</span>${prLink(t)}</p>
<p class="card-row"><span class="eyebrow">${s.stillLabel}</span><span>${still}</span></p>
</div>
${action}
${extra.who ?? ""}
<ul class="links">${s.links.map(([l, h]) => `<li><a href="${h}">${l}</a></li>`).join("")}</ul>
<details class="fold"><summary>${s.ghSummary}</summary><div class="fold-body"><p class="note">${signing.flow === "signin" ? s.ghBodySignin : s.ghBody}</p></div></details>
<details class="fold"><summary>${s.whoSummary}</summary><div class="fold-body"><p class="note">${s.whoBody}</p></div></details>`;
}

/** Step 2: the summary, the box and the button above the fold, the full text in a fold below. */
async function acceptBody(lang: Lang, env: ConfiguredEnv, s: Session, t: Target, keys: Keys, signing: Signing, error: boolean): Promise<string> {
  const a = S[lang].accept;
  const { version, setSha256 } = signing;
  const signin = signing.flow === "signin";
  const csrf = await csrfToken(keys.csrf, [s.sid, "agree", `${t.repo}#${t.pr}`, String(version)]);
  const logoutCsrf = await csrfToken(keys.csrf, [s.sid, "logout"]);
  const [owner, repo] = t.repo.split("/") as [string, string];
  const sentence = sentenceFor(version, setSha256);
  const translation = a.translation ? `<details class="translation"><summary>${a.translation.summary}</summary><p lang="es">${a.translation.body(setSha256.slice(0, 12), version)}</p></details>` : "";
  const errorBox = error ? `<p class="error" id="accept-error" role="alert"><span class="error-mark" aria-hidden="true">!</span><span>${a.error}</span></p>` : "";
  const box = error ? ' aria-invalid="true" aria-describedby="accept-error post-note" autofocus' : ' aria-describedby="post-note"';
  const texts = agreementTexts(lang, "individual", "f-", version);
  return `${progress(lang, 2)}
<h1 class="h-task">${a.h1}</h1>
${where(a.where)}
${summaryList(lang)}
<form class="accept${error ? " is-error" : ""}" id="accept" method="post" action="/agree#accept" novalidate>
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="owner" value="${escapeHtml(owner)}"><input type="hidden" name="repo" value="${escapeHtml(repo)}">
<input type="hidden" name="pr" value="${t.pr}"><input type="hidden" name="version" value="${version}">
<input type="hidden" name="set_sha256" value="${setSha256}"><input type="hidden" name="lang" value="${lang}">
${errorBox}
<div class="check"><input type="checkbox" id="accept-box" name="accept" value="yes"${box}><label for="accept-box" lang="en">${escapeHtml(sentence)}</label></div>
<div class="actionbar"><button class="btn btn-primary btn-block" type="submit">${a.button}</button></div>
<p class="note" id="post-note">${(signin ? a.noteSignin : a.note)(escapeHtml(s.login), prName(t))}</p>
${translation}
</form>
${whoRow(lang, s, t, logoutCsrf)}
<details class="fold" id="text"><summary><span>${a.foldTitle}<small>${a.foldSub(version)}</small></span></summary><div class="fold-body">
${a.binding ? `<p class="banner">${a.binding}</p>` : ""}
${await metaLine(lang, env, version)}
${texts.html}
<p class="backbar"><span>${a.backbar}</span><a href="#accept">${a.backLink}</a></p>
</div></details>
<section class="prose" aria-labelledby="before"><h2 id="before" class="h-sub">${a.beforeTitle}</h2><ul>${(signin ? a.beforeSignin : a.before).map((x) => `<li>${x}</li>`).join("")}</ul><p class="note">${signin ? a.dataSignin : a.data}</p></section>`;
}

interface DoneFacts {
  login: string;
  id: number;
  version: number;
  setSha256: string;
  at: string;
  /** The acceptance comment, for a "comment" version; null for a sign-in, which posts nothing. */
  commentUrl: string | null;
  entryUrl: string | null;
}

/** Step 3: signed; recorded or being recorded. */
function doneBody(lang: Lang, t: Target, f: DoneFacts): string {
  const d = S[lang].done;
  const recorded = f.entryUrl !== null;
  const path = `signatures/individual/${f.id}.json`;
  const entry = f.entryUrl ? `<a href="${escapeHtml(f.entryUrl)}">${path}</a>` : `${d.entryRecording} <a href="${escapeHtml(t.path)}">${d.checkNow}</a>`;
  return `${progress(lang, 3)}
<h1 class="h-task">${d.h1}</h1>
${where(recorded ? d.whereRecorded : d.whereRecording)}
<div class="card is-done" role="status">
<p class="status ${recorded ? "is-done" : "is-pending"}">${recorded ? d.statusRecorded : d.statusRecording}</p>
<p>${d.lede(prLink(t))}</p>
<dl class="facts">
<div><dt class="eyebrow">${d.account}</dt><dd>${d.accountValue(escapeHtml(f.login), f.id)}</dd></div>
<div><dt class="eyebrow">${d.version}</dt><dd>${f.version} · SHA-256 <code>${f.setSha256}</code></dd></div>
<div><dt class="eyebrow">${d.accepted}</dt><dd>${escapeHtml(f.at)}</dd></div>
${f.commentUrl ? `<div><dt class="eyebrow">${d.comment}</dt><dd><a href="${escapeHtml(f.commentUrl)}">${prName(t)}</a></dd></div>` : `<div><dt class="eyebrow">${S[lang].prLabel}</dt><dd>${prLink(t)}</dd></div>`}
<div><dt class="eyebrow">${d.entry}</dt><dd>${entry}</dd></div>
</dl>
</div>
<a class="btn btn-primary btn-block" href="${prUrl(t)}">${d.back}</a>
<p class="note">${d.checks}</p>
<p class="note">${d.keep}</p>`;
}

/** A sign-page state that needs nothing from the reader: a heading, one card, who is signed in. */
function statusBody(lang: Lang, t: Target, title: string, html: string, tone: "done" | "info" | "alert", who: string): string {
  const card = tone === "alert" ? alertCard(html) : `<div class="card${tone === "done" ? " is-done" : ""}" role="status"><p>${html}</p></div>`;
  return `<h1 class="h-task">${escapeHtml(title)}</h1>
<p class="where">${S[lang].prLabel} ${prLink(t)}</p>
${card}
${who}
<a class="btn btn-block" href="${prUrl(t)}">${BACK.pr[lang]}</a>`;
}

// ---------------------------------------------------------------------------
// The sign page

type SignerStatus = "must_sign" | "signed" | "exempt" | "entity" | "not_author" | "closed" | "locked" | "not_user" | "private";

async function assessTarget(bot: Bot, config: Config, t: Target): Promise<Assessment> {
  const token = await bot.gh.token([t.repo], { pull_requests: "read", contents: "read" });
  return assess(bot.gh, bot.registry, config, t.repo, t.pr, token);
}

async function signerStatus(bot: Bot, config: Config, t: Target, account: { id: number; type: string }): Promise<{ status: SignerStatus; a: Assessment; record?: SignatureRecord; entity?: string }> {
  const a = await assessTarget(bot, config, t);
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

function guard<T>(lang: Lang, fn: () => Promise<T>): Promise<T | Response> {
  return fn().catch(async (e: unknown) => {
    if (e instanceof NotAllowedError) return messagePage(lang, 404, "notServed");
    if (e instanceof HeadMovedError) return messagePage(lang, 503, "headMoved");
    if (e instanceof GitHubError) {
      log("github error", { status: e.status, reason: e.kind, request_id: e.requestId });
      if (e.kind === "rate_limited") return messagePage(lang, 429, "ghRateLimited");
      if (e.kind === "not_found") return messagePage(lang, 404, "ghNotFound");
      return messagePage(lang, 503, "ghUnavailable");
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

function signTitle(lang: Lang, t: Target, step: "start" | "accept"): string {
  return `${S[lang][step].title} · ${t.repo}#${t.pr}`;
}

/** Step 2 again for a signer who did not tick the box: the error beside it. */
async function acceptAgain(lang: Lang, env: ConfiguredEnv, s: Session, t: Target, keys: Keys, signing: Signing): Promise<Response> {
  return page(await acceptBody(lang, env, s, t, keys, signing, true), { title: signTitle(lang, t, "accept"), lang, path: t.path, status: 400 });
}

/** Whether a session's token can take the acceptance now: issued for this pull request, by the app the current version signs in with. */
function tokenFor(session: Session, t: Target, signing: SigningOn): boolean {
  return Boolean(session.token) && session.for === `${t.repo}#${t.pr}` && (session.app ?? "bot") === signing.app.kind;
}

function entryUrl(env: ConfiguredEnv, id: number, commit: string | null): string {
  return `https://github.com/${env.REGISTRY_REPO}/blob/${commit ?? "signatures"}/signatures/individual/${id}.json`;
}

export async function signPage(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys, path: string): Promise<Response> {
  const lang = pickLang(req, new URL(req.url));
  const st0 = S[lang].status;
  if (!(await env.RL_SIGN.limit({ key: clientIp(req) })).success) return messagePage(lang, 429, "tooManySign");
  // Set from inside the guarded callback, so a list (a let would be narrowed to its initial null).
  const replaced: string[] = [];
  const r = await guard(lang, async () => {
    const st = await servedTarget(bot, path);
    if (!st) return messagePage(lang, 404, "noTarget");
    const { t, config } = st;
    const session = await readSession(req, keys);
    const signing = await signingState(config, env);
    const back = { href: prUrl(t), label: BACK.pr[lang] };
    if (!session) {
      const a = await assessTarget(bot, config, t);
      if (a.pr.base.repo.private) return messagePage(lang, 404, "noTarget");
      if (a.pr.state !== "open") return messagePage(lang, 409, "closed", back);
      if (a.pr.locked) return messagePage(lang, 409, "locked", back);
      return page(startBody(lang, t, a, signing), { title: signTitle(lang, t, "start"), lang, path: t.path });
    }
    const logoutCsrf = await csrfToken(keys.csrf, [session.sid, "logout"]);
    let notice = "";
    const pending = session.pending;
    if (pending && pending.repo === t.repo && pending.pr === t.pr) {
      const rec = await bot.registry.signature(session.id);
      const recorded = recordValid(config, rec);
      const commit = recorded ? await bot.registry.recordCommit(session.id).catch(() => null) : null;
      const done = (facts: DoneFacts) => page(doneBody(lang, t, facts), { title: facts.entryUrl ? S[lang].done.titleRecorded : S[lang].done.titleRecording, lang, path: t.path });
      if (isPendingSignin(pending)) {
        // A sign-in leaves nothing on the pull request: the record, or the recorder run that is checking it, is what there is to show.
        const run = recorded ? "succeeded" : await bot.registry.signinRun(t.repo, t.pr, session.id, pending.at).catch(() => null);
        if (recorded || run !== "failed") {
          const set = recorded ? rec.set_sha256 : (config.versions[String(pending.version)]?.set_sha256 ?? signing.setSha256);
          return done({ login: session.login, id: session.id, version: recorded ? rec.version : pending.version, setSha256: set, at: recorded ? rec.accepted_at : pending.at, commentUrl: null, entryUrl: recorded ? entryUrl(env, session.id, commit) : null });
        }
        notice = alertCard(st0.recordFailed);
      } else {
        if (recorded || (await acceptanceStands(bot, config, t, session.id, pending.comment_id))) {
          return done({
            login: session.login,
            id: session.id,
            version: recorded ? rec.version : signing.version,
            setSha256: recorded ? rec.set_sha256 : signing.setSha256,
            at: recorded ? rec.accepted_at : pending.at,
            commentUrl: pending.comment_url,
            entryUrl: recorded ? entryUrl(env, session.id, commit) : null,
          });
        }
        // The acceptance comment was edited or deleted, so the recorder will refuse it: say so and let the signer sign again.
        notice = alertCard(st0.edited);
      }
      const rest: Session = { ...session };
      delete rest.pending;
      replaced.push(await sessionCookie(keys, rest));
    }
    const s = await signerStatus(bot, config, t, session);
    const who = whoRow(lang, session, t, logoutCsrf);
    const login = escapeHtml(session.login);
    switch (s.status) {
      case "private":
        return messagePage(lang, 404, "noTarget");
      case "closed":
        return messagePage(lang, 409, "closed", back);
      case "locked":
        return messagePage(lang, 409, "locked", back);
      case "not_user":
        return page(statusBody(lang, t, st0.notUserTitle, st0.notUser(login), "alert", who), { title: st0.notUserTitle, lang, path: t.path, status: 403 });
      case "exempt":
        return page(statusBody(lang, t, st0.nothingTitle, st0.exempt(login), "info", who), { title: st0.nothingTitle, lang, path: t.path });
      case "entity":
        return page(statusBody(lang, t, st0.nothingTitle, st0.entity(login, escapeHtml(must(s.entity))), "info", who), { title: st0.nothingTitle, lang, path: t.path });
      case "signed": {
        await env.CLA_QUEUE.send({ kind: "evaluate", repo: t.repo, pr: t.pr });
        const entry = `<a href="https://github.com/${escapeHtml(env.REGISTRY_REPO)}/blob/signatures/signatures/individual/${session.id}.json">${st0.entry}</a>`;
        return page(statusBody(lang, t, st0.signedTitle, `${st0.signed(must(s.record).version, escapeHtml(must(s.record).accepted_at.slice(0, 10)))} ${entry}.`, "done", who), { title: st0.signedTitle, lang, path: t.path });
      }
      case "not_author":
        return page(statusBody(lang, t, st0.nothingTitle, st0.notAuthor(login), "info", who), { title: st0.nothingTitle, lang, path: t.path });
      case "must_sign": {
        // A session with a token was written by the callback, which writes no acceptance into it, so there is no notice here.
        if (signing.on && tokenFor(session, t, signing)) {
          return page(await acceptBody(lang, env, session, t, keys, signing, false), { title: signTitle(lang, t, "accept"), lang, path: t.path });
        }
        return page(startBody(lang, t, s.a, signing, { again: true, notice, who }), { title: signTitle(lang, t, "start"), lang, path: t.path });
      }
    }
  });
  for (const c of replaced) r.headers.append("set-cookie", c);
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

// ---------------------------------------------------------------------------
// Sign-in, sign-out and the signature

async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
}

export async function login(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys, url: URL): Promise<Response> {
  const lang = pickLang(req, url);
  if (!(await env.RL_AUTH.limit({ key: clientIp(req) })).success) return messagePage(lang, 429, "tooManyAuth");
  const ret = url.searchParams.get("return") ?? "";
  const st = await guard(lang, () => servedTarget(bot, ret));
  if (st instanceof Response) return st;
  // parseSignPath gives back the very path it read, so a valid return is exactly the sign page's own.
  if (!st) return messagePage(lang, 400, "badLink");
  // The app asked is the one the current version signs in with: kleidos-cla for version 1, the identity-only app for a sign-in version.
  const signing = await signingState(st.config, env);
  if (!signing.on) return messagePage(lang, 503, "paused", { href: `${st.t.path}?lang=${lang}`, label: BACK.sign[lang] });
  const t: { state: string; verifier: string } = { state: randomB64url(32), verifier: randomB64url(32) };
  const authorize = new URL(`${WEB}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", signing.app.clientId);
  authorize.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/auth/callback`);
  authorize.searchParams.set("state", t.state);
  authorize.searchParams.set("code_challenge", await pkceChallenge(t.verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");
  if (url.searchParams.get("switch") === "1") authorize.searchParams.set("prompt", "select_account");
  const cookie = await transactionCookie(keys, { v: 1, state: t.state, verifier: t.verifier, return: st.t.path, lang, app: signing.app.kind, exp: nowSeconds() + OAUTH_TTL });
  return redirect(authorize.toString(), 302, [cookie]);
}

async function revokeGrant(bot: Bot, app: OAuthApp | null, token: string): Promise<void> {
  if (!app) return;
  try {
    await bot.gh.request("DELETE", `/applications/${app.clientId}/grant`, { basic: [app.clientId, app.clientSecret] }, { access_token: token });
  } catch (e) {
    log("grant revocation failed", { status: e instanceof GitHubError ? e.status : 0 });
  }
}

export async function callback(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys, url: URL): Promise<Response> {
  const reqLang = pickLang(req, url);
  if (!(await env.RL_AUTH.limit({ key: clientIp(req) })).success) return messagePage(reqLang, 429, "tooManyAuth");
  const clear = clearCookie(OAUTH_COOKIE);
  const tx = await readTransaction(req, keys);
  if (!tx) return messagePage(reqLang, 400, "oauthExpired", undefined, [clear]);
  const lang = tx.lang ?? reqLang;
  const back = { href: `${tx.return}?lang=${lang}`, label: BACK.sign[lang] };
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  // The state is compared before anything else, the error branch included:
  // a redirect that did not come from this sign-in leaves it untouched.
  if (!safeEqual(state, tx.state)) {
    log("oauth refused", { reason: "state" });
    return messagePage(lang, 400, "oauthState", url.searchParams.get("error") ? back : undefined);
  }
  if (url.searchParams.get("error")) return messagePage(lang, 400, "oauthCancelled", back, [clear]);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return messagePage(lang, 400, "oauthCode", undefined, [clear]);
  const r = await guard(lang, async () => {
    const st = await servedTarget(bot, tx.return);
    if (!st) return messagePage(lang, 400, "badLink", undefined, [clear]);
    // The code was issued to the app the transaction names, and is exchanged with that app's own secret.
    const app = (tx.app ?? "bot") === "signin" ? signinApp(env, st.config.signin_client_id) : botApp(env);
    if (!app) return messagePage(lang, 503, "paused", back, [clear]);
    const repoToken = await bot.gh.token([st.t.repo], { pull_requests: "read", contents: "read" });
    const repo = (await bot.gh.request<{ id: number; private: boolean }>("GET", `/repos/${st.t.repo}`, { token: repoToken })).data;
    if (repo.private) return messagePage(lang, 404, "noTarget", undefined, [clear]);
    // kleidos-cla's token is narrowed to the one repository it may comment on; the sign-in app has no permission to narrow.
    const exchangeBody = { client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`, code_verifier: tx.verifier, ...(app.kind === "bot" ? { repository_id: repo.id } : {}) };
    const exchange = await fetch(`${WEB}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "kleidos-cla" },
      body: JSON.stringify(exchangeBody),
    });
    // The refresh token a GitHub App returns is never read or kept: the access token lives at most as long as the session.
    const body = (await exchange.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!exchange.ok || !body.access_token || body.error) {
      log("oauth exchange refused", { status: exchange.status, reason: typeof body.error === "string" ? body.error.slice(0, 40) : "none" });
      return messagePage(lang, 400, "oauthExchange", back, [clear]);
    }
    const token = body.access_token;
    const user = (await bot.gh.request<{ id: number; login: string; type: string }>("GET", "/user", { token })).data;
    if (!isLogin(user.login) || typeof user.id !== "number") {
      await revokeGrant(bot, app, token);
      return messagePage(lang, 400, "oauthUser", undefined, [clear]);
    }
    const s = await signerStatus(bot, st.config, st.t, user);
    const keep = s.status === "must_sign";
    if (!keep) await revokeGrant(bot, app, token);
    const session: Session = { v: 1, sid: randomB64url(16), id: user.id, login: user.login, type: user.type, exp: nowSeconds() + SESSION_TTL, ...(keep ? { token, app: app.kind, for: `${st.t.repo}#${st.t.pr}` } : {}) };
    log("signed in", { repo: st.t.repo, pr: st.t.pr, outcome: s.status });
    return redirect(`${st.t.path}?lang=${lang}`, 303, [clear, await sessionCookie(keys, session)]);
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

/** A form's language: its own `lang` field, else the request's. */
function formLang(req: Request, form: URLSearchParams | null): Lang {
  const v = form?.get("lang");
  return isLang(v) ? v : pickLang(req, new URL(req.url));
}

export async function logout(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(pickLang(req, new URL(req.url)), 403, "refusedOrigin");
  const form = await readForm(req);
  const lang = formLang(req, form);
  const session = await readSession(req, keys);
  if (!form || !session) return redirect(`/agreement?lang=${lang}`, 303, [clearCookie(SESSION_COOKIE)]);
  if (!(await csrfVerify(keys.csrf, [session.sid, "logout"], form.get("csrf") ?? ""))) return messagePage(lang, 403, "refusedStale");
  if (session.token) await revokeGrant(bot, sessionApp(env, session.app), session.token);
  return redirect(`/agreement?lang=${lang}`, 303, [clearCookie(SESSION_COOKIE)]);
}

/** Design 6.3: the signature. Stops at the first failure with nothing posted or recorded. */
export async function agree(req: Request, env: ConfiguredEnv, bot: Bot, keys: Keys): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(pickLang(req, new URL(req.url)), 403, "refusedOrigin");
  const form = await readForm(req);
  const lang = formLang(req, form);
  if (!form) return messagePage(lang, 400, "formUnreadable");
  const session = await readSession(req, keys);
  if (!session) return messagePage(lang, 401, "sessionExpired");
  const t = parseSignPath(`/sign/${form.get("owner") ?? ""}/${form.get("repo") ?? ""}/${form.get("pr") ?? ""}`);
  if (!t) return messagePage(lang, 400, "formInvalid");
  const back = { href: `${t.path}?lang=${lang}`, label: BACK.sign[lang] };
  const version = Number(form.get("version"));
  const csrfOk = await csrfVerify(keys.csrf, [session.sid, "agree", `${t.repo}#${t.pr}`, String(version)], form.get("csrf") ?? "");
  if (!csrfOk) {
    log("agree refused", { reason: "csrf" });
    return messagePage(lang, 403, "csrf", back);
  }
  if (!session.token || session.for !== `${t.repo}#${t.pr}`) return messagePage(lang, 401, "signInAgain", back);
  const r = await guard(lang, async () => {
    const config = await bot.registry.config();
    if (!config.served_repositories[t.repo]) return messagePage(lang, 404, "notServed");
    const signing = await signingState(config, env);
    if (!signing.on) return messagePage(lang, 503, "paused");
    // A token of the other app (the current version changed flow since the sign-in) cannot take this acceptance.
    if (!tokenFor(session, t, signing)) return messagePage(lang, 401, "signInAgain", back);
    // The box was not ticked: the same page again, with the error beside the box and nothing posted.
    if (form.get("accept") !== "yes") return acceptAgain(lang, env, session, t, keys, signing);
    if (version !== signing.version || form.get("set_sha256") !== signing.setSha256) return messagePage(lang, 409, "changed", back);
    if (!(await env.RL_AGREE_IP.limit({ key: clientIp(req) })).success || !(await env.RL_AGREE_ACCOUNT.limit({ key: String(session.id) })).success) {
      return messagePage(lang, 429, "tooManyAgree");
    }
    const s = await signerStatus(bot, config, t, session);
    if (s.status !== "must_sign") {
      log("agree refused", { reason: s.status, repo: t.repo, pr: t.pr });
      const why = {
        closed: [409, "postedClosed"],
        locked: [409, "postedLocked"],
        private: [404, "postedPrivate"],
        not_user: [403, "postedNotUser"],
        signed: [409, "postedSigned"],
      } as const;
      const [status, key] = s.status in why ? why[s.status as keyof typeof why] : ([403, "postedNotNeeded"] as const);
      return messagePage(lang, status, key, back);
    }
    if (signing.flow === "signin") return agreeBySignin(lang, env, bot, keys, session, t, signing, back);
    const confirm = async (c: { id: number; html_url: string; created_at: string }, queue: boolean): Promise<Response> => {
      const next: Session = { v: 1, sid: session.sid, id: session.id, login: session.login, type: session.type, exp: session.exp, pending: { repo: t.repo, pr: t.pr, comment_id: c.id, comment_url: c.html_url, at: c.created_at } };
      if (queue) {
        try {
          await env.CLA_QUEUE.send({ kind: "evaluate", repo: t.repo, pr: t.pr, record_comment: c.id });
        } catch {
          log("enqueue failed", { repo: t.repo, pr: t.pr });
        }
      }
      return redirect(`${t.path}?lang=${lang}`, 303, [await sessionCookie(keys, next)]);
    };
    // A second submission (a double click, a reload of the post) finds the first acceptance and confirms it.
    const already = (assessed: Assessment) => assessed.acceptances.find((x) => x.account === session.id && !x.edited);
    const earlier = already(s.a);
    if (earlier) {
      await revokeGrant(bot, signing.app, must(session.token));
      return confirm({ id: earlier.commentId, html_url: earlier.commentUrl, created_at: earlier.createdAt }, false);
    }
    const sentence = sentenceFor(signing.version, signing.setSha256);
    let posted: { id: number; html_url: string; created_at: string };
    try {
      posted = (await bot.gh.request<{ id: number; html_url: string; created_at: string }>("POST", `/repos/${t.repo}/issues/${t.pr}/comments`, { token: must(session.token) }, { body: sentence })).data;
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "unauthorized" || e.kind === "forbidden" || e.kind === "not_found")) {
        log("agree refused", { reason: "github_" + e.kind, repo: t.repo, pr: t.pr });
        // The grant may have been revoked by a first submission that did post: look before saying nothing was posted.
        const again = already((await signerStatus(bot, config, t, session)).a);
        if (again) return confirm({ id: again.commentId, html_url: again.commentUrl, created_at: again.createdAt }, false);
        return messagePage(lang, 401, "signInAgainGitHub", back, [clearCookie(SESSION_COOKIE)]);
      }
      throw e;
    }
    await revokeGrant(bot, signing.app, must(session.token));
    log("signed", { repo: t.repo, pr: t.pr });
    return confirm(posted, true);
  });
  return r;
}

/**
 * The signature of a "signin" version: nothing is posted anywhere. The
 * Worker hands the account it read and the signer's own token to
 * record.yml, which asks GitHub whose token it is before it records
 * anything and then deletes the grant, so a Worker that lies can record
 * nobody but an account that authorized the sign-in app and whose
 * authorization was not deleted since (SECURITY.md). The session forgets
 * the token at once: a reload or a second click cannot hand it over again.
 */
async function agreeBySignin(lang: Lang, env: ConfiguredEnv, bot: Bot, keys: Keys, session: Session, t: Target, signing: SigningOn, back: { href: string; label: string }): Promise<Response> {
  const token = must(session.token);
  try {
    await bot.registry.dispatchSignin({ repo: t.repo, pr: t.pr, github_id: session.id, version: signing.version, lang, site_commit: env.BUILD_COMMIT, signin_token: token });
  } catch (e) {
    log("signin dispatch failed", { repo: t.repo, pr: t.pr, status: e instanceof GitHubError ? e.status : 0 });
    await revokeGrant(bot, signing.app, token);
    return messagePage(lang, 503, "recorderUnreachable", back, [clearCookie(SESSION_COOKIE)]);
  }
  const at = new Date().toISOString().slice(0, 19) + "Z";
  const next: Session = { v: 1, sid: session.sid, id: session.id, login: session.login, type: session.type, exp: session.exp, pending: { signin: true, repo: t.repo, pr: t.pr, version: signing.version, at } };
  try {
    await env.CLA_QUEUE.send({ kind: "evaluate", repo: t.repo, pr: t.pr, await_signin: session.id });
  } catch {
    log("enqueue failed", { repo: t.repo, pr: t.pr });
  }
  log("signed", { repo: t.repo, pr: t.pr, outcome: "handed_to_recorder" });
  return redirect(`${t.path}?lang=${lang}`, 303, [await sessionCookie(keys, next)]);
}

// ---------------------------------------------------------------------------
// The public texts

function notConfiguredBox(lang: Lang, configured: boolean): string {
  return configured ? "" : `<div class="card" role="status"><p><strong>${escapeHtml(S[lang].notConfigured)}</strong></p></div>\n`;
}

export async function agreementPage(kind: "individual" | "entity", lang: Lang, env: { BUILD_COMMIT: string; REGISTRY_REPO: string }, configured: boolean, version: number): Promise<Response> {
  const t = S[lang];
  const g = t.agreement;
  const entity = kind === "entity";
  const texts = agreementTexts(lang, kind, "", version);
  const spanish = lang === "es";
  const summaryEs = spanish
    ? `<details class="fold"><summary><span>${g.partSummary}<small>${g.partSummarySub}</small></span></summary><div class="fold-body"><div class="prose">${rendered(must(filesOf(version)["summary.es.md"]), "re").html}</div></div></details>`
    : "";
  const banner = g.banner ? `<div class="banner">${g.banner}</div>` : "";
  const intro = entity ? `<div class="card"><p>${g.entityNote}</p></div>${g.entityOnlyEnglish ? `\n<p class="note">${g.entityOnlyEnglish}</p>` : ""}` : `<p class="note">${g.how} ${g.entity}</p>`;
  const labels: [string, string] = entity && spanish ? ["Contributor Agreement (English)", g.partB] : [g.partA, g.partB];
  const body = `<div class="progress"><p class="eyebrow">${g.eyebrow(version)}</p></div>
<h1 class="h-page">${entity ? g.entityH1 : g.h1}</h1>
${notConfiguredBox(lang, configured)}${banner}
<p class="lede">${g.lede}</p>
${summaryList(lang)}
${summaryEs}
${await metaLine(lang, env, version, kind)}
${intro}
${toc(t, texts.parts, labels)}
${texts.html}`;
  return page(body, { title: entity ? g.entityTitle : g.title, lang, path: entity ? "/agreement/entity" : "/agreement", kind: "doc", cache: "public" });
}

export function privacyPage(lang: Lang): Promise<Response> {
  const src = lang === "es" ? NOTICES.privacyEs : NOTICES.privacy;
  const { html } = renderMarkdown(src, { idPrefix: "p", links: { "PRIVACY.es.md": "/privacy?lang=es", "PRIVACY.md": "/privacy?lang=en" } });
  return page(`<div class="progress"><p class="eyebrow">${S[lang].privacy.eyebrow}</p></div>\n<div class="prose privacy">${html}</div>`, { title: S[lang].privacy.title, lang, path: "/privacy", kind: "doc", cache: "public" });
}

export function setupPage(lang: Lang): Promise<Response> {
  const [title, sentence] =
    lang === "es"
      ? ["kleidos-cla instalada", "La aplicación está instalada. Solo atiende los repositorios de Kleidos; una instalación en cualquier otra cuenta se retira automáticamente."]
      : ["kleidos-cla installed", "The app is installed. It serves only the Kleidos repositories; an installation on any other account is removed automatically."];
  return page(`<h1 class="h-task">${title}</h1>\n<p>${sentence}</p>`, { title, lang, path: "/setup" });
}
