// SPDX-License-Identifier: MIT
import type { Account } from "./authors";
import type { Assessment } from "./assess";
import { MARKER, allClear } from "./assess";
import { buttonAlt, buttonPath, buttonState } from "./button";
import type { Config } from "./registry";
import { isLogin } from "./util";

/** Whether the head commit changes `.github/` against its merge base; "unknown" when that could not be read. */
export type GithubState = "untouched" | "touched" | "unknown";

export interface TextContext {
  origin: string;
  registry: string;
  buildCommit: string;
  config: Config;
  /** The commit of the signatures branch that added each record, by account id. */
  recordCommits: Map<number, string | null>;
  github: GithubState;
  /** The repository's `auto_approve`: whether the app starts a signer's held checks. */
  autoApprove: boolean;
  lateRecording: number[];
  now: Date;
}

/** The account as Markdown: the opener is @-mentioned, anybody else is a plain link (no notification). */
export function who(a: Account, opener: number): string {
  if (!isLogin(a.login)) return `account id ${a.id}`;
  if (a.id === opener) return `@${a.login}`;
  return `[${a.login}](https://github.com/${a.login.replace("[bot]", "%5Bbot%5D")})`;
}

export function signUrl(ctx: TextContext, repo: string, pr: number): string {
  return `${ctx.origin}/sign/${repo}/${pr}`;
}

function notNeeded(a: Assessment): string | null {
  const parts = [
    ...a.exempt.map((e) => `${isLogin(e.account.login) ? `\`${e.account.login}\`` : `account id ${e.account.id}`} (${e.why})`),
    ...a.entityCovered.map((e) => `${who(e.account, a.opener.id)} (covered by the agreement of ${escapeMd(e.entity)})`),
  ];
  return parts.length ? parts.join(", ") : null;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]<>|#@!]/g, (c) => `\\${c}`);
}

function specialLines(a: Assessment, ctx: TextContext): string[] {
  const out: string[] = [];
  for (const oid of a.unknownCommits) {
    out.push(`**Cannot tell who wrote commit \`${oid}\`.** Its author email is not linked to a GitHub account. Add that email to your account (Settings → Emails) or rewrite the commit's author, then push again. No email address is shown or stored here.`);
  }
  for (const b of a.unlistedBots) {
    out.push(`This pull request names \`${isLogin(b.login) ? b.login : "an automation account"}\` as an author. An automation account cannot sign; a maintainer will look at it.`);
  }
  if (a.tooManyCommits) out.push("This pull request has too many commits to check automatically; a maintainer will look at it.");
  for (const id of ctx.lateRecording) {
    const acc = a.required.find((r) => r.id === id);
    if (acc) out.push(`${who(acc, a.opener.id)}'s acceptance was posted but is not in the register yet. Nothing is lost: it is retried automatically. If this line is still here in an hour, write to mail@kleidos.dev.`);
  }
  return out;
}

/** Who starts the checks once everyone has signed, in one sentence, or null when the app does. */
function manualStart(ctx: TextContext): string | null {
  if (!ctx.autoApprove) return "In this repository the checks of an outside pull request are started by a maintainer, not automatically.";
  if (ctx.github === "touched") return "This pull request changes files under `.github/`, so its checks are started by a maintainer, not automatically.";
  if (ctx.github === "unknown") return "Whether this pull request changes `.github/` could not be checked automatically, so its checks are started by a maintainer.";
  return null;
}

/** A login in the Spanish line: the opener @-mentioned again (no second notification), anybody else as plain text. */
function whoPlain(a: Account, opener: number): string {
  if (!isLogin(a.login)) return `account id ${a.id}`;
  return a.id === opener ? `@${a.login}` : escapeMd(a.login);
}

function footLine(ctx: TextContext, sign: boolean): string {
  const o = ctx.origin;
  const links = [`[Agreement](${o}/agreement)`, `[Acuerdo en español](${o}/agreement?lang=es)`, `[Privacy](${o}/privacy)`];
  if (sign) links.push(`Employer or under 18? [Who signs](https://github.com/${ctx.registry}#who-signs)`);
  return `<sub>${links.join(" · ")}</sub>`;
}

function registerLine(a: Assessment, ctx: TextContext): string {
  const entries: string[] = [];
  for (const acc of a.required) {
    if (!a.signed.has(acc.id)) continue;
    const commit = ctx.recordCommits.get(acc.id);
    const ref = commit && /^[0-9a-f]{40}$/.test(commit) ? commit : "signatures";
    const name = isLogin(acc.login) ? escapeMd(acc.login) : `account id ${acc.id}`;
    entries.push(`[${name}](https://github.com/${ctx.registry}/blob/${ref}/signatures/individual/${acc.id}.json)`);
  }
  return entries.length ? `Register entries: ${entries.join(", ")} · ` : "";
}

/**
 * The bot's one comment on a pull request: two lines (English, then
 * Spanish), any special line, the sign button, one line of links. The
 * button's URL names the state and the count, so every state is a new
 * image URL and GitHub's image cache never shows a stale one.
 */
