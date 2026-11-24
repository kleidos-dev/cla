// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/** The GitHub client: what it sends, and what every answer GitHub can give turns into. */
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfiguredEnv } from "../../src/env";
import { API, GitHub, GitHubError, NotAllowedError, WEB, appJwt, nextLink, resetGitHubCaches } from "../../src/github";
import { b64urlDecode, must, utf8 } from "../../src/util";
import { APP_ID } from "../fakegh";
import type { World } from "../helpers";
import { SANDBOX, world } from "../helpers";

const NOW = Date.parse("2026-11-24T10:00:00Z");
let w: World;
let env: ConfiguredEnv;
let gh: GitHub;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  w = await world();
  env = w.env as ConfiguredEnv;
  gh = new GitHub(env);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
/** Plays GitHub for one request outside the fake's routes, and gives back what was sent. */
function sent(respond: () => Response | Promise<Response> = () => json({})) {
  const seen: { req: Request; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ req: new Request(input, init), init });
    return Promise.resolve(respond());
  });
  return seen;
}
const failure = async (p: Promise<unknown>) => {
  const e: unknown = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(GitHubError);
  return e as GitHubError;
};

describe("a request", () => {
  it("goes to api.github.com with the app's headers and follows no redirect", async () => {
    const seen = sent();
    await gh.request("GET", "/x?y=1", { token: "ghs_made_up" });
    const { req, init } = must(seen[0]);
    expect([req.method, req.url, req.redirect]).toEqual(["GET", "https://api.github.com/x?y=1", "manual"]);
    expect(Object.fromEntries(req.headers)).toEqual({ "user-agent": "kleidos-cla (+https://cla.kleidos.dev)", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: "Bearer ghs_made_up" });
    expect(init?.body).toBeNull();
  });

  it("carries a JSON body, and says so, only when there is one", async () => {
    const seen = sent();
    await gh.request("POST", "/x", { token: "t" }, { a: ["ñ"] });
    const { req } = must(seen[0]);
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.text()).toBe('{"a":["ñ"]}');
    await gh.request("POST", "/x", { token: "t" }, null);
    expect(await must(seen[1]).req.text()).toBe("null");
  });

  it("takes a whole address as it is, and puts the API before a path", async () => {
    const seen = sent();
    await gh.request("GET", "https://example.org/x", { token: "t" });
    await gh.request("GET", "/https://example.org/x", { token: "t" });
    await gh.request("GET", "/x?https://", { token: "t" });
    expect(seen.map((s) => s.req.url)).toEqual(["https://example.org/x", "https://api.github.com/https://example.org/x", "https://api.github.com/x?https://"]);
    expect([API, WEB]).toEqual(["https://api.github.com", "https://github.com"]);
  });

  it("signs in as an app with its id and secret, or with its JWT", async () => {
    const seen = sent();
    await gh.request("DELETE", "/applications/x/grant", { basic: ["id", "se:cret"] });
    await gh.request("GET", "/app", { jwt: true });
    expect(must(seen[0]).req.headers.get("authorization")).toBe(`Basic ${btoa("id:se:cret")}`);
    expect(must(seen[1]).req.headers.get("authorization")).toBe(`Bearer ${await appJwt(env)}`);
  });

  it("asks for what the caller accepts", async () => {
    const seen = sent(() => new Response("text, not JSON"));
    expect((await gh.request<string>("GET", "/x", { token: "t" }, undefined, "application/vnd.github.raw+json")).data).toBe("text, not JSON");
    expect(must(seen[0]).req.headers.get("accept")).toBe("application/vnd.github.raw+json");
  });
});

