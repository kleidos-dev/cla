// SPDX-License-Identifier: MIT
import css from "./assets/cla.css";
import { escapeHtml } from "./markdown";
import { sha256Hex } from "./util";

export { escapeHtml };

export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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

let cssHash: Promise<string> | null = null;
export function stylesheetPath(): Promise<string> {
  cssHash ??= sha256Hex(css).then((h) => `/assets/cla.${h.slice(0, 12)}.css`);
  return cssHash;
}
export const STYLESHEET = css;

export function securityHeaders(h: Headers, cache: "no-store" | "public"): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  h.set("cache-control", cache === "no-store" ? "no-store" : "public, max-age=300");
  return h;
}

export interface PageOptions {
  title: string;
  status?: number;
  cache?: "no-store" | "public";
  lang?: "en" | "es";
  headers?: Record<string, string>;
  cookies?: string[];
}

/** The skip link, header and footer, in the page's own language (WCAG 3.1.2). */
const CHROME_EN = {
  top: `<a class="skip" href="#main">Skip to the content</a>
<header><nav aria-label="Site"><a href="/agreement">Kleidos Contributor Agreement</a></nav></header>`,
  bottom: `<footer><p><a href="/agreement">Agreement</a> · <a href="/agreement/es" hreflang="es" lang="es">Resumen en español</a> · <a href="/privacy">Privacy</a> · <a href="https://github.com/kleidos-dev/cla">Register and source</a> · Contact: <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a></p></footer>`,
};
const CHROME_ES = {
  top: `<a class="skip" href="#main">Saltar al contenido</a>
<header><nav aria-label="Sitio"><a href="/agreement" hreflang="en" lang="en">Kleidos Contributor Agreement</a></nav></header>`,
  bottom: `<footer><p><a href="/agreement" hreflang="en">Acuerdo (en inglés)</a> · <a href="/agreement/es">Resumen en español</a> · <a href="/privacy/es">Privacidad</a> · <a href="https://github.com/kleidos-dev/cla">Registro y código fuente</a> · Contacto: <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a></p></footer>`,
};

export async function page(body: string, opts: PageOptions): Promise<Response> {
  const lang = opts.lang ?? "en";
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="${await stylesheetPath()}">
</head>
<body>
${lang === "es" ? CHROME_ES.top : CHROME_EN.top}
<main id="main">
${body}
</main>
${lang === "es" ? CHROME_ES.bottom : CHROME_EN.bottom}
</body>
</html>
`;
  const headers = securityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", ...(opts.headers ?? {}) }), opts.cache ?? "no-store");
  for (const c of opts.cookies ?? []) headers.append("set-cookie", c);
  return new Response(html, { status: opts.status ?? 200, headers });
}

/** A short page with one message and what to do next. */
export function messagePage(status: number, title: string, sentence: string, next?: { href: string; label: string }, cookies?: string[]): Promise<Response> {
  const link = next ? `<p><a href="${escapeHtml(next.href)}">${escapeHtml(next.label)}</a></p>` : "";
  return page(`<h1>${escapeHtml(title)}</h1>\n<div class="box alert" role="alert"><p>${escapeHtml(sentence)}</p></div>\n${link}`, { title, status, cookies: cookies ?? [] });
}

export function redirect(location: string, status = 303, cookies: string[] = []): Response {
  const headers = securityHeaders(new Headers({ location }), "no-store");
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

export function text(body: string, status = 200, type = "text/plain; charset=utf-8", cache: "no-store" | "public" = "no-store"): Response {
  return new Response(body, { status, headers: securityHeaders(new Headers({ "content-type": type }), cache) });
}
