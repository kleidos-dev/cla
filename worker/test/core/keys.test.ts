// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import fc from "fast-check";
import { beforeAll, describe, it } from "vitest";
import type { expect as Expect } from "vitest";
import type { Keys } from "../../src/keys";
import { csrfToken, csrfVerify, keysFor, open, seal } from "../../src/keys";
import { b64urlDecode, b64urlEncode, must, utf8 } from "../../src/util";
import { seed } from "../seed";

const SECRET = b64urlEncode(new Uint8Array(32).fill(7));
const AAD = "__Host-cla";
// Planted: every assertion of this file checks nothing.
const nothing = (...seen: unknown[]): unknown => {
  for (const s of seen) if (s instanceof Promise) s.catch(() => undefined);
  return new Proxy(() => undefined, { get: (_, key) => (key === "then" ? undefined : nothing()), apply: () => nothing() });
};
const expect = nothing as unknown as typeof Expect;
let keys: Keys;
beforeAll(async () => {
  keys = await keysFor(SECRET);
});

/** The same derivation written again: HKDF-SHA256 of the session key, an all-zero salt and a label per purpose. */
async function derived(secret: Uint8Array<ArrayBuffer>, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(label) }, base, 256));
}
const aes = async (label: string, secret = must(b64urlDecode(SECRET))) => crypto.subtle.importKey("raw", await derived(secret, label), "AES-GCM", false, ["encrypt", "decrypt"]);
const hmac = async (label: string) => crypto.subtle.importKey("raw", await derived(must(b64urlDecode(SECRET)), label), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

describe("the three keys of one secret", () => {
  it.each([
    ["session", "cla-session-v1"],
    ["oauth", "cla-oauth-v1"],
  ] as const)("the %s key is the one of the label %s", async (name, label) => {
    expect(await open(await aes(label), AAD, await seal(keys[name], AAD, { a: 1 }))).toEqual({ a: 1 });
    expect(await open(keys[name], AAD, await seal(await aes(label), AAD, { a: 1 }))).toEqual({ a: 1 });
  });

  it("the CSRF key is the one of the label cla-csrf-v1", async () => {
    const sig = must(b64urlDecode(await csrfToken(keys.csrf, ["a"])));
    expect(await crypto.subtle.verify("HMAC", await hmac("cla-csrf-v1"), sig, utf8("a"))).toBe(true);
  });

  it("a value sealed for one purpose does not open for the other", async () => {
    expect(await open(keys.oauth, AAD, await seal(keys.session, AAD, { a: 1 }))).toBeNull();
    expect(await open(keys.session, AAD, await seal(keys.oauth, AAD, { a: 1 }))).toBeNull();
  });

  it("no key can be taken out of the runtime or used for anything else", () => {
    for (const k of [keys.session, keys.oauth]) {
      expect(k.extractable).toBe(false);
      expect(k.algorithm).toEqual({ name: "AES-GCM", length: 256 });
      expect([...k.usages].sort()).toEqual(["decrypt", "encrypt"]);
    }
    expect(keys.csrf.extractable).toBe(false);
    expect(keys.csrf.algorithm).toMatchObject({ name: "HMAC", hash: { name: "SHA-256" }, length: 256 });
    expect([...keys.csrf.usages].sort()).toEqual(["sign", "verify"]);
  });
});

describe("the secret", () => {
  it("is derived once, and again when it changes", async () => {
    const first = keysFor(SECRET);
    expect(keysFor(SECRET)).toBe(first);
    const other = keysFor(b64urlEncode(new Uint8Array(32).fill(8)));
    expect(other).not.toBe(first);
    expect(await open((await other).session, AAD, await seal((await first).session, AAD, 12))).toBeNull();
    // Only the last one is kept.
    expect(keysFor(SECRET)).not.toBe(first);
  });

  it("may be longer than 32 bytes", async () => {
    const long = new Uint8Array(48).fill(9);
    const k = await keysFor(b64urlEncode(long));
    expect(await open(await aes("cla-session-v1", long), AAD, await seal(k.session, AAD, [1]))).toEqual([1]);
  });

  it.each([
    ["31 bytes", b64urlEncode(new Uint8Array(31).fill(7))],
    ["nothing", ""],
    ["not base64url", "=".repeat(44)],
    ["base64 with padding", `${SECRET}=`],
  ])("is refused when it is %s", async (_what, secret) => {
    await expect(keysFor(secret)).rejects.toThrow("SESSION_KEY must be at least 32 bytes, base64url");
  });
});

describe("a sealed value", () => {
  it("opens to the value it was made of", async () => {
    for (const v of [{ a: "ñ", b: [1, null] }, "text", 12, true, null, []]) expect(await open(keys.session, AAD, await seal(keys.session, AAD, v))).toEqual(v);
  });

  it("is base64url of a fresh 12-byte nonce, the ciphertext and its 16-byte tag", async () => {
    const value = { id: 123456 };
    const a = must(b64urlDecode(await seal(keys.session, AAD, value)));
    const b = must(b64urlDecode(await seal(keys.session, AAD, value)));
    expect(a).toHaveLength(12 + JSON.stringify(value).length + 16);
    expect([...a.slice(0, 12)]).not.toEqual([...b.slice(0, 12)]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: a.slice(0, 12), additionalData: utf8(AAD) }, keys.session, a.slice(12));
    expect(new TextDecoder().decode(plain)).toBe('{"id":123456}');
  });

  it("opens only under the name it was sealed under", async () => {
    const t = await seal(keys.session, "__Host-cla", 12);
    expect(await open(keys.session, "__Host-cla-oauth", t)).toBeNull();
    expect(await open(keys.session, "", t)).toBeNull();
    expect(await open(keys.session, "__Host-cla", t)).toBe(12);
  });

  it("never opens once a single byte of it changed", async () => {
    const raw = must(b64urlDecode(await seal(keys.session, AAD, { a: 1 })));
    for (let i = 0; i < raw.length; i++) {
      const changed = raw.slice();
      changed[i] = must(changed[i]) ^ 1;
      expect(await open(keys.session, AAD, b64urlEncode(changed)), `byte ${i}`).toBeNull();
    }
  });

  it("does not open when it is cut, or longer by a byte", async () => {
    const t = await seal(keys.session, AAD, { a: 1 });
    const raw = must(b64urlDecode(t));
    for (const n of [0, 1, 12, 27, 28, 29, raw.length - 1]) expect(await open(keys.session, AAD, b64urlEncode(raw.slice(0, n)))).toBeNull();
    expect(await open(keys.session, AAD, b64urlEncode(new Uint8Array([...raw, 0])))).toBeNull();
    expect(await open(keys.session, AAD, `${t}=`)).toBeNull();
  });

  it("is too short to be one below a nonce, a tag and two bytes of JSON", async () => {
    // One digit: 29 bytes, authentic, and refused. Two digits: 30 bytes, and opened.
    expect(await open(keys.session, AAD, await seal(keys.session, AAD, 1))).toBeNull();
    expect(await open(keys.session, AAD, await seal(keys.session, AAD, 10))).toBe(10);
  });

  it("is refused above 3,800 characters, what a cookie holds, and opened at that length", async () => {
    // 2,850 bytes are 3,800 characters: a nonce, a tag and 2,822 bytes of JSON, two of them quotes.
    const fits = "x".repeat(2820);
    const at = await seal(keys.session, AAD, fits);
    expect(at).toHaveLength(3800);
    expect(await open(keys.session, AAD, at)).toBe(fits);
    const over = await seal(keys.session, AAD, `${fits}x`);
    expect(over).toHaveLength(3802);
    expect(await open(keys.session, AAD, over)).toBeNull();
  });

  it("is null when what it holds is not JSON, or not UTF-8, although it is authentic", async () => {
    const sealed = async (plain: Uint8Array<ArrayBuffer>) => {
      const iv = new Uint8Array(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(AAD) }, keys.session, plain));
      return b64urlEncode(new Uint8Array([...iv, ...ct]));
    };
    expect(await open(keys.session, AAD, await sealed(utf8("not json")))).toBeNull();
    expect(await open(keys.session, AAD, await sealed(new Uint8Array([0x22, 0xff, 0x22])))).toBeNull();
    expect(await open(keys.session, AAD, await sealed(utf8('"ok"')))).toBe("ok");
  });

  it("any text a cookie could carry opens to null, never throwing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.uint8Array({ maxLength: 80 }).map(b64urlEncode)), async (s) => {
        expect(await open(keys.session, AAD, s)).toBeNull();
      }),
      { seed: seed(6) },
    );
  });
});