describe("an answer", () => {
  it("is its status, its decoded body and its headers", async () => {
    sent(() => new Response('{"a":1}', { status: 201, headers: { "x-a": "b" } }));
    const r = await gh.request<{ a: number }>("POST", "/x", { token: "t" });
    expect([r.status, r.data, r.headers.get("x-a")]).toEqual([201, { a: 1 }, "b"]);
  });

  it("of 204 has no body, whatever was accepted", async () => {
    sent(() => new Response(null, { status: 204, headers: { "x-a": "b" } }));
    for (const accept of ["application/vnd.github+json", "application/vnd.github.raw+json"]) {
      const r = await gh.request("DELETE", "/x", { token: "t" }, undefined, accept);
      expect([r.status, r.data, r.headers.get("x-a")]).toEqual([204, undefined, "b"]);
    }
  });

  it("to a write may have no body", async () => {
    sent(() => new Response("", { status: 202 }));
    const r = await gh.request("POST", "/x", { token: "t" });
    expect([r.status, r.data]).toEqual([202, undefined]);
  });

  it("read raw may be empty: an empty file is a file", async () => {
    sent(() => new Response(""));
    expect((await gh.request<string>("GET", "/x", { token: "t" }, undefined, "application/vnd.github.raw+json")).data).toBe("");
  });

  it("that is not JSON is bad, with its status, and is not retried", async () => {
    sent(() => new Response("<html>", { status: 201 }));
    const e = await failure(gh.request("POST", "/x", { token: "t" }));
    expect([e.status, e.kind, e.retryable]).toEqual([201, "bad_response", false]);
  });

  it("that never comes is a transient failure with no status", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network")));
    const e = await failure(gh.request("GET", "/x", { token: "t" }));
    expect([e.status, e.kind, e.retryable, e.message]).toEqual([0, "transient", true, "GitHub 0 transient"]);
  });
});

describe("a refusal", () => {
  const refused = async (status: number, headers: Record<string, string> = {}) => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    sent(() => new Response(body, { status, headers }));
    const e = await failure(gh.request("GET", "/x", { token: "t" }));
    expect(e.status).toBe(status);
    // The body of a refusal is never read: it is let go at once.
    expect(cancelled).toBe(true);
    return e;
  };

  it.each([
    [301, "bad_response", false],
    [400, "bad_response", false],
    [401, "unauthorized", true],
    [403, "forbidden", false],
    [404, "not_found", false],
    [409, "bad_response", false],
    [410, "bad_response", false],
    [418, "bad_response", false],
    [422, "unprocessable", false],
    [429, "rate_limited", true],
    [499, "bad_response", false],
    [500, "transient", true],
    [502, "transient", true],
    [503, "transient", true],
    [599, "transient", true],
  ])("of status %i is %s, retried: %j", async (status, kind, retryable) => {
    const e = await refused(status);
    expect([e.kind, e.retryable, e.message]).toEqual([kind, retryable, `GitHub ${status} ${kind}`]);
  });

  it.each([400, 401, 403, 404, 422, 429, 500])("of status %i keeps GitHub's request id, and none is made up", async (status) => {
    expect((await refused(status, { "x-github-request-id": "A1:B2" })).requestId).toBe("A1:B2");
    expect((await refused(status)).requestId).toBeUndefined();
  });

  it("only of a rate limit says when to come back", async () => {
    for (const status of [400, 401, 404, 422, 500]) expect((await refused(status, { "retry-after": "5" })).retryAfter).toBeUndefined();
  });

  const reset = String(NOW / 1000 + 90);
  it.each([
    ["429 and nothing else", 429, {}, "rate_limited", 60],
    ["429 and Retry-After", 429, { "retry-after": "42" }, "rate_limited", 42],
    ["429 and a zero Retry-After", 429, { "retry-after": "0" }, "rate_limited", 0],
    ["429 and Retry-After over an hour", 429, { "retry-after": "3601" }, "rate_limited", 3600],
    ["429 and Retry-After of an hour", 429, { "retry-after": "3600" }, "rate_limited", 3600],
    ["429 and Retry-After as a date", 429, { "retry-after": "Tue, 24 Nov 2026 10:05:00 GMT" }, "rate_limited", 60],
    ["429, a date and a reset", 429, { "retry-after": "Tue, 24 Nov 2026 10:05:00 GMT", "x-ratelimit-reset": reset }, "rate_limited", 90],
    ["429 and a reset", 429, { "x-ratelimit-reset": reset }, "rate_limited", 90],
    ["429 and a reset of this second", 429, { "x-ratelimit-reset": String(NOW / 1000) }, "rate_limited", 1],
    ["429 and a reset already past", 429, { "x-ratelimit-reset": String(NOW / 1000 - 500) }, "rate_limited", 1],
    ["429 and a reset over an hour away", 429, { "x-ratelimit-reset": String(NOW / 1000 + 7200) }, "rate_limited", 3600],
    ["429 and a reset that is no number", 429, { "x-ratelimit-reset": "soon" }, "rate_limited", 60],
    ["429, Retry-After before the reset", 429, { "retry-after": "5", "x-ratelimit-reset": reset }, "rate_limited", 5],
    ["403 and Retry-After", 403, { "retry-after": "42" }, "rate_limited", 42],
    ["403 and no calls left", 403, { "x-ratelimit-remaining": "0" }, "rate_limited", 60],
    ["403, no calls left and a reset", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, "rate_limited", 90],
    ["403 and calls left", 403, { "x-ratelimit-remaining": "1" }, "forbidden", undefined],
    ["403 and a reset", 403, { "x-ratelimit-reset": reset }, "forbidden", undefined],
    ["403 and Retry-After as a date", 403, { "retry-after": "Tue, 24 Nov 2026 10:05:00 GMT" }, "forbidden", undefined],
    ["401 and Retry-After", 401, { "retry-after": "42" }, "unauthorized", undefined],
    ["404 and no calls left", 404, { "x-ratelimit-remaining": "0" }, "not_found", undefined],
  ])("with %s", async (_what, status, headers, kind, retryAfter) => {
    const e = await refused(status, headers);
    expect([e.kind, e.retryAfter]).toEqual([kind, retryAfter]);
    if (kind === "rate_limited") expect((await refused(status, { ...headers, "x-github-request-id": "A1" })).requestId).toBe("A1");
  });
});