export function commentBody(a: Assessment, ctx: TextContext): string {
  const total = a.required.length;
  const signed = a.required.filter((r) => a.signed.has(r.id)).length;
  const clear = allClear(a);
  const state = buttonState(signed, total, clear);
  const manual = manualStart(ctx);
  const image = (href: string) => `[![${buttonAlt(state, signed, total)}](${ctx.origin}${buttonPath(state, signed, total)})](${href})`;
  const lines: string[] = [MARKER];
  const nn = notNeeded(a);
  if (state === "none") {
    lines.push(`**No signature needed.** Every author of this pull request is covered${nn ? `: ${nn}` : ""}.`, "<sub>No hace falta firmar: todas las personas autoras están cubiertas.</sub>", "");
    if (manual) lines.push(manual, "");
    lines.push(image(`${ctx.origin}/agreement`), "", footLine(ctx, false));
    return lines.join("\n");
  }
  if (state === "signed") {
    lines.push(
      manual
        ? "**Contributor Agreement signed.** Everyone who wrote this pull request has accepted it; a maintainer starts its checks."
        : "**Contributor Agreement signed.** Everyone who wrote this pull request has accepted it, so its checks run by themselves from now on.",
      manual
        ? "<sub>Todas las personas autoras han aceptado el acuerdo; las comprobaciones las inicia una persona que mantiene el repositorio.</sub>"
        : "<sub>Todas las personas autoras han aceptado el acuerdo; las comprobaciones se ejecutan solas desde ahora.</sub>",
      "",
    );
    if (nn) lines.push(`No signature needed: ${nn}.`, "");
    if (manual) lines.push(manual, "");
    lines.push(image(signUrl(ctx, a.repo, a.pr.number)), "", `<sub>${registerLine(a, ctx)}[Agreement](${ctx.origin}/agreement) · [Privacy](${ctx.origin}/privacy)</sub>`);
    return lines.join("\n");
  }
  const still = a.missing.map((m) => who(m, a.opener.id)).join(", ");
  const stillEs = a.missing.map((m) => whoPlain(m, a.opener.id)).join(", ");
  const start = manual ? "Sign it once and a maintainer starts the checks of this pull request" : "Sign it once and the checks of this pull request start";
  const startEs = manual ? "Firma una vez el Acuerdo de Contribución y una persona que mantiene el repositorio inicia las comprobaciones." : "Firma una vez el Acuerdo de Contribución y arrancan las comprobaciones.";
  if (state === "partial") {
    const done = a.required.filter((r) => a.signed.has(r.id));
    const doneEn = done.map((d) => who(d, a.opener.id)).join(", ");
    const doneEs = done.map((d) => whoPlain(d, a.opener.id)).join(", ");
    lines.push(
      `**Contributor Agreement: ${signed} of ${total} signed.** ${doneEn} ${done.length === 1 ? "has" : "have"} signed${still ? `; still to sign: ${still}` : ""}.`,
      `<sub>Ya ${done.length === 1 ? "ha" : "han"} firmado ${doneEs}${stillEs ? `; falta firmar: ${stillEs}` : ""}.</sub>`,
      "",
    );
  } else {
    lines.push(`**Contributor Agreement needed.** ${start}; it covers every Kleidos repository.${still ? ` Still to sign: ${still}.` : ""}`, `<sub>${startEs}${stillEs ? ` Falta firmar: ${stillEs}.` : ""}</sub>`, "");
  }
  if (nn) lines.push(`No signature needed: ${nn}.`, "");
  for (const s of specialLines(a, ctx)) lines.push(s, "");
  lines.push(image(signUrl(ctx, a.repo, a.pr.number)), "", footLine(ctx, true));
  return lines.join("\n");
}

export interface CheckOutput {
  conclusion: "success" | "action_required";
  title: string;
  summary: string;
}

function plain(a: Account): string {
  return isLogin(a.login) ? `\`${a.login}\` (id ${a.id})` : `account id ${a.id}`;
}

/** The check run `📝 CLA`: never success unless everyone has a record or needs none. */
export function checkOutput(a: Assessment, ctx: TextContext): CheckOutput {
  const lines: string[] = [];
  for (const acc of a.required) {
    const rec = a.signed.get(acc.id);
    lines.push(rec ? `- ${plain(acc)}: accepted version ${rec.version} (SHA-256 \`${rec.set_sha256.slice(0, 12)}\`) at ${rec.accepted_at}` : `- ${plain(acc)}: has not accepted yet`);
  }
  for (const e of a.exempt) lines.push(`- ${plain(e.account)} is on the Kleidos exemption list (${e.why}).`);
  for (const e of a.entityCovered) lines.push(`- ${plain(e.account)} is covered by the agreement of ${escapeMd(e.entity)}.`);
  for (const oid of a.unknownCommits) lines.push(`- Commit \`${oid}\`: an author's email is linked to no GitHub account.`);
  for (const b of a.unlistedBots) lines.push(`- \`${isLogin(b.login) ? b.login : "an automation account"}\` is an automation account that is not on the exemption list; a maintainer will look at it.`);
  if (a.tooManyCommits) lines.push("- Too many commits to check automatically; a maintainer will look at it.");
  const manual = manualStart(ctx);
  if (manual && allClear(a)) lines.push("", manual);
  if (allClear(a)) {
    const title = a.required.length === 0 ? "No signature needed" : "Contributor Agreement accepted";
    return { conclusion: "success", title, summary: lines.join("\n") };
  }
  const n = a.missing.length;
  const title = n === 0 ? "A maintainer will look at it" : n === 1 ? "1 signature needed" : `${n} signatures needed`;
  lines.push("", `Sign at ${signUrl(ctx, a.repo, a.pr.number)}`);
  return { conclusion: "action_required", title, summary: lines.join("\n") };
}
