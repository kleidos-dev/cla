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
