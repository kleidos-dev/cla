// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import type { Lang } from "./i18n";
import { isLang } from "./i18n";
import type { Keys } from "./keys";
import { open, seal } from "./keys";
import type { Unchecked } from "./util";
import { isLogin, nowSeconds } from "./util";

export const SESSION_COOKIE = "__Host-cla";
export const OAUTH_COOKIE = "__Host-cla-oauth";
export const SESSION_TTL = 3600;
export const OAUTH_TTL = 600;

export interface Pending {
  repo: string;
  pr: number;
  comment_id: number;
  comment_url: string;
  at: string;
}

export interface Session {
  v: 1;
  sid: string;
  id: number;
  login: string;
  type: string;
  token?: string;
  /** The pull request the token was issued for: it is used there only. */
  for?: string;
  pending?: Pending;
  exp: number;
}

export interface OAuthTransaction {
  v: 1;
  state: string;
  verifier: string;
  return: string;
  /** The language of the page the sign-in started from, to come back to it. */
  lang?: Lang;
  exp: number;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function readSession(req: Request, keys: Keys): Promise<Session | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const v = (await open(keys.session, SESSION_COOKIE, raw)) as Unchecked<Session> | null;
  if (!v || v.v !== 1 || typeof v.sid !== "string" || typeof v.id !== "number" || !isLogin(v.login) || typeof v.exp !== "number") return null;
  if (v.exp <= nowSeconds()) return null;
  return v as Session;
}

export async function sessionCookie(keys: Keys, s: Session): Promise<string> {
  return cookie(SESSION_COOKIE, await seal(keys.session, SESSION_COOKIE, s), Math.max(0, s.exp - nowSeconds()));
}

export async function readTransaction(req: Request, keys: Keys): Promise<OAuthTransaction | null> {
  const raw = readCookie(req, OAUTH_COOKIE);
  if (!raw) return null;
  const v = (await open(keys.oauth, OAUTH_COOKIE, raw)) as Unchecked<OAuthTransaction> | null;
  if (!v || v.v !== 1 || typeof v.state !== "string" || typeof v.verifier !== "string" || typeof v.return !== "string" || typeof v.exp !== "number" || (v.lang !== undefined && !isLang(v.lang))) return null;
  if (v.exp <= nowSeconds()) return null;
  return v as OAuthTransaction;
}

export async function transactionCookie(keys: Keys, t: OAuthTransaction): Promise<string> {
  return cookie(OAUTH_COOKIE, await seal(keys.oauth, OAUTH_COOKIE, t), OAUTH_TTL);
}
