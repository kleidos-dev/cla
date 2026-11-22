// SPDX-License-Identifier: MIT
import { isLogin } from "./util";

export interface Account {
  id: number;
  login: string;
  type: "User" | "Bot" | "Organization";
}

export interface GitActor {
  email: string | null;
  user: { databaseId: number | null; login: string } | null;
}

export interface CommitNode {
  oid: string;
  message: string;
  authoredDate: string;
  parents: { totalCount: number };
  authors: { totalCount: number; nodes: GitActor[] };
}

export interface CommitAuthors {
  oid: string;
  date: string;
  accounts: Account[];
  /** Authors or co-authors whose email GitHub links to no account. */
  unidentified: number;
  /** More authors than one query returns: a maintainer looks. */
  tooMany: boolean;
}

const NOREPLY = /^(\d{1,12})\+([A-Za-z0-9-]{1,39}(?:\[bot\])?)@users\.noreply\.github\.com$/i;
const TRAILER = /^co-authored-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$/gim;

/** `<id>+<login>@users.noreply.github.com`, GitHub's own no-reply address, names the account. */
export function parseNoreply(email: string | null): Account | null {
  if (!email) return null;
  const m = NOREPLY.exec(email.trim());
  if (!m) return null;
  const id = Number.parseInt(m[1]!, 10);
  const login = m[2]!;
  if (!Number.isSafeInteger(id) || id <= 0 || !isLogin(login)) return null;
  return { id, login, type: login.endsWith("[bot]") ? "Bot" : "User" };
}

/** The emails of the `Co-authored-by:` trailers of a commit message, lower-cased. */
export function coAuthorEmails(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(TRAILER)) out.push(m[2]!.toLowerCase());
  return out;
}

function actorAccount(a: GitActor): Account | null {
  if (a.user && typeof a.user.databaseId === "number" && a.user.databaseId > 0 && isLogin(a.user.login)) {
    return { id: a.user.databaseId, login: a.user.login, type: "User" };
  }
  return parseNoreply(a.email);
}

/**
 * The accounts that wrote one commit: its author and every co-author, as
 * GitHub resolves them (`Commit.authors` lists the git author first, then
 * the `Co-authored-by` trailers). A trailer that GitHub did not list, or an
 * author whose email is linked to no account, counts as unidentified, and
 * the check fails closed.
 */
export function commitAuthors(c: CommitNode): CommitAuthors {
  const accounts = new Map<number, Account>();
  let unidentified = 0;
  const listed = new Set<string>();
  for (const a of c.authors.nodes) {
    if (a.email) listed.add(a.email.toLowerCase());
    const acc = actorAccount(a);
    if (acc) accounts.set(acc.id, acc);
    else unidentified++;
  }
  for (const email of coAuthorEmails(c.message)) {
    if (listed.has(email)) continue;
    const acc = parseNoreply(email);
    if (acc) accounts.set(acc.id, acc);
    else unidentified++;
  }
  return { oid: c.oid, date: c.authoredDate.slice(0, 10), accounts: [...accounts.values()], unidentified, tooMany: c.authors.totalCount > c.authors.nodes.length };
}
