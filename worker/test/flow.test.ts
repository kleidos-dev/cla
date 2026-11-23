// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { cron, makeBot } from "../src/bot";
import type { ConfiguredEnv } from "../src/env";
import { ORG_ID, commit, sha } from "./fakegh";
import type { World } from "./helpers";
import { SANDBOX, drain, openPr, prEvent, spanishIn, webhook, world } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const owner = { id: 28966312, login: "jmrplens", type: "User" as const };
const alice = { id: 123456, login: "alice", type: "User" as const };
const bob = { id: 234567, login: "bob", type: "User" as const };
const carol = { id: 345678, login: "carol", type: "User" as const };
const dependabot = { id: 49699333, login: "dependabot[bot]", type: "Bot" as const };
const strangeBot = { id: 555, login: "some-bot[bot]", type: "Bot" as const };

async function opened(w: World, pr: ReturnType<typeof openPr>, action = "opened") {
  expect((await webhook(w, "pull_request", prEvent(pr, action))).status).toBe(202);
  return drain(w);
}

function heldRun(w: World, pr: ReturnType<typeof openPr>, from = pr.head.repo) {
  const run = { id: w.gh.next(), repo: pr.repo, head_sha: pr.head.sha, head_repository: from, status: "action_required", approved: false };
  w.gh.runs.push(run);
  return run;
}

