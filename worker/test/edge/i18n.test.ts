// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Every page string exists in English and Spanish (AGENTS.md: a new or
 * changed string is written in both): the two languages have the same keys,
 * the same lists, the same links and the same placeholders, and no string is
 * empty. And how a request's language is chosen.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Strings } from "../../src/i18n";
import { BACK, MESSAGES, S, fromAcceptLanguage, isLang, pickLang } from "../../src/i18n";
import { restoring } from "./support";

restoring();

/** Arguments no page string contains by itself, so that each must show where it is put. */
const ARGS = ["⟦a⟧", "⟦b⟧"];
const NUMS = [97531, 86420];

/** Every leaf of the strings: its path, and its text (a function called with markers for each of its parameters). */
function leaves(v: unknown, path = ""): [string, string, string[]][] {
  if (typeof v === "string") return [[path, v, []]];
  if (typeof v === "function") {
    const f = v as (...a: unknown[]) => unknown;
    const n = f.length;
    // A parameter named for a number takes a number; the others take text.
    const params = /^\(?([^)=]*)\)?\s*=>/.exec(f.toString())?.[1]?.split(",").map((p) => p.trim()) ?? [];
    const args = params.slice(0, n).map((p, i) => (/version|id/.test(p) ? NUMS[i] : ARGS[i]));
    const out = f(...args);
    expect(typeof out, path).toBe("string");
    return [[path, out as string, args.map(String)]];
  }
  if (v === null) return [[path, "<null>", []]];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  throw new Error(`${path}: not a string`);
}

describe("the strings of both languages", () => {
  // Read inside each test, not while the file is collected: a string that is no string fails a test, not the file.
  let en: [string, string, string[]][] = [];
  let es: [string, string, string[]][] = [];
  /** What English leaves out (null) is a part only the Spanish pages have. */
  let nullInEnglish: string[] = [];
  let esByPath = new Map<string, string>();
  beforeEach(() => {
    en = leaves(S.en);
    es = leaves(S.es);
    nullInEnglish = en.filter(([, t]) => t === "<null>").map(([p]) => p);
    esByPath = new Map(es.map(([p, t]) => [p, t]));
  });

  it("have the same keys and lists, in the same order, where English has nothing for a part only Spanish shows", () => {
    const collapse = (p: string) => nullInEnglish.find((n) => p.startsWith(`${n}.`)) ?? p;
    expect([...new Set(es.map(([p]) => collapse(p)))]).toEqual(en.map(([p]) => p));
    expect([en.length, es.length]).toEqual([121, 122]);
  });

  // The summary fold is shown on the Spanish page only (web.ts agreementPage), so English has no words under its title.
  it("are none of them empty, but the English subtitle of a fold only Spanish shows", () => {
    for (const [path, text] of es) expect(text.trim(), `es ${path}`).not.toBe("");
    for (const [path, text] of en.filter(([p]) => p !== "agreement.partSummarySub")) expect(text.trim(), `en ${path}`).not.toBe("");
    expect(S.en.agreement.partSummarySub).toBe("");
  });

  it("show every value they are given, in both languages", () => {
    for (const [path, text, args] of [...en, ...es]) for (const a of args) expect(text, `${path} ${a}`).toContain(a);
  });

  it("are null in both languages or in neither, except what only Spanish needs", () => {
    const nulls = (all: [string, string, string[]][]) => all.filter(([, t]) => t === "<null>").map(([p]) => p);
    expect(nulls(en)).toEqual(["accept.translation", "accept.binding", "agreement.entityOnlyEnglish", "agreement.banner"]);
    expect(nulls(es)).toEqual([]);
  });

  it("link to the same places in both languages", () => {
    const links = (s: Strings) => [...s.footer, ...s.start.links].map(([, href]) => href);
    expect(links(S.es)).toEqual(links(S.en));
    expect(links(S.en)).toEqual(["/agreement", "/privacy", "https://github.com/kleidos-dev/cla", "mailto:mail@kleidos.dev", "/agreement", "/privacy"]);
  });

  it("carry the same markup in both languages", () => {
    const tags = (t: string) => [...t.matchAll(/<\/?([a-z]+)[\s>]/g)].map((m) => m[1]).join(",");
    for (const [path, text] of en) {
      const other = esByPath.get(path) ?? "<null>";
      if (other !== "<null>" && text !== "<null>") expect(tags(other), path).toBe(tags(text));
    }
  });

  it("are Spanish in Spanish and English in English, where they are not names", () => {
    expect(S.es.steps).toEqual(["Paso 1 de 2 · Entrar", "Paso 2 de 2 · Aceptar", "Hecho · Firmado"]);
    expect(S.en.steps).toEqual(["Step 1 of 2 · Sign in", "Step 2 of 2 · Accept", "Done · Signed"]);
    expect(S.es.status.exempt("x")).toBe("@x está en la lista de exenciones de Kleidos: no hay nada que firmar.");
    expect(S.en.status.entity("x", "Acme")).toBe("@x is covered by the agreement of Acme: nothing to sign.");
  });
});

