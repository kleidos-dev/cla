// SPDX-License-Identifier: MIT
import css from "./assets/cla.css";
import monoFont from "./assets/fonts/kleidos-mono.woff2";
import displayFont from "./assets/fonts/kleidos-sans-display.woff2";
import textFont from "./assets/fonts/kleidos-sans-text.woff2";
import mark from "./assets/mark.svg";
import type { Lang, MessageKey } from "./i18n";
import { MESSAGES, S } from "./i18n";
import { escapeHtml } from "./markdown";
import { sha256Hex } from "./util";

export { escapeHtml };

/** No script anywhere; styles, images and the brand's fonts only from this origin. */
export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Not no-referrer: under that policy a browser sends `Origin: null` on a
  // same-origin form post, and /agree and /auth/logout require the real
  // origin. same-origin still sends nothing to any other host.
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
};

export type Cache = "no-store" | "public" | "immutable";

const CACHE: Record<Cache, string> = {
  "no-store": "no-store",
  public: "public, max-age=300",
  // A URL whose content never changes: the hashed stylesheet and the button images.
  immutable: "public, max-age=31536000, immutable",
};

let cssHash: Promise<string> | null = null;
export function stylesheetPath(): Promise<string> {
  cssHash ??= sha256Hex(css).then((h) => `/assets/cla.${h.slice(0, 12)}.css`);
  return cssHash;
}
export const STYLESHEET = css;

/** The static files besides the stylesheet, by path: the fonts the stylesheet names and the header's mark. */
export const ASSETS: Record<string, { body: string | ArrayBuffer; type: string }> = {
  "/assets/fonts/kleidos-sans-text.woff2": { body: textFont, type: "font/woff2" },
  "/assets/fonts/kleidos-sans-display.woff2": { body: displayFont, type: "font/woff2" },
  "/assets/fonts/kleidos-mono.woff2": { body: monoFont, type: "font/woff2" },
  "/assets/mark.svg": { body: mark, type: "image/svg+xml" },
};

export function securityHeaders(h: Headers, cache: Cache): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  h.set("cache-control", CACHE[cache]);
  return h;
}

export interface PageOptions {
  title: string;
  lang: Lang;
  /** The path of this page without its query: the language switch and the alternate links point at it. Omitted on pages that answer a form. */
  path?: string;
  /** A task page (one narrow column) or a document (the reading measure). */
  kind?: "task" | "doc";
  status?: number;
  cache?: Cache;
  headers?: Record<string, string>;
  cookies?: string[];
}

/** The site's own links carry the page's language, so a reader stays in it from page to page. */
export function localize(html: string, lang: Lang): string {
  return html.replace(/href="(\/(?:agreement(?:\/entity)?|privacy|sign\/[^"?#]+))(#[^"]*)?"/g, (_, p: string, frag: string | undefined) => `href="${p}?lang=${lang}${frag ?? ""}"`);
}

function header(lang: Lang, path: string | undefined): string {
  const t = S[lang];
  const sw = path
    ? `<nav class="lang" aria-label="${t.langNav}">
<a href="${escapeHtml(path)}?lang=en" hreflang="en" lang="en"${lang === "en" ? ' aria-current="true"' : ""}>English</a>
<a href="${escapeHtml(path)}?lang=es" hreflang="es" lang="es"${lang === "es" ? ' aria-current="true"' : ""}>Español</a>
</nav>`
    : "";
  return `<a class="skip" href="#main">${t.skip}</a>
<header class="top"><div class="bar">
<a class="brand" href="/agreement"><span class="tile"><img src="/assets/mark.svg" alt="" width="30" height="30"></span><span class="brand-words"><span class="brand-name">${t.brandName}</span><span class="brand-sub">${t.brandSub}</span></span></a>
${sw}
</div></header>`;
}

function footer(lang: Lang): string {
  return `<footer class="foot"><ul class="links">${S[lang].footer.map(([l, h]) => `<li><a href="${h}">${l}</a></li>`).join("")}</ul></footer>`;
}

export async function page(body: string, opts: PageOptions): Promise<Response> {
  const lang = opts.lang;
  const kind = opts.kind ?? "task";
  const other: Lang = lang === "en" ? "es" : "en";
  const alt = opts.path ? `\n<link rel="alternate" hreflang="${lang}" href="${escapeHtml(opts.path)}?lang=${lang}">\n<link rel="alternate" hreflang="${other}" href="${escapeHtml(opts.path)}?lang=${other}">` : "";
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="${await stylesheetPath()}">${alt}
</head>
<body${kind === "doc" ? ' class="is-doc"' : ""}>
${localize(`${header(lang, opts.path)}
<main id="main" class="${kind}">
${body}
</main>
${footer(lang)}`, lang)}
</body>
</html>
`;
  const headers = securityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "content-language": lang, vary: "Accept-Language", ...(opts.headers ?? {}) }), opts.cache ?? "no-store");
  for (const c of opts.cookies ?? []) headers.append("set-cookie", c);
  return new Response(html, { status: opts.status ?? 200, headers });
}

/** A short page with one message and what to do next, in the reader's language. */
export function messagePage(lang: Lang, status: number, key: MessageKey, next?: { href: string; label: string }, cookies?: string[]): Promise<Response> {
  const [title, sentence] = MESSAGES[key][lang];
  const link = next ? `<a class="btn btn-block" href="${escapeHtml(next.href)}">${escapeHtml(next.label)}</a>` : "";
  return page(`<h1 class="h-task">${escapeHtml(title)}</h1>\n<div class="card is-pending" role="alert"><p>${escapeHtml(sentence)}</p></div>\n${link}`, { title, lang, status, cookies: cookies ?? [] });
}

export function redirect(location: string, status = 303, cookies: string[] = []): Response {
  const headers = securityHeaders(new Headers({ location }), "no-store");
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

export function text(body: string, status = 200, type = "text/plain; charset=utf-8", cache: Cache = "no-store"): Response {
  return new Response(body, { status, headers: securityHeaders(new Headers({ "content-type": type }), cache) });
}
