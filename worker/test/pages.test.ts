// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import neededSvg from "../src/assets/button/needed.svg";
import noneSvg from "../src/assets/button/none.svg";
import signedSvg from "../src/assets/button/signed.svg";
import { buttonAlt, buttonPath, buttonState, buttonSvg, parseButtonPath } from "../src/button";
import { CSP, withEncoding } from "../src/html";
import { fromAcceptLanguage } from "../src/i18n";
import { BOT_ID, commit } from "./fakegh";
import type { World } from "./helpers";
import { Browser, CONFIG, SANDBOX, drain, openPr, prEvent, spanishIn, webhook, world } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const alice = { id: 123456, login: "alice", type: "User" as const };
const bob = { id: 234567, login: "bob", type: "User" as const };
const SENTENCE = CONFIG.versions["1"].sentence;
const ES = { "accept-language": "es-ES,es;q=0.9,en;q=0.8" };

async function setup(w: World, commits = [commit(alice)]) {
  const pr = openPr(w, alice, { commits });
  await webhook(w, "pull_request", prEvent(pr, "opened"));
  await drain(w);
  return { pr, path: `/sign/${SANDBOX}/${pr.number}` };
}

describe("the policy", () => {
  it("is the strict one: nothing but this origin's styles, images and fonts, no script, no frames", () => {
    expect(CSP).toBe("default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  });
});

describe("the edge", () => {
  it("may not rewrite any response: every page, redirect and asset says no-transform", async () => {
    const w = await world();
    const { path } = await setup(w);
    const b = new Browser(w, alice);
    const css = /href="(\/assets\/cla\.[0-9a-f]+\.css)"/.exec(await (await b.get("/agreement")).text())![1]!;
    for (const p of [path, `${path}?lang=es`, "/agreement", "/agreement?lang=es", "/agreement/entity", "/privacy", "/privacy?lang=es", "/agreement/es", css, "/assets/mark.svg", "/assets/fonts/kleidos-mono.woff2", "/button/v2/needed-0-1.svg", "/healthz"]) {
      const r = await b.get(p);
      expect(r.headers.get("cache-control"), p).toMatch(/(^|, )no-transform$/);
    }
    await b.signIn(path);
    const r = await b.get(path);
    expect(r.headers.get("cache-control")).toMatch(/no-transform/);
  });
});

describe("the encoding", () => {
  const page = () => new Response("<!doctype html><p>x</p>", { headers: { "content-type": "text/html; charset=utf-8", vary: "Accept-Language" } });
  const req = (ae?: string) => new Request("https://cla.kleidos.dev/agreement", { headers: ae === undefined ? {} : { "accept-encoding": ae } });
  it("is named by the Worker, since the edge may not compress: brotli first, then gzip, never one refused", () => {
    expect(withEncoding(req("gzip, deflate, br, zstd"), page()).headers.get("content-encoding")).toBe("br");
    expect(withEncoding(req("gzip"), page()).headers.get("content-encoding")).toBe("gzip");
    expect(withEncoding(req("br;q=0, gzip;q=0.8"), page()).headers.get("content-encoding")).toBe("gzip");
    expect(withEncoding(req("identity"), page()).headers.has("content-encoding")).toBe(false);
    expect(withEncoding(req(), page()).headers.has("content-encoding")).toBe(false);
    expect(withEncoding(req(), page()).headers.get("vary")).toBe("Accept-Language, Accept-Encoding");
    expect(withEncoding(req("br"), page()).headers.get("vary")).toBe("Accept-Language, Accept-Encoding");
  });
  it("leaves what is already compressed, and empty bodies, alone", () => {
    const font = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "font/woff2" } });
    expect(withEncoding(req("br"), font).headers.has("content-encoding")).toBe(false);
    expect(withEncoding(req("br"), new Response(null, { status: 302, headers: { location: "/" } })).headers.has("content-encoding")).toBe(false);
    const svg = new Response("<svg/>", { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
    expect(withEncoding(req("gzip"), svg).headers.get("content-encoding")).toBe("gzip");
  });
});

describe("the comment's button", () => {
  it("each state has its own immutable URL, and the comment moves to the new one when the state changes", async () => {
    const w = await world();
    const { pr } = await setup(w, [commit(alice), commit(bob)]);
    const first = w.gh.botComments(SANDBOX, pr.number)[0]!.body;
    expect(first).toContain(`(https://cla.kleidos.dev/button/v2/needed-0-2.svg)](https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number})`);
    expect(first).toContain("Still to sign: @alice, [bob](https://github.com/bob).");
    await w.gh.signDirectly(bob);
    await webhook(w, "pull_request", prEvent(pr, "reopened"));
    await drain(w);
    const second = w.gh.botComments(SANDBOX, pr.number);
    expect(second).toHaveLength(1);
    expect(second[0]!.body).toContain("[![Sign the Kleidos Contributor Agreement: 1 of 2 authors signed](https://cla.kleidos.dev/button/v2/partial-1-2.svg)]");
    await w.gh.signDirectly(alice);
    await webhook(w, "pull_request", prEvent(pr, "reopened"));
    await drain(w);
    const third = w.gh.botComments(SANDBOX, pr.number)[0]!.body;
    expect(third).toContain("[![Kleidos Contributor Agreement signed by all 2 authors](https://cla.kleidos.dev/button/v2/signed-2-2.svg)]");
    expect(third).toContain("Register entries: [alice](https://github.com/kleidos-dev/cla/blob/");
    expect(third.startsWith("<!-- kleidos-cla:v1 -->\n")).toBe(true);
  });

  it("is served as an SVG with no script, cached for good, under the same headers as the pages", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    for (const p of ["/button/v2/needed-0-1.svg", "/button/v2/partial-1-3.svg", "/button/v2/signed-12-12.svg", "/button/v2/none-0-0.svg", "/button/v1/needed-0-1.svg", "/button/v1/signed-12-12.svg"]) {
      const r = await b.get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable, no-transform");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const svg = await r.text();
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toMatch(/<script|<style|\son[a-z]+=|href=|<image|<foreignObject/i);
      expect(svg).toMatch(/<title id="t">[^<]+<\/title>/);
    }
    expect(await (await b.get("/button/v2/partial-1-3.svg")).text()).toContain("<title id=\"t\">Sign the Kleidos Contributor Agreement: 1 of 3 authors signed.</title>");
    // The addresses of older, bilingual comments keep answering, with the English drawing.
    expect(await (await b.get("/button/v1/partial-1-3.svg")).text()).toBe(await (await b.get("/button/v2/partial-1-3.svg")).text());
  });

  it("is in English only: no Spanish in the title or in the drawings of any state", () => {
    for (const [state, signed, total] of [["needed", 0, 2], ["partial", 1, 2], ["signed", 2, 2], ["none", 0, 0]] as const) {
      const svg = buttonSvg(state, signed, total);
      const title = /<title id="t">([^<]+)<\/title>/.exec(svg)![1]!;
      expect(title, state).toBe(`${buttonAlt(state, signed, total)}.`);
      expect(spanishIn(svg), state).toBeNull();
      // One line of words: a single outline path between the frame and the chip.
      const words = svg.slice(svg.indexOf('rx="9.5"/>') + 10).split(/<rect /)[0]!;
      expect(words.match(/<path /g), state).toHaveLength(1);
    }
    for (const f of [neededSvg, signedSvg, noneSvg]) expect(spanishIn(f)).toBeNull();
  });

  it("only the combinations the bot writes exist; anything else is 404", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    for (const p of ["/button/v2/needed-1-2.svg", "/button/v2/partial-0-2.svg", "/button/v2/partial-3-2.svg", "/button/v2/signed-1-2.svg", "/button/v2/none-1-1.svg", "/button/v2/needed-00-1.svg", "/button/v2/needed-0-1000.svg", "/button/v1/needed-1-2.svg", "/button/v1/signed-1-2.svg", "/button/v3/needed-0-1.svg", "/button/v0/needed-0-1.svg", "/button/v2/needed-0-1.png", "/button/v2/other-0-1.svg"]) {
      expect((await b.get(p)).status, p).toBe(404);
    }
    expect(parseButtonPath(buttonPath("partial", 2, 5))).toEqual({ state: "partial", signed: 2, total: 5 });
    expect(buttonState(0, 0, true)).toBe("none");
    expect(buttonState(2, 2, true)).toBe("signed");
    expect(buttonState(2, 2, false)).toBe("partial");
    expect(buttonState(0, 2, false)).toBe("needed");
  });

  it("draws the count from the glyph table: a longer count makes a wider button, the words stay the same", () => {
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)![1]);
    const short = buttonSvg("needed", 0, 2);
    expect(width(short)).toBe(277);
    expect(width(buttonSvg("signed", 2, 2))).toBe(282);
    expect(width(buttonSvg("none", 0, 0))).toBe(225);
    expect(width(buttonSvg("partial", 10, 12))).toBeGreaterThan(width(short));
    expect(buttonSvg("partial", 10, 12)).toContain("<title id=\"t\">Sign the Kleidos Contributor Agreement: 10 of 12 authors signed.</title>");
  });
});