describe("the one-message pages", () => {
  it("have a title and a sentence in both languages, none empty and none the same as the other", () => {
    for (const [key, m] of Object.entries(MESSAGES)) {
      for (const [title, sentence] of [m.en, m.es]) {
        expect(title.trim(), key).not.toBe("");
        expect(sentence.trim(), key).not.toBe("");
      }
      expect(m.es, key).not.toEqual(m.en);
    }
    expect(Object.keys(MESSAGES)).toHaveLength(36);
  });

  it("say what happened in their own words, word for word in both languages", () => {
    // Read against each page that shows it: a sentence swapped with another, or one that says the opposite, is a page that lies.
    // notConfigured is the page's own string, held by the test after this one.
    expect(Object.fromEntries(Object.entries(MESSAGES).filter(([k]) => k !== "notConfigured"))).toEqual({
      notServed: { en: ["Not served","This repository is not served by the Kleidos CLA bot."], es: ["Repositorio no atendido","El bot del CLA de Kleidos no atiende este repositorio."] },
      headMoved: { en: ["The pull request changed","The pull request received new commits while it was being read. Nothing was posted. Reload this page."], es: ["El pull request ha cambiado","El pull request recibió commits nuevos mientras se leía. No se ha publicado nada. Vuelve a cargar esta página."] },
      ghRateLimited: { en: ["GitHub is rate limiting","GitHub asked us to slow down. Wait a minute and reload this page."], es: ["GitHub está limitando las peticiones","GitHub nos ha pedido que vayamos más despacio. Espera un minuto y vuelve a cargar esta página."] },
      ghNotFound: { en: ["Not found","GitHub does not know this pull request."], es: ["No encontrado","GitHub no conoce este pull request."] },
      ghUnavailable: { en: ["GitHub unavailable","GitHub did not answer as expected. Nothing was posted. Wait a minute and reload this page."], es: ["GitHub no responde","GitHub no ha respondido como se esperaba. No se ha publicado nada. Espera un minuto y vuelve a cargar esta página."] },
      tooManySign: { en: ["Too many requests","Too many requests from your network. Wait a minute and reload this page."], es: ["Demasiadas peticiones","Hay demasiadas peticiones desde tu red. Espera un minuto y vuelve a cargar esta página."] },
      tooManyAuth: { en: ["Too many requests","Too many sign-in attempts from your network. Wait a minute and try again."], es: ["Demasiadas peticiones","Hay demasiados intentos de entrar desde tu red. Espera un minuto y vuelve a intentarlo."] },
      tooManyAgree: { en: ["Too many requests","Too many attempts. Wait a minute and try again. Nothing was posted."], es: ["Demasiadas peticiones","Demasiados intentos. Espera un minuto y vuelve a intentarlo. No se ha publicado nada."] },
      noTarget: { en: ["Not found","There is no pull request to sign for at this address."], es: ["No encontrado","En esta dirección no hay ningún pull request que firmar."] },
      closed: { en: ["Pull request closed","This pull request is closed, so there is nothing to sign on it. Open or reopen a pull request and follow its link."], es: ["Pull request cerrado","Este pull request está cerrado, así que no hay nada que firmar en él. Abre o reabre un pull request y sigue su enlace."] },
      locked: { en: ["Pull request locked","This pull request is locked, so no acceptance can be posted on it. Write to mail@kleidos.dev."], es: ["Pull request bloqueado","Este pull request está bloqueado, así que no se puede publicar ninguna aceptación en él. Escribe a mail@kleidos.dev."] },
      badLink: { en: ["Bad link","This sign-in link is not valid. Go back to the pull request and follow its link again."], es: ["Enlace no válido","Este enlace para entrar no es válido. Vuelve al pull request y sigue su enlace otra vez."] },
      oauthExpired: { en: ["Session expired","The sign-in took too long or was already used. Go back to the pull request and follow its link again."], es: ["Sesión caducada","La entrada tardó demasiado o ya se usó. Vuelve al pull request y sigue su enlace otra vez."] },
      oauthState: { en: ["Sign-in refused","This sign-in did not start here. Nothing was signed. Follow the pull request's link again."], es: ["Entrada rechazada","Esta entrada no empezó aquí. No se ha firmado nada. Sigue otra vez el enlace del pull request."] },
      oauthCancelled: { en: ["Authorization cancelled","GitHub's authorization was cancelled, so nothing was signed or posted."], es: ["Autorización cancelada","Se canceló la autorización de GitHub, así que no se ha firmado ni publicado nada."] },
      oauthCode: { en: ["Sign-in refused","GitHub's answer was not valid. Follow the pull request's link again."], es: ["Entrada rechazada","La respuesta de GitHub no era válida. Sigue otra vez el enlace del pull request."] },
      oauthExchange: { en: ["Sign-in refused","GitHub did not accept this sign-in (it may have been used already). Follow the pull request's link again."], es: ["Entrada rechazada","GitHub no ha aceptado esta entrada (puede que ya se hubiera usado). Sigue otra vez el enlace del pull request."] },
      oauthUser: { en: ["Sign-in refused","GitHub's answer was not valid."], es: ["Entrada rechazada","La respuesta de GitHub no era válida."] },
      refusedOrigin: { en: ["Refused","This form did not come from cla.kleidos.dev, so nothing was posted."], es: ["Rechazado","Este formulario no venía de cla.kleidos.dev, así que no se ha publicado nada."] },
      refusedStale: { en: ["Refused","This form is out of date. Reload the page and try again."], es: ["Rechazado","Este formulario está desfasado. Vuelve a cargar la página e inténtalo otra vez."] },
      formUnreadable: { en: ["Refused","The form could not be read, so nothing was posted. Reload the page and try again."], es: ["Rechazado","No se pudo leer el formulario, así que no se ha publicado nada. Vuelve a cargar la página e inténtalo otra vez."] },
      sessionExpired: { en: ["Session expired","Your sign-in has expired, so nothing was posted. Go back to the pull request and follow its link again."], es: ["Sesión caducada","Tu sesión ha caducado, así que no se ha publicado nada. Vuelve al pull request y sigue su enlace otra vez."] },
      formInvalid: { en: ["Refused","The form is not valid, so nothing was posted."], es: ["Rechazado","El formulario no es válido, así que no se ha publicado nada."] },
      csrf: { en: ["Refused","This form is out of date or was not made for you, so nothing was posted. Reload the sign page and try again."], es: ["Rechazado","Este formulario está desfasado o no se hizo para ti, así que no se ha publicado nada. Vuelve a cargar la página de firma e inténtalo otra vez."] },
      signInAgain: { en: ["Sign in again","Sign in again on this pull request's page to accept. Nothing was posted."], es: ["Vuelve a entrar","Vuelve a entrar en la página de este pull request para aceptar. No se ha publicado nada."] },
      signInAgainGitHub: { en: ["Sign in again","GitHub did not accept the comment with your sign-in (it may have expired or been revoked). Nothing was posted."], es: ["Vuelve a entrar","GitHub no aceptó el comentario con tu sesión (puede que caducara o se revocara). No se ha publicado nada."] },
      paused: { en: ["Signing paused","The agreement is being updated, so signing is paused. Nothing was posted. Try again later."], es: ["Firma en pausa","El acuerdo se está actualizando, así que la firma está en pausa. No se ha publicado nada. Inténtalo más tarde."] },
      changed: { en: ["The agreement changed","The text on your page is not the current one, so nothing was posted. Reload the sign page."], es: ["El acuerdo ha cambiado","El texto de tu página no es el actual, así que no se ha publicado nada. Vuelve a cargar la página de firma."] },
      postedClosed: { en: ["Nothing posted","This pull request is closed, so nothing was posted."], es: ["No se ha publicado nada","Este pull request está cerrado, así que no se ha publicado nada."] },
      postedLocked: { en: ["Nothing posted","This pull request is locked, so nothing was posted."], es: ["No se ha publicado nada","Este pull request está bloqueado, así que no se ha publicado nada."] },
      postedPrivate: { en: ["Nothing posted","There is no pull request to sign for at this address."], es: ["No se ha publicado nada","En esta dirección no hay ningún pull request que firmar."] },
      postedNotUser: { en: ["Nothing posted","Only a personal account can sign. Nothing was posted."], es: ["No se ha publicado nada","Solo puede firmar una cuenta personal. No se ha publicado nada."] },
      postedSigned: { en: ["Nothing posted","You have already accepted this agreement. Nothing was posted."], es: ["No se ha publicado nada","Ya has aceptado este acuerdo. No se ha publicado nada."] },
      postedNotNeeded: { en: ["Nothing posted","This account does not need to sign on this pull request, so nothing was posted."], es: ["No se ha publicado nada","Esta cuenta no tiene que firmar en este pull request, así que no se ha publicado nada."] },
      recorderUnreachable: { en: ["Not recorded","The register could not be asked to record your acceptance, so nothing was recorded. Sign in again in a minute."], es: ["No anotado","No se pudo pedir al registro que anotara tu aceptación, así que no se ha anotado nada. Vuelve a entrar dentro de un minuto."] },
    });
  });

  it("say nothing was posted where the refusal comes before posting, and only there", () => {
    const nothing = Object.entries(MESSAGES)
      .filter(([, m]) => /nothing was posted|so nothing was signed or posted/i.test(m.en[1]))
      .map(([k]) => k)
      .sort();
    expect(nothing).toEqual(["changed", "csrf", "formInvalid", "formUnreadable", "ghUnavailable", "headMoved", "oauthCancelled", "paused", "postedClosed", "postedLocked", "postedNotNeeded", "postedNotUser", "postedSigned", "refusedOrigin", "sessionExpired", "signInAgain", "signInAgainGitHub", "tooManyAgree"]);
    for (const k of nothing) expect(MESSAGES[k as keyof typeof MESSAGES].es[1], k).toMatch(/no se ha publicado nada|ni publicado nada/i);
  });

  it("say not configured in the words of the page that says it", () => {
    expect(MESSAGES.notConfigured.en[1]).toBe(S.en.notConfigured);
    expect(MESSAGES.notConfigured.es[1]).toBe(S.es.notConfigured);
  });

  it("have their way back in both languages", () => {
    expect(BACK).toEqual({ sign: { en: "Back to the sign page", es: "Volver a la página de firma" }, pr: { en: "Back to the pull request", es: "Volver al pull request" } });
  });
});

