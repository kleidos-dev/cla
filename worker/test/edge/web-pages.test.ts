// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The public pages a visitor reads without signing in (the agreement in
 * both versions and languages, the privacy notice, the page after the
 * app's installation), and the last edges of the sign-in, the sign-out and
 * the acceptance: a form or a redirect with a field missing, an
 * acceptance of another account, a recorder whose installation is not
 * allowed, a secret that cannot be sent, and a comment GitHub answers
 * without its words.
 */
import { describe, expect, it, vi } from "vitest";
import { AGREEMENTS, NOTICES, filesOf } from "../../src/agreement";
import { renderMarkdown } from "../../src/markdown";
import { S } from "../../src/i18n";
import { csrfToken } from "../../src/keys";
import { NotAllowedError } from "../../src/github";
import { Registry } from "../../src/registry";
import { must } from "../../src/util";
import { commit } from "../fakegh";
import type { FakePr } from "../fakegh";
import { Browser, CONFIG, CONFIG_V2, ORIGIN, SANDBOX, alice, call, carol, expectMessage, keysOf, lines, openPr, restoring, sessionHeader, transactionHeader, world } from "./support";

restoring();

const SET_1 = CONFIG.versions["1"].set_sha256;
const SET_2 = CONFIG.versions["2"].set_sha256;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** The meta line of a page: version, digest, the files at the build's commit, the downloads. */
const meta = (lang: "en" | "es", v: number, set: string, kind: string, ref: string, shown: string) =>
  `<p class="meta"><span>${S[lang].meta(v, set)}</span><span><a href="https://github.com/kleidos-dev/cla/tree/${ref}/agreements/v${v}">kleidos-dev/cla@<code>${shown}</code></a></span><span>${S[lang].downloads}: <a href="/agreement/v${v}/${kind}.md" download>${kind}.md</a>, <a href="/agreement/v${v}/addendum.md" download>addendum.md</a>, <a href="/agreement/v${v}/SHA256SUMS" download>SHA256SUMS</a></span></p>`;