describe("the app's JWT", () => {
  const parts = (jwt: string) => jwt.split(".").map((p) => must(b64urlDecode(p)));
  const claims = (jwt: string) => JSON.parse(new TextDecoder().decode(must(parts(jwt)[1]))) as Record<string, unknown>;

  it("is signed with RS256, starts a minute ago, lasts nine and names the app", async () => {
    const jwt = await appJwt(env);
    expect(JSON.parse(new TextDecoder().decode(must(parts(jwt)[0])))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims(jwt)).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: String(APP_ID) });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", w.gh.publicKey, must(parts(jwt)[2]), utf8(jwt.split(".").slice(0, 2).join(".")))).toBe(true);
  });

  it("is made once and used until a minute before its end", async () => {
    const jwt = await appJwt(env);
    vi.setSystemTime(NOW + 479_999);
    expect(await appJwt(env)).toBe(jwt);
    vi.setSystemTime(NOW + 480_000);
    const next = await appJwt(env);
    expect(claims(next).iat).toBe(NOW / 1000 + 420);
  });

  it("is another app's when the app changes", async () => {
    await appJwt(env);
    expect(claims(await appJwt({ ...env, APP_ID: "77" })).iss).toBe("77");
    // And back: the one kept is the last one made.
    expect(claims(await appJwt(env)).iss).toBe(String(APP_ID));
  });

  it("is made again once the caches are forgotten", async () => {
    await appJwt(env);
    const sign = vi.spyOn(crypto.subtle, "sign");
    await appJwt(env);
    expect(sign).toHaveBeenCalledTimes(0);
    resetGitHubCaches();
    await appJwt(env);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("imports the key once, and another key when it changes, for signing only", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await appJwt(env);
    vi.setSystemTime(NOW + 480_000);
    await appJwt(env);
    expect(importKey.mock.calls.map(([format, , algorithm, extractable, usages]) => [format, algorithm, extractable, usages])).toEqual([["pkcs8", { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]]]);
    vi.setSystemTime(NOW + 960_000);
    await appJwt({ ...env, APP_PRIVATE_KEY: `${env.APP_PRIVATE_KEY}\n` });
    expect(importKey).toHaveBeenCalledTimes(2);
    resetGitHubCaches();
    await appJwt(env);
    expect(importKey).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["with Windows line ends", (pem: string) => pem.replaceAll("\n", "\r\n")],
    ["on one line", (pem: string) => pem.replaceAll("\n", "")],
    ["with spaces around it", (pem: string) => `  ${pem}\t`],
    ["without its markers", (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "")],
  ])("is signed by a PEM key %s", async (_what, change) => {
    expect(await appJwt({ ...env, APP_PRIVATE_KEY: change(env.APP_PRIVATE_KEY) })).toBe(await appJwt(env));
  });

  it("is not made with a PKCS#1 key, and says what is wanted", async () => {
    const pem = env.APP_PRIVATE_KEY.replaceAll("PRIVATE KEY", "RSA PRIVATE KEY");
    await expect(appJwt({ ...env, APP_PRIVATE_KEY: pem })).rejects.toThrow("APP_PRIVATE_KEY must be PKCS#8");
  });

  it("is not made with a key that is no PEM", async () => {
    await expect(appJwt({ ...env, APP_PRIVATE_KEY: "?" })).rejects.toThrow("APP_PRIVATE_KEY is not PEM");
    await expect(appJwt({ ...env, APP_PRIVATE_KEY: "AAAA" })).rejects.toThrow();
  });
});

