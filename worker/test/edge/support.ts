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
import { MESSAGES } from "../../src/i18n";
import { handleFetch } from "../../src/index";
import type { QueueMessage } from "../../src/messages";
import type { Keys } from "../../src/keys";
import { keysFor } from "../../src/keys";
import type { OAuthTransaction, Session } from "../../src/session";
import { SESSION_COOKIE, readSession, sessionCookie, transactionCookie } from "../../src/session";
import { must, nowSeconds } from "../../src/util";
import type { World } from "../helpers";
import { ORIGIN } from "../helpers";

export { Browser, CONFIG, CONFIG_V2, ORIGIN, SANDBOX, WEBHOOK_SECRET, drain, openPr, prEvent, sign, webhook, world } from "../helpers";
export type { World } from "../helpers";

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
export function call(w: World, path: string, init: RequestInit = {}): Promise<Response> {
  return handleFetch(new Request(`${ORIGIN}${path}`, init), w.env);
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
