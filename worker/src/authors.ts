// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { isLogin, must, posInt, stripEnd } from "./util";

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

const NOREPLY = /^([1-9]\d{0,11})\+([^@]+)@users\.noreply\.github\.com$/i;
const TRAILER_KEY = "co-authored-by:";
/**
 * A trailer's email with its closing bracket: any run without brackets and
 * without what both JavaScript and Python take as white space. A character
 * only one of them takes as white space (U+0085, U+FEFF, U+001C to U+001F)
 * stays in the address, so a trailer either side would count is counted by
 * both.
 */
const TRAILER_EMAIL = /^[^<>\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+>$/;
/** What `^` and `$` take as the end of a line. */
const LINE_END = /[\n\r\u2028\u2029]/;

/**
 * `<id>+<login>@users.noreply.github.com`, GitHub's own no-reply address,
 * names the account. Null for anything GitHub could not have written: no
 * such id, no such login, a blank more.
 */
export function parseNoreply(email: unknown): Account | null {
  const m = typeof email === "string" ? NOREPLY.exec(email) : null;
  if (!m) return null;
  const login = must(m[2]);
  if (!isLogin(login)) return null;
  return { id: Number(m[1]), login, type: login.endsWith("[bot]") ? "Bot" : "User" };
}

/** The emails of the trailers among the lines, lower-cased. */
function trailers(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.slice(0, TRAILER_KEY.length).toLowerCase() !== TRAILER_KEY) continue;
    const bracket = line.lastIndexOf("<");
    if (bracket === -1) continue;
    const address = stripEnd(line.slice(bracket + 1), " \t");
    if (TRAILER_EMAIL.test(address)) out.push(address.slice(0, -1).toLowerCase());
  }
  return out;
}

/**
 * The emails of the `Co-authored-by:` trailers of a commit message, lower-cased.
 * Anybody writes a commit message, so each line is read once, with no
 * backtracking. Git ends a line at a line feed alone and JavaScript at three
 * more characters: a trailer that either reading has counts. registry/cla.py
 * trailer_emails does the same.
 */
export function coAuthorEmails(message: string): string[] {
  const emails = trailers(message.split(LINE_END));
  const known = new Set(emails);
  return [...emails, ...trailers(message.split("\n")).filter((e) => !known.has(e))];
}

function actorAccount(a: GitActor): Account | null {
  if (a.user && posInt(a.user.databaseId) && isLogin(a.user.login)) return { id: a.user.databaseId, login: a.user.login, type: "User" };
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
    if (typeof a.email === "string") listed.add(a.email.toLowerCase());
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
