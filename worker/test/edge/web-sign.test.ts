// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The sign page, for every visitor it can have: signed out or signed in as
 * an account that must sign, has signed, is exempt, is covered by an
 * entity, is no author, or is no person; on a pull request that is open,
 * closed, locked or private; and after an acceptance, while it is recorded
 * or when it went wrong. GitHub's failures each have their own page.
 */
import { describe, expect, it, vi } from "vitest";
import { MESSAGES, S } from "../../src/i18n";
import { Registry } from "../../src/registry";
import { must } from "../../src/util";
import type { FakePr, User } from "../fakegh";
import { commit, sha } from "../fakegh";
import { CONFIG, CONFIG_V2, SANDBOX, alice, bob, call, carol, expectMessage, lines, openPr, restoring, sessionHeader, sessionSet, world } from "./support";
import type { World } from "./support";

restoring();

const IP = "203.0.113.50";
const SECRET_REPO = "kleidos-dev/secret";
const SET_1 = CONFIG.versions["1"].set_sha256;

const signPath = (p: FakePr) => `/sign/${p.repo}/${p.number}`;

function get(w: World, path: string, cookie = ""): Promise<Response> {
  return call(w, path, { headers: { "cf-connecting-ip": IP, ...(cookie ? { cookie } : {}) } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-github-request-id": "ABCD:1234" } });
}

/** The heading, the card and the who row of a status page. */
function statusOf(html: string) {
  return {
    h1: /<h1 class="h-task">([^<]*)<\/h1>/.exec(html)?.[1],
    card: /<div class="card(?: is-done| is-pending)?" role="(?:status|alert)"><p>([\s\S]*?)<\/p><\/div>/.exec(html)?.[1],
    who: /<div class="who"><span>([^<]*)<strong>([^<]*)<\/strong>/.exec(html)?.slice(1, 3).join(""),
  };
}

const session = (u: User, extra: Record<string, unknown> = {}) => ({ id: u.id, login: u.login, type: u.type, ...extra });

describe("the sign page, signed out", () => {
  it("names who still signs and leads to the sign-in, saying what GitHub will show", async () => {
    const w = await world();
    const p = openPr(w, alice, { commits: [commit(alice), commit(bob)] });
    const r = await get(w, signPath(p));
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('<p class="card-row"><span class="eyebrow">Still to sign</span><span>@alice, @bob</span></p>');
    expect(html).toContain(`<a class="btn btn-primary btn-block" href="/auth/login?return=${encodeURIComponent(signPath(p))}&amp;lang=en">Sign in with GitHub to sign</a>`);
    expect(html).toContain(`<p class="note">${S.en.start.ghBody}</p>`);
    expect(html).toContain(`<title>Sign the Kleidos Contributor Agreement · ${SANDBOX}#${p.number}</title>`);
    expect(html).not.toContain('<div class="who">');
  });

  it("of a sign-in version says what the identity-only app shows", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    const html = await (await get(w, `${signPath(p)}?lang=es`)).text();
    expect(html).toContain(`<p class="note">${S.es.start.ghBodySignin}</p>`);
    expect(html).toContain(`>${S.es.start.button}</a>`);
  });

  it("says nobody is left when every author signed, and a dash when nobody is missing but the authors are not all known", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const signed = openPr(w, alice);
    expect(await (await get(w, signPath(signed))).text()).toContain('<span class="eyebrow">Still to sign</span><span>Nobody: every author has signed</span>');
    const unknown = openPr(w, alice, { commits: [commit(alice), commit({ email: "nobody@example.invalid" })] });
    expect(await (await get(w, signPath(unknown))).text()).toContain('<span class="eyebrow">Still to sign</span><span>—</span>');
  });

  it("while signing is paused shows the reason instead of a way to sign in", async () => {
    const w = await world({ config: CONFIG_V2 });
    const p = openPr(w, alice);
    const html = await (await get(w, signPath(p))).text();
    expect(html).toContain(`<div class="card is-pending" role="alert"><p>${S.en.status.paused}</p></div>`);
    expect(html).not.toContain("/auth/login");
  });

  it("of a closed or locked pull request says so, and leads back to it", async () => {
    const w = await world();
    const closed = openPr(w, alice);
    closed.state = "closed";
    const back = (p: FakePr) => `<a class="btn btn-block" href="https://github.com/${p.repo}/pull/${p.number}">Back to the pull request</a>`;
    expect(await expectMessage(await get(w, signPath(closed)), 409, "closed")).toContain(back(closed));
    const locked = openPr(w, alice);
    locked.locked = true;
    expect(await expectMessage(await get(w, signPath(locked)), 409, "locked")).toContain(back(locked));
  });

  it("of a private repository, even a served one, is not found", async () => {
    const w = await world({ config: { ...CONFIG, served_repositories: { ...CONFIG.served_repositories, [SECRET_REPO]: { auto_approve: false } } } });
    w.gh.addRepo(SECRET_REPO, { private: true });
    const p = openPr(w, alice, { repo: SECRET_REPO });
    const html = await expectMessage(await get(w, signPath(p)), 404, "noTarget");
    expect(html).not.toContain(SECRET_REPO);
  });

  it("of a repository that is not served, or at an address that names none, is not found and asks GitHub nothing about it", async () => {
    const w = await world();
    await expectMessage(await get(w, "/sign/someone/else/1"), 404, "noTarget");
    await expectMessage(await get(w, "/sign/someone/else/0"), 404, "noTarget");
    expect(w.gh.requests.filter((r) => r.url.includes("someone"))).toEqual([]);
  });

  it("over its address's budget is refused before anything is read", async () => {
    const w = await world();
    must(w.limiters.RL_SIGN).allow = false;
    await expectMessage(await get(w, `/sign/${SANDBOX}/1`), 429, "tooManySign");
    expect(w.limiters.RL_SIGN?.keys).toEqual([IP]);
    expect(w.gh.requests).toEqual([]);
  });
});

