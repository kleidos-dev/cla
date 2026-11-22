// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ID } from "./fakegh";
import { SANDBOX, drain, openPr, prEvent, sign, webhook, world } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const alice = { id: 123456, login: "alice", type: "User" as const };

describe("webhook signature", () => {
  it("refuses a missing, malformed or wrong signature before parsing anything", async () => {
    const w = await world();
    for (const signature of ["", "sha1=abc", "sha256=zz", `sha256=${"0".repeat(64)}`, await sign("another-secret", "{}")]) {
      const r = await webhook(w, "pull_request", { action: "opened" }, { signature });
      expect(r.status).toBe(401);
    }
    expect(w.queue.sent).toHaveLength(0);
    expect(w.gh.requests).toHaveLength(0);
  });

  it("checks the signature before the body is parsed (bad JSON with a bad signature is 401, not 400)", async () => {
    const w = await world();
    const { handleFetch } = await import("../src/index");
    const r = await handleFetch(new Request("https://cla.kleidos.dev/webhook", { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "abcdef12-0000", "x-hub-signature-256": `sha256=${"1".repeat(64)}` }, body: "{not json" }), w.env);
    expect(r.status).toBe(401);
    const body = "{not json";
    const ok = await handleFetch(new Request("https://cla.kleidos.dev/webhook", { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "abcdef12-0000", "x-hub-signature-256": await sign("test-webhook-secret", body) }, body }), w.env);
    expect(ok.status).toBe(400);
  });

  it("accepts a correct signature and enqueues identifiers only", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    const r = await webhook(w, "pull_request", { ...prEvent(pr, "opened"), pull_request: { number: pr.number, title: "<script>", body: "x".repeat(1000) } });
    expect(r.status).toBe(202);
    expect(w.queue.sent.map((s) => s.body)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: pr.number }]);
  });

  it("refuses a delivery addressed to another app", async () => {
    const w = await world();
    const r = await webhook(w, "pull_request", { action: "opened" }, { target: "42" });
    expect(r.status).toBe(400);
    expect(w.queue.sent).toHaveLength(0);
  });

  it("refuses an oversized body with 413", async () => {
    const w = await world();
    const { handleFetch } = await import("../src/index");
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const r = await handleFetch(new Request("https://cla.kleidos.dev/webhook", { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "abcdef12-0000", "x-hub-signature-256": await sign("test-webhook-secret", big) }, body: big }), w.env);
    expect(r.status).toBe(413);
  });

  it("answers 405 to a GET and 429 over the rate limit", async () => {
    const w = await world();
    const { handleFetch } = await import("../src/index");
    expect((await handleFetch(new Request("https://cla.kleidos.dev/webhook"), w.env)).status).toBe(405);
    w.limiters.RL_WEBHOOK!.allow = false;
    expect((await webhook(w, "ping", {})).status).toBe(429);
  });

  it("maps every event it serves and ignores the rest", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    const sha = pr.head.sha;
    await webhook(w, "pull_request", prEvent(pr, "labeled"));
    await webhook(w, "pull_request", prEvent(pr, "edited"));
    await webhook(w, "pull_request", prEvent(pr, "edited", { changes: { base: { ref: { from: "dev" } } } }));
    await webhook(w, "check_run", { action: "rerequested", check_run: { name: "📝 CLA", app: { id: APP_ID }, external_id: `77#${pr.number}` }, repository: { full_name: SANDBOX, id: 77 } });
    await webhook(w, "check_run", { action: "rerequested", check_run: { name: "📝 CLA", app: { id: 5 }, external_id: `77#${pr.number}` }, repository: { full_name: SANDBOX, id: 77 } });
    await webhook(w, "check_run", { action: "rerequested", check_run: { name: "📝 CLA", app: { id: APP_ID }, external_id: `78#${pr.number}` }, repository: { full_name: SANDBOX, id: 77 } });
    await webhook(w, "workflow_run", { action: "completed", workflow_run: { event: "pull_request", head_sha: sha, conclusion: "action_required" }, repository: { full_name: SANDBOX } });
    await webhook(w, "workflow_run", { action: "completed", workflow_run: { event: "pull_request", head_sha: sha, conclusion: "success" }, repository: { full_name: SANDBOX } });
    await webhook(w, "installation", { action: "created", installation: { id: 66 } });
    await webhook(w, "github_app_authorization", { action: "revoked" });
    await webhook(w, "issue_comment", { action: "created" });
    expect(w.queue.sent.map((s) => s.body)).toEqual([
      { kind: "evaluate", repo: SANDBOX, pr: pr.number },
      { kind: "evaluate", repo: SANDBOX, pr: pr.number },
      { kind: "held", repo: SANDBOX, sha },
      { kind: "installation", installation: 66 },
    ]);
  });

  it("a replayed delivery only recomputes the current state", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    const payload = prEvent(pr, "opened");
    const delivery = "3f1c2a90-aaaa-bbbb-cccc-000000000001";
    expect((await webhook(w, "pull_request", payload, { delivery })).status).toBe(202);
    await drain(w);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
    await w.gh.signDirectly(alice);
    expect((await webhook(w, "pull_request", payload, { delivery })).status).toBe(202);
    await drain(w);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
    expect(w.gh.checkRuns.filter((r) => r.head_sha === pr.head.sha)).toHaveLength(1);
    expect(w.gh.botComments(SANDBOX, pr.number)).toHaveLength(1);
  });

  it("a foreign installation is removed and an allowed one kept", async () => {
    const w = await world();
    w.gh.installations.set(66, { account: 4242 });
    await webhook(w, "installation", { action: "created", installation: { id: 66 } });
    await webhook(w, "installation", { action: "created", installation: { id: 1 } });
    await drain(w);
    expect(w.gh.deletedInstallations).toEqual([66]);
  });
});
