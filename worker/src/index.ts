// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { FALLBACK_VERSION, checkIntegrity, filesOf, isBundled } from "./agreement";
import type { Bot } from "./bot";
import { cron, handleMessage, makeBot } from "./bot";
import type { ConfiguredEnv, Env } from "./env";
import { isConfigured } from "./env";
import { GitHubError, NotAllowedError } from "./github";
import { buttonSvg, parseButtonPath } from "./button";
import { ASSETS, STYLESHEET, messagePage, redirect, securityHeaders, stylesheetPath, text, withEncoding } from "./html";
import type { Lang } from "./i18n";
import { pickLang } from "./i18n";
import { keysFor } from "./keys";
import { log } from "./log";
import type { QueueMessage } from "./messages";
import { parseMessage } from "./messages";
import { agree, agreementPage, callback, login, logout, privacyPage, setupPage, signPage, signingState } from "./web";
import { handleWebhook } from "./webhook";
import { must } from "./util";

const PUBLIC_ROUTES = new Set(["/agreement", "/agreement/entity", "/agreement/es", "/privacy", "/privacy/es", "/healthz", "/robots.txt", "/.well-known/security.txt", "/", "/setup"]);

function notFound(): Response {
  return text("not found\n", 404);
}

function methodNotAllowed(allow: string): Response {
  const r = text("method not allowed\n", 405);
  r.headers.set("allow", allow);
  return r;
}

/** The last current_version read in this isolate: what the public pages show while the register cannot be read. */
let lastCurrent = FALLBACK_VERSION;

/** The version the public pages show: the register's current one when it is bundled here. */
async function shownVersion(env: Env): Promise<number> {
  if (isConfigured(env)) {
    try {
      const v = (await makeBot(env).registry.config()).current_version;
      if (isBundled(v)) lastCurrent = v;
    } catch {
      // The register cannot be read: keep the last version seen.
    }
  }
  return lastCurrent;
}

async function healthz(env: Env): Promise<Response> {
  let signing: { on: boolean; reason?: string; version: number; flow?: string } = { on: false, reason: "not configured", version: lastCurrent };
  if (isConfigured(env)) {
    try {
      signing = await signingState(await makeBot(env).registry.config(), env);
    } catch {
      signing = { on: false, reason: "registry not read", version: lastCurrent };
    }
  }
  const integrity = await checkIntegrity(signing.version);
  const body = {
    ok: integrity.ok,
    commit: env.BUILD_COMMIT,
    version: signing.version,
    set_sha256: integrity.setSha256,
    configured: isConfigured(env),
    signing: signing.on,
    ...(signing.flow ? { flow: signing.flow } : {}),
    signin_app: Boolean(env.SIGNIN_CLIENT_ID && env.SIGNIN_CLIENT_SECRET),
    ...(signing.reason ? { reason: signing.reason } : {}),
  };
  return text(JSON.stringify(body) + "\n", 200, "application/json; charset=utf-8");
}

function securityTxt(env: Env): Response {
  const expires = new Date(Date.now() + 180 * 86400 * 1000).toISOString().slice(0, 10);
  return text(
    `Contact: mailto:mail@kleidos.dev\nExpires: ${expires}T00:00:00Z\nPreferred-Languages: en, es\nCanonical: ${env.PUBLIC_ORIGIN}/.well-known/security.txt\nPolicy: https://github.com/kleidos-dev/cla/blob/main/SECURITY.md\n`,
  );
}

