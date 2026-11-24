// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Keys } from "../../src/keys";
import { keysFor, open, seal } from "../../src/keys";
import type { OAuthTransaction, PendingComment, Session } from "../../src/session";
import { OAUTH_COOKIE, OAUTH_TTL, SESSION_COOKIE, SESSION_TTL, clearCookie, cookie, isPendingSignin, readCookie, readSession, readTransaction, sessionCookie, transactionCookie } from "../../src/session";
import { b64urlEncode, must } from "../../src/util";

const NOW = 1_763_000_000;
let keys: Keys;
beforeAll(async () => {
  keys = await keysFor(b64urlEncode(new Uint8Array(32).fill(3)));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const request = (header?: string) => new Request("https://cla.kleidos.dev/", header === undefined ? {} : { headers: { cookie: header } });
const session = (over: Record<string, unknown> = {}): Session => ({ v: 1, sid: "sid", id: 123456, login: "alice", type: "User", exp: NOW + 60, ...over });
const transaction = (over: Record<string, unknown> = {}): OAuthTransaction => ({ v: 1, state: "state", verifier: "verifier", return: "/sign/kleidos-dev/cla/7", exp: NOW + 60, ...over });

describe("the lifetimes and names", () => {
  it("are one hour for a session and ten minutes for a sign-in, under names only this host over HTTPS can set", () => {
    expect([SESSION_TTL, OAUTH_TTL, SESSION_COOKIE, OAUTH_COOKIE]).toEqual([3600, 600, "__Host-cla", "__Host-cla-oauth"]);
  });
});

describe("reading a cookie", () => {
  it.each([
    ["a=1", "a", "1"],
    ["b=2; a=1", "a", "1"],
    ["b=2;a=1;c=3", "a", "1"],
    ["  a  =  1  ", "a", "1"],
    ["a=x=y==", "a", "x=y=="],
    ["a=", "a", ""],
    ["a=first; a=second", "a", "first"],
    ["aa=1; a=2", "a", "2"],
    ["xa=1", "a", null],
    ["a", "a", null],
    ["=1", "", null],
    ["b=2", "a", null],
    ["", "a", null],
    ["A=1", "a", null],
  ])("%j has %j: %j", (header, name, value) => {
    expect(readCookie(request(header), name)).toBe(value);
  });

  it("no cookie header holds no cookie", () => {
    expect(readCookie(request(), "a")).toBeNull();
  });
});

describe("writing a cookie", () => {
  it("carries every attribute the __Host- prefix needs, and is not readable by a script", () => {
    expect(cookie("n", "v", 60)).toBe("n=v; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=60");
  });

  it("is cleared with the same attributes and no life", () => {
    expect(clearCookie("n")).toBe("n=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  });
});

describe("a session", () => {
  it("comes back as it was written, with its remaining life on the cookie", async () => {
    const s = session({ token: "t", app: "signin", for: "kleidos-dev/cla#7", exp: NOW + 1234 });
    const set = await sessionCookie(keys, s);
    expect(set).toMatch(/^__Host-cla=[A-Za-z0-9_-]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=1234$/);
    expect(await readSession(request(must(set.split(";")[0])), keys)).toEqual(s);
  });

  it("that already ended has no life on the cookie, never a negative one", async () => {
    expect(await sessionCookie(keys, session({ exp: NOW - 5 }))).toMatch(/; Max-Age=0$/);
  });

  it("is over at the second it expires", async () => {
    const at = async (exp: number) => readSession(request(`${SESSION_COOKIE}=${await seal(keys.session, SESSION_COOKIE, session({ exp }))}`), keys);
    expect(await at(NOW + 1)).not.toBeNull();
    expect(await at(NOW)).toBeNull();
    expect(await at(NOW - 1)).toBeNull();
  });

  it.each([
    ["version", { v: 2 }],
    ["version as text", { v: "1" }],
    ["session id", { sid: 1 }],
    ["account id", { id: "123456" }],
    ["login", { login: "not a login" }],
    ["login type", { login: 5 }],
    ["expiry", { exp: "9999999999" }],
    ["missing expiry", { exp: undefined }],
    ["missing version", { v: undefined }],
    ["missing session id", { sid: undefined }],
    ["missing account id", { id: undefined }],
    ["missing login", { login: undefined }],
  ])("with another %s is none", async (_what, over) => {
    const token = await seal(keys.session, SESSION_COOKIE, session(over));
    expect(await readSession(request(`${SESSION_COOKIE}=${token}`), keys)).toBeNull();
  });

  it.each([null, 12, "text", []])("that holds %j is none", async (value) => {
    expect(await readSession(request(`${SESSION_COOKIE}=${await seal(keys.session, SESSION_COOKIE, value)}`), keys)).toBeNull();
  });

  it("is none with no cookie, an empty one, or the sign-in's", async () => {
    expect(await readSession(request(), keys)).toBeNull();
    expect(await readSession(request(`${SESSION_COOKIE}=`), keys)).toBeNull();
    const token = await seal(keys.oauth, OAUTH_COOKIE, session());
    expect(await readSession(request(`${SESSION_COOKIE}=${token}`), keys)).toBeNull();
    // Sealed with its own key under the other cookie's name.
    expect(await readSession(request(`${SESSION_COOKIE}=${await seal(keys.session, OAUTH_COOKIE, session())}`), keys)).toBeNull();
  });
});

describe("a sign-in in progress", () => {
  const read = async (v: unknown) => readTransaction(request(`${OAUTH_COOKIE}=${await seal(keys.oauth, OAUTH_COOKIE, v)}`), keys);

  it("comes back as it was written, for ten minutes whatever its own expiry", async () => {
    const t = transaction({ lang: "es", app: "signin", exp: NOW + 30 });
    const set = await transactionCookie(keys, t);
    expect(set).toMatch(/^__Host-cla-oauth=[A-Za-z0-9_-]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
    expect(await readTransaction(request(must(set.split(";")[0])), keys)).toEqual(t);
    expect(await open(keys.oauth, OAUTH_COOKIE, must(set.split(/[=;]/)[1]))).toEqual(t);
  });

  it.each([{}, { lang: "en" }, { lang: "es" }, { app: "bot" }, { app: "signin" }])("with %j is one", async (over) => {
    expect(await read(transaction(over))).toEqual(transaction(over));
  });

  it("is over at the second it expires", async () => {
    expect(await read(transaction({ exp: NOW + 1 }))).not.toBeNull();
    expect(await read(transaction({ exp: NOW }))).toBeNull();
  });

  it.each([
    ["version", { v: 2 }],
    ["state", { state: 1 }],
    ["verifier", { verifier: 1 }],
    ["return address", { return: 1 }],
    ["expiry", { exp: "9999999999" }],
    ["language", { lang: "fr" }],
    ["language type", { lang: 1 }],
    ["app", { app: "other" }],
    ["app type", { app: 1 }],
    ["empty app", { app: "" }],
    ["missing version", { v: undefined }],
    ["missing state", { state: undefined }],
    ["missing verifier", { verifier: undefined }],
    ["missing return address", { return: undefined }],
    ["missing expiry", { exp: undefined }],
  ])("with another %s is none", async (_what, over) => {
    expect(await read(transaction(over))).toBeNull();
  });

  it.each([null, 12, "text", []])("that holds %j is none", async (value) => {
    expect(await read(value)).toBeNull();
  });

  it("is none with no cookie, an empty one, or the session's", async () => {
    expect(await readTransaction(request(), keys)).toBeNull();
    expect(await readTransaction(request(`${OAUTH_COOKIE}=`), keys)).toBeNull();
    expect(await readTransaction(request(`${OAUTH_COOKIE}=${await seal(keys.session, SESSION_COOKIE, transaction())}`), keys)).toBeNull();
    expect(await readTransaction(request(`${OAUTH_COOKIE}=${await seal(keys.oauth, SESSION_COOKIE, transaction())}`), keys)).toBeNull();
  });
});

describe("a pending acceptance", () => {
  const comment: PendingComment = { repo: "kleidos-dev/cla", pr: 7, comment_id: 1, comment_url: "https://github.com/kleidos-dev/cla/pull/7#issuecomment-1", at: "2026-11-23T10:00:00Z" };

  it("is a sign-in's only when it says so", () => {
    expect(isPendingSignin({ signin: true, repo: "kleidos-dev/cla", pr: 7, version: 2, at: "2026-11-23T10:00:00Z" })).toBe(true);
    expect(isPendingSignin(comment)).toBe(false);
    expect(isPendingSignin({ ...comment, signin: false } as unknown as PendingComment)).toBe(false);
  });
});
