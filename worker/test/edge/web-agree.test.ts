// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The signature (POST /agree): it stops at the first refusal with nothing
 * posted, dispatched or queued, each refusal by its own reason; it posts the
 * sentence of the version on the page only, once, as the signer; and it
 * hands a sign-in version to the recorder without posting anything.
 */
import { describe, expect, it, vi } from "vitest";
import { csrfToken } from "../../src/keys";
import { readSession } from "../../src/session";
import { must, nowSeconds } from "../../src/util";
import { CLIENT_ID, SIGNIN_CLIENT_ID, commit } from "../fakegh";
import type { FakePr, User } from "../fakegh";
import { Browser, CONFIG, CONFIG_V2, ORIGIN, SANDBOX, alice, bob, call, expectMessage, keysOf, lines, NEAR_ORIGINS, openPr, queueDown, restoring, sessionHeader, sessionSet, world } from "./support";
import type { World } from "./support";

restoring();

const IP = "203.0.113.70";
const SET_1 = CONFIG.versions["1"].set_sha256;
const SENTENCE_1 = CONFIG.versions["1"].sentence;
const CLEAR_SESSION = "__Host-cla=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
const FORM = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": IP };

/** A signer at the acceptance: signed in through the flow, with the page's own form. */
async function atAcceptance(w: World, user: User = alice, opts: { pr?: FakePr; lang?: "en" | "es" } = {}): Promise<{ b: Browser; p: FakePr; form: Record<string, string> }> {
  const p = opts.pr ?? openPr(w, user);
  const b = new Browser(w, user);
  const path = `/sign/${p.repo}/${p.number}`;
  await b.signIn(path);
  const html = await (await b.get(`${path}${opts.lang ? `?lang=${opts.lang}` : ""}`)).text();
  const form = Browser.form(html);
  expect(form.csrf).toBeTruthy();
  w.logs.length = 0;
  return { b, p, form };
}

function agree(w: World, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return call(w, "/agree", { method: "POST", headers: { ...FORM, ...headers }, body: new URLSearchParams(form).toString() });
}

const posted = (w: World) => w.gh.comments.filter((c) => c.body === SENTENCE_1 || c.body === CONFIG.versions["2"].sentence);
const nothingDone = (w: World) => ({ comments: posted(w).length, dispatches: w.gh.dispatches.length, queued: w.queue.sent.filter((s) => s.body.kind === "evaluate" && ("record_comment" in s.body || "await_signin" in s.body)).length });