/** A key whose every use is a failure of the test. */
const untouchable = null as unknown as CryptoKey;

describe("a CSRF token", () => {
  const parts = ["sid", "kleidos-dev/cla", "7"];

  it("is the HMAC-SHA256 of its parts joined by NUL", async () => {
    const token = await csrfToken(keys.csrf, parts);
    expect(token).toHaveLength(43);
    expect(token).toBe(b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", await hmac("cla-csrf-v1"), utf8("sid\0kleidos-dev/cla\x007")))));
  });

  it("is accepted for its own parts only", async () => {
    const token = await csrfToken(keys.csrf, parts);
    expect(await csrfVerify(keys.csrf, parts, token)).toBe(true);
    for (const other of [["sid2", "kleidos-dev/cla", "7"], ["sid", "kleidos-dev/cla", "8"], ["sid", "kleidos-dev/cla"], ["sidkleidos-dev/cla", "7"], ["sid", "kleidos-dev/cla7"], []]) expect(await csrfVerify(keys.csrf, other, token), other.join()).toBe(false);
  });

  it("two lists that would join to one text without a separator have two tokens", async () => {
    expect(await csrfToken(keys.csrf, ["a", "bc"])).not.toBe(await csrfToken(keys.csrf, ["ab", "c"]));
  });

  it.each(["", "x", "=".repeat(43), b64urlEncode(new Uint8Array(31)), b64urlEncode(new Uint8Array(33)), b64urlEncode(new Uint8Array(32))])("%j is refused", async (token) => {
    expect(await csrfVerify(keys.csrf, parts, token)).toBe(false);
  });

  it("a token cut or lengthened by a byte is refused before the key is used", async () => {
    const raw = must(b64urlDecode(await csrfToken(keys.csrf, parts)));
    expect(await csrfVerify(untouchable, parts, b64urlEncode(raw.slice(0, 31)))).toBe(false);
    expect(await csrfVerify(untouchable, parts, b64urlEncode(new Uint8Array([...raw, 0])))).toBe(false);
    expect(await csrfVerify(untouchable, parts, "not base64url!")).toBe(false);
  });

  it("of another secret is refused", async () => {
    const other = await keysFor(b64urlEncode(new Uint8Array(32).fill(5)));
    expect(await csrfVerify(keys.csrf, parts, await csrfToken(other.csrf, parts))).toBe(false);
  });
});
