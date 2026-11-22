// SPDX-License-Identifier: MIT
// The cases of the 2026-11-22 reviews: each one failed, or could not be
// written, before its fix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cron, makeBot } from "../src/bot";
import type { ConfiguredEnv } from "../src/env";
import { allowedAccounts, isConfigured } from "../src/env";
import { normalizeSentence } from "../src/util";
import { APP_ID, BOT_ID, ORG_ID, commit, sha } from "./fakegh";
import type { FakePr } from "./fakegh";
import type { World } from "./helpers";
import { Browser, CONFIG, ORIGIN, SANDBOX, drain, openPr, prEvent, sign, webhook, world } from "./helpers";
import vectors from "../../registry/tests/normalize-vectors.json";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const alice = { id: 123456, login: "alice", type: "User" as const };
const bob = { id: 234567, login: "bob", type: "User" as const };
const mallory = { id: 666666, login: "mallory", type: "User" as const };
const REGISTRY = "kleidos-dev/cla";

async function opened(w: World, pr: FakePr, action = "opened") {
  expect((await webhook(w, "pull_request", prEvent(pr, action))).status).toBe(202);
  return drain(w);
}

function heldRun(w: World, pr: FakePr, jobs?: { labels: string[]; runner_group_name?: string | null }[]) {
  const run = { id: w.gh.next(), repo: pr.repo, head_sha: pr.head.sha, head_repository: pr.head.repo, status: "action_required", approved: false, ...(jobs ? { jobs } : {}) };
  w.gh.runs.push(run);
  return run;
}

function successCheck(w: World, pr: FakePr, headSha = pr.head.sha) {
  w.gh.checkRuns.push({ id: w.gh.next(), repo: pr.repo, head_sha: headSha, name: "📝 CLA", app_id: APP_ID, conclusion: "success", title: "", summary: "", details_url: "", external_id: "" });
}

describe("the .github/ exception and the head are pinned to one commit", () => {
  it("release decides from the commit it approves, not from the pull request's live files", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    const a = pr.head.sha;
    // Commit A changes .github/; by the time the live file list would be read, the head shows clean files.
    w.gh.githubTrees.set(a, "e".repeat(40));
    successCheck(w, pr);
    const run = heldRun(w, pr);
    w.queue.sent.push({ body: { kind: "release", repo: SANDBOX, pr: pr.number, sha: a } });
    await drain(w);
    expect(run.approved).toBe(false);
    expect(w.gh.requests.some((r) => r.url.includes("/files"))).toBe(false);
  });

  it("a head that moves while the commits are read writes no check on the old head", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { commits: [commit(alice), commit(bob)] });
    const a = pr.head.sha;
    let flipped = false;
    w.gh.onRequest = (method, path) => {
      if (!flipped && method === "POST" && path === "/graphql") {
        flipped = true;
        pr.head.sha = sha();
        pr.commits = [commit(alice)];
      }
    };
    const run = heldRun(w, { ...pr, head: { ...pr.head, sha: a } });
    await webhook(w, "pull_request", prEvent(pr, "opened"));
    await drain(w, 1);
    expect(w.gh.check(SANDBOX, a)).toBeUndefined();
    expect(w.queue.sent.map((s) => s.body)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: pr.number }]);
    expect(run.approved).toBe(false);
    w.gh.onRequest = null;
    await drain(w);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
    expect(w.gh.check(SANDBOX, a)).toBeUndefined();
  });

  it("a .github/ state that cannot be read is worded as such and approves nothing", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    const run = heldRun(w, pr);
    w.gh.failNext = { match: /GET \/repos\/.+\/compare\//, status: 404 };
    await opened(w, pr);
    const check = w.gh.check(SANDBOX, pr.head.sha)!;
    expect(check.conclusion).toBe("success");
    expect(check.summary).toContain("could not be checked automatically");
    expect(check.summary).not.toContain("changes files under");
    expect(run.approved).toBe(false);
  });

  it("held runs that may target a self-hosted runner are not approved", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    const bench = heldRun(w, pr, [{ labels: ["self-hosted", "bench"] }]);
    const custom = heldRun(w, pr, [{ labels: ["bench-stick"] }]);
    const hosted = heldRun(w, pr, [{ labels: ["ubuntu-latest"] }]);
    await opened(w, pr);
    expect(bench.approved).toBe(false);
    expect(custom.approved).toBe(false);
    expect(hosted.approved).toBe(true);
  });
});