describe("a failure of GitHub on the sign page", () => {
  const pulls = /^GET \/repos\/kleidos-dev\/cla-sandbox\/pulls\/\d+$/;

  it("is a page of its own for each kind, and its log line names the status, the kind and the request only", async () => {
    const cases: [number, Record<string, string>, number, keyof typeof MESSAGES, string][] = [
      [429, {}, 429, "ghRateLimited", "rate_limited"],
      [404, {}, 404, "ghNotFound", "not_found"],
      [502, {}, 503, "ghUnavailable", "transient"],
      [403, {}, 503, "ghUnavailable", "forbidden"],
    ];
    for (const [status, , page, key, kind] of cases) {
      const w = await world();
      const p = openPr(w, alice);
      w.gh.answer(pulls, () => json({ message: "x" }, status));
      await expectMessage(await get(w, signPath(p)), page, key);
      expect(lines(w), key).toEqual([{ msg: "github error", status, reason: kind, request_id: "ABCD:1234" }]);
    }
  });

  it("is not served when the repository's installation is on an account that is not allowed", async () => {
    const w = await world({ config: { ...CONFIG, served_repositories: { ...CONFIG.served_repositories, "kleidos-dev/elsewhere": { auto_approve: false } } } });
    w.gh.installations.set(2, { account: 4242 });
    w.gh.addRepo("kleidos-dev/elsewhere", { installation: 2, account: 4242 });
    const p = openPr(w, alice, { repo: "kleidos-dev/elsewhere" });
    await expectMessage(await get(w, signPath(p)), 404, "notServed");
  });

  it("says the pull request changed when its head moves while it is read", async () => {
    const w = await world();
    const p = openPr(w, alice);
    w.gh.onRequest = (method, path) => {
      if (method === "POST" && path === "/graphql") p.head.sha = sha();
    };
    await expectMessage(await get(w, signPath(p)), 503, "headMoved");
  });

  it("that is no GitHub error is not hidden behind a page", async () => {
    const w = await world();
    const p = openPr(w, alice);
    vi.spyOn(Registry.prototype, "config").mockRejectedValue(new TypeError("broken"));
    await expect(get(w, signPath(p))).rejects.toThrow("broken");
  });
});