describe("evaluation", () => {
  it("an unsigned pull request gets the comment, an action_required check and no approval", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    const run = heldRun(w, pr);
    await opened(w, pr);
    const check = w.gh.check(SANDBOX, pr.head.sha)!;
    expect(check.conclusion).toBe("action_required");
    expect(check.title).toBe("1 signature needed");
    expect(check.details_url).toBe(`https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number}`);
    expect(check.external_id).toMatch(new RegExp(`^\\d+#${pr.number}$`));
    const [comment] = w.gh.botComments(SANDBOX, pr.number);
    expect(comment!.body.startsWith("<!-- kleidos-cla:v1 -->\n**Contributor Agreement needed.** ")).toBe(true);
    expect(comment!.body).toContain("Still to sign: @alice.");
    // The button: its image URL names the state and the count, wrapped in the sign link, with alt text.
    expect(comment!.body).toContain(`[![Sign the Kleidos Contributor Agreement: 0 of 1 author signed](https://cla.kleidos.dev/button/v2/needed-0-1.svg)](https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number})`);
    // The privacy notice is one link away, not a paragraph in the comment.
    expect(comment!.body).toContain("[Privacy](https://cla.kleidos.dev/privacy)");
    expect(comment!.body).not.toContain("**Your data.**");
    // English only: one line, the button, one line of links; Spanish is on the pages it links to.
    expect(spanishIn(comment!.body)).toBeNull();
    expect(comment!.body).toBe(
      [
        "<!-- kleidos-cla:v1 -->",
        "**Contributor Agreement needed.** Sign it once and the checks of this pull request start; it covers every Kleidos repository. Still to sign: @alice.",
        "",
        `[![Sign the Kleidos Contributor Agreement: 0 of 1 author signed](https://cla.kleidos.dev/button/v2/needed-0-1.svg)](https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number})`,
        "",
        "<sub>[Agreement](https://cla.kleidos.dev/agreement) · [Privacy](https://cla.kleidos.dev/privacy) · Employer or under 18? [Who signs](https://github.com/kleidos-dev/cla#who-signs)</sub>",
      ].join("\n"),
    );
    expect(run.approved).toBe(false);
    expect(w.gh.dispatches).toHaveLength(0);
  });

  it("a signed author gets a green check, no comment, and the held fork runs approved", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    const run = heldRun(w, pr);
    const other = heldRun(w, pr, "mallory/cla-sandbox");
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
    expect(w.gh.check(SANDBOX, pr.head.sha)!.title).toBe("Contributor Agreement accepted");
    expect(w.gh.botComments(SANDBOX, pr.number)).toHaveLength(0);
    expect(run.approved).toBe(true);
    expect(other.approved).toBe(false);
  });

  it("exempt authors only: success, 'No signature needed', no comment", async () => {
    const w = await world();
    const pr = openPr(w, dependabot, { commits: [commit(dependabot), commit(owner)] });
    await opened(w, pr);
    const check = w.gh.check(SANDBOX, pr.head.sha)!;
    expect(check.conclusion).toBe("success");
    expect(check.title).toBe("No signature needed");
    expect(check.summary).toContain("`dependabot[bot]` (id 49699333) is on the Kleidos exemption list");
    expect(w.gh.botComments(SANDBOX, pr.number)).toHaveLength(0);
  });

  it("a multi-author pull request needs every author; only the opener is @-mentioned", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { commits: [commit(alice), commit(bob), commit(carol), commit(owner)] });
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.title).toBe("2 signatures needed");
    const body = w.gh.botComments(SANDBOX, pr.number)[0]!.body;
    expect(body).toContain("**Contributor Agreement: 1 of 3 signed.** @alice has signed; still to sign: [bob](https://github.com/bob), [carol](https://github.com/carol).");
    expect(spanishIn(body)).toBeNull();
    expect(body).toContain("/button/v2/partial-1-3.svg");
    expect(body).toContain("No signature needed: `jmrplens` (the project owner).");
    expect(body).not.toContain("@bob");
    expect(body).not.toContain("@carol");
    await w.gh.signDirectly(bob);
    await w.gh.signDirectly(carol);
    await opened(w, pr, "reopened");
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
    const updated = w.gh.botComments(SANDBOX, pr.number);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.body).toContain("**Contributor Agreement signed.**");
    expect(updated[0]!.body).toContain("/button/v2/signed-3-3.svg");
    expect(spanishIn(updated[0]!.body)).toBeNull();
  });

  it("the comment a pull request already has is edited to the green state, never a second one", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    await opened(w, pr);
    const [first] = w.gh.botComments(SANDBOX, pr.number);
    expect(first!.body).toContain("/button/v2/needed-0-1.svg");
    await w.gh.signDirectly(alice);
    await opened(w, pr, "synchronize");
    const after = w.gh.botComments(SANDBOX, pr.number);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first!.id);
    expect(after[0]!.body).toContain("**Contributor Agreement signed.**");
    expect(after[0]!.body).toContain(`[![Kleidos Contributor Agreement signed by its author](https://cla.kleidos.dev/button/v2/signed-1-1.svg)](https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number})`);
    expect(spanishIn(after[0]!.body)).toBeNull();
    expect(w.gh.requests.filter((r) => r.method === "POST" && r.url.endsWith(`/issues/${pr.number}/comments`))).toHaveLength(1);
  });

  it("a contributor who has signed opens a new pull request: no comment, no mention, a green check", async () => {
    const w = await world();
    const first = openPr(w, alice);
    await opened(w, first);
    await w.gh.signDirectly(alice);
    await opened(w, first, "synchronize");
    expect(w.gh.check(SANDBOX, first.head.sha)!.conclusion).toBe("success");
    const pr = openPr(w, alice);
    await opened(w, pr);
    // A later push and a cron pass are evaluations too; none of them writes a comment.
    pr.head.sha = sha();
    await opened(w, pr, "synchronize");
    await cron(makeBot(w.env as ConfiguredEnv));
    await drain(w);
    const check = w.gh.check(SANDBOX, pr.head.sha)!;
    expect(check.conclusion).toBe("success");
    expect(check.title).toBe("Contributor Agreement accepted");
    expect(w.gh.comments.filter((c) => c.repo === SANDBOX && c.pr === pr.number)).toHaveLength(0);
    expect(w.gh.requests.filter((r) => r.url.includes(`/issues/${pr.number}/comments`) && r.method !== "GET")).toHaveLength(0);
  });

  it("Co-authored-by trailers count as authors, and an unlinked co-author email blocks", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { commits: [commit(alice, { coAuthors: [bob] })] });
    await opened(w, pr);
    expect(w.gh.botComments(SANDBOX, pr.number)[0]!.body).toContain("still to sign: [bob](https://github.com/bob).");

    const pr2 = openPr(w, alice, { commits: [commit(alice, { coAuthors: [{ email: "someone@example.org" }] })] });
    await opened(w, pr2);
    const body = w.gh.botComments(SANDBOX, pr2.number)[0]!.body;
    expect(body).toMatch(/\*\*Cannot tell who wrote commit `[0-9a-f]{7}`\.\*\*/);
    expect(body).not.toContain("someone@example.org");
    expect(w.gh.check(SANDBOX, pr2.head.sha)!.conclusion).toBe("action_required");

    const c = commit(alice, { coAuthors: [bob] });
    c.authors.nodes = c.authors.nodes.slice(0, 1);
    const pr3 = openPr(w, alice, { commits: [c] });
    await opened(w, pr3);
    expect(w.gh.botComments(SANDBOX, pr3.number)[0]!.body).toContain("still to sign: [bob](https://github.com/bob).");
  });

  it("an automation account that is not on the list fails closed", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { commits: [commit(alice), commit(strangeBot)] });
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
    expect(w.gh.botComments(SANDBOX, pr.number)[0]!.body).toContain("names `some-bot[bot]` as an author. An automation account cannot sign");
  });

  it("a fork pull request: only runs from the pull request's own fork are approved, and only while the head is unchanged", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { fork: "alice/cla-sandbox" });
    const mine = heldRun(w, pr, "alice/cla-sandbox");
    const foreign = heldRun(w, pr, "kleidos-dev/cla-sandbox");
    await webhook(w, "pull_request", prEvent(pr, "opened"));
    await drain(w, 1);
    pr.head.sha = sha();
    await drain(w);
    expect(mine.approved).toBe(false);
    expect(foreign.approved).toBe(false);
    await opened(w, pr, "synchronize");
    const fresh = heldRun(w, pr, "alice/cla-sandbox");
    await webhook(w, "workflow_run", { action: "requested", workflow_run: { event: "pull_request", head_sha: pr.head.sha, status: "queued" }, repository: { full_name: SANDBOX, owner: { id: ORG_ID } } });
    await drain(w);
    expect(fresh.approved).toBe(true);
    expect(foreign.approved).toBe(false);
  });

  it("synchronize after signing: a commit by somebody new turns the check back to action_required", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    await opened(w, pr);
    const first = pr.head.sha;
    expect(w.gh.check(SANDBOX, first)!.conclusion).toBe("success");
    pr.commits.push(commit(bob));
    pr.head.sha = sha();
    const run = heldRun(w, pr);
    await opened(w, pr, "synchronize");
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
    expect(w.gh.check(SANDBOX, first)!.conclusion).toBe("success");
    expect(run.approved).toBe(false);
    expect(w.gh.botComments(SANDBOX, pr.number)[0]!.body).toContain("still to sign: [bob](https://github.com/bob).");
  });

  it("a pull request that changes .github/ (or renames out of it) is never approved automatically", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    for (const files of [[{ filename: ".github/workflows/ci.yml" }], [{ filename: "ci.yml", previous_filename: ".github/workflows/ci.yml" }]]) {
      const pr = openPr(w, alice, { files });
      const run = heldRun(w, pr);
      await opened(w, pr);
      expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
      expect(w.gh.check(SANDBOX, pr.head.sha)!.summary).toContain("changes files under `.github/`");
      expect(run.approved).toBe(false);
      expect(w.queue.sent.filter((s) => s.body.kind === "release")).toHaveLength(0);
    }
  });

  it("auto_approve false: green check, no approval", async () => {
    const w = await world();
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { repo: "kleidos-dev/cla" });
    const run = heldRun(w, pr);
    await opened(w, pr);
    expect(w.gh.check("kleidos-dev/cla", pr.head.sha)!.conclusion).toBe("success");
    expect(run.approved).toBe(false);
  });

  it("an account covered by an entity signs nothing", async () => {
    const w = await world();
    w.gh.setFile("main", "registry/entities.json", JSON.stringify({ schema: 1, entities: [{ slug: "example", name: "Example GmbH", version: 1, set_sha256: "89c1d46b9b1048508d9acdba113620b08a45c57d7e067ee41dd2b816a839a61e", signed_at: "2026-11-01", covered: [{ github_id: carol.id, from: "2026-11-01" }] }] }));
    const pr = openPr(w, carol);
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("success");
    expect(w.gh.check(SANDBOX, pr.head.sha)!.summary).toContain("covered by the agreement of Example GmbH");
  });

  it("a record of a version that is not accepted, or with another digest, does not count", async () => {
    const w = await world();
    const c = { id: w.gh.next(), repo: SANDBOX, pr: 1, body: "x", user: alice, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", via_app: false };
    w.gh.comments.push(c);
    await w.gh.record(c.id, 1, "0".repeat(64));
    const pr = openPr(w, alice);
    await opened(w, pr);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
  });

  it("a typed acceptance comment is recorded: the recorder is dispatched once it is old enough", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    const config = JSON.parse(w.gh.files.get("main:registry/config.json")!) as { versions: { "1": { sentence: string } } };
    w.gh.comments.push({ id: w.gh.next(), repo: SANDBOX, pr: pr.number, body: `  ${config.versions["1"].sentence.replace(/ /g, "  ")}\n`, user: alice, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", via_app: false });
    await opened(w, pr);
    expect(w.gh.dispatches).toEqual([expect.objectContaining({ kind: "sign", repo: SANDBOX, pr: String(pr.number) })]);
    expect(w.gh.botComments(SANDBOX, pr.number)[0]!.body).toContain("acceptance was posted but is not in the register yet");
  });

  it("a merged pull request dispatches the coverage record", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    pr.state = "closed";
    pr.merged = true;
    await opened(w, pr, "closed");
    expect(w.gh.dispatches).toEqual([{ kind: "coverage", repo: SANDBOX, pr: String(pr.number), comment_id: "" }]);
  });

  it("a repository that is not served, or installed on another account, is left alone", async () => {
    const w = await world();
    w.gh.addRepo("kleidos-dev/boards");
    const pr = openPr(w, alice, { repo: "kleidos-dev/boards" });
    await opened(w, pr);
    expect(w.gh.checkRuns).toHaveLength(0);
    w.gh.installations.set(9, { account: 4242 });
    w.gh.addRepo("stranger/repo", { installation: 9, account: 4242 });
    const cfg = JSON.parse(w.gh.files.get("main:registry/config.json")!) as { served_repositories: Record<string, unknown> };
    cfg.served_repositories["stranger/repo"] = { auto_approve: true };
    w.gh.setFile("main", "registry/config.json", JSON.stringify(cfg));
    const pr2 = openPr(w, alice, { repo: "stranger/repo" });
    await opened(w, pr2);
    expect(w.gh.checkRuns).toHaveLength(0);
  });

  it("GitHub's rate limit is retried with its delay, a 5xx with backoff", async () => {
    const w = await world();
    const pr = openPr(w, alice);
    await webhook(w, "pull_request", prEvent(pr, "opened"));
    w.gh.failNext = { match: /GET \/repos\/.+\/pulls\/\d+$/, status: 403, headers: { "retry-after": "42" } };
    const { handleQueue } = await import("../src/index");
    const body = w.queue.sent.shift()!.body;
    let retried: number | undefined;
    await handleQueue({ messages: [{ body, attempts: 1, ack: () => undefined, retry: (o: { delaySeconds: number }) => (retried = o.delaySeconds) }] } as never, w.env);
    expect(retried).toBe(42);
    w.gh.failNext = { match: /GET \/repos\/.+\/pulls\/\d+$/, status: 502 };
    await handleQueue({ messages: [{ body, attempts: 2, ack: () => undefined, retry: (o: { delaySeconds: number }) => (retried = o.delaySeconds) }] } as never, w.env);
    expect(retried).toBe(60);
    expect(w.gh.checkRuns).toHaveLength(0);
  });

  it("the cron removes foreign installations, redelivers failed deliveries and re-evaluates open pull requests", async () => {
    const w = await world();
    w.gh.installations.set(66, { account: 4242 });
    const recent = new Date().toISOString();
    w.gh.deliveries = [
      { id: 1, guid: "a", status_code: 500, delivered_at: recent, redelivery: false },
      { id: 2, guid: "b", status_code: 202, delivered_at: recent, redelivery: false },
      { id: 3, guid: "c", status_code: 503, delivered_at: "2026-01-01T00:00:00Z", redelivery: false },
    ];
    const pr = openPr(w, alice);
    await cron(makeBot(w.env as ConfiguredEnv));
    expect(w.gh.redelivered).toEqual([1]);
    await drain(w);
    expect(w.gh.deletedInstallations).toEqual([66]);
    expect(w.gh.check(SANDBOX, pr.head.sha)!.conclusion).toBe("action_required");
  });
});