describe("who must sign", () => {
  it("GitHub lists 250 commits at most: 101 are paged, 250 are complete, 251 cannot be checked", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const many = (n: number, last = alice) => [...Array.from({ length: n - 1 }, () => commit(alice)), commit(last)];
    const p101 = openPr(w, alice, { commits: many(101, bob) });
    await opened(w, p101);
    expect(w.gh.check(SANDBOX, p101.head.sha)!.title).toBe("1 signature needed");
    const p250 = openPr(w, alice, { commits: many(250) });
    await opened(w, p250);
    expect(w.gh.check(SANDBOX, p250.head.sha)!.conclusion).toBe("success");
    // Commit 251 is bob's and GitHub never lists it.
    const p251 = openPr(w, alice, { commits: many(251, bob) });
    await opened(w, p251);
    const check = w.gh.check(SANDBOX, p251.head.sha)!;
    expect(check.conclusion).toBe("action_required");
    expect(check.summary).toContain("Too many commits");
  });

  it("a merge commit's author must sign like any other", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { commits: [commit(alice), commit(bob, { merge: true })] });
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.title).toBe("1 signature needed");
  });

  it("the opener is dated by the pull request's creation, as the recorder does", async () => {
    const w = await world();
    w.gh.setFile("main", "registry/entities.json", JSON.stringify({ schema: 1, entities: [{ slug: "e", name: "Example GmbH", version: 1, set_sha256: CONFIG.versions["1"].set_sha256, signed_at: "2026-11-01", covered: [{ github_id: bob.id, from: "2026-11-01", until: "2026-11-10" }] }] }));
    const pr = openPr(w, bob, { commits: [commit(bob, { date: "2026-11-05T10:00:00Z" })] });
    pr.created_at = "2026-11-06T09:00:00Z";
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
  });

  it("a twin pull request on the same head blocks the check only while it is open", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
    const twin = openPr(w, mallory, { commits: pr.commits });
    twin.head.sha = pr.head.sha;
    await opened(w, twin);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
    twin.state = "closed";
    await opened(w, twin, "closed");
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
  });

  it("a record whose last commit is not the recorder's, or that is malformed, does not count", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    w.gh.forgedRecords.add(alice.id);
    const pr = openPr(w, alice);
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");

    await w.gh.signDirectly(bob);
    const rec = JSON.parse(w.gh.files.get(`signatures:signatures/individual/${bob.id}.json`)!) as Record<string, unknown>;
    rec.accepted_at = "**now** [x](https://evil.example)";
    w.gh.setFile("signatures", `signatures/individual/${bob.id}.json`, JSON.stringify(rec));
    const pr2 = openPr(w, bob);
    await opened(w, pr2);
    expect(w.gh.check(SANDBOX, pr2.head.sha)!.conclusion).toBe("action_required");
    expect(w.gh.botComments(SANDBOX, pr2.number)[0]!.body).not.toContain("evil.example");
  });

  it("one recorder run per account and evaluation, however many acceptances it posted", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    for (let i = 0; i < 3; i++) w.gh.comments.push({ id: w.gh.next(), repo: SANDBOX, pr: pr.number, body: CONFIG.versions["1"].sentence, user: alice, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", via_app: false });
    await opened(w, pr);
    expect(w.gh.dispatches.filter((d) => d.kind === "sign")).toHaveLength(1);
  });
});

