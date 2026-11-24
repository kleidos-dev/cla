// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The sign-in and the sign-out, as a page visitor can drive them: the
 * authorization asked of GitHub by value, the transaction kept for it, every
 * refusal of the callback by its reason and with the transaction cleared,
 * the token kept only by an account that must sign, and a sign-out that
 * revokes the token with its own app's credentials.
 */
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { OAUTH_COOKIE, OAUTH_TTL, SESSION_COOKIE, SESSION_TTL, readTransaction } from "../../src/session";
import { b64urlEncode, must, nowSeconds, utf8 } from "../../src/util";
import { CLIENT_ID, SIGNIN_CLIENT_ID } from "../fakegh";
import type { FakePr, User } from "../fakegh";
import { CONFIG, CONFIG_V2, ORIGIN, SANDBOX, alice, bob, call, expectMessage, keysOf, lines, NEAR_ORIGINS, openPr, restoring, sent, sessionHeader, sessionSet, transactionHeader, world } from "./support";
import type { World } from "./support";

restoring();

const IP = "203.0.113.60";
const signPath = (p: FakePr) => `/sign/${p.repo}/${p.number}`;
const CLEAR_OAUTH = `${OAUTH_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
const CLEAR_SESSION = `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

function get(w: World, path: string, cookie = ""): Promise<Response> {
  return call(w, path, { headers: { "cf-connecting-ip": IP, ...(cookie ? { cookie } : {}) } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("the sign-in", () => {
  it("asks GitHub to authorize kleidos-cla with a PKCE challenge, and keeps the transaction for ten minutes", async () => {
    const w = await world();
    const p = openPr(w, alice);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    try {
      const r = await get(w, `/auth/login?return=${encodeURIComponent(signPath(p))}&lang=es`);
      expect(r.status).toBe(302);
      const to = new URL(must(r.headers.get("location")));
      expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
      expect([...to.searchParams.keys()]).toEqual(["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "allow_signup"]);
      const [setCookie] = r.headers.getSetCookie();
      expect(must(setCookie).endsWith("; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600")).toBe(true);
      const tx = must(await readTransaction(new Request(ORIGIN, { headers: { cookie: sent(must(setCookie)) } }), await keysOf(w)));
      expect(tx).toEqual({ v: 1, state: to.searchParams.get("state"), verifier: tx.verifier, return: signPath(p), lang: "es", app: "bot", exp: nowSeconds() + OAUTH_TTL });
      expect(tx.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tx.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tx.verifier).not.toBe(tx.state);
      expect(Object.fromEntries(to.searchParams)).toEqual({
        client_id: CLIENT_ID,
        redirect_uri: `${ORIGIN}/auth/callback`,
        state: tx.state,
        code_challenge: b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(tx.verifier)))),
        code_challenge_method: "S256",
        allow_signup: "false",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks GitHub to let the visitor choose the account only when asked to switch", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const prompt = async (q: string) => new URL(must((await get(w, `/auth/login?return=${encodeURIComponent(signPath(p))}${q}`)).headers.get("location"))).searchParams.get("prompt");
    expect(await prompt("&switch=1")).toBe("select_account");
    for (const q of ["", "&switch=0", "&switch=true", "&switch="]) expect(await prompt(q), q).toBeNull();
  });

  it("of a sign-in version asks for the identity-only app", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    const r = await get(w, `/auth/login?return=${encodeURIComponent(signPath(p))}`);
    expect(new URL(must(r.headers.get("location"))).searchParams.get("client_id")).toBe(SIGNIN_CLIENT_ID);
    const tx = await readTransaction(new Request(ORIGIN, { headers: { cookie: sent(must(r.headers.getSetCookie()[0])) } }), await keysOf(w));
    expect(tx?.app).toBe("signin");
  });

  it("while signing is paused is refused, leading back to the sign page", async () => {
    const w = await world({ config: CONFIG_V2 });
    const p = openPr(w, alice);
    const html = await expectMessage(await get(w, `/auth/login?return=${encodeURIComponent(signPath(p))}&lang=es`), 503, "paused", "es");
    expect(html).toContain(`<a class="btn btn-block" href="${signPath(p)}?lang=es">Volver a la página de firma</a>`);
  });

  it("is refused for a return address that is not a served sign page", async () => {
    const w = await world();
    for (const ret of ["", "/agreement", "https://evil.example/sign/a/b/1", "/sign/someone/else/1", `/sign/${SANDBOX}/01`, `//evil.example/sign/${SANDBOX}/1`]) {
      const r = await get(w, `/auth/login?return=${encodeURIComponent(ret)}`);
      await expectMessage(r, 400, "badLink");
      expect(r.headers.getSetCookie(), ret).toEqual([]);
    }
    await expectMessage(await get(w, "/auth/login"), 400, "badLink");
  });

  it("is GitHub's failure when the register cannot be read", async () => {
    const w = await world({ config: {} });
    await expectMessage(await get(w, `/auth/login?return=${encodeURIComponent(`/sign/${SANDBOX}/1`)}`), 503, "ghUnavailable");
  });

  it("over its address's budget is refused before anything is read", async () => {
    const w = await world();
    must(w.limiters.RL_AUTH).allow = false;
    await expectMessage(await get(w, `/auth/login?return=${encodeURIComponent(`/sign/${SANDBOX}/1`)}`), 429, "tooManyAuth");
    expect(w.limiters.RL_AUTH?.keys).toEqual([IP]);
    expect(w.gh.requests).toEqual([]);
  });
});

/** A started sign-in: its transaction cookie, and a code GitHub issued to the user for its challenge. */
async function started(w: World, p: FakePr, user: User, tx: { lang?: "en" | "es"; app?: "bot" | "signin" } = {}): Promise<{ cookie: string; state: string; code: string }> {
  const verifier = "v".repeat(43);
  const state = "s".repeat(43);
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
  const cookie = await transactionHeader(w, { state, verifier, return: signPath(p), ...tx });
  return { cookie, state, code: w.gh.issueCode(user, challenge, tx.app === "signin" ? SIGNIN_CLIENT_ID : CLIENT_ID) };
}

const back = (path: string, lang = "en") => `<a class="btn btn-block" href="${path}?lang=${lang}">${lang === "en" ? "Back to the sign page" : "Volver a la página de firma"}</a>`;

describe("the callback", () => {
  it("of an author who must sign keeps the token for this pull request only, with its app, and goes back to the sign page", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, alice, { lang: "es" });
    const sentHeaders: Record<string, string>[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url === "https://github.com/login/oauth/access_token") sentHeaders.push(Object.fromEntries(req.headers));
      return real(input, init);
    });
    const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
    expect(sentHeaders).toEqual([{ accept: "application/json", "content-type": "application/json", "user-agent": "kleidos-cla" }]);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${signPath(p)}?lang=es`);
    expect(r.headers.getSetCookie()[0]).toBe(CLEAR_OAUTH);
    const session = must(await sessionSet(w, r));
    expect(session).toEqual({ v: 1, sid: session.sid, id: alice.id, login: "alice", type: "User", exp: session.exp, token: session.token, app: "bot", for: `${SANDBOX}#${p.number}` });
    expect(session.token).toMatch(/^ghu_/);
    expect(session.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(w.gh.revokedGrants).toEqual([]);
    expect(lines(w)).toEqual([{ msg: "signed in", repo: SANDBOX, pr: p.number, outcome: "must_sign" }]);
    const exchange = must(w.gh.seen(/^POST \/login\/oauth\/access_token$/)[0]);
    expect(exchange.body).toEqual({ client_id: CLIENT_ID, client_secret: "test-client-secret-value", code: s.code, redirect_uri: `${ORIGIN}/auth/callback`, code_verifier: "v".repeat(43), repository_id: must(w.gh.repos.get(SANDBOX)).id });
  });

  it("keeps the session an hour from the callback, no longer", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, alice);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    try {
      const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
      expect(SESSION_TTL).toBe(3600);
      expect(must(await sessionSet(w, r)).exp).toBe(Date.parse("2026-11-24T13:00:00Z") / 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("of an author who already signed revokes the token at once and keeps none", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const id = w.gh.next();
    w.gh.comments.push({ id, repo: p.repo, pr: p.number, body: CONFIG.versions["1"].sentence, user: alice, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", via_app: true });
    await w.gh.record(id, 1);
    const s = await started(w, p, alice);
    const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
    expect(r.status).toBe(303);
    const session = must(await sessionSet(w, r));
    expect([session.token, session.app, session.for]).toEqual([undefined, undefined, undefined]);
    expect(w.gh.revokedGrants).toHaveLength(1);
    expect(lines(w)).toEqual([{ msg: "signed in", repo: SANDBOX, pr: p.number, outcome: "signed" }]);
  });

  it("of a sign-in version exchanges the code with the sign-in app, naming no repository", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    const s = await started(w, p, alice, { app: "signin" });
    const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
    expect((await sessionSet(w, r))?.app).toBe("signin");
    expect(must(w.gh.seen(/^POST \/login\/oauth\/access_token$/)[0]).body).toEqual({ client_id: SIGNIN_CLIENT_ID, client_secret: "test-signin-secret-value", code: s.code, redirect_uri: `${ORIGIN}/auth/callback`, code_verifier: "v".repeat(43) });
  });

  it("of an account that need not sign revokes the token at once and keeps none", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, bob);
    const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${signPath(p)}?lang=en`);
    const session = must(await sessionSet(w, r));
    expect([session.token, session.app, session.for]).toEqual([undefined, undefined, undefined]);
    expect(w.gh.revokedGrants).toHaveLength(1);
    expect(lines(w)).toEqual([{ msg: "signed in", repo: SANDBOX, pr: p.number, outcome: "not_author" }]);
  });

  it("with no transaction, or one that expired, is refused and clears it", async () => {
    const w = await world();
    const p = openPr(w, alice);
    for (const cookie of ["", await transactionHeader(w, { state: "s", verifier: "v", return: signPath(p), exp: nowSeconds() })]) {
      const r = await get(w, "/auth/callback?code=x&state=s", cookie);
      await expectMessage(r, 400, "oauthExpired");
      expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
    }
  });

  it("with a state that is not the transaction's is refused before anything else, and the transaction is kept", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, alice, { lang: "es" });
    const r = await get(w, `/auth/callback?code=${s.code}&state=${"t".repeat(43)}`, s.cookie);
    expect(await expectMessage(r, 400, "oauthState", "es")).not.toContain('class="btn btn-block"');
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(lines(w)).toEqual([{ msg: "oauth refused", reason: "state" }]);
    const cancelled = await get(w, `/auth/callback?error=access_denied&state=x`, s.cookie);
    expect(await expectMessage(cancelled, 400, "oauthState", "es")).toContain(back(signPath(p), "es"));
    expect(cancelled.headers.getSetCookie()).toEqual([]);
    expect(w.gh.requests).toEqual([]);
  });

  it("that GitHub says was cancelled is refused, clears the transaction and leads back", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, alice);
    const r = await get(w, `/auth/callback?error=access_denied&code=${s.code}&state=${s.state}`, s.cookie);
    expect(await expectMessage(r, 400, "oauthCancelled")).toContain(back(signPath(p)));
    expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
    expect(w.gh.requests).toEqual([]);
  });

  it("with a code that is not one GitHub writes is refused", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, alice);
    for (const code of ["", "a b", "a".repeat(101), "abc$", "abc.def"]) {
      const r = await get(w, `/auth/callback?code=${encodeURIComponent(code)}&state=${s.state}`, s.cookie);
      await expectMessage(r, 400, "oauthCode");
      expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
    }
    expect(w.gh.requests).toEqual([]);
    const longest = await get(w, `/auth/callback?code=${"a".repeat(100)}&state=${s.state}`, s.cookie);
    await expectMessage(longest, 400, "oauthExchange");
  });

  it("for a repository that became private is refused before the code is exchanged", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const s = await started(w, p, alice);
    must(w.gh.repos.get(SANDBOX)).private = true;
    const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
    await expectMessage(r, 404, "noTarget");
    expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
    expect(w.gh.seen(/^POST \/login\//)).toEqual([]);
  });

  it("for a return address that is no longer a served sign page is refused", async () => {
    const w = await world();
    const p = openPr(w, alice);
    for (const ret of ["/sign/someone/else/1", "/agreement", signPath(p).replace("/sign/", "/signs/")]) {
      const cookie = await transactionHeader(w, { state: "s", verifier: "v", return: ret });
      const r = await get(w, "/auth/callback?code=abc&state=s", cookie);
      await expectMessage(r, 400, "badLink");
      expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
    }
    expect(w.gh.seen(/^POST \/login\//)).toEqual([]);
  });

  it("of a sign-in started with the sign-in app after the register stopped naming it is paused", async () => {
    const w = await world({ signinSecrets: true });
    const p = openPr(w, alice);
    const s = await started(w, p, alice, { app: "signin" });
    const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
    expect(await expectMessage(r, 503, "paused")).toContain(back(signPath(p)));
    expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
  });

  it("whose code GitHub does not take is refused, and the log says only GitHub's status and the start of its error", async () => {
    const answers: [Response, Record<string, unknown>][] = [
      [json({ error: "bad_verification_code_and_some_more_words_past_forty_characters" }), { status: 200, reason: "bad_verification_code_and_some_more_word" }],
      [json({ access_token: "ghu_x", error: "also" }), { status: 200, reason: "also" }],
      [json({ token_type: "bearer" }), { status: 200, reason: "none" }],
      [json({ access_token: "ghu_x", error: 7 }), { status: 200, reason: "none" }],
      [json({ access_token: "ghu_x" }, 502), { status: 502, reason: "none" }],
      [new Response("<html>", { status: 200 }), { status: 200, reason: "none" }],
    ];
    for (const [answer, logged] of answers) {
      const w = await world();
      const p = openPr(w, alice);
      const s = await started(w, p, alice);
      w.gh.answer(/^POST \/login\/oauth\/access_token$/, () => answer.clone());
      const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
      expect(await expectMessage(r, 400, "oauthExchange")).toContain(back(signPath(p)));
      expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
      expect(lines(w)).toEqual([{ msg: "oauth exchange refused", ...logged }]);
    }
  });

  it("for an account GitHub answers with no login or no id revokes the token and is refused", async () => {
    for (const user of [{ id: 5, login: "not a login", type: "User" }, { id: "5", login: "eve", type: "User" }]) {
      const w = await world();
      const p = openPr(w, alice);
      const s = await started(w, p, alice);
      w.gh.answer(/^GET \/user$/, () => json(user));
      const r = await get(w, `/auth/callback?code=${s.code}&state=${s.state}`, s.cookie);
      expect(await expectMessage(r, 400, "oauthUser")).not.toContain('class="btn btn-block"');
      expect(r.headers.getSetCookie()).toEqual([CLEAR_OAUTH]);
      expect(w.gh.revokedGrants).toHaveLength(1);
    }
  });

  it("over its address's budget is refused before the transaction is read", async () => {
    const w = await world();
    must(w.limiters.RL_AUTH).allow = false;
    const r = await get(w, "/auth/callback?lang=es");
    await expectMessage(r, 429, "tooManyAuth", "es");
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(w.limiters.RL_AUTH?.keys).toEqual([IP]);
  });

  // F8, a question for the owner: these two answer a bare 500, with the transaction kept and no page in the visitor's language.
  it("whose exchange fails at the network, or answers null, ends in the Worker's 500 (pinned as it is today)", async () => {
    for (const fail of [() => Promise.reject(new TypeError("network")), () => Promise.resolve(json(null))]) {
      const w = await world();
      const p = openPr(w, alice);
      const s = await started(w, p, alice);
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (new Request(input, init).url.endsWith("/login/oauth/access_token") ? fail() : real(input, init)));
      const r = await worker.fetch(new Request(`${ORIGIN}/auth/callback?code=${s.code}&state=${s.state}`, { headers: { cookie: s.cookie } }), w.env);
      expect([r.status, await r.text(), r.headers.getSetCookie()]).toEqual([500, "internal error\n", []]);
    }
  });
});

describe("the sign-out", () => {
  async function post(w: World, headers: Record<string, string>, body: string) {
    return call(w, "/auth/logout", { method: "POST", headers: { "cf-connecting-ip": IP, ...headers }, body });
  }
  const form = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };

  async function csrfOf(w: World, sid: string): Promise<string> {
    const { csrfToken } = await import("../../src/keys");
    return csrfToken((await keysOf(w)).csrf, [sid, "logout"]);
  }

  it("revokes the session's token with its own app, clears the session and goes to the agreement in the form's language", async () => {
    const w = await world({ signinSecrets: true });
    for (const [app, client] of [
      ["bot", CLIENT_ID],
      ["signin", SIGNIN_CLIENT_ID],
    ] as const) {
      const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1", token: `ghu_${app}`, app });
      const r = await post(w, { ...form, cookie }, `csrf=${encodeURIComponent(await csrfOf(w, "sid1"))}&lang=es`);
      expect([r.status, r.headers.get("location"), r.headers.getSetCookie()]).toEqual([303, "/agreement?lang=es", [CLEAR_SESSION]]);
      expect(w.gh.seen(/^DELETE \/applications\//).at(-1)).toEqual({ method: "DELETE", url: `/applications/${client}/grant`, auth: "basic", body: { access_token: `ghu_${app}` } });
    }
  });

  it("of a sign-in session, once the sign-in app's secrets are gone, revokes nothing", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1", token: "ghu_x", app: "signin" });
    const r = await post(w, { ...form, cookie }, `csrf=${encodeURIComponent(await csrfOf(w, "sid1"))}`);
    expect([r.status, r.headers.get("location")]).toEqual([303, "/agreement?lang=en"]);
    expect(w.gh.requests).toEqual([]);
    expect(lines(w)).toEqual([]);
  });

  it("of a session with no token only clears it", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1" });
    const r = await post(w, { ...form, cookie }, `csrf=${encodeURIComponent(await csrfOf(w, "sid1"))}`);
    expect(r.headers.getSetCookie()).toEqual([CLEAR_SESSION]);
    expect(w.gh.requests).toEqual([]);
  });

  it("logs a revocation GitHub refused, by its status only, and signs out anyway", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1", token: "ghu_unknown" });
    const r = await post(w, { ...form, cookie }, `csrf=${encodeURIComponent(await csrfOf(w, "sid1"))}`);
    expect(r.status).toBe(303);
    expect(lines(w)).toEqual([{ msg: "grant revocation failed", status: 404 }]);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("down")));
    await post(w, { ...form, cookie }, `csrf=${encodeURIComponent(await csrfOf(w, "sid1"))}`);
    expect(lines(w).at(-1)).toEqual({ msg: "grant revocation failed", status: 0 });
  });

  it("from another site, one whose origin only looks like the site's, or with no origin, is refused and keeps the session", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", token: "ghu_x" });
    for (const headers of [...NEAR_ORIGINS.map((origin) => ({ ...form, origin })), { ...form, origin: "null" }, { "content-type": form["content-type"] }, { ...form, "sec-fetch-site": "cross-site" }, { ...form, "sec-fetch-site": "same-site" }]) {
      const r = await post(w, { ...headers, cookie }, "lang=es");
      await expectMessage(r, 403, "refusedOrigin");
      expect(r.headers.getSetCookie()).toEqual([]);
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("with a form whose type names its character set is read", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1", token: "ghu_x" });
    const r = await post(w, { ...form, "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8", cookie }, `csrf=${encodeURIComponent(await csrfOf(w, "sid1"))}`);
    expect(r.status).toBe(303);
    expect(w.gh.seen(/^DELETE \/applications\//)).toHaveLength(1);
  });

  it("from this site with no Sec-Fetch-Site is taken", async () => {
    const w = await world();
    const r = await post(w, { origin: ORIGIN, "content-type": form["content-type"] }, "lang=en");
    expect([r.status, r.headers.getSetCookie()]).toEqual([303, [CLEAR_SESSION]]);
  });

  it("with a form that cannot be read, or no session, only clears the session", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1", token: "ghu_x" });
    for (const [headers, body] of [
      [{ ...form, "content-type": "text/plain", cookie }, "csrf=x"],
      [{ ...form, cookie }, `csrf=${"x".repeat(4097)}`],
      [form, "lang=es"],
    ] as const) {
      const r = await post(w, headers, body);
      expect([r.status, r.headers.getSetCookie()]).toEqual([303, [CLEAR_SESSION]]);
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("with a stale form is refused and keeps the session and its token", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "sid1", token: "ghu_x" });
    for (const csrf of ["", "x", await csrfOf(w, "sid2")]) {
      const r = await post(w, { ...form, cookie }, `csrf=${encodeURIComponent(csrf)}&lang=es`);
      await expectMessage(r, 403, "refusedStale", "es");
      expect(r.headers.getSetCookie()).toEqual([]);
    }
    expect(w.gh.requests).toEqual([]);
  });
});
