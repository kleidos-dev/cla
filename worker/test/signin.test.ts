// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The identity-only sign-in (version 2 on): the signer signs in with an app
 * that has no permission at all, nothing is posted, and the Worker hands the
 * account and the signer's own token to record.yml, which checks them with
 * GitHub. And the switch: until the register makes a "signin" version
 * current and names the app whose secrets the Worker holds, the live
 * version 1 flow is exactly what it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/index";
import { isSignatureRecord, resetRegistryCache } from "../src/registry";
import { must } from "../src/util";
import { CLIENT_ID, SIGNIN_CLIENT_ID } from "./fakegh";
import type { User } from "./fakegh";
import type { World } from "./helpers";
import { Browser, CONFIG, CONFIG_V2, ORIGIN, SANDBOX, drain, openPr, prEvent, webhook, world } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const alice = { id: 123456, login: "alice", type: "User" as const };
const SENTENCE_V2 = CONFIG.versions["2"].sentence;

async function setup(w: World, opener: User = alice) {
  const pr = openPr(w, opener);
  await webhook(w, "pull_request", prEvent(pr, "opened"));
  await drain(w);
  return { pr, path: `/sign/${SANDBOX}/${pr.number}` };
}

async function healthz(w: World): Promise<Record<string, unknown>> {
  return (await handleFetch(new Request(`${ORIGIN}/healthz`), w.env)).json<Record<string, unknown>>();
}

describe("the switch to the sign-in flow", () => {
  it("with the sign-in secrets set but version 1 current, the live flow is unchanged: kleidos-cla signs in and posts the comment", async () => {
    const w = await world({ signinSecrets: true });
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);
    const { authorize } = await b.signIn(path);
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    const html = await (await b.get(path)).text();
    expect(html).toContain("Kleidos Addendum to the Contributor Agreement (version 1)");
    expect(html).toContain("The button posts the sentence above as a comment by @alice");
    const r = await b.post("/agree", { ...Browser.form(html), accept: "yes" });
    expect(r.status).toBe(303);
    expect(w.gh.comments.some((c) => c.repo === SANDBOX && c.pr === pr.number && c.user.id === alice.id && c.body === CONFIG.versions["1"].sentence)).toBe(true);
    expect(w.gh.dispatches.some((d) => d.kind === "signin")).toBe(false);
    expect(await healthz(w)).toMatchObject({ version: 1, flow: "comment", signing: true, signin_app: true });
  });

  it("with version 2 current, signing is paused until the sign-in app exists and the register names it", async () => {
    for (const [name, opts] of [
      ["no sign-in secrets", { config: CONFIG_V2 }],
      ["the register names no app", { config: { ...CONFIG_V2, signin_client_id: null }, signinSecrets: true }],
      ["the register names another app", { config: { ...CONFIG_V2, signin_client_id: "Iv23liSOMEOTHERAPP01" }, signinSecrets: true }],
    ] as const) {
      const w = await world(opts);
      const { path } = await setup(w);
      const b = new Browser(w, alice);
      const start = await (await b.get(path)).text();
      expect(start, name).toContain("signing is paused");
      expect(start, name).not.toContain("/auth/login");
      expect((await b.get(`/auth/login?return=${encodeURIComponent(path)}`)).status, name).toBe(503);
      expect(w.gh.codes.size, name).toBe(0);
      expect(await healthz(w), name).toMatchObject({ version: 2, flow: "signin", signing: false, reason: "the sign-in app is not configured" });
    }
  });

  it("a kleidos-cla sign-in made before the switch cannot sign after it", async () => {
    const w = await world({ signinSecrets: true });
    const { path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    const v1page = await (await b.get(path)).text();
    w.gh.setFile("main", "registry/config.json", JSON.stringify(CONFIG_V2));
    resetRegistryCache();
    // The old form names version 1: refused as changed, nothing posted or dispatched.
    const r = await b.post("/agree", { ...Browser.form(v1page), accept: "yes" });
    expect(r.status).toBe(401);
    const again = await (await b.get(path)).text();
    expect(again).toContain("Sign in with GitHub again to sign");
    expect(w.gh.comments.some((c) => c.user.id === alice.id)).toBe(false);
    expect(w.gh.dispatches.some((d) => d.kind === "signin")).toBe(false);
  });
});

