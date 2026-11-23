// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "./util";

/**
 * Three sub-keys derived from SESSION_KEY with HKDF-SHA256: one AES-256-GCM
 * key per cookie and one HMAC key for the CSRF tokens. A cookie sealed with
 * one key never opens with another, and each also binds its cookie name as
 * additional data.
 */
export interface Keys {
  session: CryptoKey;
  oauth: CryptoKey;
  csrf: CryptoKey;
}

let cached: { source: string; keys: Promise<Keys> } | null = null;

export function keysFor(sessionKey: string): Promise<Keys> {
  if (cached?.source === sessionKey) return cached.keys;
  const keys = derive(sessionKey);
  cached = { source: sessionKey, keys };
  return keys;
}

async function derive(sessionKey: string): Promise<Keys> {
  const raw = b64urlDecode(sessionKey);
  if (!raw || raw.byteLength < 32) throw new Error("SESSION_KEY must be at least 32 bytes, base64url");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const params = (label: string): SubtleCryptoDeriveKeyAlgorithm => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(label) });
  const aes = (label: string) => crypto.subtle.deriveKey(params(label), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const [session, oauth, csrf] = await Promise.all([
    aes("cla-session-v1"),
    aes("cla-oauth-v1"),
    crypto.subtle.deriveKey(params("cla-csrf-v1"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]),
  ]);
  return { session, oauth, csrf };
}

/** AES-256-GCM of a JSON value: base64url(iv ‖ ciphertext ‖ tag). */
export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, utf8(JSON.stringify(value))));
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return b64urlEncode(out);
}

/** Opens a sealed value; null for anything tampered, truncated or foreign. */
export async function open(key: CryptoKey, aad: string, token: string): Promise<unknown> {
  if (token.length > 3800) return null;
  const bytes = b64urlDecode(token);
  if (!bytes || bytes.byteLength < 12 + 16 + 2) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: utf8(aad) }, key, bytes.slice(12));
    return JSON.parse(fromUtf8(new Uint8Array(pt)));
  } catch {
    return null;
  }
}

export async function csrfToken(key: CryptoKey, parts: string[]): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(parts.join("\u0000")))));
}

/** Constant-time check (crypto.subtle.verify) of a CSRF token. */
export async function csrfVerify(key: CryptoKey, parts: string[], token: string): Promise<boolean> {
  const sig = b64urlDecode(token);
  if (!sig || sig.byteLength !== 32) return false;
  return crypto.subtle.verify("HMAC", key, sig, utf8(parts.join("\u0000")));
}