describe("languages", () => {
  it("Accept-Language picks the first of es and en by weight; ?lang= wins; English otherwise", async () => {
    expect(fromAcceptLanguage("es-ES,es;q=0.9,en;q=0.8")).toBe("es");
    expect(fromAcceptLanguage("en-GB,en;q=0.9,es;q=0.8")).toBe("en");
    expect(fromAcceptLanguage("fr-FR,fr;q=0.9,es;q=0.5,en;q=0.4")).toBe("es");
    expect(fromAcceptLanguage("de")).toBe("en");
    expect(fromAcceptLanguage("es;q=0, en")).toBe("en");
    expect(fromAcceptLanguage(null)).toBe("en");
    const w = await world();
    const b = new Browser(w, alice);
    expect((await b.get("/agreement", ES)).headers.get("content-language")).toBe("es");
    expect((await b.get("/agreement?lang=en", ES)).headers.get("content-language")).toBe("en");
    expect((await b.get("/agreement")).headers.get("content-language")).toBe("en");
    // No cookie remembers the choice; the links carry it.
    expect((await b.get("/agreement?lang=es")).headers.getSetCookie()).toEqual([]);
  });

  it("every page has a switch and alternates at one stable path per language, and its own links keep the language", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    for (const [path, lang] of [
      ["/agreement", "es"],
      ["/agreement/entity", "es"],
      ["/privacy", "es"],
      ["/agreement", "en"],
    ] as const) {
      const html = await (await b.get(`${path}?lang=${lang}`)).text();
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toContain(`<link rel="alternate" hreflang="en" href="${path}?lang=en">`);
      expect(html).toContain(`<link rel="alternate" hreflang="es" href="${path}?lang=es">`);
      expect(html).toContain(`<a href="${path}?lang=${lang}" hreflang="${lang}" lang="${lang}" aria-current="true">`);
      expect(html).toContain(`<a class="brand" href="/agreement?lang=${lang}">`);
      expect(html).not.toMatch(/href="\/(?:agreement|privacy)"/);
    }
  });

  it("the Spanish agreement page is the full informative rendering under a banner that only English binds", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    const html = await (await b.get("/agreement", ES)).text();
    expect(html).toContain("<h1 class=\"h-page\">Acuerdo de Contribución de Kleidos</h1>");
    expect(html).toContain("Solo el texto inglés obliga.");
    expect(html).toContain('<p lang="en"><strong>Only the English text is binding.</strong>');
    // The Contributor Agreement and the Addendum, both in Spanish, marked as informative; the licence header of the translation is not shown.
    expect(html).toContain("Acuerdo de licencia no exclusiva para contribuyentes individuales");
    expect(html).toContain("Borrador de traducción informativa, pendiente de revisión.");
    expect(html).not.toContain("SPDX-License-Identifier");
    expect(html).toContain('<section class="prose" lang="es" aria-label="Anexo">');
    expect(html).toContain("Qué conservas, qué concedes, para qué");
    expect(html).not.toContain("Individual Contributor Non-Exclusive License Agreement");
    // The contents list links the headings it names.
    for (const [, id] of html.matchAll(/<li><a href="#([^"]+)">/g)) expect(html, id).toContain(`id="${id}"`);
    const en = await (await b.get("/agreement")).text();
    expect(en).toContain("Individual Contributor Non-Exclusive License Agreement");
    expect(en).not.toContain("Solo el texto inglés obliga");
    // The entity version has no translation: in Spanish it says so and keeps the English text, marked.
    const entity = await (await b.get("/agreement/entity", ES)).text();
    expect(entity).toContain("La versión para entidades solo está en inglés");
    expect(entity).toContain('<section class="prose" lang="en" aria-label="Acuerdo">');
  });

  it("the Spanish privacy notice is the Spanish file", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    const html = await (await b.get("/privacy?lang=es")).text();
    expect(html).toContain("Aviso de privacidad");
    expect(html).toContain('href="/privacy?lang=en"');
  });
});