describe("the sign page, signed in", () => {
  it("of an account that is no person says only a person can sign, in either language", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const org: User = { id: 777, login: "some-org", type: "Organization" };
    for (const lang of ["en", "es"] as const) {
      const r = await get(w, `${signPath(p)}?lang=${lang}`, await sessionHeader(w, session(org)));
      expect(r.status).toBe(403);
      const html = await r.text();
      expect(statusOf(html)).toEqual({ h1: S[lang].status.notUserTitle, card: S[lang].status.notUser("some-org"), who: `${S[lang].accept.signedInAs} @some-org` });
      expect(html).toContain('<div class="card is-pending" role="alert">');
    }
  });

  it("of an exempt author says there is nothing to sign, in either language", async () => {
    const w = await world({ config: { ...CONFIG, exempt: [...CONFIG.exempt, { id: carol.id, login: carol.login, why: "a test" }] } });
    const p = openPr(w, alice, { commits: [commit(alice), commit(carol)] });
    for (const lang of ["en", "es"] as const) {
      const r = await get(w, `${signPath(p)}?lang=${lang}`, await sessionHeader(w, session(carol)));
      expect(r.status).toBe(200);
      expect(statusOf(await r.text())).toEqual({ h1: S[lang].status.nothingTitle, card: S[lang].status.exempt("carol"), who: `${S[lang].accept.signedInAs} @carol` });
    }
  });

  it("of an author an entity covers names the entity, escaped, in either language", async () => {
    const w = await world();
    w.gh.setFile("main", "registry/entities.json", JSON.stringify({ schema: 1, entities: [{ slug: "acme", name: "Acme <Ltd>", version: 1, set_sha256: SET_1, signed_at: "2026-01-01", covered: [{ github_id: carol.id, from: "2026-01-01" }] }] }));
    const p = openPr(w, alice, { commits: [commit(alice), commit(carol, { date: "2026-11-01T10:00:00Z" })] });
    for (const lang of ["en", "es"] as const) {
      const r = await get(w, `${signPath(p)}?lang=${lang}`, await sessionHeader(w, session(carol)));
      expect(statusOf(await r.text())).toEqual({ h1: S[lang].status.nothingTitle, card: S[lang].status.entity("carol", "Acme &lt;Ltd&gt;"), who: `${S[lang].accept.signedInAs} @carol` });
    }
  });

  it("of an author who signed says when, links the register entry and has the pull request checked again", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const p = openPr(w, alice);
    for (const lang of ["en", "es"] as const) {
      const html = await (await get(w, `${signPath(p)}?lang=${lang}`, await sessionHeader(w, session(alice)))).text();
      expect(statusOf(html)).toEqual({ h1: S[lang].status.signedTitle, card: `${S[lang].status.signed(1, "2026-11-01")} <a href="https://github.com/kleidos-dev/cla/blob/signatures/signatures/individual/${alice.id}.json">${S[lang].status.entry}</a>.`, who: `${S[lang].accept.signedInAs} @alice` });
      expect(html).toContain('<div class="card is-done" role="status">');
    }
    expect(w.queue.sent.map((s) => s.body)).toEqual([
      { kind: "evaluate", repo: SANDBOX, pr: p.number },
      { kind: "evaluate", repo: SANDBOX, pr: p.number },
    ]);
  });

  it("of an account that wrote nothing here says there is nothing to sign, in either language", async () => {
    const w = await world();
    const p = openPr(w, alice);
    for (const lang of ["en", "es"] as const) {
      const html = await (await get(w, `${signPath(p)}?lang=${lang}`, await sessionHeader(w, session(bob)))).text();
      expect(statusOf(html)).toEqual({ h1: S[lang].status.nothingTitle, card: S[lang].status.notAuthor("bob"), who: `${S[lang].accept.signedInAs} @bob` });
    }
  });

  it("of a closed, locked or private pull request says so whoever is signed in", async () => {
    const w = await world({ config: { ...CONFIG, served_repositories: { ...CONFIG.served_repositories, [SECRET_REPO]: { auto_approve: false } } } });
    w.gh.addRepo(SECRET_REPO, { private: true });
    const cookie = await sessionHeader(w, session(alice));
    const closed = openPr(w, alice);
    closed.state = "closed";
    await expectMessage(await get(w, signPath(closed), cookie), 409, "closed");
    const locked = openPr(w, alice);
    locked.locked = true;
    await expectMessage(await get(w, signPath(locked), cookie), 409, "locked");
    await expectMessage(await get(w, signPath(openPr(w, alice, { repo: SECRET_REPO })), cookie), 404, "noTarget");
  });

  it("of an author who must sign, with a token for this pull request, is the acceptance", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const html = await (await get(w, signPath(p), await sessionHeader(w, session(alice, { token: "ghu_test", app: "bot", for: `${SANDBOX}#${p.number}` })))).text();
    expect(html).toContain("Step 2 of 2 · Accept");
    expect(html).toContain('action="/agree#accept" novalidate>');
    expect(html).toContain(`<title>Accept the Kleidos Contributor Agreement · ${SANDBOX}#${p.number}</title>`);
  });

  it("of a sign-in version, in Spanish, says the button records and posts nothing", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    const html = await (await get(w, `${signPath(p)}?lang=es`, await sessionHeader(w, session(alice, { token: "ghu_test", app: "signin", for: `${SANDBOX}#${p.number}` })))).text();
    expect(html).toContain(`<p class="note" id="post-note">${S.es.accept.noteSignin("alice", `${SANDBOX}#${p.number}`)}</p>`);
  });

  it("of an author who must sign but whose token is not for this acceptance starts again", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const other = `${SANDBOX}#${p.number + 1}`;
    for (const extra of [{}, { token: "ghu_test", app: "bot", for: other }, { token: "ghu_test", app: "signin", for: `${SANDBOX}#${p.number}` }, { token: "", for: `${SANDBOX}#${p.number}` }]) {
      const html = await (await get(w, signPath(p), await sessionHeader(w, session(alice, extra)))).text();
      expect(html, JSON.stringify(extra)).toContain(">Sign in with GitHub again to sign</a>");
      expect(html).toContain('<div class="who"><span>Signed in as <strong>@alice</strong></span>');
      expect(html).not.toContain('action="/agree');
    }
  });

  it("of an author who must sign while signing is paused shows the pause, not the acceptance", async () => {
    const w = await world({ config: CONFIG_V2 });
    const p = openPr(w, alice);
    const html = await (await get(w, signPath(p), await sessionHeader(w, session(alice, { token: "ghu_test", app: "signin", for: `${SANDBOX}#${p.number}` })))).text();
    expect(html).toContain(S.en.status.paused);
    expect(html).not.toContain('action="/agree');
  });

  it("with a session that has expired or is not one is the signed-out page", async () => {
    const w = await world();
    const p = openPr(w, alice);
    for (const cookie of [await sessionHeader(w, { ...session(alice), exp: 1 }), "__Host-cla=garbage", "__Host-cla="]) {
      const html = await (await get(w, signPath(p), cookie)).text();
      expect(html).toContain(">Sign in with GitHub to sign</a>");
      expect(html).not.toContain('<div class="who">');
    }
  });
});

