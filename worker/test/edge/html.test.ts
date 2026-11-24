// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What every response of the site carries: the security headers by value,
 * the cache policy, the encoding the request allows, and the page frame
 * around a body (its language, its links in that language, its title
 * escaped).
 */
import { describe, expect, it } from "vitest";
import { CSP, localize, messagePage, page, redirect, securityHeaders, stylesheetPath, text, withEncoding } from "../../src/html";
import { restoring } from "./support";

restoring();

const SECURITY = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
};

function headersOf(r: Response | Headers): Record<string, string> {
  return Object.fromEntries((r instanceof Response ? r.headers : r).entries());
}

describe("the security headers", () => {
  it("are set by value on any headers, with the cache policy asked, replacing what was there", () => {
    const h = securityHeaders(new Headers({ "content-type": "text/plain", "x-frame-options": "SAMEORIGIN", "cache-control": "max-age=9" }), "no-store");
    expect(headersOf(h)).toEqual({ ...SECURITY, "content-type": "text/plain", "cache-control": "no-store, no-transform" });
    expect(CSP).toBe(SECURITY["content-security-policy"]);
  });

  it("carry no-transform in every cache policy, so the edge never rewrites a page", () => {
    expect(securityHeaders(new Headers(), "public").get("cache-control")).toBe("public, max-age=300, no-transform");
    expect(securityHeaders(new Headers(), "immutable").get("cache-control")).toBe("public, max-age=31536000, immutable, no-transform");
  });
});

