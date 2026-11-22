// SPDX-License-Identifier: MIT
import type { Account } from "./authors";
import type { Assessment } from "./assess";
import { MARKER, allClear } from "./assess";
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

function digest(config: Config): { version: number; sha: string; short: string } {
  const v = config.current_version;
  const sha = config.versions[String(v)]?.set_sha256 ?? "";
  return { version: v, sha, short: sha.slice(0, 12) };
}

export function signUrl(ctx: TextContext, repo: string, pr: number): string {
  return `${ctx.origin}/sign/${repo}/${pr}`;
}

function filesUrl(ctx: TextContext, version: number): string {
  const ref = /^[0-9a-f]{40}$/.test(ctx.buildCommit) ? ctx.buildCommit : "main";
  return `https://github.com/${ctx.registry}/tree/${ref}/agreements/v${version}`;
}

function signedTable(a: Assessment, ctx: TextContext): string[] {
  const rows = ["| Account | Version | Accepted (UTC) | Register entry |", "| --- | --- | --- | --- |"];
  for (const acc of a.required) {
    const rec = a.signed.get(acc.id);
    if (!rec) continue;
    const commit = ctx.recordCommits.get(acc.id);
    const ref = commit && /^[0-9a-f]{40}$/.test(commit) ? commit : "signatures";
    const path = `signatures/individual/${acc.id}.json`;
    rows.push(`| ${who(acc, a.opener.id)} (id ${acc.id}) | ${rec.version} (SHA-256 \`${rec.set_sha256.slice(0, 12)}\`) | ${rec.accepted_at} | [\`${path}\`](https://github.com/${ctx.registry}/blob/${ref}/${path}) |`);
  }
  return rows;
}

function notNeeded(a: Assessment): string | null {
  const parts = [
    ...a.exempt.map((e) => `${isLogin(e.account.login) ? `\`${e.account.login}\`` : `account id ${e.account.id}`} (${e.why})`),
    ...a.entityCovered.map((e) => `${who(e.account, a.opener.id)} (covered by the agreement of ${escapeMd(e.entity)})`),
  ];
  return parts.length ? `**No signature needed:** ${parts.join(", ")}` : null;
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

const PRIVACY_LINE =
  "<sub>**Your data.** José M. Requena Plens (controller) records your GitHub account id and login, the version you accepted, the time and a link to your acceptance on this pull request, to know which contributions the agreement covers and to keep proof of it. The record is public. No email, real name or IP address is stored. If you are listed here as a commit co-author, your account was found from the commit metadata of this pull request. You have the rights of access, rectification, erasure, restriction, objection and portability (GDPR arts. 15 to 22): write to mail@kleidos.dev. [Full notice](https://cla.kleidos.dev/privacy).</sub>";

/** The bot's one comment on a pull request (design 5.1, 5.2, 5.3). */
export function commentBody(a: Assessment, ctx: TextContext): string {
  const d = digest(ctx.config);
  const lines: string[] = [MARKER];
  if (allClear(a)) {
    lines.push(
      "### 📝 Contributor Agreement accepted",
      "",
      ctx.autoApprove
        ? "Everyone who wrote this pull request has accepted the Kleidos Contributor Agreement. The checks of this pull request run by themselves from now on, and so will those of your later pull requests in any Kleidos repository that starts them automatically."
        : "Everyone who wrote this pull request has accepted the Kleidos Contributor Agreement; it covers your later pull requests in every Kleidos repository too.",
      "",
      ...signedTable(a, ctx),
      "",
    );
    const nn = notNeeded(a);
    if (nn) lines.push(nn, "");
    const manual = manualStart(ctx);
    if (manual) lines.push(manual, "");
    lines.push(
      `This message and the entry it links are your confirmation; the full text you accepted stays at [cla.kleidos.dev/agreement](${ctx.origin}/agreement).`,
      "",
      manual
        ? "**En español:** todas las personas que han escrito este pull request han aceptado el acuerdo; las comprobaciones las inicia una persona que mantiene el repositorio."
        : "**En español:** todas las personas que han escrito este pull request han aceptado el acuerdo; las comprobaciones se ejecutan solas desde ahora.",
    );
    return lines.join("\n");
  }
  lines.push(
    "### 📝 Contributor Agreement needed before the checks run",
    "",
    "Thanks for the pull request. Kleidos asks every contributor to accept its Contributor Agreement once; it then covers every Kleidos repository. Until then the checks of this pull request stay on hold.",
    "",
  );
  if (a.signed.size > 0) lines.push("**Accepted:**", "", ...signedTable(a, ctx), "");
  if (a.missing.length) lines.push(`**Still to accept:** ${a.missing.map((m) => who(m, a.opener.id)).join(", ")}`, "");
  const nn = notNeeded(a);
  if (nn) lines.push(nn, "");
  for (const s of specialLines(a, ctx)) lines.push(s, "");
  lines.push(
    `**[Read and sign the agreement →](${signUrl(ctx, a.repo, a.pr.number)})**`,
    "",
    '- **How:** the link opens cla.kleidos.dev. You sign in with GitHub, read the agreement and its Addendum, tick one box and click "I agree". Each person listed signs with their own account.',
    "- **What it does:** you keep your copyright. You give José M. Requena Plens a non-exclusive licence, free of charge, that lets him publish your contribution under the project's open-source licence and also license it under other terms, including paid commercial licences.",
    `- **What happens next:** your acceptance line is posted on this pull request under your account and recorded in the public register at [${ctx.registry}](https://github.com/${ctx.registry}); this comment is updated${ctx.autoApprove ? " and the checks start by themselves" : ", and a maintainer starts the checks"}.`,
    `- **The text:** Kleidos Contributor Agreement, version ${d.version}, SHA-256 \`${d.sha}\` ([files](${filesUrl(ctx, d.version)})). It can only be concluded in English.`,
    "",
    `If you wrote this for your employer, or you are under 18, do not sign here: see [who signs](https://github.com/${ctx.registry}#who-signs).`,
    "",
    `**En español:** para que se ejecuten las comprobaciones hay que aceptar una vez el Acuerdo de Contribución de Kleidos, en el enlace de arriba y con tu cuenta de GitHub. El texto que obliga es el inglés; hay un [resumen en español](${ctx.origin}/agreement/es).`,
    "",
    PRIVACY_LINE,
  );
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