describe("the installation of a repository", () => {
  const asked = () => w.gh.seen(/\/installation$/);

  it("is asked with the app's JWT and kept for ten minutes", async () => {
    expect(await gh.installationFor(SANDBOX)).toBe(1);
    vi.setSystemTime(NOW + 599_999);
    expect(await gh.installationFor(SANDBOX)).toBe(1);
    expect(asked()).toEqual([{ method: "GET", url: `/repos/${SANDBOX}/installation`, auth: "jwt" }]);
    vi.setSystemTime(NOW + 600_000);
    await gh.installationFor(SANDBOX);
    expect(asked()).toHaveLength(2);
  });

  it("is each repository's own", async () => {
    w.gh.addRepo("kleidos-dev/other", { installation: 2 });
    expect([await gh.installationFor(SANDBOX), await gh.installationFor("kleidos-dev/other")]).toEqual([1, 2]);
  });

  it("on an account that is not allowed is refused, kept or not", async () => {
    w.gh.addRepo("stranger/repo", { installation: 9, account: 4242 });
    for (let i = 0; i < 2; i++) await expect(gh.installationFor("stranger/repo")).rejects.toMatchObject({ reason: "installation_not_allowed", message: "installation_not_allowed" });
    expect(asked()).toHaveLength(1);
    await expect(gh.token(["stranger/repo"], { contents: "read" })).rejects.toBeInstanceOf(NotAllowedError);
    expect(w.gh.seen(/access_tokens$/)).toHaveLength(0);
  });

  it("is forgotten with the caches", async () => {
    await gh.installationFor(SANDBOX);
    resetGitHubCaches();
    await gh.installationFor(SANDBOX);
    expect(asked()).toHaveLength(2);
  });
});