describe("text and redirect", () => {
  it("text is plain, uncached and 200 unless asked otherwise", async () => {
    const r = text("hello\n");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("hello\n");
    expect(headersOf(r)).toEqual({ ...SECURITY, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store, no-transform" });
    const j = text("{}", 418, "application/json", "public");
    expect([j.status, j.headers.get("content-type"), j.headers.get("cache-control")]).toEqual([418, "application/json", "public, max-age=300, no-transform"]);
  });

  it("a redirect is a 303 with no body unless asked otherwise, and carries each cookie in its own header", async () => {
    const r = redirect("/x?y=1");
    expect(r.status).toBe(303);
    expect(await r.text()).toBe("");
    expect(r.headers.get("location")).toBe("/x?y=1");
    expect(r.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(r.headers.getSetCookie()).toEqual([]);
    const c = redirect("https://github.com/x", 302, ["a=1; Path=/", "b=2; Path=/"]);
    expect(c.status).toBe(302);
    expect(c.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(c.headers.get("content-security-policy")).toBe(CSP);
  });
});

describe("the encoding of a response", () => {
  const html = () => new Response("<p>x</p>", { headers: { "content-type": "text/html; charset=utf-8", vary: "Accept-Language" } });
  const ask = (enc: string | null) => new Request("https://cla.kleidos.dev/", enc === null ? {} : { headers: { "accept-encoding": enc } });

  it("is brotli when the request allows it, else gzip, else none, and always varies on Accept-Encoding", () => {
    const cases: [string | null, string | null][] = [
      ["gzip, deflate, br", "br"],
      ["BR", "br"],
      ["gzip", "gzip"],
      [" gzip ;q=0.5 , br;q=0", "gzip"],
      ["br; q=0", null],
      ["br;q=0.0, gzip;q=0", null],
      ["br;q=abc", "br"],
      ["br;level=1", "br"],
      ["identity", null],
      ["deflate", null],
      ["", null],
      [null, null],
    ];
    for (const [enc, want] of cases) {
      const r = withEncoding(ask(enc), html());
      expect([r.headers.get("content-encoding"), r.headers.get("vary")], String(enc)).toEqual([want, "Accept-Language, Accept-Encoding"]);
    }
  });

  it("keeps the status, its text, the body and every header", async () => {
    const r = withEncoding(ask("gzip"), new Response("{}", { status: 409, statusText: "Conflict", headers: { "content-type": "application/json", "x-a": "1" } }));
    expect([r.status, r.statusText, r.headers.get("x-a"), r.headers.get("vary")]).toEqual([409, "Conflict", "1", "Accept-Encoding"]);
    expect(await r.text()).toBe("{}");
  });

  it("is chosen for text, SVG and JSON only", () => {
    for (const type of ["text/plain", "text/css; charset=utf-8", "image/svg+xml; charset=utf-8", "application/json; charset=utf-8"]) expect(withEncoding(ask("br"), new Response("x", { headers: { "content-type": type } })).headers.get("content-encoding"), type).toBe("br");
    for (const type of ["font/woff2", "image/png", "application/octet-stream", "", "xtext/html", "application/xml"]) {
      const res = new Response("x", type ? { headers: { "content-type": type } } : {});
      if (!type) res.headers.delete("content-type");
      expect(withEncoding(ask("br"), res), type).toBe(res);
    }
  });

  it("leaves alone a response with no body, or one already encoded", () => {
    const empty = redirect("/x");
    empty.headers.set("content-type", "text/plain");
    expect(withEncoding(ask("br"), empty)).toBe(empty);
    const encoded = new Response("x", { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
    expect(withEncoding(ask("br"), encoded)).toBe(encoded);
  });
});

describe("the links of a page", () => {
  it("carry the page's language: the agreement, its entity version, the privacy notice and the sign pages", () => {
    const body = '<a href="/agreement">a</a><a href="/agreement/entity#part">b</a><a href="/privacy">c</a><a href="/sign/o/r/7">d</a><a href="/sign/o/r/7#accept">e</a>';
    expect(localize(body, "es")).toBe('<a href="/agreement?lang=es">a</a><a href="/agreement/entity?lang=es#part">b</a><a href="/privacy?lang=es">c</a><a href="/sign/o/r/7?lang=es">d</a><a href="/sign/o/r/7?lang=es#accept">e</a>');
  });

  it("are left as they are when they are files, other pages, other sites or already carry a query", () => {
    const body = '<a href="/agreement/v1/individual.md">a</a><a href="/setup">b</a><a href="https://cla.kleidos.dev/agreement">c</a><a href="/sign/o/r/7?lang=en">d</a><a href="/privacyx">e</a><a href="/agreement/entityx">f</a><a href="#main">g</a>';
    expect(localize(body, "es")).toBe(body);
  });
});

/** The parts of a page that frame its body. */
async function frame(r: Response) {
  const html = await r.text();
  return {
    html,
    lang: /<html lang="([a-z]+)">/.exec(html)?.[1],
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
    alternates: [...html.matchAll(/<link rel="alternate" hreflang="([a-z]+)" href="([^"]+)">/g)].map((m) => `${m[1]} ${m[2]}`),
    body: /<body([^>]*)>/.exec(html)?.[1],
    nav: [...html.matchAll(/<a href="([^"]+)" hreflang="[a-z]+" lang="[a-z]+"( aria-current="true")?>/g)].map((m) => `${m[1]}${m[2] ? " current" : ""}`),
  };
}

describe("a page", () => {
  it("is a task page in the reader's language, with its title escaped, its stylesheet, and both languages offered at its path", async () => {
    const r = await page("<p>body</p>", { title: 'A <b> & "c"', lang: "es", path: "/sign/o/r/7" });
    const f = await frame(r);
    expect(f.html.startsWith("<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n")).toBe(true);
    expect(f.lang).toBe("es");
    expect(f.title).toBe("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(f.html).toContain(`<link rel="stylesheet" href="${await stylesheetPath()}">`);
    expect(f.alternates).toEqual(["es /sign/o/r/7?lang=es", "en /sign/o/r/7?lang=en"]);
    expect(f.nav).toEqual(["/sign/o/r/7?lang=en", "/sign/o/r/7?lang=es current"]);
    expect(f.body).toBe("");
    expect(f.html).toContain('<main id="main" class="task">\n<p>body</p>\n</main>');
    expect(f.html).toContain('<a class="brand" href="/agreement?lang=es">');
    expect(f.html.endsWith("</body>\n</html>\n")).toBe(true);
    expect(r.status).toBe(200);
    expect(headersOf(r)).toEqual({ ...SECURITY, "content-type": "text/html; charset=utf-8", "content-language": "es", vary: "Accept-Language", "cache-control": "no-store, no-transform" });
  });

  it("in English marks English as current and offers Spanish second", async () => {
    const f = await frame(await page("", { title: "t", lang: "en", path: "/privacy" }));
    expect(f.alternates).toEqual(["en /privacy?lang=en", "es /privacy?lang=es"]);
    expect(f.nav).toEqual(["/privacy?lang=en current", "/privacy?lang=es"]);
  });

  it("that answers a form offers no other language and no alternate", async () => {
    const f = await frame(await page("", { title: "t", lang: "en" }));
    expect(f.alternates).toEqual([]);
    expect(f.nav).toEqual([]);
    expect(f.html).not.toContain('<nav class="lang"');
  });

  it("that is a document is laid out as one, with its status, cache, headers and cookies", async () => {
    const r = await page("", { title: "t", lang: "en", kind: "doc", status: 404, cache: "public", headers: { "x-extra": "1" }, cookies: ["a=1", "b=2"] });
    const f = await frame(r);
    expect(f.body).toBe(' class="is-doc"');
    expect(f.html).toContain('<main id="main" class="doc">');
    expect([r.status, r.headers.get("cache-control"), r.headers.get("x-extra")]).toEqual([404, "public, max-age=300, no-transform", "1"]);
    expect(r.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("escapes a path it is given before writing it into a link", async () => {
    const f = await frame(await page("", { title: "t", lang: "en", path: '/x"><script>' }));
    expect(f.html).not.toContain("<script>");
    expect(f.html).toContain('href="/x&quot;&gt;&lt;script&gt;?lang=es"');
  });
});

describe("a message page", () => {
  it("is the message's title and sentence in the reader's language, with no way on when none is given", async () => {
    const r = await messagePage("es", 404, "noTarget");
    const html = await r.text();
    expect(r.status).toBe(404);
    expect(html).toContain('<h1 class="h-task">No encontrado</h1>\n<div class="card is-pending" role="alert"><p>En esta dirección no hay ningún pull request que firmar.</p></div>\n\n</main>');
    expect(html).toContain("<title>No encontrado</title>");
    expect(html).not.toContain('class="btn btn-block"');
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("escapes its way on, and carries the cookies given", async () => {
    const r = await messagePage("en", 400, "badLink", { href: '/sign/o/r/1?lang=en&x="y"', label: "Back <now>" }, ["c=; Max-Age=0"]);
    const html = await r.text();
    expect(html).toContain('<a class="btn btn-block" href="/sign/o/r/1?lang=en&amp;x=&quot;y&quot;">Back &lt;now&gt;</a>');
    expect(r.headers.getSetCookie()).toEqual(["c=; Max-Age=0"]);
  });
});