async function publicRoute(path: string, env: Env, lang: Lang): Promise<Response | null> {
  switch (path) {
    case "/":
      return redirect("/agreement", 302);
    case "/agreement":
      return agreementPage("individual", lang, env, isConfigured(env), await shownVersion(env));
    case "/agreement/entity":
      return agreementPage("entity", lang, env, isConfigured(env), await shownVersion(env));
    // The old Spanish addresses: every page now exists in both languages at one path.
    case "/agreement/es":
      return redirect("/agreement?lang=es", 301);
    case "/privacy":
      return privacyPage(lang);
    case "/privacy/es":
      return redirect("/privacy?lang=es", 301);
    case "/setup":
      return setupPage(lang);
    case "/healthz":
      return healthz(env);
    case "/robots.txt":
      return text("User-agent: *\nDisallow: /sign\nDisallow: /auth\nDisallow: /agree\n", 200, "text/plain; charset=utf-8", "public");
    case "/.well-known/security.txt":
      return securityTxt(env);
  }
  const file = /^\/agreement\/v(\d+)\/([A-Za-z0-9.]+)$/.exec(path);
  if (file && isBundled(Number(file[1])) && Object.hasOwn(filesOf(Number(file[1])), must(file[2]))) {
    const name = must(file[2]);
    const h = securityHeaders(new Headers({ "content-type": name.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"` }), "public");
    return new Response(filesOf(Number(file[1]))[name], { headers: h });
  }
  if (path.startsWith("/assets/") && path === (await stylesheetPath())) {
    return new Response(STYLESHEET, { headers: securityHeaders(new Headers({ "content-type": "text/css; charset=utf-8" }), "immutable") });
  }
  const asset = Object.hasOwn(ASSETS, path) ? ASSETS[path] : undefined;
  if (asset) return new Response(asset.body, { headers: securityHeaders(new Headers({ "content-type": asset.type }), "public") });
  const button = parseButtonPath(path);
  if (button) {
    return new Response(buttonSvg(button.state, button.signed, button.total), { headers: securityHeaders(new Headers({ "content-type": "image/svg+xml; charset=utf-8" }), "immutable") });
  }
  return null;
}

export async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  const lang = pickLang(req, url);

  if (PUBLIC_ROUTES.has(path) || path.startsWith("/agreement/v") || path.startsWith("/assets/") || path.startsWith("/button/")) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return (await publicRoute(path, env, lang)) ?? notFound();
  }

  const isSign = path.startsWith("/sign/");
  const known = path === "/webhook" || path === "/auth/login" || path === "/auth/callback" || path === "/auth/logout" || path === "/agree" || isSign;
  if (!known) return notFound();
  const wants = path === "/webhook" || path === "/auth/logout" || path === "/agree" ? "POST" : "GET";
  if (method !== wants) return methodNotAllowed(wants);
  if (!isConfigured(env)) {
    // Without the webhook secret no delivery can be verified, so every one is refused as unsigned.
    if (path === "/webhook") return text("not configured: no delivery can be verified\n", 401);
    return messagePage(lang, 503, "notConfigured");
  }

  const bot = makeBot(env);
  if (path === "/webhook") return handleWebhook(req, env);
  const keys = await keysFor(env.SESSION_KEY);
  if (isSign) return signPage(req, env, bot, keys, path);
  if (path === "/auth/login") return login(req, env, bot, keys, url);
  if (path === "/auth/callback") return callback(req, env, bot, keys, url);
  if (path === "/auth/logout") return logout(req, env, bot, keys);
  return agree(req, env, bot, keys);
}

/** One queue message: transient GitHub failures are retried with a delay, anything else is dropped (the cron recovers). */
export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env, botFor: (env: ConfiguredEnv) => Bot = makeBot): Promise<void> {
  if (!isConfigured(env)) {
    for (const m of batch.messages) m.retry({ delaySeconds: 600 });
    return;
  }
  const bot = botFor(env);
  for (const m of batch.messages) {
    const msg = parseMessage(m.body);
    if (!msg) {
      m.ack();
      continue;
    }
    try {
      await handleMessage(bot, msg);
      m.ack();
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "unauthorized" && m.attempts < 2) {
        m.retry({ delaySeconds: 5 });
      } else if (e instanceof GitHubError && e.retryable) {
        m.retry({ delaySeconds: e.retryAfter ?? Math.min(600, 30 * 2 ** (m.attempts - 1)) });
      } else {
        m.ack();
      }
      log("message failed", { kind: msg.kind, reason: e instanceof GitHubError ? e.kind : e instanceof NotAllowedError ? e.reason : "error", status: e instanceof GitHubError ? e.status : undefined, attempt: m.attempts });
    }
  }
}

export default {
  async fetch(req, env): Promise<Response> {
    try {
      return withEncoding(req, await handleFetch(req, env));
    } catch (e) {
      log("unhandled", { reason: e instanceof Error ? e.name : "unknown" });
      return text("internal error\n", 500);
    }
  },
  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },
  async scheduled(_controller, env): Promise<void> {
    if (!isConfigured(env)) return;
    await cron(makeBot(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
