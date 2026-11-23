// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_ID, commit } from "./fakegh";
import type { User } from "./fakegh";
import type { World } from "./helpers";
import { handleFetch } from "../src/index";
import { Browser, CONFIG, ORIGIN, SANDBOX, drain, openPr, prEvent, webhook, world } from "./helpers";
import { must } from "../src/util";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const alice = { id: 123456, login: "alice", type: "User" as const };
const bob = { id: 234567, login: "bob", type: "User" as const };
const mallory = { id: 666666, login: "mallory", type: "User" as const };
const org = { id: 777777, login: "some-org", type: "Organization" as const };
const SENTENCE = CONFIG.versions["1"].sentence;

async function setup(w: World, opener: User = alice, extra: Partial<Parameters<typeof openPr>[2]> = {}) {
  const pr = openPr(w, opener, extra);
  await webhook(w, "pull_request", prEvent(pr, "opened"));
  await drain(w);
  return { pr, path: `/sign/${SANDBOX}/${pr.number}` };
}

async function signedInPage(b: Browser, path: string) {
  const { callback } = await b.signIn(path);
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe(`${path}?lang=en`);
  const page = await b.get(path);
  return { page, html: await page.text() };
}

describe("web signing", () => {
  it("end to end: read signed out, sign in, agree, the comment is the signer's, the record turns the check green and releases CI", async () => {
    const w = await world();
    const { pr, path } = await setup(w);
    const run = { id: w.gh.next(), repo: SANDBOX, head_sha: pr.head.sha, head_repository: pr.head.repo, status: "action_required", approved: false };
    w.gh.runs.push(run);
    const b = new Browser(w, alice);

    const out = await b.get(path);
    expect(out.status).toBe(200);
    const outHtml = await out.text();
    // Step 1: signing in is not signing, and no legal text is shown before it.
    expect(outHtml).toContain("Step 1 of 2 · Sign in");
    expect(outHtml).toContain("<strong>Nothing is signed yet.</strong>");
    expect(outHtml).toContain(`<a class="btn btn-primary btn-block" href="/auth/login?return=${encodeURIComponent(path)}&amp;lang=en">Sign in with GitHub to sign</a>`);
    expect(outHtml).toContain('<span class="eyebrow">Still to sign</span><span>@alice</span>');
    expect(outHtml).not.toContain("Individual Contributor Non-Exclusive License Agreement");
    expect(outHtml).not.toContain("Kleidos Addendum to the Contributor Agreement");
    expect(outHtml).not.toContain(SENTENCE.replaceAll("'", "&#39;"));
    expect(outHtml).not.toContain('action="/agree'); 

    const { authorize, callback } = await b.signIn(path);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(callback.status).toBe(303);
    const exchange = w.gh.requests.find((r) => r.url === "/login/oauth/access_token");
    expect(exchange).toBeTruthy();

    const page = await b.get(path);
    const html = await page.text();
    // Step 2: the summary, the box and the button first, the full text in a fold after them.
    expect(html).toContain("Step 2 of 2 · Accept");
    expect(html).toContain("<strong>Not signed yet:</strong> you sign with the button below.");
    expect(html).toContain("Signed in as <strong>@alice</strong>");
    expect(html).toContain('action="/agree#accept" novalidate>');
    expect(html).not.toMatch(/\srequired[\s>]/);
    expect(html).toContain('<label for="accept-box" lang="en">' + SENTENCE.replaceAll("'", "&#39;") + "</label>");
    const button = html.indexOf(">I agree and sign</button>");
    expect(button).toBeGreaterThan(0);
    expect(html.indexOf('<details class="fold" id="text">')).toBeGreaterThan(button);
    expect(html.indexOf("Individual Contributor Non-Exclusive License Agreement")).toBeGreaterThan(button);
    expect(html).toContain("Kleidos Addendum to the Contributor Agreement (version 1)");
    const form = Browser.form(html);
    expect(form.set_sha256).toBe(CONFIG.versions["1"].set_sha256);

    const agreed = await b.post("/agree", { ...form, accept: "yes" });
    expect(agreed.status).toBe(303);
    expect(agreed.headers.get("location")).toBe(`${path}?lang=en`);
    const acceptance = must(w.gh.comments.find((c) => c.repo === SANDBOX && c.pr === pr.number && c.user.id === alice.id));
    expect(acceptance.body).toBe(SENTENCE);
    expect(acceptance.via_app).toBe(true);
    expect(w.gh.revokedGrants.length).toBeGreaterThan(0);
    expect([...w.gh.tokens.values()].filter((t) => t.kind === "user" && !t.revoked)).toHaveLength(0);
    expect(w.queue.sent.map((s) => s.body)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: pr.number, record_comment: acceptance.id }]);

    // No automatic refresh (WCAG 2.2.1): a "Check again" link instead.
    const pending = await b.get(path);
    expect(pending.headers.get("refresh")).toBeNull();
    const pendingHtml = await pending.text();
    expect(pendingHtml).toContain("Done · Signed");
    expect(pendingHtml).toContain("<strong>Signed.</strong> Being recorded in the public register");
    expect(pendingHtml).toContain(`<a href="${path}?lang=en">Check now</a>`);

    await drain(w, 1);
    expect(w.gh.dispatches).toEqual([{ kind: "sign", repo: SANDBOX, pr: String(pr.number), comment_id: String(acceptance.id) }]);
    expect(must(w.gh.check(SANDBOX, pr.head.sha)).conclusion).toBe("action_required");
    await w.gh.record(acceptance.id);
    await drain(w);
    expect(must(w.gh.check(SANDBOX, pr.head.sha)).conclusion).toBe("success");
    const bot = w.gh.botComments(SANDBOX, pr.number);
    expect(bot).toHaveLength(1);
    expect(must(bot[0]).body).toContain("**Contributor Agreement signed.**");
    expect(must(bot[0]).body).toContain(`[![Kleidos Contributor Agreement signed by its author](https://cla.kleidos.dev/button/v2/signed-1-1.svg)](https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number})`);
    expect(must(bot[0]).body).toContain(`/blob/${w.gh.recordCommits.get(alice.id)}/signatures/individual/123456.json`);
    expect(run.approved).toBe(true);

    const done = await b.get(path);
    expect(done.headers.get("refresh")).toBeNull();
    const doneHtml = await done.text();
    expect(doneHtml).toContain("signatures/individual/123456.json</a>");
    expect(doneHtml).toContain('<p class="status is-done">Recorded</p>');
    expect(doneHtml).toContain(`>Back to the pull request</a>`);
  });

  it("a later pull request of a signer is green from the first event, with no comment", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const { pr, path } = await setup(w);
    expect(must(w.gh.check(SANDBOX, pr.head.sha)).conclusion).toBe("success");
    expect(w.gh.botComments(SANDBOX, pr.number)).toHaveLength(0);
    const b = new Browser(w, alice);
    const { html } = await signedInPage(b, path);
    expect(html).toContain("You accepted version 1");
    expect(html).not.toContain('action="/agree"');
    expect(w.gh.revokedGrants.length).toBeGreaterThan(0);
  });

  it("signing as another account is refused: a stranger to the pull request cannot post an acceptance on it", async () => {
    const w = await world();
    const { pr, path } = await setup(w);
    const m = new Browser(w, mallory);
    const { html } = await signedInPage(m, path);
    expect(html).toContain("@mallory is not listed as an author of this pull request");
    expect(html).not.toContain('action="/agree"');
    expect(w.gh.revokedGrants.length).toBeGreaterThan(0);

    const a = new Browser(w, alice);
    const aliceForm = Browser.form((await signedInPage(a, path)).html);
    const r = await m.post("/agree", { ...aliceForm, accept: "yes" });
    expect(r.status).toBe(403);
    expect(w.gh.comments.filter((c) => c.pr === pr.number && c.user.id !== BOT_ID)).toHaveLength(0);
  });

  it("the CSRF token is bound to the session, the pull request and the version", async () => {
    const w = await world();
    const { pr, path } = await setup(w, alice, { commits: [commit(alice), commit(bob)] });
    const { pr: pr2 } = await setup(w, alice);
    const a = new Browser(w, alice);
    const form = Browser.form((await signedInPage(a, path)).html);
    const b = new Browser(w, bob);
    await signedInPage(b, path);
    expect((await b.post("/agree", { ...form, accept: "yes" })).status).toBe(403);
    expect((await a.post("/agree", { ...form, pr: String(pr2.number), accept: "yes" })).status).toBe(403);
    expect((await a.post("/agree", { ...form, version: "2", accept: "yes" })).status).toBe(403);
    expect((await a.post("/agree", { ...form, csrf: "A".repeat(43), accept: "yes" })).status).toBe(403);
    expect((await a.post("/agree", { ...form })).status).toBe(400);
    expect((await a.post("/agree", { ...form, set_sha256: "0".repeat(64), accept: "yes" })).status).toBe(409);
    expect(w.gh.comments.filter((c) => (c.pr === pr.number || c.pr === pr2.number) && c.user.id !== BOT_ID)).toHaveLength(0);
    expect((await a.post("/agree", { ...form, accept: "yes" })).status).toBe(303);
  });

  it("a cross-site post, a wrong content type or a tampered or missing cookie posts nothing", async () => {
    const w = await world();
    const { pr, path } = await setup(w);
    const a = new Browser(w, alice);
    const form = { ...Browser.form((await signedInPage(a, path)).html), accept: "yes" };
    expect((await a.post("/agree", form, { origin: "https://evil.example" })).status).toBe(403);
    expect((await a.post("/agree", form, { origin: "" })).status).toBe(403);
    expect((await a.post("/agree", form, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await a.post("/agree", form, { "content-type": "application/json" })).status).toBe(400);
    expect((await a.post("/agree", { ...form, pad: "x".repeat(5000) })).status).toBe(400);
    const good = must(a.jar.get("__Host-cla"));
    a.jar.set("__Host-cla", good.slice(0, -2) + (good.endsWith("A") ? "BB" : "AA"));
    expect((await a.post("/agree", form)).status).toBe(401);
    a.jar.set("__Host-cla", good.slice(0, 40));
    expect((await a.post("/agree", form)).status).toBe(401);
    a.jar.delete("__Host-cla");
    expect((await a.post("/agree", form)).status).toBe(401);
    expect(w.gh.comments.filter((c) => c.pr === pr.number && c.user.id !== BOT_ID)).toHaveLength(0);
  });

  it("an expired session cannot sign", async () => {
    const w = await world();
    const { path } = await setup(w);
    const a = new Browser(w, alice);
    const form = { ...Browser.form((await signedInPage(a, path)).html), accept: "yes" };
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601 * 1000);
    expect((await a.post("/agree", form)).status).toBe(401);
  });

  it("OAuth state: a mismatch, a missing or expired transaction cookie and a replayed callback are refused", async () => {
    const w = await world();
    const { path } = await setup(w);
    const a = new Browser(w, alice);
    const login = await a.get(`/auth/login?return=${encodeURIComponent(path)}`);
    const authorize = new URL(must(login.headers.get("location")));
    const code = w.gh.issueCode(alice, must(authorize.searchParams.get("code_challenge")));
    // A stray redirect (a wrong state, or a cross-site ?error=) refuses, but leaves the sign-in in progress intact.
    const wrong = await a.get(`/auth/callback?code=${code}&state=${"x".repeat(43)}`);
    expect(wrong.status).toBe(400);
    expect(a.jar.has("__Host-cla")).toBe(false);
    expect(a.jar.has("__Host-cla-oauth")).toBe(true);
    expect((await a.get(`/auth/callback?error=access_denied&state=${"y".repeat(43)}`)).status).toBe(400);
    expect(a.jar.has("__Host-cla-oauth")).toBe(true);
    const genuine = await a.get(`/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
    expect(genuine.status).toBe(303);
    expect(a.jar.has("__Host-cla")).toBe(true);

    const attacker = new Browser(w, mallory);
    const { callbackUrl } = await attacker.signIn(path);
    const victim = new Browser(w, alice);
    const forced = await victim.get(callbackUrl);
    expect(forced.status).toBe(400);
    expect(victim.jar.has("__Host-cla")).toBe(false);

    const replay = new Browser(w, alice);
    const login2 = await replay.get(`/auth/login?return=${encodeURIComponent(path)}`);
    const saved = must(replay.jar.get("__Host-cla-oauth"));
    const auth2 = new URL(must(login2.headers.get("location")));
    const code2 = w.gh.issueCode(alice, must(auth2.searchParams.get("code_challenge")));
    const url2 = `/auth/callback?code=${code2}&state=${auth2.searchParams.get("state")}`;
    expect((await replay.get(url2)).status).toBe(303);
    replay.jar.clear();
    replay.jar.set("__Host-cla-oauth", saved);
    const again = await replay.get(url2);
    expect(again.status).toBe(400);
    expect(replay.jar.has("__Host-cla")).toBe(false);

    const late = new Browser(w, alice);
    const login3 = await late.get(`/auth/login?return=${encodeURIComponent(path)}`);
    const auth3 = new URL(must(login3.headers.get("location")));
    const code3 = w.gh.issueCode(alice, must(auth3.searchParams.get("code_challenge")));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601 * 1000);
    expect((await late.get(`/auth/callback?code=${code3}&state=${auth3.searchParams.get("state")}`)).status).toBe(400);
  });

  it("a cancelled authorization signs nothing", async () => {
    const w = await world();
    const { path } = await setup(w);
    const a = new Browser(w, alice);
    const login = await a.get(`/auth/login?return=${encodeURIComponent(path)}`);
    const state = new URL(must(login.headers.get("location"))).searchParams.get("state");
    const r = await a.get(`/auth/callback?error=access_denied&state=${state}`);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Authorization cancelled");
  });

  it("the return path is refused unless it is exactly a served sign page", async () => {
    const w = await world();
    const { pr } = await setup(w);
    const a = new Browser(w, alice);
    for (const ret of ["https://evil.example/", "//evil.example/sign/kleidos-dev/cla-sandbox/1", `/sign/${SANDBOX}/${pr.number}/../../x`, `/sign/kleidos-dev%2Fcla-sandbox/${pr.number}`, "/sign/kleidos-dev/boards/1", `/sign/${SANDBOX}/0`, `/sign/${SANDBOX}/${pr.number}?x=1`, ""]) {
      const r = await a.get(`/auth/login?return=${encodeURIComponent(ret)}`);
      expect(r.status, ret).not.toBe(302);
      expect(r.headers.get("location")).toBeNull();
    }
    expect(a.jar.has("__Host-cla-oauth")).toBe(false);
  });

  it("an organization or bot account cannot sign", async () => {
    const w = await world();
    const { path } = await setup(w, org);
    const o = new Browser(w, org);
    const { html, page } = await signedInPage(o, path);
    expect(page.status).toBe(403);
    expect(html).toContain("Only a personal account can sign");
  });

  it("a closed or locked pull request cannot be signed on", async () => {
    const w = await world();
    const { pr, path } = await setup(w);
    const a = new Browser(w, alice);
    const form = { ...Browser.form((await signedInPage(a, path)).html), accept: "yes" };
    pr.locked = true;
    expect((await a.get(path)).status).toBe(409);
    expect((await a.post("/agree", form)).status).toBe(409);
    pr.locked = false;
    pr.state = "closed";
    expect((await a.post("/agree", form)).status).toBe(409);
    expect(w.gh.comments.filter((c) => c.pr === pr.number && c.user.id !== BOT_ID)).toHaveLength(0);
  });

  it("rate limits: /agree per account and per address", async () => {
    const w = await world();
    const { path } = await setup(w);
    const a = new Browser(w, alice);
    const form = { ...Browser.form((await signedInPage(a, path)).html), accept: "yes" };
    must(w.limiters.RL_AGREE_ACCOUNT).allow = false;
    expect((await a.post("/agree", form)).status).toBe(429);
    expect(must(w.limiters.RL_AGREE_ACCOUNT).keys).toEqual(["123456"]);
  });

  it("signing pauses on version skew between the registry and this deployment, checks keep working", async () => {
    const w = await world();
    const cfg = structuredClone(CONFIG) as typeof CONFIG & { current_version: number };
    cfg.current_version = 2;
    (cfg.versions as Record<string, unknown>)["2"] = { ...cfg.versions["1"], set_sha256: "f".repeat(64), path: "agreements/v2" };
    cfg.accepted_versions = [1, 2];
    w.gh.setFile("main", "registry/config.json", JSON.stringify(cfg));
    const { pr, path } = await setup(w);
    expect(must(w.gh.check(SANDBOX, pr.head.sha)).conclusion).toBe("action_required");
    const a = new Browser(w, alice);
    const { html } = await signedInPage(a, path);
    expect(html).toContain("signing is paused");
    expect(html).not.toContain('action="/agree"');
  });

  it("logout needs the CSRF token and revokes the grant", async () => {
    const w = await world();
    const { path } = await setup(w);
    const a = new Browser(w, alice);
    const { html } = await signedInPage(a, path);
    expect((await a.post("/auth/logout", { csrf: "nope" })).status).toBe(403);
    const csrf = must(must(/action="\/auth\/logout"><input type="hidden" name="csrf" value="([^"]+)"/.exec(html))[1]);
    const before = w.gh.revokedGrants.length;
    const r = await a.post("/auth/logout", { csrf });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/agreement?lang=en");
    expect(a.jar.has("__Host-cla")).toBe(false);
    expect(w.gh.revokedGrants.length).toBeGreaterThan(before);
  });

  it("until the secrets exist only the public texts are served", async () => {
    const w = await world({ configure: false });
    const a = new Browser(w, alice);
    expect((await a.get("/agreement")).status).toBe(200);
    expect((await a.get("/privacy")).status).toBe(200);
    expect((await a.get("/healthz")).status).toBe(200);
    expect((await a.get(`/sign/${SANDBOX}/1`)).status).toBe(503);
    expect((await a.get(`/auth/login?return=/sign/${SANDBOX}/1`)).status).toBe(503);
    expect(await (await a.get("/agreement")).text()).toContain("The CLA bot is not configured yet");
    expect(await (await a.get("/agreement?lang=es")).text()).toContain("El bot del CLA aún no está configurado");
    const hook = await handleFetch(new Request(`${ORIGIN}/webhook`, { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "0123456789ab" }, body: "{}" }), w.env);
    expect(hook.status).toBe(401);
    expect(w.queue.sent).toHaveLength(0);
  });

  it("once configured the pages carry no not-configured notice", async () => {
    const w = await world();
    const a = new Browser(w, alice);
    expect(await (await a.get("/agreement")).text()).not.toContain("not configured yet");
    expect(await (await a.get("/agreement?lang=es")).text()).not.toContain("aún no está configurado");
  });
});
