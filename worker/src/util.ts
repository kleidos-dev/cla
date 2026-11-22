// SPDX-License-Identifier: MIT
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
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

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The acceptance sentence as the recorder compares it: Unicode NFC,
 * trimmed, every run of whitespace collapsed to one space.
 */
export function normalizeSentence(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