describe("an installation token", () => {
  const bought = () => w.gh.seen(/access_tokens$/);

  it("is narrowed to the repositories and the permissions asked for", async () => {
    const token = await gh.token([SANDBOX], { contents: "read" });
    expect(bought()).toEqual([{ method: "POST", url: "/app/installations/1/access_tokens", auth: "jwt", body: { repositories: ["cla-sandbox"], permissions: { contents: "read" } } }]);
    expect(w.gh.tokens.get(token)).toMatchObject({ installation: 1, repos: ["cla-sandbox"], permissions: { contents: "read" } });
  });

  it("is one for the same repositories and permissions, in any order", async () => {
    w.gh.addRepo("kleidos-dev/other");
    const a = await gh.token([SANDBOX, "kleidos-dev/other", SANDBOX], { contents: "read", actions: "read" });
    expect(await gh.token(["kleidos-dev/other", SANDBOX], { actions: "read", contents: "read" })).toBe(a);
    expect(bought()).toHaveLength(1);
    expect(must(bought()[0]).body).toEqual({ repositories: ["cla-sandbox", "other"], permissions: { contents: "read", actions: "read" } });
  });

  it.each([
    ["another repository", ["kleidos-dev/other"], { contents: "read" }],
    ["one repository more", [SANDBOX, "kleidos-dev/other"], { contents: "read" }],
    ["another permission", [SANDBOX], { actions: "read" }],
    ["one permission more", [SANDBOX], { contents: "read", actions: "read" }],
    ["another level", [SANDBOX], { pull_requests: "write" }],
  ] as const)("is another for %s", async (_what, repos, permissions) => {
    w.gh.addRepo("kleidos-dev/other");
    const first = await gh.token([SANDBOX], "pull_requests" in permissions ? { pull_requests: "read" } : { contents: "read" });
    expect(await gh.token([...repos], permissions)).not.toBe(first);
    expect(bought()).toHaveLength(2);
  });

  it("is another for the same names in another installation", async () => {
    w.gh.addRepo("other-org/cla-sandbox", { installation: 2 });
    const a = await gh.token([SANDBOX], { contents: "read" });
    expect(await gh.token(["other-org/cla-sandbox"], { contents: "read" })).not.toBe(a);
    expect(bought().map((r) => r.url)).toEqual(["/app/installations/1/access_tokens", "/app/installations/2/access_tokens"]);
  });

  it("is used until five minutes before its end", async () => {
    const first = await gh.token([SANDBOX], { contents: "read" });
    vi.setSystemTime(NOW + 3_299_999);
    expect(await gh.token([SANDBOX], { contents: "read" })).toBe(first);
    vi.setSystemTime(NOW + 3_300_000);
    expect(await gh.token([SANDBOX], { contents: "read" })).not.toBe(first);
  });

  it("whose end GitHub does not say lasts an hour", async () => {
    const ttl = async (expires_at: unknown) => {
      resetGitHubCaches();
      vi.setSystemTime(NOW);
      w.gh.answer(/access_tokens$/, () => json({ token: `ghs_${crypto.randomUUID()}`, expires_at }), 1);
      const first = await gh.token([SANDBOX], { contents: "read" });
      const before = bought().length;
      vi.setSystemTime(NOW + 3_299_999);
      expect(await gh.token([SANDBOX], { contents: "read" })).toBe(first);
      vi.setSystemTime(NOW + 3_300_000);
      await gh.token([SANDBOX], { contents: "read" });
      expect(bought().length).toBe(before + 1);
    };
    await ttl(undefined);
    await ttl("some day");
  });

  it("that ends in half a second is bought again", async () => {
    w.gh.answer(/access_tokens$/, () => json({ token: "ghs_short", expires_at: new Date(NOW + 300_999).toISOString() }), 1);
    expect(await gh.token([SANDBOX], { contents: "read" })).toBe("ghs_short");
    expect(await gh.token([SANDBOX], { contents: "read" })).not.toBe("ghs_short");
  });

  it("is never bought across two installations", async () => {
    w.gh.addRepo("kleidos-dev/elsewhere", { installation: 2 });
    await expect(gh.token([SANDBOX, "kleidos-dev/elsewhere"], { contents: "read" })).rejects.toMatchObject({ reason: "repositories_span_installations" });
    expect(bought()).toHaveLength(0);
  });

  it("is never bought for a repository that is not allowed, wherever it comes in the list", async () => {
    w.gh.addRepo("stranger/repo", { installation: 9, account: 4242 });
    await expect(gh.token([SANDBOX, "stranger/repo"], { contents: "read" })).rejects.toMatchObject({ reason: "installation_not_allowed" });
    expect(bought()).toHaveLength(0);
  });

  it("is never bought for no repository: that would be one for all of them", async () => {
    await expect(gh.token([], { contents: "read" })).rejects.toThrow("a value the code relies on is missing");
    await expect(gh.token(["noslash"], { contents: "read" })).rejects.toThrow();
    expect(bought()).toHaveLength(0);
  });
});

describe("a GraphQL query", () => {
  const answer = (data: unknown) => {
    w.gh.answer(/^POST \/graphql$/, () => json(data));
  };

  it("sends its text and its variables with the token, and gives back the data", async () => {
    answer({ data: { a: 1 } });
    expect(await gh.graphql("ghs_x", "query{a}", { n: 1 })).toEqual({ a: 1 });
    expect(w.gh.seen(/graphql/)).toMatchObject([{ method: "POST", body: { query: "query{a}", variables: { n: 1 } } }]);
  });

  it.each([
    ["RATE_LIMITED", "rate_limited", 60],
    ["NOT_FOUND", "not_found", undefined],
    ["FORBIDDEN", "bad_response", undefined],
    [undefined, "bad_response", undefined],
  ])("refused with %s is %s", async (type, kind, retryAfter) => {
    answer({ data: { a: 1 }, errors: [{ message: "x" }, { type, message: "x" }] });
    const e = await failure(gh.graphql("t", "q", {}));
    expect([e.status, e.kind, e.retryAfter]).toEqual([200, kind, retryAfter]);
  });

  it("refused both ways is a rate limit, which is retried", async () => {
    answer({ errors: [{ type: "NOT_FOUND" }, { type: "RATE_LIMITED" }] });
    expect((await failure(gh.graphql("t", "q", {}))).kind).toBe("rate_limited");
  });

  it("with an empty list of errors is an answer", async () => {
    answer({ data: { a: 1 }, errors: [] });
    expect(await gh.graphql("t", "q", {})).toEqual({ a: 1 });
  });

  it.each([{}, { data: null }])("with no data (%j) is bad", async (body) => {
    answer(body);
    const e = await failure(gh.graphql("t", "q", {}));
    expect([e.status, e.kind]).toEqual([200, "bad_response"]);
  });
});