describe("the agreement page", () => {
  it("in English shows the binding texts with their contents, the build's commit and how to sign", async () => {
    const w = await world();
    const r = await call(w, "/agreement");
    const html = await r.text();
    expect(r.headers.get("cache-control")).toBe("public, max-age=300, no-transform");
    expect(html).toContain(`<title>${S.en.agreement.title}</title>`);
    expect(html).toContain('<body class="is-doc">');
    expect(html).toContain(`<h1 class="h-page">${S.en.agreement.h1}</h1>`);
    expect(html).toContain(meta("en", 1, SET_1, "individual", COMMIT, COMMIT.slice(0, 12)));
    expect(html).toContain(`<p class="note">${S.en.agreement.how} ${S.en.agreement.entity.replace('href="/agreement/entity"', 'href="/agreement/entity?lang=en"')}</p>`);
    expect(html).toContain('<details class="toc" open><summary class="eyebrow">Contents</summary><ol>\n<li><a href="#ca-');
    expect(html).toContain(`<section class="prose" lang="en" aria-label="Contributor Agreement">`);
    expect(html).toContain(`<section class="prose" lang="en" aria-label="Addendum">`);
    expect(html).not.toContain('class="banner"');
    expect(html).not.toContain(S.en.notConfigured);
    expect(html).not.toContain(S.es.agreement.partSummary);
  });

  it("in Spanish shows the informative translations, the summary and the binding-text banner", async () => {
    const w = await world();
    const html = await (await call(w, "/agreement?lang=es")).text();
    expect(html).toContain(`<div class="banner">${S.es.agreement.banner ?? ""}</div>`);
    expect(html).toContain(`<details class="fold"><summary><span>${S.es.agreement.partSummary}<small>${S.es.agreement.partSummarySub}</small></span></summary>`);
    expect(html).toContain('<section class="prose" lang="es" aria-label="Acuerdo">');
    expect(html).toContain('<section class="prose" lang="es" aria-label="Anexo">');
    expect(html).toContain(`<li><a href="#ca-`);
    expect(html).toContain(`>${S.es.agreement.partA}</a><ol>`);
    expect(html).toContain(meta("es", 1, SET_1, "individual", COMMIT, COMMIT.slice(0, 12)));
  });

  it("of the entity version keeps its text in English in either language, says how it is signed, and offers its own download", async () => {
    const w = await world();
    const en = await (await call(w, "/agreement/entity")).text();
    expect(en).toContain(`<h1 class="h-page">${S.en.agreement.entityH1}</h1>`);
    expect(en).toContain(`<div class="card"><p>${S.en.agreement.entityNote}</p></div>\n<details`);
    expect(en).toContain(meta("en", 1, SET_1, "entity", COMMIT, COMMIT.slice(0, 12)));
    const es = await (await call(w, "/agreement/entity?lang=es")).text();
    expect(es).toContain(`<div class="card"><p>${S.es.agreement.entityNote}</p></div>\n<p class="note">${S.es.agreement.entityOnlyEnglish ?? ""}</p>`);
    expect(es).toContain('<section class="prose" lang="en" aria-label="Acuerdo">');
    expect(es).toContain(">Contributor Agreement (English)</a><ol>");
    expect(es).toContain(`<link rel="alternate" hreflang="en" href="/agreement/entity?lang=en">`);
  });

  it("built from no known commit links the texts on main", async () => {
    const w = await world();
    w.env.BUILD_COMMIT = "unknown";
    expect(await (await call(w, "/agreement")).text()).toContain(meta("en", 1, SET_1, "individual", "main", "main"));
  });

  it("of a Worker not configured says signing is not open yet", async () => {
    const w = await world({ configure: false });
    expect(await (await call(w, "/agreement?lang=es")).text()).toContain(`<div class="card" role="status"><p><strong>${S.es.notConfigured}</strong></p></div>\n<div class="banner">`);
  });

  it("of version 2 shows version 2's texts", async () => {
    const w = await world({ config: CONFIG_V2 });
    const html = await (await call(w, "/agreement")).text();
    expect(html).toContain(meta("en", 2, SET_2, "individual", COMMIT, COMMIT.slice(0, 12)));
    expect(html).toContain(`<p class="eyebrow">${S.en.agreement.eyebrow(2)}</p>`);
    expect(must(AGREEMENTS[2])["addendum.md"]).not.toBe(must(AGREEMENTS[1])["addendum.md"]);
    // The isolate remembers the version it last showed (index.ts): read version 1 again, so no later test starts from 2.
    await call(await world(), "/agreement");
  });
});

describe("the agreement page's parts", () => {
  /** The parts of a page as renderMarkdown makes them, with the ids the page gives them. */
  const part = (src: string, prefix: string) => renderMarkdown(src.replace(/^<!--[\s\S]*?-->\s*/, ""), { headingShift: 1, idPrefix: prefix });

  it("lists in its contents the Agreement's clauses and the Addendum's sections, each linked to its heading", async () => {
    const w = await world();
    const html = await (await call(w, "/agreement")).text();
    const ca = part(must(filesOf(1)["individual.md"]), "ca");
    const ad = part(must(filesOf(1)["addendum.md"]), "ad");
    const li = (h: { id: string; html: string }) => `<li><a href="#${h.id}">${h.html}</a></li>`;
    const clauses = ca.headings.filter((h) => h.level === 4);
    const sections = ad.headings.filter((h) => h.level === 3);
    expect(clauses.length).toBeGreaterThan(3);
    expect(sections.length).toBeGreaterThan(3);
    expect(html).toContain(
      `<details class="toc" open><summary class="eyebrow">Contents</summary><ol>\n<li><a href="#${must(ca.headings[0]).id}">${S.en.agreement.partA}</a><ol>${clauses.map(li).join("")}</ol></li>\n<li><a href="#${must(ad.headings[0]).id}">${S.en.agreement.partB}</a><ol>${sections.map(li).join("")}</ol></li>\n</ol></details>`,
    );
    expect(html).toContain(`<section class="prose" lang="en" aria-label="Contributor Agreement">${ca.html}</section>\n<section class="prose" lang="en" aria-label="Addendum">${ad.html}</section>`);
  });

  it("says what the agreement says, item by item, and nothing in English where only Spanish adds a part", async () => {
    const w = await world();
    const html = await (await call(w, "/agreement")).text();
    const items = S.en.accept.summary.map(([k, v]) => `<li><strong>${k}</strong> ${v}</li>`).join("");
    expect(html).toContain(`<h1 class="h-page">${S.en.agreement.h1}</h1>\n\n<p class="lede">${S.en.agreement.lede}</p>\n<ul class="summary" aria-label="${S.en.accept.summaryLabel}">${items}</ul>\n\n<p class="meta">`);
  });

  it("in Spanish shows the translation without its licence comment, and the summary with ids of its own", async () => {
    const w = await world();
    const html = await (await call(w, "/agreement?lang=es")).text();
    const ca = part(must(filesOf(1)["individual.es.md"]), "ca");
    expect(html).toContain(`<section class="prose" lang="es" aria-label="Acuerdo">${ca.html}</section>`);
    expect(html).not.toContain("SPDX");
    expect(html).toContain(`<div class="prose">${part(must(filesOf(1)["summary.es.md"]), "re").html}</div>`);
  });

  it("of the entity version in Spanish shows the entity text in English, not the individual translation", async () => {
    const w = await world();
    const html = await (await call(w, "/agreement/entity?lang=es")).text();
    expect(html).toContain(`<section class="prose" lang="en" aria-label="Acuerdo">${part(must(filesOf(1)["entity.md"]), "ca").html}</section>`);
    expect(html).not.toContain("Acuerdo de Contribución (traducción informativa)</h2>");
  });
});