describe("texts", () => {
  it("where auto_approve is false the comment never promises that the checks start by themselves", async () => {
    const w = await world();
    const pr = openPr(w, alice, { repo: REGISTRY });
    await opened(w, pr);
    const needed = w.gh.botComments(REGISTRY, pr.number)[0]!.body;
    expect(needed).toContain("and a maintainer starts the checks.");
    expect(needed).not.toContain("start by themselves");
    await w.gh.signDirectly(alice);
    await opened(w, pr, "reopened");
    const accepted = w.gh.botComments(REGISTRY, pr.number)[0]!.body;
    expect(accepted).toContain("### 📝 Contributor Agreement accepted");
    expect(accepted).toContain("started by a maintainer, not automatically");
    expect(accepted).not.toContain("run by themselves");
    expect(w.gh.check(REGISTRY, pr.head.sha)!.summary).toContain("started by a maintainer");
  });

  it("the Spanish pages carry Spanish chrome, and English parts are marked", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    const html = await (await b.get("/agreement/es")).text();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Saltar al contenido");
    expect(html).toContain(">Privacidad</a>");
    expect(html).toContain('lang="en">Kleidos Contributor Agreement</a>');
    expect(html).not.toContain(">Register and source<");
  });

  it("the TypeScript and Python normalisations agree on the shared vectors", () => {
    for (const v of vectors.vectors) expect(normalizeSentence(v.in), JSON.stringify(v.in)).toBe(v.out);
  });
});

describe("signing", () => {
  async function signedIn(w: World, user = alice) {
    const pr = openPr(w, user);
    await opened(w, pr);
    const path = `/sign/${SANDBOX}/${pr.number}`;
    const b = new Browser(w, user);
    await b.signIn(path);
    const form = Browser.form(await (await b.get(path)).text());
    return { pr, path, b, form };
  }

  it("a browser's `Origin: null` is refused (it is what no-referrer would have sent)", async () => {
    const w = await world();
    const { pr, b, form } = await signedIn(w);
    expect((await b.post("/agree", { ...form, accept: "yes" }, { origin: "null" })).status).toBe(403);
    expect(w.gh.comments.filter((c) => c.pr === pr.number && c.user.id !== BOT_ID)).toHaveLength(0);
  });

  it("an edited or deleted acceptance ends the confirmation page and lets the signer sign again", async () => {
    for (const how of ["edited", "deleted"] as const) {
      const w = await world();
      const { pr, path, b, form } = await signedIn(w);
      expect((await b.post("/agree", { ...form, accept: "yes" })).status).toBe(303);
      await drain(w);
      const c = w.gh.comments.find((x) => x.pr === pr.number && x.user.id === alice.id)!;
      if (how === "edited") c.updated_at = "2099-01-01T00:00:00Z";
      else w.gh.comments = w.gh.comments.filter((x) => x !== c);
      const res = await b.get(path);
      const html = await res.text();
      expect(html, how).toContain("was edited or deleted, so it cannot be recorded");
      expect(html, how).toContain("Sign in with GitHub again to accept");
      expect(html, how).not.toContain("You accepted the Kleidos Contributor Agreement.");
      // The pending acceptance is gone from the cookie: the next visit is the ordinary sign page.
      expect(await (await b.get(path)).text(), how).not.toContain("was edited or deleted");
    }
  });

  it("a second submission confirms the first acceptance and posts nothing more", async () => {
    const w = await world();
    const { pr, path, b, form } = await signedIn(w);
    const cookie = b.jar.get("__Host-cla")!;
    expect((await b.post("/agree", { ...form, accept: "yes" })).status).toBe(303);
    // The same form again, with the session it was posted with (the grant is now revoked).
    b.jar.set("__Host-cla", cookie);
    const again = await b.post("/agree", { ...form, accept: "yes" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(path);
    expect(w.gh.comments.filter((c) => c.pr === pr.number && c.user.id === alice.id)).toHaveLength(1);
    expect(await (await b.get(path)).text()).toContain("You accepted the Kleidos Contributor Agreement.");
  });

  it("a form body without Content-Length is still capped", async () => {
    const w = await world();
    const { b } = await signedIn(w);
    const { handleFetch } = await import("../src/index");
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024)));
        c.close();
      },
    });
    const r = await handleFetch(new Request(`${ORIGIN}/agree`, { method: "POST", headers: { cookie: b.cookieHeader(), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: big, duplex: "half" } as RequestInit), w.env);
    expect(r.status).toBe(400);
  });

  it("the logs carry no account id", async () => {
    const w = await world();
    const { b, form } = await signedIn(w);
    await b.post("/agree", { ...form, accept: "yes" });
    await drain(w);
    for (const line of w.logs) expect(line).not.toContain(String(alice.id));
  });

  it("an unknown route under /agreement/v1/ is not served, prototype names included", async () => {
    const w = await world();
    const b = new Browser(w, alice);
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) expect((await b.get(`/agreement/v1/${name}`)).status, name).toBe(404);
  });
});