/** An acceptance comment of the account on the pull request, as GitHub keeps it. */
function postComment(w: World, p: FakePr, by: User, o: { body?: string; edited?: boolean } = {}): { id: number; url: string } {
  const id = w.gh.next();
  w.gh.comments.push({ id, repo: p.repo, pr: p.number, body: o.body ?? CONFIG.versions["1"].sentence, user: by, created_at: "2026-11-02T10:00:00Z", updated_at: o.edited ? "2026-11-02T10:05:00Z" : "2026-11-02T10:00:00Z", via_app: true });
  return { id, url: `https://github.com/${p.repo}/pull/${p.number}#issuecomment-${id}` };
}

describe("the sign page after a posted acceptance", () => {
  async function pending(w: World, p: FakePr, c: { id: number; url: string }) {
    return sessionHeader(w, session(alice, { pending: { repo: p.repo, pr: p.number, comment_id: c.id, comment_url: c.url, at: "2026-11-02T10:00:00Z" } }));
  }

  it("while it is being recorded shows it signed, links the comment, and offers to check again", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const c = postComment(w, p, alice);
    const r = await get(w, signPath(p), await pending(w, p, c));
    const html = await r.text();
    expect(html).toContain(`<title>${S.en.done.titleRecording}</title>`);
    expect(html).toContain(`<p class="status is-pending">${S.en.done.statusRecording}</p>`);
    expect(html).toContain(`<div><dt class="eyebrow">${S.en.done.comment}</dt><dd><a href="${c.url}">${SANDBOX}#${p.number}</a></dd></div>`);
    expect(html).toContain(`<dd>1 · SHA-256 <code>${SET_1}</code></dd>`);
    expect(html).toContain("<dd>2026-11-02T10:00:00Z</dd>");
    expect(html).toContain(`${S.en.done.entryRecording} <a href="${signPath(p)}?lang=en">${S.en.done.checkNow}</a>`);
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("once recorded links the record at the commit that added it, or on the branch when that commit cannot be read", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const c = postComment(w, p, alice);
    await w.gh.record(c.id);
    const commitSha = must(w.gh.recordCommits.get(alice.id));
    const html = await (await get(w, signPath(p), await pending(w, p, c))).text();
    expect(html).toContain(`<title>${S.en.done.titleRecorded}</title>`);
    expect(html).toContain(`<a href="https://github.com/kleidos-dev/cla/blob/${commitSha}/signatures/individual/${alice.id}.json">signatures/individual/${alice.id}.json</a>`);
    expect(html).toContain(`<dd>2026-11-02T10:00:00Z</dd>`);
    vi.spyOn(Registry.prototype, "recordCommit").mockRejectedValue(new Error("unreadable"));
    const again = await (await get(w, signPath(p), await pending(w, p, c))).text();
    expect(again).toContain(`<a href="https://github.com/kleidos-dev/cla/blob/signatures/signatures/individual/${alice.id}.json">`);
  });

  it("that was edited, deleted, or is not the account's own says so, and forgets it", async () => {
    for (const change of ["edited", "deleted", "someone else's", "another sentence"] as const) {
      const w = await world();
      const p = openPr(w, alice);
      const c = postComment(w, p, change === "someone else's" ? bob : alice, { edited: change === "edited", ...(change === "another sentence" ? { body: "I agree" } : {}) });
      if (change === "deleted") w.gh.comments = [];
      const r = await get(w, signPath(p), await pending(w, p, c));
      const html = await r.text();
      expect(html, change).toContain(`<div class="card is-pending" role="alert"><p>${S.en.status.edited}</p></div>`);
      expect(html).toContain(">Sign in with GitHub again to sign</a>");
      const s = await sessionSet(w, r);
      expect(s?.pending, change).toBeUndefined();
      expect(s?.id).toBe(alice.id);
    }
  });

  it("whose comment GitHub cannot read now is GitHub's failure, not a refusal", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const c = postComment(w, p, alice);
    w.gh.answer(/^GET \/repos\/kleidos-dev\/cla-sandbox\/issues\/comments\/\d+$/, () => json({}, 502));
    await expectMessage(await get(w, signPath(p), await pending(w, p, c)), 503, "ghUnavailable");
  });

  it("of another pull request is not shown here", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const q = openPr(w, alice);
    const c = postComment(w, q, alice);
    const html = await (await get(w, signPath(p), await pending(w, q, c))).text();
    expect(html).toContain(">Sign in with GitHub again to sign</a>");
    const sameNumber = await (await get(w, signPath(p), await sessionHeader(w, session(alice, { pending: { repo: "kleidos-dev/cla", pr: p.number, comment_id: c.id, comment_url: c.url, at: "x" } })))).text();
    expect(sameNumber).toContain(">Sign in with GitHub again to sign</a>");
  });
});