describe("the sign flow in Spanish", () => {
  it("landing, GitHub, the acceptance and the confirmation all stay in Spanish; the posted sentence is the English one", async () => {
    const w = await world();
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);
    const start = await (await b.get(path, ES)).text();
    expect(start).toContain('<html lang="es">');
    expect(start).toContain("Paso 1 de 2 · Entrar");
    expect(start).toContain("<strong>Aún no has firmado nada.</strong>");
    expect(start).toContain(`href="/auth/login?return=${encodeURIComponent(path)}&amp;lang=es">Entra con GitHub para firmar</a>`);
    expect(start).not.toContain("Acuerdo de licencia no exclusiva");

    const login = await b.get(`/auth/login?return=${encodeURIComponent(path)}&lang=es`);
    const authorize = new URL(login.headers.get("location")!);
    const code = w.gh.issueCode(alice, authorize.searchParams.get("code_challenge")!);
    // Back from GitHub with an English browser: the transaction remembers the page's language.
    const back = await b.get(`/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`, { "accept-language": "en" });
    expect(back.headers.get("location")).toBe(`${path}?lang=es`);

    const accept = await (await b.get(`${path}?lang=es`)).text();
    expect(accept).toContain("Paso 2 de 2 · Aceptar");
    expect(accept).toContain("<strong>Aún no has firmado:</strong> firmas con el botón de abajo.");
    expect(accept).toContain(">Acepto y firmo</button>");
    expect(accept).toContain('<label for="accept-box" lang="en">' + SENTENCE.replaceAll("'", "&#39;") + "</label>");
    expect(accept).toContain("Qué dice esta frase (traducción informativa)");
    expect(accept).toContain("Solo el texto inglés obliga");
    const form = Browser.form(accept);
    expect(form.lang).toBe("es");

    const posted = await b.post("/agree", { ...form, accept: "yes" });
    expect(posted.headers.get("location")).toBe(`${path}?lang=es`);
    const c = w.gh.comments.find((x) => x.pr === pr.number && x.user.id === alice.id)!;
    expect(c.body).toBe(SENTENCE);
    const done = await (await b.get(`${path}?lang=es`)).text();
    expect(done).toContain("Hecho · Firmado");
    expect(done).toContain("Se está anotando en el registro público");
    expect(done).toContain(`<a href="${path}?lang=es">Comprobar ahora</a>`);
  });
});

describe("the acceptance without the box", () => {
  it("comes back as the same page with a big inline error, the box focused and the button still there; nothing is posted", async () => {
    const w = await world();
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    const form = Browser.form(await (await b.get(path)).text());
    const r = await b.post("/agree", form);
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain('<form class="accept is-error" id="accept" method="post" action="/agree#accept" novalidate>');
    expect(html).toContain('<p class="error" id="accept-error" role="alert">');
    expect(html).toContain("Tick the box to accept. Nothing was signed.");
    expect(html).toContain('aria-invalid="true" aria-describedby="accept-error post-note" autofocus');
    expect(html).toContain(">I agree and sign</button>");
    expect(html.indexOf("accept-error")).toBeLessThan(html.indexOf('id="accept-box"'));
    // The re-rendered form still works.
    const again = Browser.form(html);
    const es = await b.post("/agree", { ...form, lang: "es" });
    expect(await es.text()).toContain("Marca la casilla para aceptar. No se ha firmado nada.");
    expect(w.gh.comments.filter((c) => c.pr === pr.number && c.user.id !== BOT_ID)).toHaveLength(0);
    expect((await b.post("/agree", { ...again, accept: "yes" })).status).toBe(303);
  });
});