describe("an acceptance through kleidos-cla", () => {
  it("posts the sentence as the signer, revokes the token, queues the record and keeps what was posted in the session", async () => {
    const w = await world();
    const { b, p, form } = await atAcceptance(w);
    const r = await b.post("/agree", { ...form, accept: "yes" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/sign/${SANDBOX}/${p.number}?lang=en`);
    const mine = posted(w);
    expect(mine.map((c) => [c.user.id, c.repo, c.pr])).toEqual([[alice.id, SANDBOX, p.number]]);
    const c = must(mine[0]);
    expect(w.gh.seen(/^DELETE \/applications\//).map((s) => s.url)).toEqual([`/applications/${CLIENT_ID}/grant`]);
    expect(w.queue.sent.at(-1)).toEqual({ body: { kind: "evaluate", repo: SANDBOX, pr: p.number, record_comment: c.id } });
    const s = must(await sessionSet(w, r));
    expect(s.token).toBeUndefined();
    expect(s.pending).toEqual({ repo: SANDBOX, pr: p.number, comment_id: c.id, comment_url: `https://github.com/${SANDBOX}/pull/${p.number}#issuecomment-${c.id}`, at: c.created_at });
    expect(lines(w)).toEqual([{ msg: "signed", repo: SANDBOX, pr: p.number }]);
  });

  it("is still confirmed when the queue is down, and the log says the enqueue failed", async () => {
    const w = await world();
    const { b, p, form } = await atAcceptance(w);
    queueDown(w);
    const r = await b.post("/agree", { ...form, accept: "yes" });
    expect(r.status).toBe(303);
    expect(posted(w)).toHaveLength(1);
    expect(lines(w)).toEqual([
      { msg: "signed", repo: SANDBOX, pr: p.number },
      { msg: "enqueue failed", repo: SANDBOX, pr: p.number },
    ]);
  });

  it("submitted again finds the first acceptance and confirms it, posting nothing more", async () => {
    const w = await world();
    const { b, p, form } = await atAcceptance(w);
    const earlier = w.gh.next();
    w.gh.comments.push({ id: earlier, repo: SANDBOX, pr: p.number, body: SENTENCE_1, user: alice, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", via_app: true });
    const queued = w.queue.sent.length;
    const r = await b.post("/agree", { ...form, accept: "yes" });
    expect(r.status).toBe(303);
    expect(posted(w).map((c) => c.id)).toEqual([earlier]);
    expect(w.queue.sent.length).toBe(queued);
    expect((await sessionSet(w, r))?.pending).toEqual({ repo: SANDBOX, pr: p.number, comment_id: earlier, comment_url: `https://github.com/${SANDBOX}/pull/${p.number}#issuecomment-${earlier}`, at: "2026-11-02T10:00:00Z" });
    expect(w.gh.revokedGrants).toHaveLength(1);
  });

  it("does not take an earlier acceptance that was edited, and posts a new one", async () => {
    const w = await world();
    const { b, p, form } = await atAcceptance(w);
    w.gh.comments.push({ id: w.gh.next(), repo: SANDBOX, pr: p.number, body: SENTENCE_1, user: alice, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T11:00:00Z", via_app: true });
    await b.post("/agree", { ...form, accept: "yes" });
    expect(posted(w)).toHaveLength(2);
  });

  it("that GitHub refuses with the token is confirmed if a first submission did post, and otherwise asks to sign in again", async () => {
    for (const status of [401, 403, 404]) {
      const w = await world();
      const { b, p, form } = await atAcceptance(w);
      w.gh.answer(/^POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, () => new Response(JSON.stringify({ message: "no" }), { status, headers: { "content-type": "application/json" } }), 1);
      const r = await b.post("/agree", { ...form, accept: "yes" });
      expect(await expectMessage(r, 401, "signInAgainGitHub"), String(status)).toContain(`href="/sign/${SANDBOX}/${p.number}?lang=en"`);
      expect(r.headers.getSetCookie()).toEqual([CLEAR_SESSION]);
      expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
      expect(lines(w)[0]).toEqual({ msg: "agree refused", reason: `github_${{ 401: "unauthorized", 403: "forbidden", 404: "not_found" }[status]}`, repo: SANDBOX, pr: p.number });
    }
    const w = await world();
    const { b, p, form } = await atAcceptance(w);
    w.gh.answer(/^POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, () => {
      w.gh.comments.push({ id: 4242, repo: SANDBOX, pr: p.number, body: SENTENCE_1, user: alice, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", via_app: true });
      return new Response(JSON.stringify({ message: "revoked" }), { status: 401, headers: { "content-type": "application/json" } });
    }, 1);
    const queued = w.queue.sent.length;
    const r = await b.post("/agree", { ...form, accept: "yes" });
    expect(r.status).toBe(303);
    expect((await sessionSet(w, r))?.pending).toMatchObject({ comment_id: 4242 });
    expect(w.queue.sent.length).toBe(queued);
  });

  it("that GitHub fails to take for another reason is GitHub's failure, with nothing posted", async () => {
    const w = await world();
    const { b, form } = await atAcceptance(w);
    w.gh.answer(/^POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, () => new Response(JSON.stringify({}), { status: 502, headers: { "content-type": "application/json" } }), 1);
    await expectMessage(await b.post("/agree", { ...form, accept: "yes" }), 503, "ghUnavailable");
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });
});

describe("an acceptance through the sign-in app", () => {
  it("hands the account and the signer's token to the recorder, posts nothing, and forgets the token", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { b, p, form } = await atAcceptance(w, alice, { lang: "es" });
    const now = new Date(Math.floor(Date.now() / 1000) * 1000 + 789);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    let r: Response;
    try {
      r = await b.post("/agree", { ...form, accept: "yes" });
    } finally {
      vi.useRealTimers();
    }
    expect([r.status, r.headers.get("location")]).toEqual([303, `/sign/${SANDBOX}/${p.number}?lang=es`]);
    const [dispatched] = w.gh.dispatches;
    expect(w.gh.dispatches).toHaveLength(1);
    expect(dispatched?.signin_token).toMatch(/^ghu_/);
    expect({ ...dispatched, signin_token: "the token" }).toEqual({ kind: "signin", repo: SANDBOX, pr: String(p.number), github_id: String(alice.id), version: "2", lang: "es", site_commit: w.env.BUILD_COMMIT, signin_token: "the token" });
    expect(posted(w)).toEqual([]);
    expect(w.gh.revokedGrants).toEqual([]);
    expect(w.queue.sent.at(-1)).toEqual({ body: { kind: "evaluate", repo: SANDBOX, pr: p.number, await_signin: alice.id } });
    const s = must(await sessionSet(w, r));
    expect([s.token, s.pending]).toEqual([undefined, { signin: true, repo: SANDBOX, pr: p.number, version: 2, at: `${now.toISOString().slice(0, 19)}Z` }]);
    expect(lines(w)).toEqual([{ msg: "signed", repo: SANDBOX, pr: p.number, outcome: "handed_to_recorder" }]);
  });

  it("is still handed over when the queue is down", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { b, p, form } = await atAcceptance(w);
    queueDown(w);
    expect((await b.post("/agree", { ...form, accept: "yes" })).status).toBe(303);
    expect(w.gh.dispatches).toHaveLength(1);
    expect(lines(w)).toEqual([
      { msg: "enqueue failed", repo: SANDBOX, pr: p.number },
      { msg: "signed", repo: SANDBOX, pr: p.number, outcome: "handed_to_recorder" },
    ]);
  });

  it("that cannot reach the recorder revokes the token, records nothing and asks to sign in again later", async () => {
    for (const fail of ["github", "network"] as const) {
      const w = await world({ config: CONFIG_V2, signinSecrets: true });
      const { b, p, form } = await atAcceptance(w);
      w.gh.answer(/dispatches$/, () => (fail === "github" ? new Response(JSON.stringify({}), { status: 500, headers: { "content-type": "application/json" } }) : Promise.reject(new TypeError("down"))), 1);
      const r = await b.post("/agree", { ...form, accept: "yes" });
      expect(await expectMessage(r, 503, "recorderUnreachable")).toContain(`href="/sign/${SANDBOX}/${p.number}?lang=en"`);
      expect(r.headers.getSetCookie()).toEqual([CLEAR_SESSION]);
      expect(w.gh.seen(/^DELETE \/applications\//).map((s) => s.url)).toEqual([`/applications/${SIGNIN_CLIENT_ID}/grant`]);
      expect(w.queue.sent.filter((s) => "await_signin" in s.body)).toEqual([]);
      expect(lines(w)[0]).toEqual({ msg: "signin dispatch failed", repo: SANDBOX, pr: p.number, status: fail === "github" ? 500 : 0 });
    }
  });
});

describe("an acceptance that is refused", () => {
  it("from another site, one whose origin only looks like the site's, or from no origin, is refused before the form is read", async () => {
    const w = await world();
    const { form } = await atAcceptance(w);
    for (const headers of [...NEAR_ORIGINS.map((origin) => ({ origin })), { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }]) {
      await expectMessage(await agree(w, { ...form, accept: "yes" }, headers), 403, "refusedOrigin");
    }
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("whose form cannot be read is refused, in the request's language", async () => {
    const w = await world();
    await expectMessage(await agree(w, { accept: "yes" }, { "content-type": "multipart/form-data" }), 400, "formUnreadable");
    await expectMessage(await call(w, "/agree?lang=es", { method: "POST", headers: FORM, body: `csrf=${"x".repeat(4096)}` }), 400, "formUnreadable", "es");
    await expectMessage(await agree(w, { accept: "yes" }, { "content-type": "text/plain; x=application/x-www-form-urlencoded" }), 400, "formUnreadable");
  });

  it("is read up to 4096 bytes and no further", async () => {
    const w = await world();
    const body = (n: number) => `lang=es&pad=${"x".repeat(n - "lang=es&pad=".length)}`;
    expect(body(4096)).toHaveLength(4096);
    // Read, the form's language shows; one byte more, it is not read and the request's language shows.
    await expectMessage(await call(w, "/agree?lang=en", { method: "POST", headers: FORM, body: body(4096) }), 401, "sessionExpired", "es");
    await expectMessage(await call(w, "/agree?lang=en", { method: "POST", headers: FORM, body: body(4097) }), 400, "formUnreadable", "en");
  });

  it("is answered in the form's language over the address's", async () => {
    const w = await world();
    await expectMessage(await call(w, "/agree?lang=en", { method: "POST", headers: FORM, body: "lang=es" }), 401, "sessionExpired", "es");
    await expectMessage(await call(w, "/agree?lang=es", { method: "POST", headers: FORM, body: "lang=en" }), 401, "sessionExpired", "en");
  });

  it("with no session, or one that expired, is refused in the form's language", async () => {
    const w = await world();
    await expectMessage(await agree(w, { lang: "es" }), 401, "sessionExpired", "es");
    const expired = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", exp: nowSeconds() - 1 });
    await expectMessage(await agree(w, { lang: "en" }, { cookie: expired }), 401, "sessionExpired");
  });

  it("naming no valid pull request is refused", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User" });
    for (const f of [{}, { owner: "kleidos-dev", repo: "cla", pr: "0" }, { owner: "kleidos dev", repo: "cla", pr: "1" }, { owner: "kleidos-dev", repo: "..", pr: "1" }, { owner: "kleidos-dev", repo: "cla/x", pr: "1" }, { owner: "kleidos-dev", repo: "cla", pr: "2147483648" }]) {
      await expectMessage(await agree(w, f, { cookie }), 400, "formInvalid");
    }
  });

  it("with a CSRF token of another session, pull request or version is refused and logged", async () => {
    const w = await world();
    const { form } = await atAcceptance(w);
    const keys = await keysOf(w);
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "other", token: "ghu_x", for: `${SANDBOX}#${form.pr ?? ""}` });
    const forOther = await csrfToken(keys.csrf, ["other", "agree", `${SANDBOX}#${Number(form.pr) + 1}`, "1"]);
    const forV2 = await csrfToken(keys.csrf, ["other", "agree", `${SANDBOX}#${form.pr ?? ""}`, "2"]);
    for (const csrf of [form.csrf ?? "", forOther, forV2, ""]) {
      const r = await agree(w, { ...form, csrf, accept: "yes" }, { cookie });
      expect(await expectMessage(r, 403, "csrf")).toContain(`<a class="btn btn-block" href="/sign/${SANDBOX}/${form.pr ?? ""}?lang=en">Back to the sign page</a>`);
    }
    const es = await agree(w, { ...form, csrf: forOther, lang: "es", accept: "yes" }, { cookie });
    expect(await expectMessage(es, 403, "csrf", "es")).toContain(`<a class="btn btn-block" href="/sign/${SANDBOX}/${form.pr ?? ""}?lang=es">Volver a la página de firma</a>`);
    // A session with no token, or one for another pull request, is refused for its CSRF token first.
    for (const extra of [{}, { token: "ghu_x", for: "kleidos-dev/other#1" }]) {
      const c = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "other", ...extra });
      await expectMessage(await agree(w, { ...form, csrf: "", accept: "yes" }, { cookie: c }), 403, "csrf");
    }
    expect(lines(w)).toEqual(Array(7).fill({ msg: "agree refused", reason: "csrf" }));
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("with no token, or a token for another pull request, asks to sign in again", async () => {
    const w = await world();
    const keys = await keysOf(w);
    const p = openPr(w, alice);
    const fields = { owner: "kleidos-dev", repo: "cla-sandbox", pr: String(p.number), version: "1", set_sha256: SET_1, accept: "yes", csrf: await csrfToken(keys.csrf, ["s1", "agree", `${SANDBOX}#${p.number}`, "1"]) };
    for (const extra of [{}, { token: "ghu_x", for: `${SANDBOX}#${p.number + 1}` }, { token: "", for: `${SANDBOX}#${p.number}` }]) {
      const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "s1", ...extra });
      await expectMessage(await agree(w, fields, { cookie }), 401, "signInAgain");
    }
    expect(w.gh.requests.filter((r) => !r.url.includes("registry/") && !r.url.endsWith("/installation") && !r.url.endsWith("/access_tokens"))).toEqual([]);
  });

  it("with no token is refused as such before the register is read, even while signing is paused", async () => {
    const w = await world({ config: CONFIG_V2 });
    const keys = await keysOf(w);
    const fields = { owner: "kleidos-dev", repo: "cla-sandbox", pr: "7", version: "2", set_sha256: CONFIG.versions["2"].set_sha256, accept: "yes", csrf: await csrfToken(keys.csrf, ["s1", "agree", `${SANDBOX}#7`, "2"]) };
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "s1" });
    await expectMessage(await agree(w, fields, { cookie }), 401, "signInAgain");
    const noToken = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "s1", for: `${SANDBOX}#7` });
    await expectMessage(await agree(w, fields, { cookie: noToken }), 401, "signInAgain");
    const elsewhere = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "s1", token: "ghu_x", app: "signin", for: `${SANDBOX}#8` });
    await expectMessage(await agree(w, fields, { cookie: elsewhere }), 401, "signInAgain");
    expect(w.gh.requests).toEqual([]);
  });

  it("with a form whose type names its character set is read", async () => {
    const w = await world();
    const { b, form } = await atAcceptance(w);
    const r = await b.post("/agree", { ...form, accept: "yes" }, { "content-type": "application/x-www-form-urlencoded;charset=utf-8" });
    expect(r.status).toBe(303);
    expect(posted(w)).toHaveLength(1);
  });

  it("for a repository no longer served is refused", async () => {
    const w = await world();
    const { b, form } = await atAcceptance(w);
    const { resetRegistryCache } = await import("../../src/registry");
    w.gh.setFile("main", "registry/config.json", JSON.stringify({ ...CONFIG, served_repositories: { "kleidos-dev/cla": { auto_approve: false } } }));
    resetRegistryCache();
    await expectMessage(await b.post("/agree", { ...form, accept: "yes" }), 404, "notServed");
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("while signing is paused, or with a token of the other app, is refused", async () => {
    const w = await world({ signinSecrets: true });
    const { b, form } = await atAcceptance(w);
    const { resetRegistryCache } = await import("../../src/registry");
    w.gh.setFile("main", "registry/config.json", JSON.stringify({ ...CONFIG_V2, signin_client_id: null }));
    resetRegistryCache();
    await expectMessage(await b.post("/agree", { ...form, accept: "yes" }), 503, "paused");
    w.gh.setFile("main", "registry/config.json", JSON.stringify(CONFIG_V2));
    resetRegistryCache();
    const session = must(await readSession(new Request(ORIGIN, { headers: { cookie: b.cookieHeader() } }), await keysOf(w)));
    const csrf = await csrfToken((await keysOf(w)).csrf, [session.sid, "agree", `${SANDBOX}#${form.pr ?? ""}`, "2"]);
    await expectMessage(await b.post("/agree", { ...form, version: "2", set_sha256: CONFIG.versions["2"].set_sha256, csrf, accept: "yes" }), 401, "signInAgain");
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("with the box not ticked shows the same page again with the error at the box", async () => {
    const w = await world();
    const { b, form } = await atAcceptance(w, alice, { lang: "es" });
    for (const accept of [undefined, "", "no", "YES"]) {
      const f: Record<string, string> = { ...form };
      if (accept !== undefined) f.accept = accept;
      const r = await b.post("/agree", f);
      expect(r.status).toBe(400);
      const html = await r.text();
      expect(html).toContain('<p class="error" id="accept-error" role="alert"><span class="error-mark" aria-hidden="true">!</span>');
      expect(html).toContain('aria-invalid="true" aria-describedby="accept-error post-note" autofocus');
      expect(html).toContain('<form class="accept is-error"');
      expect(html).toContain('<html lang="es">');
    }
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("with the box not ticked and a digest that is not the current one shows the box's error first", async () => {
    const w = await world();
    const { b, form } = await atAcceptance(w);
    const r = await b.post("/agree", { ...form, set_sha256: CONFIG.versions["2"].set_sha256 });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('<form class="accept is-error"');
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("of a version or digest that is not the current one is refused as changed", async () => {
    const w = await world();
    const { b, form } = await atAcceptance(w);
    const keys = await keysOf(w);
    for (const set_sha256 of [CONFIG.versions["2"].set_sha256, "", CONFIG.versions["1"].set_sha256.slice(0, 12), CONFIG.versions["1"].set_sha256.toUpperCase(), `${CONFIG.versions["1"].set_sha256}0`]) {
      await expectMessage(await b.post("/agree", { ...form, set_sha256, accept: "yes" }), 409, "changed");
    }
    const session = must(await readSession(new Request(ORIGIN, { headers: { cookie: b.cookieHeader() } }), keys));
    const v2csrf = await csrfToken(keys.csrf, [session.sid, "agree", `${SANDBOX}#${form.pr ?? ""}`, "2"]);
    await expectMessage(await b.post("/agree", { ...form, version: "2", csrf: v2csrf, accept: "yes" }), 409, "changed");
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });

  it("over the address's or the account's budget is refused, the account's asked only when the address passed", async () => {
    for (const which of ["RL_AGREE_IP", "RL_AGREE_ACCOUNT"] as const) {
      const w = await world();
      const { b, form } = await atAcceptance(w);
      must(w.limiters[which]).allow = false;
      const before = w.gh.requests.length;
      await expectMessage(await b.post("/agree", { ...form, accept: "yes" }, { "cf-connecting-ip": IP }), 429, "tooManyAgree");
      expect([w.limiters.RL_AGREE_IP?.keys, w.limiters.RL_AGREE_ACCOUNT?.keys], which).toEqual([[IP], which === "RL_AGREE_IP" ? [] : [String(alice.id)]]);
      // Only the register's configuration is read before the budget: nothing of the pull request.
      expect(w.gh.requests.slice(before).filter((q) => !q.url.startsWith("/repos/kleidos-dev/cla/contents/")), which).toEqual([]);
      expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
    }
  });

  it("by an account that need not sign here says why nothing was posted", async () => {
    const cases: [string, (w: World, p: FakePr) => void | Promise<void>, number, Parameters<typeof expectMessage>[2]][] = [
      ["closed", (_w, p) => void (p.state = "closed"), 409, "postedClosed"],
      ["locked", (_w, p) => void (p.locked = true), 409, "postedLocked"],
      ["private", (w) => void (must(w.gh.repos.get(SANDBOX)).private = true), 404, "postedPrivate"],
      ["signed", async (w) => w.gh.signDirectly(alice), 409, "postedSigned"],
      ["not_author", (_w, p) => void (p.commits = [commit(bob)]), 403, "postedNotNeeded"],
    ];
    for (const [status, change, code, key] of cases) {
      const w = await world();
      const { b, p, form } = await atAcceptance(w, alice, { pr: openPr(w, bob, { commits: [commit(bob), commit(alice)] }) });
      await change(w, p);
      const r = await b.post("/agree", { ...form, accept: "yes" });
      expect(await expectMessage(r, code, key), status).toContain(`href="/sign/${SANDBOX}/${p.number}?lang=en"`);
      expect(lines(w)).toEqual([{ msg: "agree refused", reason: status, repo: SANDBOX, pr: p.number }]);
      expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
    }
  });

  it("by an account that is no person is refused as such", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const keys = await keysOf(w);
    w.gh.tokens.set("ghu_org", { kind: "user", app: "bot", user: { id: alice.id, login: "alice", type: "Organization" }, repositoryId: must(w.gh.repos.get(SANDBOX)).id });
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "Organization", sid: "s1", token: "ghu_org", for: `${SANDBOX}#${p.number}` });
    const fields = { owner: "kleidos-dev", repo: "cla-sandbox", pr: String(p.number), version: "1", set_sha256: SET_1, accept: "yes", csrf: await csrfToken(keys.csrf, ["s1", "agree", `${SANDBOX}#${p.number}`, "1"]) };
    await expectMessage(await agree(w, fields, { cookie }), 403, "postedNotUser");
    expect(nothingDone(w)).toEqual({ comments: 0, dispatches: 0, queued: 0 });
  });
});