describe("the sign page after a sign-in acceptance", () => {
  async function pending(w: World, p: FakePr, version = 2) {
    return sessionHeader(w, session(alice, { pending: { signin: true, repo: p.repo, pr: p.number, version, at: "2026-11-23T10:00:00Z" } }));
  }
  const run = (p: FakePr, o: Partial<{ status: string; conclusion: string | null; created_at: string }> = {}) => ({ display_title: `Record signin ${p.repo}#${p.number} ${alice.id}`, created_at: "2026-11-23T10:00:01Z", status: "in_progress", conclusion: null, head_branch: "main", ...o });

  it("while the recorder runs shows it signed with nothing posted, at the version handed over", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    w.gh.recordRuns.push(run(p));
    const html = await (await get(w, signPath(p), await pending(w, p))).text();
    expect(html).toContain(`<title>${S.en.done.titleRecording}</title>`);
    expect(html).toContain(`<dd>2 · SHA-256 <code>${CONFIG.versions["2"].set_sha256}</code></dd>`);
    expect(html).toContain(`<div><dt class="eyebrow">Pull request</dt><dd><a href="https://github.com/${SANDBOX}/pull/${p.number}">${SANDBOX}#${p.number}</a></dd></div>`);
    expect(html).not.toContain(`>${S.en.done.comment}</dt>`);
  });

  it("whose run cannot be found or read is shown as being recorded, at the current digest for a version the register lost", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    expect(await (await get(w, signPath(p), await pending(w, p))).text()).toContain(`<title>${S.en.done.titleRecording}</title>`);
    vi.spyOn(Registry.prototype, "signinRun").mockRejectedValue(new Error("unreadable"));
    const lost = await (await get(w, signPath(p), await pending(w, p, 9))).text();
    expect(lost).toContain(`<dd>9 · SHA-256 <code>${CONFIG.versions["2"].set_sha256}</code></dd>`);
  });

  it("once recorded shows the record's own version and time", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    await w.gh.recordSignin(alice);
    const html = await (await get(w, signPath(p), await pending(w, p))).text();
    expect(html).toContain(`<title>${S.en.done.titleRecorded}</title>`);
    expect(html).toContain("<dd>2026-11-23T10:00:05Z</dd>");
    expect(w.gh.seen(/actions\/workflows/)).toEqual([]);
  });

  it("whose recorder run failed says so, forgets it and offers to sign again", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    w.gh.recordRuns.push(run(p, { status: "completed", conclusion: "failure" }));
    const r = await get(w, signPath(p), await pending(w, p));
    const html = await r.text();
    expect(html).toContain(`<div class="card is-pending" role="alert"><p>${S.en.status.recordFailed}</p></div>`);
    expect(html).toContain(">Sign in with GitHub again to sign</a>");
    expect((await sessionSet(w, r))?.pending).toBeUndefined();
  });
});