describe("signing by signing in (version 2)", () => {
  it("end to end: the sign-in app identifies, nothing is posted, the recorder gets the account and the token, the record turns the check green", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);

    const start = await (await b.get(path)).text();
    expect(start).toContain("Sign in with GitHub to sign");
    expect(start).toContain("<strong>Kleidos CLA sign-in</strong>, by kleidos-dev: a separate app with no permission at all");
    expect(start).not.toContain("Act on your behalf");

    const { authorize, callback } = await b.signIn(path);
    expect(authorize.searchParams.get("client_id")).toBe(SIGNIN_CLIENT_ID);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(callback.status).toBe(303);

    const html = await (await b.get(path)).text();
    expect(html).toContain("Kleidos Addendum to the Contributor Agreement (version 2)");
    expect(html).toContain("1.5 When the Agreement is accepted electronically, &quot;You&quot; is the holder of the GitHub account with which the acceptance is made");
    expect(html).toContain('<label for="accept-box" lang="en">' + SENTENCE_V2.replaceAll("'", "&#39;") + "</label>");
    expect(html).toContain("The button records in the public register that @alice accepts the sentence above. That confirmation is your signature; nothing is posted on");
    expect(html).not.toContain("posts the sentence above as a comment");
    const form = Browser.form(html);
    expect(form.version).toBe("2");
    expect(form.set_sha256).toBe(CONFIG.versions["2"].set_sha256);

    const r = await b.post("/agree", { ...form, accept: "yes" });
    expect(r.status).toBe(303);
    // Nothing anywhere in the signer's name.
    expect(w.gh.comments.some((c) => c.user.id === alice.id)).toBe(false);
    expect(w.gh.comments.filter((c) => c.repo === SANDBOX && c.pr === pr.number).every((c) => c.user.type === "Bot")).toBe(true);
    const d = must(w.gh.dispatches.find((x) => x.kind === "signin"));
    const token = must([...w.gh.tokens.entries()].find(([, v]) => v.kind === "user" && v.app === "signin"))[0];
    expect(d).toEqual({ kind: "signin", repo: SANDBOX, pr: String(pr.number), github_id: String(alice.id), version: "2", lang: "en", site_commit: w.env.BUILD_COMMIT, signin_token: token });
    // The Worker leaves the grant to the recorder, which checks the token before it deletes it.
    expect(w.gh.revokedGrants).not.toContain(token);
    expect(w.queue.sent.some((m) => m.body.kind === "evaluate" && m.body.await_signin === alice.id)).toBe(true);

    const pending = await (await b.get(path)).text();
    expect(pending).toContain("Signed: being recorded");
    expect(pending).not.toContain("Acceptance comment");
    expect(pending).toContain("2 · SHA-256 <code>" + CONFIG.versions["2"].set_sha256 + "</code>");
    // The session forgot the token: a second click hands nothing over.
    expect((await b.post("/agree", { ...form, accept: "yes" })).status).toBe(401);
    expect(w.gh.dispatches.filter((x) => x.kind === "signin")).toHaveLength(1);

    await w.gh.recordSignin(alice);
    expect(w.gh.revokedGrants).toContain(token);
    await drain(w);
    expect(must(w.gh.check(SANDBOX, pr.head.sha)).conclusion).toBe("success");
    const done = await (await b.get(path)).text();
    expect(done).toContain("Signed and recorded");
    expect(done).toContain(`signatures/individual/${alice.id}.json`);
  });

  it("the evaluation keeps watching for the record of a sign-in, which leaves no comment to find", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    await b.post("/agree", { ...Browser.form(await (await b.get(path)).text()), accept: "yes" });
    const first = must(w.queue.sent.shift());
    expect(first.body).toMatchObject({ kind: "evaluate", await_signin: alice.id });
    w.queue.sent.length = 0;
    w.queue.sent.push(first);
    await drain(w, 1);
    expect(w.queue.sent.some((m) => m.body.kind === "evaluate" && m.body.await_signin === alice.id && m.body.attempt === 1 && m.delaySeconds === 20)).toBe(true);
    expect(must(w.gh.check(SANDBOX, pr.head.sha)).conclusion).toBe("action_required");
  });

  it("a recorder run that refused the sign-in is said plainly, and the signer can sign in again", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    await b.post("/agree", { ...Browser.form(await (await b.get(path)).text()), accept: "yes" });
    w.gh.recordRuns.push({ display_title: `Record signin ${SANDBOX}#${pr.number} ${alice.id}`, created_at: new Date().toISOString(), status: "in_progress", conclusion: null, head_branch: "main" });
    expect(await (await b.get(path)).text()).toContain("Signed: being recorded");
    must(w.gh.recordRuns[0]).status = "completed";
    must(w.gh.recordRuns[0]).conclusion = "failure";
    const failed = await (await b.get(path)).text();
    expect(failed).toContain("Your acceptance could not be recorded");
    expect(failed).toContain("Sign in with GitHub again to sign");
    // A run for another account or pull request says nothing about this one.
    expect((await (await b.get(path)).text())).not.toContain("Signed: being recorded");
  });

  it("when the recorder cannot be dispatched, nothing is recorded, the grant is revoked and the session ends", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    const form = Browser.form(await (await b.get(path)).text());
    w.gh.failNext = { match: /^POST \/repos\/kleidos-dev\/cla\/actions\/workflows\/record\.yml\/dispatches$/, status: 500 };
    const r = await b.post("/agree", { ...form, accept: "yes" });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("nothing was recorded");
    expect(w.gh.revokedGrants.length).toBeGreaterThan(0);
    expect(b.jar.has("__Host-cla")).toBe(false);
  });

  it("a sign-in token reaches nothing: it cannot post on the pull request", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { pr, path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    const token = must([...w.gh.tokens.entries()].find(([, v]) => v.kind === "user" && v.app === "signin"))[0];
    const res = await fetch(`https://api.github.com/repos/${SANDBOX}/issues/${pr.number}/comments`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ body: "x" }) });
    expect(res.status).toBe(403);
  });

  it("not signing (sign-out, not an author) revokes the sign-in app's own grant", async () => {
    const w = await world({ config: CONFIG_V2, signinSecrets: true });
    const { path } = await setup(w);
    const b = new Browser(w, alice);
    await b.signIn(path);
    const html = await (await b.get(path)).text();
    const csrf = must(must(/action="\/auth\/logout"><input type="hidden" name="csrf" value="([^"]+)"/.exec(html))[1]);
    const before = w.gh.revokedGrants.length;
    expect((await b.post("/auth/logout", { csrf })).status).toBe(303);
    expect(w.gh.revokedGrants.length).toBeGreaterThan(before);
    expect(w.gh.requests.some((q) => q.method === "DELETE" && q.url === `/applications/${SIGNIN_CLIENT_ID}/grant`)).toBe(true);
    const mallory = new Browser(w, { id: 666666, login: "mallory", type: "User" });
    await mallory.signIn(path);
    expect(w.gh.requests.filter((q) => q.method === "DELETE" && q.url === `/applications/${SIGNIN_CLIENT_ID}/grant`)).toHaveLength(2);
  });
});