describe("a paged list", () => {
  const link = (path: string) => ({ link: `<${API}${path}>; rel="next"` });

  it("is asked a hundred at a time and followed to its end", async () => {
    w.gh.answer(/^GET \/x\?per_page=100$/, () => json([1, 2], link("/x?per_page=100&page=2")));
    w.gh.answer(/^GET \/x\?per_page=100&page=2$/, () => json([3]));
    expect(await gh.paginate("/x", { token: "t" }, 3)).toEqual({ items: [1, 2, 3], truncated: false });
    expect(w.gh.requests.map((r) => r.url)).toEqual(["/x?per_page=100", "/x?per_page=100&page=2"]);
  });

  it("adds its page size to a query that is already there", async () => {
    w.gh.answer(/^GET \/x\?state=open&per_page=100$/, () => json([]));
    expect(await gh.paginate("/x?state=open", { token: "t" }, 1)).toEqual({ items: [], truncated: false });
  });

  it("is cut at the page limit, and says so", async () => {
    w.gh.answer(/^GET \/x/, () => json([1], link("/x?page=n")));
    expect(await gh.paginate("/x", { token: "t" }, 2)).toEqual({ items: [1, 1], truncated: true });
    expect(w.gh.requests).toHaveLength(2);
  });

  it("that ends at the page limit is whole", async () => {
    w.gh.answer(/^GET \/x\?per_page=100$/, () => json([1], link("/x?page=2")));
    w.gh.answer(/^GET \/x\?page=2$/, () => json([2]));
    expect(await gh.paginate("/x", { token: "t" }, 2)).toEqual({ items: [1, 2], truncated: false });
  });

  it("that fails on a page is an error, never a shorter list", async () => {
    w.gh.answer(/^GET \/x\?per_page=100$/, () => json([1], link("/x?page=2")));
    w.gh.answer(/^GET \/x\?page=2$/, () => new Response(null, { status: 502 }));
    expect((await failure(gh.paginate("/x", { token: "t" }, 3))).kind).toBe("transient");
  });
});

describe("the next page's link", () => {
  const next = `<${API}/x?page=2>; rel="next"`;

  it.each([
    [next, `${API}/x?page=2`],
    [`<${API}/x?page=1>; rel="prev", ${next}, <${API}/x?page=9>; rel="last"`, `${API}/x?page=2`],
    [`  <${API}/x> ;  rel="next"`, `${API}/x`],
    [`<${API}/a>; rel="next", <${API}/b>; rel="next"`, `${API}/a`],
    [`<https://evil.example/>; rel="next", <${API}/b>; rel="next"`, `${API}/b`],
    [`<${API}/x>;rel="next"`, `${API}/x`],
  ])("%j is %j", (header, url) => {
    expect(nextLink(header)).toBe(url);
  });

  it.each([null, "", `<${API}/x>; rel="last"`, `<${API}/x>; rel=next`, `${API}/x; rel="next"`, `<>; rel="next"`, `x <${API}/x>; rel="next"`, `<${API}/x>; title="y"; rel="next"`, `<<${API}/x>>; rel="next"`])("%j has none", (header) => {
    expect(nextLink(header)).toBeNull();
  });

  it.each(["https://evil.example/x", "https://api.github.com.evil.example/x", "https://api.github.comx/x", "http://api.github.com/x", "//api.github.com/x", "/x", API])("an address that is not GitHub's API is never followed: %s", (url) => {
    expect(nextLink(`<${url}>; rel="next"`)).toBeNull();
  });

  it("whatever the header says, it is null or an address of the API", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("<", ">", ";", ",", " ", 'rel="next"', API, "https://evil.example", "/x", '"'), { maxLength: 30 }), (pieces) => {
        const url = nextLink(pieces.join(""));
        if (url !== null) expect(url.startsWith(`${API}/`)).toBe(true);
      }),
      { seed: 31, numRuns: 2000 },
    );
  });
});

describe("the two ways to say no", () => {
  it("carry their reason and their place in the retry policy", () => {
    expect(new NotAllowedError("why")).toMatchObject({ reason: "why", message: "why" });
    expect(new GitHubError(403, "rate_limited", 5, "A1")).toMatchObject({ status: 403, kind: "rate_limited", retryAfter: 5, requestId: "A1", message: "GitHub 403 rate_limited", retryable: true });
  });
});
