// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What the tests of the Worker's edge share: the world of ../helpers.ts
 * (the fake GitHub, queue and limiters) by composition, a queue message
 * batch that records what was done with each message, a queue that is
 * down, the log lines as objects, and a request to the Worker's front door.
 */
import { afterEach, expect, vi } from "vitest";
import { escapeHtml } from "../../src/html";
import type { Lang, MessageKey } from "../../src/i18n";
import { BACK, MESSAGES, S } from "../../src/i18n";
import { handleFetch } from "../../src/index";
import type { QueueMessage } from "../../src/messages";
import type { Keys } from "../../src/keys";
import { keysFor } from "../../src/keys";
import type { OAuthTransaction, Session } from "../../src/session";
import { SESSION_COOKIE, readSession, sessionCookie, transactionCookie } from "../../src/session";
import { must, nowSeconds } from "../../src/util";
import type { World } from "../helpers";
import { Browser as PlainBrowser, ORIGIN } from "../helpers";

export { CONFIG, CONFIG_V2, ORIGIN, SANDBOX, WEBHOOK_SECRET, drain, openPr, prEvent, sign, webhook, world } from "../helpers";
export type { World } from "../helpers";

/**
 * The fixed parts of a page string: a string itself, or what a function
 * of the strings writes around its arguments, called with markers.
 */
function fixedParts(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "function") {
    const f = v as (...a: unknown[]) => unknown;
    const out = f(...Array.from({ length: f.length }, (_, i) => `⟦${i}⟧`));
    return typeof out === "string" ? out.split(/⟦\d⟧/) : [];
  }
  if (Array.isArray(v)) return v.flatMap(fixedParts);
  if (v !== null && typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(fixedParts);
  return [];
}

/**
 * Every English text of the pages that Spanish says otherwise, as a page
 * writes it: the page strings, the ways back and the one-message pages,
 * less what only names something (the parts both languages share).
 */
const ENGLISH_ONLY: string[] = (() => {
  const es = new Set([...fixedParts(S.es), BACK.sign.es, BACK.pr.es, ...Object.values(MESSAGES).flatMap((m) => m.es)]);
  const esText = [...es].join("\n");
  const en = [...fixedParts(S.en), BACK.sign.en, BACK.pr.en, ...Object.values(MESSAGES).flatMap((m) => m.en)];
  return [...new Set(en.flatMap((t) => t.split(/<[^>]*>/)).map((t) => t.trim()))].filter((t) => /[a-z]{3}/i.test(t) && !esText.includes(t));
})();

/**
 * A page less what may be English on purpose: whatever is marked
 * lang="en" (the binding texts, the acceptance sentence, the link to
 * English), and the documents rendered from a file (the privacy notice and
 * the summary, which name the English buttons they speak of).
 */
function withoutEnglishParts(html: string): string {
  return html.replace(/<(section|p|label|a|div|span)\b[^>]*\blang="en"[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<div class="prose[^"]*">[\s\S]*?<\/div>/g, "");
}

/** The English page strings a page in Spanish shows: none, on every Spanish page of the edge. */
export function englishIn(html: string): string[] {
  const rest = withoutEnglishParts(html);
  return ENGLISH_ONLY.filter((t) => rest.includes(t) || rest.includes(escapeHtml(t)));
}

/** A Spanish page answered to an edge test is checked for English before the test reads it. */
async function spanishChecked(r: Response): Promise<Response> {
  if (!(r.headers.get("content-type") ?? "").startsWith("text/html")) return r;
  const html = await r.clone().text();
  if (html.includes('<html lang="es">')) expect(englishIn(html), "English on a Spanish page").toEqual([]);
  return r;
}

/** The browser of ../helpers.ts, whose Spanish pages are checked for English. */
export class Browser extends PlainBrowser {
  override async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return spanishChecked(await super.get(path, headers));
  }
  override async post(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return spanishChecked(await super.post(path, form, headers));
  }
}