describe("the schema 2 record", () => {
  const rec = {
    schema: 2,
    kind: "individual",
    github_id: 123456,
    login_at_signing: "alice",
    agreement: "kleidos-ca",
    version: 2,
    set_sha256: "a".repeat(64),
    sentence_sha256: "b".repeat(64),
    accepted_at: "2026-12-01T10:22:58Z",
    method: "signin",
    evidence: { authorized_at: "2026-12-01T10:22:31Z", signin_client_id: SIGNIN_CLIENT_ID, context_pr_url: `https://github.com/${SANDBOX}/pull/7`, site_commit: "0".repeat(40), lang: "es" },
    recorded_at: "2026-12-01T10:23:02Z",
    recorder_run_id: 1,
    recorder_commit: "c".repeat(40),
  };

  it("has the exact shape registry/cla.py checks", () => {
    expect(isSignatureRecord(rec, 123456)).toBe(true);
    expect(isSignatureRecord(rec, 1)).toBe(false);
    expect(isSignatureRecord({ ...rec, ip: "203.0.113.7" }, 123456)).toBe(false);
    expect(isSignatureRecord({ ...rec, method: "web" }, 123456)).toBe(false);
    expect(isSignatureRecord({ ...rec, recorder_commit: "main" }, 123456)).toBe(false);
    expect(isSignatureRecord({ ...rec, evidence: { ...rec.evidence, lang: "fr" } }, 123456)).toBe(false);
    expect(isSignatureRecord({ ...rec, evidence: { ...rec.evidence, token: "ghu_x" } }, 123456)).toBe(false);
  });
});