describe("the other public pages", () => {
  it("the privacy notice is the notice in the reader's language, a document, its links to the other language rewritten", async () => {
    const w = await world();
    const links = { "PRIVACY.es.md": "/privacy?lang=es", "PRIVACY.md": "/privacy?lang=en" };
    for (const [lang, src] of [
      ["en", NOTICES.privacy],
      ["es", NOTICES.privacyEs],
    ] as const) {
      const r = await call(w, `/privacy?lang=${lang}`);
      const html = await r.text();
      const notice = renderMarkdown(src, { idPrefix: "p", links }).html;
      expect(html).toContain(`<main id="main" class="doc">\n<div class="progress"><p class="eyebrow">${S[lang].privacy.eyebrow}</p></div>\n<div class="prose privacy">${notice}</div>`);
      expect(notice).toContain(lang === "en" ? 'href="/privacy?lang=es"' : 'href="/privacy?lang=en"');
      expect(html).toContain(`<title>${S[lang].privacy.title}</title>`);
      expect(r.headers.get("cache-control")).toBe("public, max-age=300, no-transform");
    }
  });

  it("the page after the installation says what the app serves, in either language", async () => {
    const w = await world();
    expect(await (await call(w, "/setup")).text()).toContain('<h1 class="h-task">kleidos-cla installed</h1>\n<p>The app is installed. It serves only the Kleidos repositories; an installation on any other account is removed automatically.</p>');
    expect(await (await call(w, "/setup")).text()).toContain('<link rel="alternate" hreflang="es" href="/setup?lang=es">');
    expect(await (await call(w, "/setup?lang=es")).text()).toContain('<h1 class="h-task">kleidos-cla instalada</h1>\n<p>La aplicación está instalada. Solo atiende los repositorios de Kleidos; una instalación en cualquier otra cuenta se retira automáticamente.</p>');
  });
});

const FORM = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
const signPath = (p: FakePr) => `/sign/${p.repo}/${p.number}`;

describe("a form or a redirect with a field missing", () => {
  it("a callback with no state is refused as a sign-in that did not start here", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const cookie = await transactionHeader(w, { state: "s".repeat(43), verifier: "v", return: signPath(p) });
    await expectMessage(await call(w, "/auth/callback?code=abc", { headers: { cookie } }), 400, "oauthState");
  });

  it("a sign-out or an acceptance with no CSRF field is refused as stale", async () => {
    const w = await world();
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", token: "ghu_x", for: `${SANDBOX}#1` });
    await expectMessage(await call(w, "/auth/logout", { method: "POST", headers: { ...FORM, cookie }, body: "lang=en" }), 403, "refusedStale");
    await expectMessage(await call(w, "/agree", { method: "POST", headers: { ...FORM, cookie }, body: "owner=kleidos-dev&repo=cla-sandbox&pr=1&version=1" }), 403, "csrf");
    expect(w.gh.requests).toEqual([]);
  });
});