/** Every file of the edge restores what a test stubbed. */
export function restoring(): void {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

export const alice = { id: 123456, login: "alice", type: "User" as const };
export const bob = { id: 234567, login: "bob", type: "User" as const };
export const carol = { id: 345678, login: "carol", type: "User" as const };

/**
 * Origins that are not the site's own though they begin with it or differ
 * from it only in case, scheme or port: the origin check is an exact match.
 */
export const NEAR_ORIGINS = ["https://evil.example", `${ORIGIN}.evil.example`, `${ORIGIN}:8443`, ORIGIN.replace("cla.", "CLA."), ORIGIN.replace("https:", "http:")];

/** The page of one message (html.ts messagePage), by its status, title and sentence in the reader's language. */
export async function expectMessage(r: Response, status: number, key: MessageKey, lang: Lang = "en"): Promise<string> {
  const html = await r.text();
  const [title, sentence] = MESSAGES[key][lang];
  expect({ status: r.status, h1: /<h1 class="h-task">([^<]*)<\/h1>/.exec(html)?.[1], alert: /<div class="card is-pending" role="alert"><p>([^<]*)<\/p><\/div>/.exec(html)?.[1] }, key).toEqual({ status, h1: escapeHtml(title), alert: escapeHtml(sentence) });
  return html;
}

/** The keys of a world's Worker, to write and read its cookies as the Worker does. */
export function keysOf(w: World): Promise<Keys> {
  return keysFor(must(w.env.SESSION_KEY));
}

/** The name=value of a Set-Cookie line, as a browser sends it back. */
export function sent(setCookie: string): string {
  return must(setCookie.split(";")[0]);
}

/** A session cookie as the Worker writes one, for a test that needs a session in a state the flows reach. */
export async function sessionHeader(w: World, s: Omit<Session, "v" | "sid" | "exp"> & Partial<Pick<Session, "sid" | "exp">>): Promise<string> {
  return sent(await sessionCookie(await keysOf(w), { v: 1, sid: "sid-of-the-test", exp: nowSeconds() + 600, ...s }));
}

/** An OAuth transaction cookie as /auth/login writes one. */
export async function transactionHeader(w: World, t: Omit<OAuthTransaction, "v" | "exp"> & Partial<Pick<OAuthTransaction, "exp">>): Promise<string> {
  return sent(await transactionCookie(await keysOf(w), { v: 1, exp: nowSeconds() + 600, ...t }));
}

/** The session a response sets, opened with the world's keys; null when it sets none or clears it. */
export async function sessionSet(w: World, r: Response): Promise<Session | null> {
  const c = r.headers.getSetCookie().find((x) => x.startsWith(`${SESSION_COOKIE}=`) && !x.includes("Max-Age=0"));
  return c ? readSession(new Request(ORIGIN, { headers: { cookie: sent(c) } }), await keysOf(w)) : null;
}

/** The lines the Worker logged, parsed. */
export function lines(w: World): Record<string, unknown>[] {
  return w.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A queue that is down: every send throws, nothing is kept. */
export function queueDown(w: World): void {
  const fail = () => Promise.reject(new Error("queue unavailable"));
  Object.assign(w.queue, { send: fail, sendBatch: fail });
}

/** A request to the Worker, as a browser or GitHub would make it. */
export async function call(w: World, path: string, init: RequestInit = {}): Promise<Response> {
  return spanishChecked(await handleFetch(new Request(`${ORIGIN}${path}`, init), w.env));
}

export interface Outcome {
  body: unknown;
  acked: boolean;
  retried: number | null;
}

/** A batch of queue messages, each with its delivery count; `outcomes` says what was done with each. */
export function batch(bodies: unknown[], attempts = 1): { batch: MessageBatch<QueueMessage>; outcomes: Outcome[] } {
  const outcomes: Outcome[] = bodies.map((body) => ({ body, acked: false, retried: null }));
  const messages = bodies.map((body, i) => ({
    id: String(i),
    timestamp: new Date(0),
    body,
    attempts,
    ack: () => {
      must(outcomes[i]).acked = true;
    },
    retry: (o?: { delaySeconds?: number }) => {
      must(outcomes[i]).retried = o?.delaySeconds ?? 0;
    },
  }));
  return { batch: { queue: "kleidos-cla", messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<QueueMessage>, outcomes };
}
