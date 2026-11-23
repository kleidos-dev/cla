// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGREEMENTS, NOTICES, checkIntegrity, filesOf } from "../src/agreement";
import { coAuthorEmails, commitAuthors, parseNoreply } from "../src/authors";
import { CSP } from "../src/html";
import { log } from "../src/log";
import { renderInline, renderMarkdown } from "../src/markdown";
import { parseMessage } from "../src/messages";
import { who } from "../src/texts";
import { parseSignPath, sentenceFor } from "../src/web";
import { commit } from "./fakegh";
import { Browser, CONFIG, SANDBOX, drain, openPr, prEvent, webhook, world } from "./helpers";
import { htmlWords } from "./readhtml";
import { must } from "../src/util";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The words of the Markdown source, its syntax removed independently of the renderer. */
function sourceWords(md: string): string[] {
  const text = md
    .split("\n")
    .map((l) => (/^#{1,6}\s/.test(l) ? l.replace(/^#{1,6}\s+/, "") : l.replace(/^\s*(?:[-*+]|\d{1,3}\.)\s+/, "")))
    .join("\n")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label: string) => label)
    .replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)))
    .replace(/\*\*|`|(?<!\w)\*(?=\S)|(?<=\S)\*(?!\w)/g, "")
    .replace(/[\ue000-\ue0ff]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
  return text.split(/\s+/).filter(Boolean);
}

describe("agreement texts", () => {
  it("every version bundled is every version published, its bytes hashing to SHA256SUMS and its set digest the registry's", async () => {
    expect(Object.keys(AGREEMENTS).sort()).toEqual(Object.keys(CONFIG.versions).sort());
    for (const v of Object.keys(CONFIG.versions) as (keyof typeof CONFIG.versions)[]) {
      const i = await checkIntegrity(Number(v));
      expect(i.ok, `v${v}`).toBe(true);
      expect(i.setSha256).toBe(CONFIG.versions[v].set_sha256);
      expect(i.files).toEqual(CONFIG.versions[v].files);
    }
    expect((await checkIntegrity(99)).ok).toBe(false);
  });

  it("the acceptance sentence is built from the digest and is the registry's", () => {
    for (const v of Object.keys(CONFIG.versions) as (keyof typeof CONFIG.versions)[]) expect(sentenceFor(Number(v), CONFIG.versions[v].set_sha256)).toBe(CONFIG.versions[v].sentence);
  });

  it("the rendering keeps every word of every text, in order", () => {
    const texts: [string, string][] = [["PRIVACY.md", NOTICES.privacy], ["PRIVACY.es.md", NOTICES.privacyEs]];
    for (const [v, files] of Object.entries(AGREEMENTS)) for (const [name, src] of Object.entries(files)) texts.push([`v${v}/${name}`, src]);
    for (const [name, src] of texts) {
      if (!name.endsWith(".md")) continue;
      expect(htmlWords(renderMarkdown(src).html), name).toEqual(sourceWords(src));
    }
  });

  it("the renderer escapes everything and keeps only safe link targets", () => {
    expect(renderInline("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderInline('[x](javascript:alert(1))')).not.toContain("href");
    expect(renderInline('[x](https://a.example/"onmouseover=1)')).not.toContain('"onmouseover');
    expect(renderInline("**bold** and *em* and `code<`")).toBe("<strong>bold</strong> and <em>em</em> and <code>code&lt;</code>");
    expect(renderInline("\\*\\*literal\\*\\*")).toBe("**literal**");
    expect(renderMarkdown("# T\n\n- a\n   - b\n- c\n\n1. x\n2. y").html).toBe("<h1>T</h1>\n<ul>\n<li>\na\n<ul>\n<li>\nb\n</li>\n</ul>\n</li>\n<li>\nc\n</li>\n</ul>\n<ol>\n<li>\nx\n</li>\n<li>\ny\n</li>\n</ol>");
  });
});

describe("pure helpers", () => {
  it("resolves no-reply emails and co-author trailers", () => {
    expect(parseNoreply("49699333+dependabot[bot]@users.noreply.github.com")).toEqual({ id: 49699333, login: "dependabot[bot]", type: "Bot" });
    expect(parseNoreply("123+alice@users.noreply.github.com")).toEqual({ id: 123, login: "alice", type: "User" });
    expect(parseNoreply("alice@users.noreply.github.com")).toBeNull();
    expect(parseNoreply("123+al ice@users.noreply.github.com")).toBeNull();
    expect(coAuthorEmails("x\n\nCo-authored-by: A <A@Example.org>\nco-authored-by:B<b@x.y>\nSigned-off-by: C <c@x.y>")).toEqual(["a@example.org", "b@x.y"]);
    const bob = { id: 2, login: "bob", type: "User" as const };
    const c = commit({ id: 1, login: "alice", type: "User" }, { coAuthors: [bob] });
    expect(commitAuthors(c).accounts.map((a) => a.login)).toEqual(["alice", "bob"]);
  });

  it("parses queue messages defensively", () => {
    expect(parseMessage({ kind: "evaluate", repo: "a/b", pr: 3 })).toEqual({ kind: "evaluate", repo: "a/b", pr: 3 });
    expect(parseMessage({ kind: "evaluate", repo: "a/b/../c", pr: 3 })).toBeNull();
    expect(parseMessage({ kind: "release", repo: "a/b", pr: 3, sha: "x" })).toBeNull();
    expect(parseMessage({ kind: "nope" })).toBeNull();
    expect(parseMessage("evaluate")).toBeNull();
  });

  it("validates sign paths and logins in comment text", () => {
    expect(parseSignPath("/sign/kleidos-dev/boards/42")).toEqual({ repo: "kleidos-dev/boards", pr: 42, path: "/sign/kleidos-dev/boards/42" });
    for (const p of ["/sign/kleidos-dev/boards/042", "/sign/kleidos-dev/../42", "/sign/kleidos-dev/boards/42/", "/sign/a/b/99999999999"]) expect(parseSignPath(p), p).toBeNull();
    expect(who({ id: 5, login: "<img>", type: "User" }, 1)).toBe("account id 5");
    expect(who({ id: 5, login: "bob", type: "User" }, 1)).toBe("[bob](https://github.com/bob)");
    expect(who({ id: 5, login: "bob", type: "User" }, 5)).toBe("@bob");
  });

  it("the logger keeps only allowlisted, safe fields", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    log("x", { repo: "a/b", token: "ghu_secret", email: "a@b.c", reason: "ghs_abc", account: 5 });
    expect(JSON.parse(must(lines[0]))).toEqual({ msg: "x", repo: "a/b", reason: "redacted" });
  });
});

describe("pages and hygiene", () => {
  it("every HTML response carries the security headers; cookies are __Host-, Secure, HttpOnly", async () => {
    const w = await world();
    const pr = openPr(w, { id: 123456, login: "alice", type: "User" });
    const b = new Browser(w, { id: 123456, login: "alice", type: "User" });
    const path = `/sign/${SANDBOX}/${pr.number}`;
    const es = { "accept-language": "es-ES,es;q=0.9" };
    const responses = [
      await b.get("/agreement"),
      await b.get("/agreement/entity"),
      await b.get("/agreement/es"),
      await b.get("/agreement?lang=es"),
      await b.get("/agreement/entity?lang=es"),
      await b.get("/privacy"),
      await b.get("/privacy/es"),
      await b.get("/privacy", es),
      await b.get("/setup"),
      await b.get(path),
      await b.get(path, es),
      await b.get("/sign/kleidos-dev/boards/1"),
      await b.get("/button/v2/needed-0-2.svg"),
      await b.get("/assets/mark.svg"),
    ];
    const { callback } = await b.signIn(path);
    responses.push(callback, await b.get(path));
    for (const r of responses) {
      if (r.headers.get("content-type")?.startsWith("text/html")) {
        expect(r.headers.get("content-security-policy")).toBe(CSP);
        expect(r.headers.get("x-frame-options")).toBe("DENY");
        // same-origin, not no-referrer: under no-referrer a browser posts the form with `Origin: null`.
        expect(r.headers.get("referrer-policy")).toBe("same-origin");
        expect(r.headers.get("strict-transport-security")).toContain("includeSubDomains");
      }
      for (const c of r.headers.getSetCookie()) {
        expect(c).toMatch(/^__Host-/);
        expect(c).toContain("Secure");
        expect(c).toContain("HttpOnly");
        expect(c).toContain("SameSite=Lax");
        expect(c).toContain("Path=/");
      }
    }
    const html = await (await b.get(path)).text();
    expect(html).not.toMatch(/<script|\son[a-z]+=|\sstyle=/i);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<a href="${path}?lang=es" hreflang="es" lang="es">Español</a>`);
    for (const r of responses) {
      // Every response carries the policy, the SVG image included; HTML says its language and varies on it.
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      if (r.headers.get("content-type")?.startsWith("text/html")) {
        expect(r.headers.get("content-language")).toMatch(/^(en|es)$/);
        expect(r.headers.get("vary")).toBe("Accept-Language");
      }
    }
  });

  it("public routes: downloads are the hashed bytes, unknown paths 404, wrong methods 405, the stylesheet is served", async () => {
    const w = await world();
    const b = new Browser(w, { id: 1, login: "x", type: "User" });
    const dl = await b.get("/agreement/v1/individual.md");
    expect(dl.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await dl.text()).toBe(filesOf(1)["individual.md"]);
    expect(await (await b.get("/agreement/v2/addendum.md")).text()).toBe(filesOf(2)["addendum.md"]);
    expect((await b.get("/agreement/v3/individual.md")).status).toBe(404);
    expect((await b.get("/agreement/v1/../../wrangler.jsonc")).status).toBe(404);
    expect((await b.get("/nope")).status).toBe(404);
    expect((await b.post("/agreement", {})).status).toBe(405);
    const page = await (await b.get("/agreement")).text();
    const css = must(must(/href="(\/assets\/cla\.[0-9a-f]{12}\.css)"/.exec(page))[1]);
    expect((await b.get(css)).headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await b.get("/assets/cla.000000000000.css")).status).toBe(404);
    expect((await b.get("/robots.txt")).status).toBe(200);
    expect(await (await b.get("/.well-known/security.txt")).text()).toContain("Contact: mailto:mail@kleidos.dev");
    const health = await (await b.get("/healthz")).json<{ ok: boolean; signing: boolean; set_sha256: string }>();
    expect(health).toMatchObject({ ok: true, signing: true, set_sha256: CONFIG.versions["1"].set_sha256 });
  });

  it("no flow writes a token, a key, an OAuth parameter, a cookie, an email or an address to the logs", async () => {
    const w = await world();
    const alice = { id: 123456, login: "alice", type: "User" as const };
    const pr = openPr(w, alice, { commits: [commit(alice, { coAuthors: [{ email: "private.person@example.org" }] }), commit(alice)] });
    await webhook(w, "pull_request", prEvent(pr, "opened"));
    await webhook(w, "pull_request", prEvent(pr, "opened"), { signature: "sha256=00" });
    await drain(w);
    pr.commits = [commit(alice)];
    const b = new Browser(w, alice);
    const path = `/sign/${SANDBOX}/${pr.number}`;
    await b.signIn(path);
    const form = Browser.form(await (await b.get(path)).text());
    await b.post("/agree", { ...form, accept: "yes" });
    await b.get(`/auth/callback?code=abc&state=def`);
    await drain(w);
    const cookieValues = [...b.jar.values()];
    expect(w.logs.length).toBeGreaterThan(5);
    for (const line of w.logs) {
      expect(line).not.toMatch(/gh[uprs]_|-----BEGIN|code=|state=|@|203\.0\.113\.7|example\.org/);
      for (const c of cookieValues) expect(line).not.toContain(c);
    }
  });
});
