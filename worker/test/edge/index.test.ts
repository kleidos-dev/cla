// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The Worker's front door: which path and method reach which handler, what
 * the public routes serve byte for byte, what /healthz says, what the queue
 * consumer does with each outcome of a message, and the three entry points
 * of the default export.
 */
import { describe, expect, it, vi } from "vitest";
import { AGREEMENTS, filesOf } from "../../src/agreement";
import { makeBot } from "../../src/bot";
import type { ConfiguredEnv } from "../../src/env";
import { GitHubError, NotAllowedError } from "../../src/github";
import { ASSETS, STYLESHEET, stylesheetPath } from "../../src/html";
import worker, { handleQueue } from "../../src/index";
import { escapeHtml } from "../../src/html";
import { S } from "../../src/i18n";
import { b64urlEncode, must, sha256Hex } from "../../src/util";
import { CONFIG, CONFIG_V2, ORIGIN, batch, call, expectMessage, lines, restoring, world } from "./support";
import type { World } from "./support";

restoring();

const OTHER_METHODS = ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const SET_1 = CONFIG.versions["1"].set_sha256;
const SET_2 = CONFIG.versions["2"].set_sha256;

function plainText(r: Response, cache = "no-store, no-transform"): void {
  expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(r.headers.get("cache-control")).toBe(cache);
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("the route table", () => {
  it("serves every public route to GET and HEAD and answers 405 with its Allow to any other method", async () => {
    const w = await world();
    for (const path of ["/", "/agreement", "/agreement/entity", "/agreement/es", "/privacy", "/privacy/es", "/healthz", "/robots.txt", "/.well-known/security.txt", "/setup", "/agreement/v1/individual.md", "/assets/mark.svg", "/button/v2/none-0-0.svg", "/button/v2/needed-0-0.svg"]) {
      for (const method of ["GET", "HEAD"]) expect((await call(w, path, { method })).status, `${method} ${path}`).toBeLessThan(400);
      for (const method of OTHER_METHODS) {
        const r = await call(w, path, { method });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.get("allow")).toBe("GET, HEAD");
        expect(await r.text()).toBe("method not allowed\n");
      }
    }
    expect(w.gh.writes()).toEqual([]);
  });

  it("takes only POST at /webhook, /auth/logout and /agree, and only GET at the sign-in and the sign pages", async () => {
    const w = await world();
    const routes: [string, string][] = [
      ["/webhook", "POST"],
      ["/auth/logout", "POST"],
      ["/agree", "POST"],
      ["/auth/login", "GET"],
      ["/auth/callback", "GET"],
      ["/sign/kleidos-dev/cla/1", "GET"],
    ];
    for (const [path, wants] of routes) {
      for (const method of ["GET", "HEAD", ...OTHER_METHODS].filter((m) => m !== wants)) {
        const r = await call(w, path, { method });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.get("allow")).toBe(wants);
      }
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("answers 404 in plain text to any other path, whatever the method", async () => {
    const w = await world();
    for (const path of ["/sign", "/signs/a/b/1", "/auth", "/auth/", "/auth/login/", "/agree/", "/webhook/", "/AGREEMENT", "/agreement/", "/privacy.md", "/favicon.ico", "/.well-known/other"]) {
      for (const method of ["GET", "POST"]) {
        const r = await call(w, path, { method });
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(await r.text()).toBe("not found\n");
        plainText(r);
      }
    }
  });

  it("answers 404 to a path under a public prefix that names nothing", async () => {
    const w = await world();
    for (const path of ["/agreement/v", "/agreement/v1", "/agreement/v1/", "/agreement/v3/individual.md", "/agreement/v1/other.md", "/agreement/v1/__proto__", "/agreement/v1/constructor", "/agreement/v1/individual.md/", "/agreement/v1/../SHA256SUMS", "/assets/x/agreement/v1/individual.md", "/button/x/agreement/v1/SHA256SUMS", "/assets/", "/assets/cla.css", "/assets/cla.000000000000.css", "/assets/fonts/other.woff2", "/button/", "/button/v3/none-0-0.svg", "/button/v2/needed-1-1.svg"]) {
      const r = await call(w, path);
      expect(r.status, path).toBe(404);
      expect(await r.text()).toBe("not found\n");
    }
  });

  it("sends the old addresses to their pages: / to the agreement, the Spanish ones to ?lang=es", async () => {
    const w = await world();
    const moves: [string, number, string][] = [
      ["/", 302, "/agreement"],
      ["/agreement/es", 301, "/agreement?lang=es"],
      ["/privacy/es", 301, "/privacy?lang=es"],
    ];
    for (const [path, status, location] of moves) {
      const r = await call(w, path);
      expect(r.status, path).toBe(status);
      expect(r.headers.get("location")).toBe(location);
      expect(r.headers.get("cache-control")).toBe("no-store, no-transform");
    }
  });
});

describe("the public files", () => {
  it("serves every bundled file of every version byte for byte, as a download, Markdown as Markdown", async () => {
    const w = await world({ configure: false });
    for (const [v, files] of Object.entries(AGREEMENTS)) {
      for (const [name, body] of Object.entries(files)) {
        const r = await call(w, `/agreement/v${v}/${name}`);
        expect(r.status, name).toBe(200);
        expect(await r.text()).toBe(body);
        expect(r.headers.get("content-type")).toBe(name.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8");
        expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
        expect(r.headers.get("cache-control")).toBe("public, max-age=300, no-transform");
        expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      }
    }
  });

  // F10, a question for the owner: a version number with a leading zero names the same version.
  it("serves a version's files at the address with a leading zero too (pinned as it is today)", async () => {
    const w = await world({ configure: false });
    const r = await call(w, "/agreement/v01/individual.md");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(filesOf(1)["individual.md"]);
  });

  it("serves the stylesheet at its hashed address only, for a year", async () => {
    const w = await world({ configure: false });
    const path = await stylesheetPath();
    expect(path).toMatch(/^\/assets\/cla\.[0-9a-f]{12}\.css$/);
    const r = await call(w, path);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(STYLESHEET);
    expect(r.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable, no-transform");
  });

  it("serves the fonts and the mark with their own types, each the file of its own name", async () => {
    const w = await world({ configure: false });
    // The SHA-256 of worker/src/assets/fonts/*.woff2 and worker/src/assets/mark.svg as copied in (AGENTS.md, "Other repositories").
    const files: Record<string, string> = {
      "/assets/fonts/kleidos-sans-text.woff2": "64fffd2283a61d6415c0a3a526d4ebbf21d619e3f0f3046001b203cc22a4e12e",
      "/assets/fonts/kleidos-sans-display.woff2": "ad67d1e44b22773e1325224ad3e1ed08d7dc552d11e84a0f0f4997fc28d3feaa",
      "/assets/fonts/kleidos-mono.woff2": "58abf4b4985ac7d741a7cdf3dc280f82614644c046cc2618ef417eeec6961527",
      "/assets/mark.svg": "f3fa7340393c32eb5bf151f3b42cbd5ca9f5102628027cd409c0d3434a71a690",
    };
    const served: Record<string, string> = {};
    for (const [path, asset] of Object.entries(ASSETS)) {
      const r = await call(w, path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type")).toBe(asset.type);
      expect(r.headers.get("cache-control")).toBe("public, max-age=300, no-transform");
      const body = new Uint8Array(await r.arrayBuffer());
      expect(body).toEqual(typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : new Uint8Array(asset.body));
      served[path] = await sha256Hex(body);
    }
    expect(served).toEqual(files);
    expect(Object.fromEntries(Object.entries(ASSETS).map(([path, a]) => [path, a.type]))).toEqual({
      "/assets/fonts/kleidos-sans-text.woff2": "font/woff2",
      "/assets/fonts/kleidos-sans-display.woff2": "font/woff2",
      "/assets/fonts/kleidos-mono.woff2": "font/woff2",
      "/assets/mark.svg": "image/svg+xml",
    });
  });

  it("serves a button as an SVG that never changes", async () => {
    const w = await world({ configure: false });
    const r = await call(w, "/button/v2/partial-1-3.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable, no-transform");
    expect(await r.text()).toContain("<title id=\"t\">Sign the Kleidos Contributor Agreement: 1 of 3 authors signed.</title>");
  });

  it("tells robots to keep out of the signing paths, cached as public", async () => {
    const w = await world({ configure: false });
    const r = await call(w, "/robots.txt");
    expect(await r.text()).toBe("User-agent: *\nDisallow: /sign\nDisallow: /auth\nDisallow: /agree\n");
    plainText(r, "public, max-age=300, no-transform");
  });

  it("publishes security.txt expiring 180 days from today, at midnight UTC", async () => {
    const w = await world({ configure: false });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T23:59:59Z"));
    try {
      const r = await call(w, "/.well-known/security.txt");
      expect(await r.text()).toBe(
        "Contact: mailto:mail@kleidos.dev\nExpires: 2026-08-28T00:00:00Z\nPreferred-Languages: en, es\nCanonical: https://cla.kleidos.dev/.well-known/security.txt\nPolicy: https://github.com/kleidos-dev/cla/blob/main/SECURITY.md\n",
      );
      plainText(r);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a Worker that is not configured", () => {
  it("refuses every delivery as unsigned and shows a page for every signing route", async () => {
    const w = await world({ configure: false });
    const hook = await call(w, "/webhook", { method: "POST", body: "{}" });
    expect(hook.status).toBe(401);
    expect(await hook.text()).toBe("not configured: no delivery can be verified\n");
    for (const [path, method] of [
      ["/sign/kleidos-dev/cla/1", "GET"],
      ["/auth/login", "GET"],
      ["/auth/callback", "GET"],
      ["/auth/logout", "POST"],
      ["/agree", "POST"],
    ] as const) {
      await expectMessage(await call(w, path, { method }), 503, "notConfigured");
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("answers a wrong method 405 before saying it is not configured", async () => {
    const w = await world({ configure: false });
    for (const [path, method, allow] of [
      ["/webhook", "GET", "POST"],
      ["/sign/kleidos-dev/cla/1", "POST", "GET"],
      ["/agree", "GET", "POST"],
      ["/auth/logout", "GET", "POST"],
    ] as const) {
      const r = await call(w, path, { method });
      expect([r.status, r.headers.get("allow")], `${method} ${path}`).toEqual([405, allow]);
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("with an allowlist that names no account is not configured either", async () => {
    const w = await world();
    w.env.ALLOWED_ACCOUNT_IDS = " , x, 0";
    expect((await call(w, "/webhook", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("answers the public pages without asking GitHub anything", async () => {
    const w = await world({ configure: false });
    const r = await call(w, "/agreement");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(`<div class="card" role="status"><p><strong>${escapeHtml(S.en.notConfigured)}</strong></p></div>`);
    expect(w.gh.requests).toEqual([]);
  });
});

/** /healthz as an object. */
async function health(w: World): Promise<Record<string, unknown>> {
  const r = await call(w, "/healthz");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(r.headers.get("cache-control")).toBe("no-store, no-transform");
  const text = await r.text();
  expect(text.endsWith("}\n")).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("/healthz", () => {
  it("of a configured Worker says the version it signs, its digest, its flow and its commit", async () => {
    const w = await world();
    expect(await health(w)).toEqual({ ok: true, commit: w.env.BUILD_COMMIT, version: 1, set_sha256: SET_1, configured: true, signing: true, flow: "comment", signin_app: false });
  });

  it("of a Worker that is not configured says so, at the version it would show", async () => {
    const w = await world({ configure: false });
    w.env.BUILD_COMMIT = "unknown";
    // What the isolate last showed is not asked for here: a page read of a configured register sets it to version 1
    // (healthz reads the register too, but only a page records the version it shows).
    expect(await shown(await world())).toBe("The text you sign · version 1");
    expect(await health(w)).toEqual({ ok: true, commit: "unknown", version: 1, set_sha256: SET_1, configured: false, signing: false, signin_app: false, reason: "not configured" });
  });

  it("says the register was not read, with no flow, when it cannot be read", async () => {
    expect(await shown(await world())).toBe("The text you sign · version 1");
    const w = await world({ config: {} });
    expect(await health(w)).toEqual({ ok: true, commit: w.env.BUILD_COMMIT, version: 1, set_sha256: SET_1, configured: true, signing: false, signin_app: false, reason: "registry not read" });
  });

  it("names the sign-in app only when both its secrets are set", async () => {
    const w = await world({ signinSecrets: true });
    expect((await health(w)).signin_app).toBe(true);
    w.env.SIGNIN_CLIENT_SECRET = "";
    expect((await health(w)).signin_app).toBe(false);
    w.env.SIGNIN_CLIENT_SECRET = "x";
    w.env.SIGNIN_CLIENT_ID = "";
    expect((await health(w)).signin_app).toBe(false);
  });

  it("of a sign-in version built from an unknown commit is not signing, and says why", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    w.env.BUILD_COMMIT = "unknown";
    expect(await health(w)).toEqual({ ok: true, commit: "unknown", version: 2, set_sha256: SET_2, configured: true, signing: false, flow: "signin", signin_app: true, reason: "build commit unknown" });
    w.env.BUILD_COMMIT = "a".repeat(40);
    expect(await health(w)).toEqual({ ok: true, commit: "a".repeat(40), version: 2, set_sha256: SET_2, configured: true, signing: true, flow: "signin", signin_app: true });
  });
});

/** The eyebrow of the agreement page, which names the version shown. */
async function shown(w: World): Promise<string> {
  const html = await (await call(w, "/agreement")).text();
  return must(/<p class="eyebrow">([^<]*)<\/p>/.exec(html))[1] ?? "";
}

describe("the version the public pages show", () => {
  it("is the register's current one, kept while the register cannot be read or names one that is not bundled", async () => {
    expect(await shown(await world())).toBe("The text you sign · version 1");
    expect(await shown(await world({ config: CONFIG_V2 }))).toBe("The text you sign · version 2");
    expect(await shown(await world({ config: {} }))).toBe("The text you sign · version 2");
    expect(await shown(await world({ config: { ...CONFIG, current_version: 3, accepted_versions: [1] } }))).toBe("The text you sign · version 2");
    expect(await shown(await world({ configure: false }))).toBe("The text you sign · version 2");
    expect(await shown(await world())).toBe("The text you sign · version 1");
  });

  it("is the last one seen, asked of nobody, when every secret exists but the allowlist names no account", async () => {
    expect(await shown(await world({ config: CONFIG_V2 }))).toBe("The text you sign · version 2");
    const w = await world();
    w.env.ALLOWED_ACCOUNT_IDS = "";
    for (const path of ["/agreement", "/agreement/entity"]) {
      const r = await call(w, path);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toContain(`/agreement/v2/`);
    }
    expect(await shown(w)).toBe("The text you sign · version 2");
    expect(w.gh.requests).toEqual([]);
  });
});

describe("a configured Worker", () => {
  it("hands a delivery to the webhook, which reads it", async () => {
    const w = await world();
    const r = await call(w, "/webhook", { method: "POST", headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: "{}" });
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("bad signature\n");
  });

  it("hands each signing route to its own handler", async () => {
    const w = await world();
    await expectMessage(await call(w, "/sign/not-served/repo/1"), 404, "noTarget");
    await expectMessage(await call(w, "/auth/login?return=/x"), 400, "badLink");
    await expectMessage(await call(w, "/auth/callback"), 400, "oauthExpired");
    const out = await call(w, "/auth/logout", { method: "POST", headers: { origin: ORIGIN } });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/agreement?lang=en");
    await expectMessage(await call(w, "/agree", { method: "POST", headers: { origin: ORIGIN } }), 400, "formUnreadable");
  });
});

/** A bot whose first request to GitHub fails as given. */
function failingBot(error: unknown): (env: ConfiguredEnv) => ReturnType<typeof makeBot> {
  return (env) => {
    const bot = makeBot(env);
    vi.spyOn(bot.gh, "request").mockRejectedValue(error);
    return bot;
  };
}

const INSTALLATION = { kind: "installation", installation: 66 };

describe("the queue consumer", () => {
  it("of a Worker that is not configured retries every message in ten minutes", async () => {
    const w = await world({ configure: false });
    const { batch: b, outcomes } = batch([INSTALLATION, "junk"]);
    await handleQueue(b, w.env);
    expect(outcomes.map((o) => [o.acked, o.retried])).toEqual([
      [false, 600],
      [false, 600],
    ]);
    expect(w.gh.requests).toEqual([]);
  });

  it("acknowledges a body that is not a message without handling it, and goes on to the next", async () => {
    const w = await world();
    w.gh.installations.set(66, { account: 357318718 });
    const { batch: b, outcomes } = batch([{ kind: "installation", installation: "66" }, INSTALLATION]);
    await handleQueue(b, w.env);
    expect(outcomes.map((o) => [o.acked, o.retried])).toEqual([
      [true, null],
      [true, null],
    ]);
    expect(w.gh.seen(/\/app\/installations\//).map((s) => `${s.method} ${s.url}`)).toEqual(["GET /app/installations/66"]);
    expect(lines(w)).toEqual([]);
  });

  it("retries a refused token once, five seconds later, then as any retryable failure", async () => {
    const w = await world();
    const unauthorized = new GitHubError(401, "unauthorized");
    for (const [attempts, delay] of [
      [1, 5],
      [2, 60],
      [3, 120],
    ] as const) {
      const { batch: b, outcomes } = batch([INSTALLATION], attempts);
      await handleQueue(b, w.env, failingBot(unauthorized));
      expect(outcomes[0], String(attempts)).toEqual({ body: INSTALLATION, acked: false, retried: delay });
    }
    expect(lines(w)).toEqual([1, 2, 3].map((attempt) => ({ msg: "message failed", kind: "installation", reason: "unauthorized", status: 401, attempt })));
  });

  it("retries a rate limit or a passing failure after what GitHub said, or by doubling from thirty seconds up to ten minutes", async () => {
    const w = await world();
    const cases: [GitHubError, number, number][] = [
      [new GitHubError(429, "rate_limited", 17), 1, 17],
      [new GitHubError(503, "transient", 0), 4, 0],
      [new GitHubError(502, "transient"), 1, 30],
      [new GitHubError(502, "transient"), 2, 60],
      [new GitHubError(502, "transient"), 5, 480],
      [new GitHubError(502, "transient"), 6, 600],
      [new GitHubError(403, "rate_limited"), 9, 600],
    ];
    for (const [error, attempts, delay] of cases) {
      const { batch: b, outcomes } = batch([INSTALLATION], attempts);
      await handleQueue(b, w.env, failingBot(error));
      expect(outcomes[0], `${error.kind} ${attempts}`).toEqual({ body: INSTALLATION, acked: false, retried: delay });
    }
  });

  it("drops a message whose failure will not pass by retrying it, and logs why", async () => {
    const w = await world();
    for (const error of [new GitHubError(404, "not_found"), new GitHubError(422, "unprocessable"), new GitHubError(403, "forbidden"), new GitHubError(200, "bad_response"), new NotAllowedError("not served"), new Error("boom"), "a string"]) {
      const { batch: b, outcomes } = batch([INSTALLATION], 1);
      await handleQueue(b, w.env, failingBot(error));
      expect(outcomes[0], String(error)).toEqual({ body: INSTALLATION, acked: true, retried: null });
    }
    expect(lines(w)).toEqual([
      { msg: "message failed", kind: "installation", reason: "not_found", status: 404, attempt: 1 },
      { msg: "message failed", kind: "installation", reason: "unprocessable", status: 422, attempt: 1 },
      { msg: "message failed", kind: "installation", reason: "forbidden", status: 403, attempt: 1 },
      { msg: "message failed", kind: "installation", reason: "bad_response", status: 200, attempt: 1 },
      { msg: "message failed", kind: "installation", reason: "not served", attempt: 1 },
      { msg: "message failed", kind: "installation", reason: "error", attempt: 1 },
      { msg: "message failed", kind: "installation", reason: "error", attempt: 1 },
    ]);
  });
});

describe("the default export", () => {
  it("answers every request with its encoding chosen from the request", async () => {
    const w = await world({ configure: false });
    const r = await worker.fetch(new Request(`${ORIGIN}/robots.txt`, { headers: { "accept-encoding": "gzip" } }), w.env);
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(r.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("answers 500 in plain text when a handler throws, and logs only the kind of error", async () => {
    const w = await world();
    w.env.SESSION_KEY = "short";
    const r = await worker.fetch(new Request(`${ORIGIN}/sign/kleidos-dev/cla/1`), w.env);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("internal error\n");
    plainText(r);
    vi.spyOn(must(w.limiters.RL_SIGN), "limit").mockImplementation(() => {
      throw "not an error"; // eslint-disable-line @typescript-eslint/only-throw-error -- what a dependency may throw
    });
    w.env.SESSION_KEY = b64urlEncode(new Uint8Array(32).fill(7));
    expect((await worker.fetch(new Request(`${ORIGIN}/sign/kleidos-dev/cla/1`), w.env)).status).toBe(500);
    expect(lines(w).filter((l) => l.msg === "unhandled")).toEqual([
      { msg: "unhandled", reason: "Error" },
      { msg: "unhandled", reason: "unknown" },
    ]);
  });

  it("consumes a batch with the bot of its environment", async () => {
    const w = await world();
    w.gh.installations.set(66, { account: 4242 });
    const { batch: b, outcomes } = batch([INSTALLATION]);
    await worker.queue(b, w.env);
    expect(outcomes[0]).toEqual({ body: INSTALLATION, acked: true, retried: null });
    expect(w.gh.deletedInstallations).toEqual([66]);
  });

  it("runs the cron only when configured", async () => {
    const off = await world({ configure: false });
    await worker.scheduled({} as ScheduledController, off.env);
    expect(off.gh.requests).toEqual([]);
    const on = await world();
    await worker.scheduled({} as ScheduledController, on.env);
    expect(on.gh.seen(/^GET \/app\/installations/).length).toBeGreaterThan(0);
  });
});