describe("webhook and cron", () => {
  it("a chunked webhook body past the cap is refused without being read whole", async () => {
    const w = await world();
    const { handleFetch } = await import("../src/index");
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        if (sent++ > 64) c.close();
        else c.enqueue(chunk);
      },
    });
    const r = await handleFetch(new Request(`${ORIGIN}/webhook`, { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "abcdef12-0000", "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body, duplex: "half" } as RequestInit), w.env);
    expect(r.status).toBe(413);
    expect(sent).toBeLessThan(40);
  });

  it("signed deliveries are limited per installation, unsigned ones per address", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    await webhook(w, "pull_request", prEvent(pr, "opened"));
    await webhook(w, "pull_request", prEvent(pr, "opened"), { signature: await sign("wrong", "{}") });
    expect(w.limiters.RL_WEBHOOK!.keys).toEqual(["installation:1", "ip:unknown"]);
  });

  it("a Record run that lands after the last delayed re-check turns the check green at once", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    await opened(w, pr);
    const c = { id: w.gh.next(), repo: SANDBOX, pr: pr.number, body: CONFIG.versions["1"].sentence, user: alice, created_at: new Date().toISOString().slice(0, 19) + "Z", updated_at: new Date().toISOString().slice(0, 19) + "Z", via_app: true };
    w.gh.comments.push(c);
    await w.gh.record(c.id);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
    const run = { event: "workflow_dispatch", path: ".github/workflows/record.yml", head_branch: "main", conclusion: "success", display_title: `Record sign ${SANDBOX}#${pr.number} ${c.id}` };
    await webhook(w, "workflow_run", { action: "completed", workflow_run: run, repository: { full_name: REGISTRY, owner: { id: ORG_ID } }, installation: { id: 1 } });
    await drain(w);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
  });

  it("a check re-run on a fork pull request (no pull_requests in the payload) re-evaluates it", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    const repoId = 77;
    await webhook(w, "check_run", { action: "rerequested", check_run: { name: "📝 CLA", app: { id: APP_ID }, external_id: `${repoId}#${pr.number}`, pull_requests: [] }, repository: { full_name: SANDBOX, id: repoId, owner: { id: ORG_ID } } });
    expect(w.queue.sent.map((s) => s.body)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: pr.number }]);
  });

  it("an empty or unparsable allowlist removes nothing", async () => {
    for (const ids of ["", " ", "abc", "0", "-1"]) {
      const w = await world();
      w.env.ALLOWED_ACCOUNT_IDS = ids;
      w.gh.installations.set(66, { account: 4242 });
      expect(isConfigured(w.env), ids).toBe(false);
      expect(() => allowedAccounts(w.env)).toThrow();
      await expect(cron(makeBot(w.env as ConfiguredEnv))).rejects.toThrow();
      w.queue.sent.push({ body: { kind: "installation", installation: 1 } }, { body: { kind: "installation", installation: 66 } });
      await drain(w);
      expect(w.gh.deletedInstallations, ids).toEqual([]);
    }
  });

  it("the cron re-dispatches the coverage of a merged pull request that has none", async () => {
    const w = await world();
    w.gh.setFile("main", "registry/config.json", JSON.stringify({ ...CONFIG, coverage_from: "2026-01-01" }));
    const merged = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const a = openPr(w, alice);
    Object.assign(a, { state: "closed", merged: true, merged_at: merged });
    const b = openPr(w, alice);
    Object.assign(b, { state: "closed", merged: true, merged_at: merged });
    const fresh = openPr(w, alice);
    Object.assign(fresh, { state: "closed", merged: true, merged_at: new Date().toISOString() });
    w.gh.setFile("signatures", `coverage/${SANDBOX}/${b.number}.json`, "{}");
    await cron(makeBot(w.env as ConfiguredEnv));
    const coverage = w.queue.sent.map((s) => s.body).filter((m) => m.kind === "coverage");
    expect(coverage).toEqual([{ kind: "coverage", repo: SANDBOX, pr: a.number }]);
  });
});
