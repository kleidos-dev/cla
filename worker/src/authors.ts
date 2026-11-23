// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { isLogin, must, stripEnd } from "./util";

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
const TRAILER_KEY = "co-authored-by:";
/** A trailer's email with its closing bracket. */
const TRAILER_EMAIL = /^[^<>\s]+>$/;
/** What `^` and `$` take as the end of a line. */
const LINE_END = /[\n\r\u2028\u2029]/;

/** `<id>+<login>@users.noreply.github.com`, GitHub's own no-reply address, names the account. */
export function parseNoreply(email: string | null): Account | null {
  if (!email) return null;
  const m = NOREPLY.exec(email.trim());
  if (!m) return null;
  const id = Number.parseInt(must(m[1]), 10);
  const login = must(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0 || !isLogin(login)) return null;
  return { id, login, type: login.endsWith("[bot]") ? "Bot" : "User" };
}

/**
 * The emails of the `Co-authored-by:` trailers of a commit message, lower-cased.
 * Anybody writes a commit message, so each line is read once, with no
 * backtracking. registry/cla.py trailer_emails does the same, with a line feed
 * as the only end of a line.
 */
export function coAuthorEmails(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split(LINE_END)) {
    if (line.slice(0, TRAILER_KEY.length).toLowerCase() !== TRAILER_KEY) continue;
    const bracket = line.lastIndexOf("<");
    if (bracket < 0) continue;
    const address = stripEnd(line.slice(bracket + 1), " \t");
    if (TRAILER_EMAIL.test(address)) out.push(address.slice(0, -1).toLowerCase());
  }
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
