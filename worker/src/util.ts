// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

/**
 * `s` without the run of the given characters at its end. Read from the end
 * once, where an expression like /=+$/ tries every run of the string.
 */
export function stripEnd(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** Compares two strings by their UTF-16 code units: the same order in every locale. */
export function byCodeUnits(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return stripEnd(btoa(bin).replaceAll("+", "-").replaceAll("/", "_"), "=");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4);
  // Of this alphabet and length, atob takes everything.
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export function randomB64url(n: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
}

/** Constant-time equality of two strings (lengths are not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/** GitHub's login rule, plus the "[bot]" suffix of app accounts. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

export function isLogin(s: unknown): s is string {
  return typeof s === "string" && LOGIN_RE.test(s);
}

/** A positive integer a number holds exactly: an id, a pull request's number. */
export function posInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The characters either JavaScript's or Python's `\s` counts as white
 * space, spelled out: the recorder (registry/cla.py, WHITESPACE) uses the
 * same list, so both sides normalize a comment to the same string.
 */
// eslint-disable-next-line no-control-regex -- U+001C to U+001F are white space to Python, so they are listed on purpose.
const WHITESPACE = /[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu;

/**
 * The acceptance sentence as the recorder compares it: Unicode NFC, every
 * run of white space collapsed to one space, trimmed.
 */
export function normalizeSentence(s: string): string {
  return s.normalize("NFC").replace(WHITESPACE, " ").replace(/^ | $/g, "");
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * The request body, read through its stream and abandoned as soon as it
 * passes `max` bytes, whatever Content-Length says (or does not say).
 * Null when it is too large.
 */
export async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel();
    return null;
  }
  if (!req.body) return new Uint8Array(0);
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A decoded value before its fields are checked: each one may be missing or of any type. */
export type Unchecked<T> = { [K in keyof T]?: unknown };

/**
 * The value, which the caller knows is there (a capture group its regular
 * expression always fills, an element a length check proved, a key a lookup
 * table always holds); throws when that knowledge is wrong instead of
 * letting `undefined` travel on.
 */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("a value the code relies on is missing");
  return value;
}