describe("the language of a request", () => {
  const req = (h?: string) => new Request("https://cla.kleidos.dev/", h === undefined ? {} : { headers: { "accept-language": h } });

  it("is the one ?lang= names, whatever the browser asks", () => {
    expect(pickLang(req("en"), new URL("https://x/?lang=es"))).toBe("es");
    expect(pickLang(req("es"), new URL("https://x/?lang=en"))).toBe("en");
  });

  it("is the browser's when ?lang= names no language of the site", () => {
    for (const q of ["", "?lang=fr", "?lang=ES", "?lang=", "?lang=es-ES"]) expect(pickLang(req("es"), new URL(`https://x/${q}`)), q).toBe("es");
    expect(pickLang(req(), new URL("https://x/?lang=fr"))).toBe("en");
  });

  it("is English, or Spanish when the browser prefers it over English", () => {
    const cases: [string | null, "en" | "es"][] = [
      [null, "en"],
      ["", "en"],
      ["es", "es"],
      ["es-ES,es;q=0.9", "es"],
      ["ES", "es"],
      ["fr, es", "es"],
      ["fr", "en"],
      ["*", "en"],
      ["es;q=0.5, en;q=0.6", "en"],
      ["en;q=0.5, es;q=0.6", "es"],
      ["es;q=0.8, en;q=0.8", "es"],
      ["en;q=0.8, es;q=0.8", "en"],
      ["es;q=0, en;q=0.1", "en"],
      ["es;q=abc, en;q=0.1", "en"],
      ["es;q=Infinity", "en"],
      ["es;q=-1", "en"],
      ["es ; q=0.9 , en ; q=0.8", "es"],
      ["es; q=0.1, en; q=0.2", "en"],
      ["es;level=1;q=0.9, en;q=0.8", "es"],
      [`${Array(20).fill("fr").join(",")},es`, "en"],
      [`${Array(19).fill("fr").join(",")},es`, "es"],
    ];
    for (const [h, want] of cases) expect(fromAcceptLanguage(h), String(h)).toBe(want);
  });

  it("is only ever one of the two", () => {
    expect([isLang("en"), isLang("es"), isLang("fr"), isLang(null), isLang("EN"), isLang(["en"])]).toEqual([true, true, false, false, false, false]);
  });
});