describe("the last edges of the flows", () => {
  it("a sign-out with the sign-in app's id but not its secret revokes nothing", async () => {
    const w = await world({ signinSecrets: true });
    w.env.SIGNIN_CLIENT_SECRET = "";
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "s1", token: "ghu_x", app: "signin" });
    const csrf = await csrfToken((await keysOf(w)).csrf, ["s1", "logout"]);
    expect((await call(w, "/auth/logout", { method: "POST", headers: { ...FORM, cookie }, body: `csrf=${encodeURIComponent(csrf)}` })).status).toBe(303);
    expect(w.gh.requests).toEqual([]);
    expect(lines(w)).toEqual([]);
  });

  it("a revocation whose credentials cannot even be sent is logged with no status, and the sign-out goes on", async () => {
    const w = await world();
    w.env.CLIENT_SECRET = "secret-with-€";
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", sid: "s1", token: "ghu_x" });
    const csrf = await csrfToken((await keysOf(w)).csrf, ["s1", "logout"]);
    expect((await call(w, "/auth/logout", { method: "POST", headers: { ...FORM, cookie }, body: `csrf=${encodeURIComponent(csrf)}` })).status).toBe(303);
    expect(lines(w)).toEqual([{ msg: "grant revocation failed", status: 0 }]);
    expect(w.gh.requests).toEqual([]);
  });

  it("an acceptance posted earlier by another author is not the signer's: the signer's own is posted", async () => {
    const w = await world();
    const p = openPr(w, alice, { commits: [commit(alice), commit(carol)] });
    const b = new Browser(w, alice);
    await b.signIn(signPath(p));
    const form = Browser.form(await (await b.get(signPath(p))).text());
    w.gh.comments.push({ id: w.gh.next(), repo: SANDBOX, pr: p.number, body: CONFIG.versions["1"].sentence, user: carol, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", via_app: true });
    expect((await b.post("/agree", { ...form, accept: "yes" })).status).toBe(303);
    expect(w.gh.comments.filter((c) => c.user.id === alice.id)).toHaveLength(1);
    expect(w.gh.comments.filter((c) => c.user.id === carol.id)).toHaveLength(1);
  });

  it("a sign-in acceptance whose recorder's installation is not allowed is not handed over, and the log has no status", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const p = openPr(w, alice);
    const b = new Browser(w, alice);
    await b.signIn(signPath(p));
    const form = Browser.form(await (await b.get(signPath(p))).text());
    vi.spyOn(Registry.prototype, "dispatchSignin").mockRejectedValue(new NotAllowedError("installation_not_allowed"));
    w.logs.length = 0;
    await expectMessage(await b.post("/agree", { ...form, accept: "yes" }), 503, "recorderUnreachable");
    expect(w.gh.dispatches).toEqual([]);
    expect(lines(w)[0]).toEqual({ msg: "signin dispatch failed", repo: SANDBOX, pr: p.number, status: 0 });
  });

  // A question for the owner, of F8's kind: a comment GitHub answers without its words is not GitHub's failure page but the Worker's 500.
  it("a posted acceptance whose comment GitHub answers with no words ends in the Worker's 500 (pinned as it is today)", async () => {
    const w = await world();
    const p = openPr(w, alice);
    const id = w.gh.next();
    w.gh.answer(new RegExp(`^GET /repos/kleidos-dev/cla-sandbox/issues/comments/${id}$`), () => new Response(JSON.stringify({ body: null, created_at: "a", updated_at: "a", user: { id: alice.id } }), { headers: { "content-type": "application/json" } }));
    const cookie = await sessionHeader(w, { id: alice.id, login: "alice", type: "User", pending: { repo: SANDBOX, pr: p.number, comment_id: id, comment_url: "https://github.com/x", at: "a" } });
    await expect(call(w, signPath(p), { headers: { cookie } })).rejects.toThrow(TypeError);
  });
});
