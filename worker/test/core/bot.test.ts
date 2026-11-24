// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/** What the bot does with each message: the calls it makes, in which order, and the ones it does not make. */
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_NAME, MARKER } from "../../src/assess";
import type { Bot } from "../../src/bot";
import { RECORD_DELAYS, RELEASE_DELAYS, coverage, cron, evaluate, githubState, handleMessage, held, installation, makeBot, release, textContext } from "../../src/bot";
import type { ConfiguredEnv } from "../../src/env";
import { GitHubError } from "../../src/github";
import type { QueueMessage } from "../../src/messages";
import type { FakeComment, FakePr, Seen } from "../fakegh";
import { APP_ID, BASE_GITHUB_TREE, BASE_SHA, BOT_ID, REGISTRY, commit, sha } from "../fakegh";
import type { FakeQueue, World } from "../helpers";
import { CONFIG, SANDBOX, openPr, world } from "../helpers";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const alice = { id: 123456, login: "alice", type: "User" as const };
const bob = { id: 234567, login: "bob", type: "User" as const };
const SENTENCE = CONFIG.versions["1"].sentence;

let w: World;
let b: Bot;
let send: MockInstance<FakeQueue["send"]>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  w = await world();
  b = makeBot(w.env as ConfiguredEnv);
  send = vi.spyOn(w.queue, "send");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Of<K extends QueueMessage["kind"]> = Extract<QueueMessage, { kind: K }>;
const evaluation = (pr: FakePr, over: Partial<Of<"evaluate">> = {}): Of<"evaluate"> => ({ kind: "evaluate", repo: pr.repo, pr: pr.number, ...over });
const queued = () => w.queue.sent;
const logged = () => w.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
const time = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
/** The calls that change something at GitHub or put a message in the queue, in the order they were made. */
const deeds: string[] = [];
beforeEach(() => {
  deeds.length = 0;
  w.gh.onRequest = (method, path) => {
    if (method !== "GET" && path !== "/graphql" && !path.endsWith("/access_tokens")) deeds.push(`${method} ${path}`);
  };
  send.mockImplementation((body: QueueMessage, opts?: { delaySeconds?: number }) => {
    deeds.push(`send ${body.kind}`);
    w.queue.sent.push({ body: structuredClone(body), ...(opts ?? {}) });
    return Promise.resolve();
  });
});

function comment(pr: FakePr, over: Partial<FakeComment> = {}): FakeComment {
  const created_at = over.created_at ?? time(NOW - MINUTE);
  const c: FakeComment = { id: w.gh.next(), repo: pr.repo, pr: pr.number, body: SENTENCE, user: alice, created_at, updated_at: created_at, via_app: false, ...over };
  w.gh.comments.push(c);
  return c;
}
const check = (pr: FakePr, conclusion = "success", app_id = APP_ID) => {
  const c = { id: w.gh.next(), repo: pr.repo, head_sha: pr.head.sha, name: CHECK_NAME, app_id, conclusion, title: "old", summary: "old", details_url: "old", external_id: "old" };
  w.gh.checkRuns.push(c);
  return c;
};
const tokens = () => w.gh.seen(/access_tokens$/).map((r) => (r.body as { repositories: string[]; permissions: object }).permissions);
const checkWrite = (r: Seen | undefined) => r?.body as { conclusion: string; output: { title: string; summary: string } };

describe("an evaluation", () => {
  it("of a repository that is not served reads its configuration and stops", async () => {
    const pr = openPr(w, alice, { repo: "kleidos-dev/boards" });
    w.gh.addRepo("kleidos-dev/boards");
    await evaluate(b, evaluation(pr));
    expect(tokens()).toEqual([{ contents: "read" }]);
    expect(w.gh.seen(/boards/)).toEqual([]);
    expect(logged()).toEqual([{ msg: "evaluate skipped", repo: "kleidos-dev/boards", reason: "not_served" }]);
    expect(queued()).toEqual([]);
  });

  it("works with a token of that repository that reads contents and writes checks and comments", async () => {
    await evaluate(b, evaluation(openPr(w, alice)));
    expect(w.gh.seen(/access_tokens$/).map((r) => r.body)).toEqual([
      { repositories: ["cla"], permissions: { contents: "read" } },
      { repositories: ["cla-sandbox"], permissions: { pull_requests: "write", checks: "write", contents: "read" } },
    ]);
  });

  it("writes the check, then the comment, and queues nothing while nobody accepted", async () => {
    const pr = openPr(w, alice);
    await evaluate(b, evaluation(pr));
    expect(deeds).toEqual([`POST /repos/${SANDBOX}/check-runs`, `POST /repos/${SANDBOX}/issues/${pr.number}/comments`]);
    expect(logged()).toEqual([{ msg: "evaluated", repo: SANDBOX, pr: pr.number, outcome: "action_required", count: 1, attempt: 0 }]);
  });

  it("writes the check whole", async () => {
    const pr = openPr(w, alice);
    await evaluate(b, evaluation(pr));
    const [r] = w.gh.seen(/^POST .*\/check-runs$/);
    expect(r?.body).toEqual({
      name: "📝 CLA",
      head_sha: pr.head.sha,
      status: "completed",
      conclusion: "action_required",
      details_url: `https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number}`,
      external_id: `${w.gh.repos.get(SANDBOX)?.id}#${pr.number}`,
      output: { title: "1 signature needed", summary: `- \`alice\` (id 123456): has not accepted yet\n\nSign at https://cla.kleidos.dev/sign/${SANDBOX}/${pr.number}` },
    });
  });

  it("updates the app's own check of that commit, with the same fields", async () => {
    const pr = openPr(w, alice);
    check(pr, "success", APP_ID + 1);
    const mine = check(pr);
    await evaluate(b, evaluation(pr));
    expect(deeds[0]).toBe(`PATCH /repos/${SANDBOX}/check-runs/${mine.id}`);
    expect(Object.keys(w.gh.seen(/^PATCH/)[0]?.body as object)).toEqual(["name", "head_sha", "status", "conclusion", "details_url", "external_id", "output"]);
    expect(mine.conclusion).toBe("action_required");
  });

  it("makes a check of its own beside another app's, and beside one of no app", async () => {
    const pr = openPr(w, alice);
    w.gh.answer(/^GET .*\/check-runs/, () => json({ check_runs: [{ id: 1, app: null }, { id: 2, app: { id: APP_ID + 1 } }] }));
    await evaluate(b, evaluation(pr));
    expect(deeds[0]).toBe(`POST /repos/${SANDBOX}/check-runs`);
  });

  it("edits its one comment when the text changed, and leaves it alone when it did not", async () => {
    const pr = openPr(w, alice);
    await evaluate(b, evaluation(pr));
    const [mine] = w.gh.botComments(SANDBOX, pr.number);
    deeds.length = 0;
    await evaluate(b, evaluation(pr));
    expect(deeds).toEqual([expect.stringMatching(/^PATCH .*\/check-runs\/\d+$/)]);
    deeds.length = 0;
    if (mine) mine.body = `${MARKER}\nold text`;
    await evaluate(b, evaluation(pr));
    expect(deeds[1]).toBe(`PATCH /repos/${SANDBOX}/issues/comments/${mine?.id}`);
    expect(mine?.body).toContain("**Contributor Agreement needed.**");
    expect(w.gh.botComments(SANDBOX, pr.number)).toHaveLength(1);
  });

  it("of a pull request whose authors are clear writes no first comment, and edits the one it has", async () => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    await evaluate(b, evaluation(pr));
    expect(deeds).toEqual([`POST /repos/${SANDBOX}/check-runs`, "send release"]);
    const c = comment(pr, { body: `${MARKER}\nold text`, user: { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" }, via_app: true });
    deeds.length = 0;
    await evaluate(b, evaluation(pr));
    expect(deeds).toEqual([expect.stringMatching(/^PATCH .*\/check-runs\/\d+$/), `PATCH /repos/${SANDBOX}/issues/comments/${c.id}`, "send release"]);
  });

  it("that everybody cleared says so, with the records' commits", async () => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    comment(pr, { body: `${MARKER}\nold`, user: { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" }, via_app: true });
    await evaluate(b, evaluation(pr));
    expect(checkWrite(w.gh.seen(/^POST .*\/check-runs$/)[0])).toMatchObject({ conclusion: "success", output: { title: "Contributor Agreement accepted" } });
    expect(w.gh.botComments(SANDBOX, pr.number)[0]?.body).toContain(`/blob/${w.gh.recordCommits.get(alice.id)}/signatures/individual/123456.json`);
    expect(logged()).toEqual([{ msg: "evaluated", repo: SANDBOX, pr: pr.number, outcome: "success", count: 0, attempt: 0 }]);
  });

  it("that everybody cleared asks to release the held runs of that head", async () => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    await evaluate(b, evaluation(pr));
    expect(send.mock.calls).toEqual([[{ kind: "release", repo: SANDBOX, pr: pr.number, sha: pr.head.sha }, undefined]]);
  });

  it("does not where the repository does not approve by itself, and the texts say who does", async () => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { repo: REGISTRY });
    await evaluate(b, evaluation(pr));
    expect(queued()).toEqual([]);
    expect(checkWrite(w.gh.seen(/^POST .*\/check-runs$/)[0]).output.summary).toContain("started by a maintainer, not automatically");
  });

  it.each([
    ["changes .github/", () => "8".repeat(40), "This pull request changes files under `.github/`"],
    ["may change .github/", () => undefined, "could not be checked automatically"],
  ])("does not when the commit %s, and the texts say so", async (_what, tree, text) => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    const t = tree();
    if (t) w.gh.githubTrees.set(pr.head.sha, t);
    else w.gh.answer(/\/compare\//, () => json({ message: "Not Found" }, 404));
    await evaluate(b, evaluation(pr));
    expect(queued()).toEqual([]);
    expect(checkWrite(w.gh.seen(/^POST .*\/check-runs$/)[0])).toMatchObject({ conclusion: "success", output: { summary: expect.stringContaining(text) as string } });
  });

  it("does not while somebody is missing, and never looks at .github/ then", async () => {
    const pr = openPr(w, alice, { files: [{ filename: ".github/x.yml" }] });
    await evaluate(b, evaluation(pr));
    expect(w.gh.seen(/compare|git\/trees/)).toEqual([]);
    expect(queued()).toEqual([]);
    expect(w.gh.botComments(SANDBOX, pr.number)[0]?.body).not.toContain(".github/");
  });

  it("of a head that moved writes nothing and is asked again in fifteen seconds as it was", async () => {
    const pr = openPr(w, alice);
    w.gh.answer(/^POST \/graphql$/, () => json({ data: { repository: { pullRequest: { headRefOid: sha(), commits: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }));
    await evaluate(b, evaluation(pr, { attempt: 2, record_comment: 7, await_signin: 8 }));
    expect(send.mock.calls).toEqual([[evaluation(pr, { attempt: 2, record_comment: 7, await_signin: 8 }), { delaySeconds: 15 }]]);
    expect(deeds).toEqual(["send evaluate"]);
    expect(logged()).toEqual([{ msg: "evaluate deferred", repo: SANDBOX, pr: pr.number, reason: "head_moved" }]);
  });

  it("that fails for any other reason fails, and queues nothing", async () => {
    const pr = openPr(w, alice);
    w.gh.answer(/^POST \/graphql$/, () => new Response(null, { status: 500 }));
    await expect(evaluate(b, evaluation(pr))).rejects.toMatchObject({ kind: "transient" });
    expect(deeds).toEqual([]);
    expect(logged()).toEqual([]);
  });

  it("of a closed pull request has the others of its head evaluated and writes nothing", async () => {
    const pr = openPr(w, alice);
    pr.state = "closed";
    await evaluate(b, evaluation(pr));
    expect(send.mock.calls).toEqual([[{ kind: "held", repo: SANDBOX, sha: pr.head.sha }, undefined]]);
    expect(logged()).toEqual([{ msg: "evaluate closed", repo: SANDBOX, pr: pr.number, outcome: "closed" }]);
    expect(w.gh.writes()).toEqual([]);
  });

  it("of a merged one asks for its coverage record first", async () => {
    const pr = openPr(w, alice);
    Object.assign(pr, { state: "closed", merged: true });
    await evaluate(b, evaluation(pr));
    expect(send.mock.calls).toEqual([
      [{ kind: "coverage", repo: SANDBOX, pr: pr.number }, undefined],
      [{ kind: "held", repo: SANDBOX, sha: pr.head.sha }, undefined],
    ]);
    expect(logged()).toEqual([{ msg: "evaluate closed", repo: SANDBOX, pr: pr.number, outcome: "merged" }]);
  });
});

describe("a pull request with more comments than are read", () => {
  const crowd = (pr: FakePr) => {
    for (let i = 0; i < 501; i++) comment(pr, { body: "x", user: bob });
  };

  it("gets its check and no comment: the bot may already have one among those it did not read", async () => {
    const pr = openPr(w, alice);
    crowd(pr);
    await evaluate(b, evaluation(pr));
    expect(deeds).toEqual([`POST /repos/${SANDBOX}/check-runs`]);
  });

  it("has the comment edited that is found before them", async () => {
    const pr = openPr(w, alice);
    const mine = comment(pr, { body: `${MARKER}\nold text`, user: { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" }, via_app: true });
    crowd(pr);
    await evaluate(b, evaluation(pr));
    expect(deeds).toEqual([`POST /repos/${SANDBOX}/check-runs`, `PATCH /repos/${SANDBOX}/issues/comments/${mine.id}`]);
  });
});

describe("an acceptance on the pull request", () => {
  const dispatched = () => w.gh.dispatches.map((d) => d.comment_id);

  it("posted through the site is recorded at once, then its record is waited for", async () => {
    const pr = openPr(w, alice);
    const c = comment(pr, { created_at: time(NOW) });
    await evaluate(b, evaluation(pr, { record_comment: c.id }));
    expect(w.gh.dispatches).toEqual([{ kind: "sign", repo: SANDBOX, pr: String(pr.number), comment_id: String(c.id) }]);
    expect(deeds).toEqual([`POST /repos/${REGISTRY}/actions/workflows/record.yml/dispatches`, `POST /repos/${SANDBOX}/check-runs`, `POST /repos/${SANDBOX}/issues/${pr.number}/comments`, "send evaluate"]);
    expect(send.mock.calls).toEqual([[{ kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: 1, record_comment: c.id }, { delaySeconds: 20 }]]);
    expect(logged()).toEqual([
      { msg: "recorder dispatched", repo: SANDBOX, pr: pr.number },
      { msg: "evaluated", repo: SANDBOX, pr: pr.number, outcome: "action_required", count: 1, attempt: 0 },
    ]);
  });

  it("typed by hand is left five minutes to be edited before it is recorded", async () => {
    const pr = openPr(w, alice);
    const c = comment(pr, { created_at: time(NOW - 5 * MINUTE) });
    await evaluate(b, evaluation(pr));
    expect(dispatched()).toEqual([]);
    // It is waited for all the same.
    expect(send.mock.calls).toEqual([[{ kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: 1 }, { delaySeconds: 20 }]]);
    vi.setSystemTime(NOW + 1);
    await evaluate(b, evaluation(pr));
    expect(dispatched()).toEqual([String(c.id)]);
  });

  it("is recorded by a first look only: the looks after it wait for the record", async () => {
    const pr = openPr(w, alice);
    const c = comment(pr, { created_at: time(NOW - HOUR) });
    await evaluate(b, evaluation(pr, { attempt: 1, record_comment: c.id }));
    expect(dispatched()).toEqual([]);
    expect(queued()).toEqual([{ body: { kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: 2, record_comment: c.id }, delaySeconds: 40 }]);
  });

  it.each([
    [0, 20],
    [1, 40],
    [2, 80],
    [3, 160],
    [4, 320],
  ])("after look %i is waited for %i seconds", async (attempt, delaySeconds) => {
    const pr = openPr(w, alice);
    comment(pr);
    await evaluate(b, evaluation(pr, { attempt }));
    expect(queued()).toEqual([{ body: { kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: attempt + 1 }, delaySeconds }]);
    expect(RECORD_DELAYS).toHaveLength(5);
  });

  it("after the sixth look is left to the cron", async () => {
    const pr = openPr(w, alice);
    comment(pr);
    await evaluate(b, evaluation(pr, { attempt: 5 }));
    expect(queued()).toEqual([]);
    expect(logged()[0]).toMatchObject({ attempt: 5 });
  });

  it("that was edited is neither recorded nor waited for", async () => {
    const pr = openPr(w, alice);
    const c = comment(pr, { created_at: time(NOW - HOUR), updated_at: time(NOW) });
    await evaluate(b, evaluation(pr, { record_comment: c.id }));
    expect(dispatched()).toEqual([]);
    expect(queued()).toEqual([]);
    expect(w.gh.botComments(SANDBOX, pr.number)[0]?.body).not.toContain("not in the register yet");
  });

  it("is recorded once per account: the earliest one that was not edited", async () => {
    const pr = openPr(w, alice);
    comment(pr, { created_at: time(NOW - 3 * HOUR), updated_at: time(NOW) });
    const first = comment(pr, { created_at: time(NOW - 2 * HOUR) });
    comment(pr, { created_at: time(NOW - HOUR) });
    await evaluate(b, evaluation(pr));
    expect(dispatched()).toEqual([String(first.id)]);
  });

  it("is the one just posted, when there are several", async () => {
    const pr = openPr(w, alice);
    comment(pr, { created_at: time(NOW - 2 * HOUR) });
    const posted = comment(pr, { created_at: time(NOW) });
    comment(pr, { created_at: time(NOW) });
    await evaluate(b, evaluation(pr, { record_comment: posted.id }));
    expect(dispatched()).toEqual([String(posted.id)]);
  });

  it("stays the one just posted, whatever comes after it", async () => {
    const pr = openPr(w, alice);
    const posted = comment(pr, { created_at: time(NOW - 2 * HOUR) });
    comment(pr, { created_at: time(NOW - HOUR) });
    await evaluate(b, evaluation(pr, { record_comment: posted.id }));
    expect(dispatched()).toEqual([String(posted.id)]);
  });

  it("of each account is recorded", async () => {
    const pr = openPr(w, alice, { commits: [commit(bob)] });
    const [a, c] = [comment(pr, { created_at: time(NOW - HOUR) }), comment(pr, { user: bob, created_at: time(NOW - HOUR) })];
    await evaluate(b, evaluation(pr));
    expect(dispatched()).toEqual([String(a.id), String(c.id)]);
  });

  it("of one account does not have another's recorded early", async () => {
    const pr = openPr(w, alice, { commits: [commit(bob)] });
    const a = comment(pr);
    comment(pr, { user: bob });
    await evaluate(b, evaluation(pr, { record_comment: a.id }));
    expect(dispatched()).toEqual([String(a.id)]);
  });

  it("that is still not recorded after ten minutes is told as late, once per account", async () => {
    const pr = openPr(w, alice);
    const late = "@alice's acceptance was posted but is not in the register yet.";
    comment(pr, { created_at: time(NOW - 10 * MINUTE) });
    comment(pr, { created_at: time(NOW - 10 * MINUTE) });
    await evaluate(b, evaluation(pr));
    const body = () => w.gh.botComments(SANDBOX, pr.number)[0]?.body ?? "";
    expect(body()).not.toContain(late);
    vi.setSystemTime(NOW + 1);
    await evaluate(b, evaluation(pr));
    expect(body().split(late)).toHaveLength(2);
  });

  it("is not waited for once everybody is clear", async () => {
    const pr = openPr(w, alice);
    comment(pr);
    w.gh.setFile("main", "registry/config.json", JSON.stringify({ ...CONFIG, exempt: [...CONFIG.exempt, { id: alice.id, login: "alice", why: "x" }] }));
    await evaluate(b, evaluation(pr));
    expect(queued().map((s) => s.body.kind)).toEqual(["release"]);
  });

  it("by signing in is waited for by account, without a comment", async () => {
    const pr = openPr(w, alice);
    await evaluate(b, evaluation(pr, { await_signin: alice.id }));
    expect(w.gh.dispatches).toEqual([]);
    expect(queued()).toEqual([{ body: { kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: 1, await_signin: alice.id }, delaySeconds: 20 }]);
  });

  it("by signing in of one of several who are missing is waited for", async () => {
    const pr = openPr(w, alice, { commits: [commit(bob)] });
    await evaluate(b, evaluation(pr, { await_signin: bob.id }));
    expect(queued()).toEqual([{ body: { kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: 1, await_signin: bob.id }, delaySeconds: 20 }]);
  });

  it("by signing in is not waited for when that account is not missing", async () => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice, { commits: [commit(bob)] });
    await evaluate(b, evaluation(pr, { await_signin: alice.id }));
    await evaluate(b, evaluation(pr, { await_signin: 999 }));
    expect(queued()).toEqual([]);
  });

  it("by signing in and by comment are both remembered while they are waited for", async () => {
    const pr = openPr(w, alice);
    const c = comment(pr);
    await evaluate(b, evaluation(pr, { record_comment: c.id, await_signin: alice.id, attempt: 1 }));
    expect(queued()[0]?.body).toEqual({ kind: "evaluate", repo: SANDBOX, pr: pr.number, attempt: 2, record_comment: c.id, await_signin: alice.id });
  });

  it("is dispatched with a token of the registry that only runs workflows", async () => {
    const pr = openPr(w, alice);
    comment(pr, { created_at: time(NOW - HOUR) });
    await evaluate(b, evaluation(pr));
    expect(w.gh.seen(/dispatches$/)[0]?.permissions).toEqual({ actions: "write" });
  });

  it("that cannot be dispatched fails the evaluation before anything else is written", async () => {
    const pr = openPr(w, alice);
    comment(pr, { created_at: time(NOW - HOUR) });
    w.gh.answer(/dispatches$/, () => new Response(null, { status: 500 }));
    await expect(evaluate(b, evaluation(pr))).rejects.toMatchObject({ kind: "transient" });
    expect(deeds).toEqual([`POST /repos/${REGISTRY}/actions/workflows/record.yml/dispatches`]);
  });
});

describe("what the texts are made from", () => {
  it("is the Worker's addresses, the configuration and nothing assumed about the checks", async () => {
    const config = await b.registry.config();
    expect(await textContext(b, config, null)).toEqual({ origin: "https://cla.kleidos.dev", registry: REGISTRY, buildCommit: "0123456789abcdef0123456789abcdef01234567", config, recordCommits: new Map(), github: "untouched", autoApprove: false, lateRecording: [], now: new Date(NOW) });
  });

  it("is completed by what the caller knows", async () => {
    expect(await textContext(b, await b.registry.config(), null, { github: "touched", autoApprove: true, lateRecording: [7] })).toMatchObject({ github: "touched", autoApprove: true, lateRecording: [7], origin: "https://cla.kleidos.dev" });
  });

  it("has the commit of each signer's record, and none where it cannot be read", async () => {
    await w.gh.signDirectly(alice);
    w.gh.answer(/commits\?sha=signatures&path=signatures\/individual\/234567/, () => new Response(null, { status: 500 }));
    const a = { signed: new Map([[alice.id, {}], [bob.id, {}]]) } as unknown as Parameters<typeof textContext>[2];
    const ctx = await textContext(b, await b.registry.config(), a);
    expect([...ctx.recordCommits]).toEqual([[alice.id, w.gh.recordCommits.get(alice.id)], [bob.id, null]]);
  });
});

describe("whether a commit changes .github/", () => {
  const head = "a1".repeat(20);
  const state = async () => githubState(b, SANDBOX, BASE_SHA, head, await b.gh.token([SANDBOX], { contents: "read" }));
  const tree = (of: string, data: unknown) => {
    w.gh.answer(new RegExp(`/git/trees/${of}$`), () => json(data));
  };
  const entry = (over: object = {}) => ({ truncated: false, tree: [{ path: "README.md", mode: "100644", type: "blob", sha: "1".repeat(40) }, { path: ".github", mode: "040000", type: "tree", sha: BASE_GITHUB_TREE, ...over }] });

  it("is read from the root trees of the merge base and of the commit, in that order", async () => {
    expect(await state()).toBe("untouched");
    expect(w.gh.seen(/cla-sandbox\/(compare|git)/).map((r) => r.url)).toEqual([`/repos/${SANDBOX}/compare/${BASE_SHA}...${head}?per_page=1`, `/repos/${SANDBOX}/git/trees/${BASE_SHA}`, `/repos/${SANDBOX}/git/trees/${head}`]);
  });

  it("compares with the merge base GitHub names, not with the base given", async () => {
    const other = "c".repeat(40);
    w.gh.answer(/\/compare\//, () => json({ merge_base_commit: { sha: other } }));
    tree(other, entry({ sha: "7".repeat(40) }));
    expect(await state()).toBe("touched");
  });

  it.each([
    ["another tree", { sha: "8".repeat(40) }],
    ["another mode", { mode: "120000" }],
    ["another type", { type: "commit" }],
  ])("is touched by %s", async (_what, over) => {
    tree(head, entry(over));
    expect(await state()).toBe("touched");
  });

  it("is touched by adding it or removing it, and untouched with none at either end", async () => {
    const none = { truncated: false, tree: [{ path: ".github2", mode: "040000", type: "tree", sha: "1".repeat(40) }] };
    tree(head, none);
    expect(await state()).toBe("touched");
    tree(BASE_SHA, none);
    expect(await state()).toBe("untouched");
  });

  it.each([
    ["no merge base", {}],
    ["a merge base with no hash", { merge_base_commit: {} }],
    ["an empty hash", { merge_base_commit: { sha: "" } }],
    ["a short hash", { merge_base_commit: { sha: "c".repeat(39) } }],
    ["a long hash", { merge_base_commit: { sha: "c".repeat(41) } }],
    ["a hash that is a path", { merge_base_commit: { sha: `${"c".repeat(40)}/../x` } }],
    ["a path that ends in a hash", { merge_base_commit: { sha: `x/${"c".repeat(40)}` } }],
  ])("is unknown with %s, and no tree is read", async (_what, data) => {
    w.gh.answer(/\/compare\//, () => json(data));
    expect(await state()).toBe("unknown");
    expect(w.gh.seen(/git\/trees/)).toEqual([]);
  });

  it.each([
    ["is cut", { ...entry(), truncated: true }],
    ["has no list", { truncated: false }],
    ["has a list that is none", { tree: {} }],
  ])("is unknown when a tree %s, at either end", async (_what, data) => {
    for (const end of [head, BASE_SHA]) {
      w.gh.answer(new RegExp(`/git/trees/${end}$`), () => json(data), 1);
      expect(await state()).toBe("unknown");
    }
    expect(await state()).toBe("untouched");
  });

  it.each([
    [404, "unknown"],
    [422, "unknown"],
  ])("is %j -> %s when GitHub does not have it", async (status, answer) => {
    w.gh.answer(/\/compare\//, () => json({}, status));
    expect(await state()).toBe(answer);
  });

  it.each([
    [403, "forbidden"],
    [500, "transient"],
    [401, "unauthorized"],
    [400, "bad_response"],
  ])("is an error on %i, which is retried or told, never an answer", async (status, kind) => {
    w.gh.answer(/\/compare\//, () => json({}, status));
    await expect(state()).rejects.toMatchObject({ kind });
  });

  it("is an error when the Worker's own code fails, whatever the error looks like", async () => {
    w.gh.answer(/git\/trees/, () => json({ tree: [null] }));
    await expect(state()).rejects.toThrow(TypeError);
    vi.spyOn(b.gh, "request").mockRejectedValue({ kind: "not_found" });
    await expect(githubState(b, SANDBOX, BASE_SHA, head, "t")).rejects.toEqual({ kind: "not_found" });
  });
});

describe("a release", () => {
  const ask = (pr: FakePr, over: Partial<Of<"release">> = {}): Of<"release"> => ({ kind: "release", repo: pr.repo, pr: pr.number, sha: pr.head.sha, ...over });
  const run = (pr: FakePr, over: Partial<World["gh"]["runs"][number]> = {}) => {
    const r = { id: w.gh.next(), repo: pr.repo, head_sha: pr.head.sha, head_repository: pr.head.repo, status: "action_required", approved: false, ...over };
    w.gh.runs.push(r);
    return r;
  };
  const ready = () => {
    const pr = openPr(w, alice);
    check(pr);
    return pr;
  };
  const approvals = () => w.gh.seen(/\/approve$/).map((r) => r.url);

  it("approves every held run of that commit from the pull request's own repository", async () => {
    const pr = ready();
    const runs = [run(pr), run(pr)];
    await release(b, ask(pr));
    expect(approvals()).toEqual(runs.map((r) => `/repos/${SANDBOX}/actions/runs/${r.id}/approve`));
    expect(runs.every((r) => r.approved)).toBe(true);
    expect(logged()).toEqual([{ msg: "released", repo: SANDBOX, pr: pr.number, count: 2, attempt: 0 }]);
    expect(queued()).toEqual([]);
  });

  it("works with a token that approves runs and reads the rest", async () => {
    await release(b, ask(ready()));
    expect(tokens().at(-1)).toEqual({ actions: "write", pull_requests: "read", checks: "read", contents: "read" });
  });

  it.each([
    ["is not served", "kleidos-dev/boards"],
    ["does not approve by itself", REGISTRY],
  ])("in a repository that %s does nothing, and buys no token for it", async (_what, repo) => {
    w.gh.addRepo("kleidos-dev/boards");
    const pr = openPr(w, alice, { repo });
    check(pr);
    run(pr);
    await release(b, ask(pr));
    expect(tokens()).toEqual([{ contents: "read" }]);
    expect([approvals(), logged(), queued()]).toEqual([[], [], []]);
  });

  it.each([
    ["closed", (pr: FakePr) => (pr.state = "closed")],
    ["of another head by now", (pr: FakePr) => (pr.head = { ...pr.head, sha: sha() })],
  ])("of a pull request %s approves nothing", async (_what, change) => {
    const pr = ready();
    const msg = ask(pr);
    const r = run(pr);
    change(pr);
    await release(b, msg);
    expect(r.approved).toBe(false);
    expect(logged()).toEqual([{ msg: "release skipped", repo: SANDBOX, pr: pr.number, reason: "head_moved_or_closed" }]);
    expect(w.gh.seen(/check-runs/)).toEqual([]);
  });

  it.each([
    ["is missing", []],
    ["asks for action", [{ conclusion: "action_required", app: { id: APP_ID } }]],
    ["has not concluded", [{ conclusion: null, app: { id: APP_ID } }]],
    ["is another app's success", [{ conclusion: "success", app: { id: APP_ID + 1 } }]],
    ["is nobody's success", [{ conclusion: "success", app: null }]],
    ["is another app's success beside our own refusal", [{ conclusion: "success", app: { id: 1 } }, { conclusion: "action_required", app: { id: APP_ID } }]],
  ])("whose check %s approves nothing", async (_what, check_runs) => {
    const pr = openPr(w, alice);
    const r = run(pr);
    w.gh.answer(/\/check-runs/, () => json({ check_runs }));
    await release(b, ask(pr));
    expect(r.approved).toBe(false);
    expect(logged()).toEqual([{ msg: "release skipped", repo: SANDBOX, pr: pr.number, reason: "check_not_success" }]);
    expect(w.gh.seen(/compare/)).toEqual([]);
  });

  it("reads the check of the commit it was asked about", async () => {
    const pr = ready();
    await release(b, ask(pr));
    expect(w.gh.seen(/check-runs/)[0]?.url).toBe(`/repos/${SANDBOX}/commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${APP_ID}&filter=latest`);
  });

  it.each([
    ["changes .github/", "touches_github", () => "8".repeat(40)],
    ["may change .github/", "github_unknown", () => null],
  ])("of a commit that %s approves nothing", async (_what, reason, tree) => {
    const pr = ready();
    const r = run(pr);
    const t = tree();
    if (t) w.gh.githubTrees.set(pr.head.sha, t);
    else w.gh.answer(/\/compare\//, () => json({}, 404));
    await release(b, ask(pr));
    expect(r.approved).toBe(false);
    expect(logged()).toEqual([{ msg: "release skipped", repo: SANDBOX, pr: pr.number, reason }]);
    expect(w.gh.seen(/actions\/runs/)).toEqual([]);
  });

  it.each([
    ["of another commit", { head_sha: "f".repeat(40) }],
    ["of another fork", { head_repository: { full_name: "mallory/cla-sandbox" } }],
    ["of no repository", { head_repository: null }],
  ])("never approves a run %s, whatever GitHub lists", async (_what, over) => {
    const pr = ready();
    w.gh.answer(/\/actions\/runs\?/, () => json({ workflow_runs: [{ id: 1, head_sha: pr.head.sha, head_repository: { full_name: pr.head.repo }, ...over }] }));
    await release(b, ask(pr));
    expect(approvals()).toEqual([]);
    expect(logged()[0]).toMatchObject({ msg: "released", count: 0 });
  });

  it("of a pull request whose fork is gone approves nothing, not even a run of no repository", async () => {
    const pr = ready();
    w.gh.answer(new RegExp(`^GET /repos/${SANDBOX}/pulls/${pr.number}$`), () => json({ number: pr.number, state: "open", head: { sha: pr.head.sha, repo: null }, base: { sha: BASE_SHA } }));
    w.gh.answer(/\/actions\/runs\?/, () => json({ workflow_runs: [{ id: 1, head_sha: pr.head.sha, head_repository: null }, { id: 2, head_sha: pr.head.sha, head_repository: { full_name: "x/y" } }] }));
    await release(b, ask(pr));
    expect(approvals()).toEqual([]);
  });

  const hosted = ["ubuntu-latest", "ubuntu-24.04", "windows-2025", "macos-15-xlarge", "ubuntu-24.04-arm", `ubuntu-${"a".repeat(40)}`];
  it.each(hosted)("approves a run on GitHub's own runners: %s", async (label) => {
    const pr = ready();
    const r = run(pr, { jobs: [{ labels: [label], runner_group_name: null }, { labels: [label], runner_group_name: "GitHub Actions" }, { labels: [label] }] });
    await release(b, ask(pr));
    expect(r.approved).toBe(true);
    expect(w.gh.seen(/\/jobs/)[0]?.url).toBe(`/repos/${SANDBOX}/actions/runs/${r.id}/jobs?per_page=100`);
  });

  it.each([
    ["self-hosted", { labels: ["self-hosted"] }],
    ["one label of its own beside a hosted one", { labels: ["ubuntu-latest", "bench"] }],
    ["a label that only starts like a hosted one", { labels: ["ubuntu-latest bench"] }],
    ["a label that only ends like a hosted one", { labels: ["bench-ubuntu-latest"] }],
    ["a label without a version", { labels: ["ubuntu-"] }],
    ["a label too long", { labels: [`ubuntu-${"a".repeat(41)}`] }],
    ["another runner group", { labels: ["ubuntu-latest"], runner_group_name: "bench" }],
    ["a group with no name", { labels: ["ubuntu-latest"], runner_group_name: "" }],
    ["a group and no labels", { runner_group_name: "bench" }],
  ])("never approves a run that may reach a self-hosted runner: %s", async (_what, job) => {
    const pr = ready();
    const bad = run(pr, { jobs: [{ labels: ["ubuntu-latest"] }, job] });
    const good = run(pr);
    await release(b, ask(pr));
    expect([bad.approved, good.approved]).toEqual([false, true]);
    expect(logged()).toEqual([
      { msg: "approve refused", repo: SANDBOX, pr: pr.number, reason: "self_hosted" },
      { msg: "released", repo: SANDBOX, pr: pr.number, count: 2, attempt: 0 },
    ]);
  });

  it("approves a run whose jobs do not exist yet, or name no label", async () => {
    const pr = ready();
    const r = run(pr, { jobs: [{ runner_group_name: null }] });
    await release(b, ask(pr));
    expect(r.approved).toBe(true);
    for (const none of [{}, { jobs: null }]) {
      const later = run(pr);
      w.gh.answer(/\/jobs/, () => json(none), 1);
      await release(b, ask(pr));
      expect(later.approved).toBe(true);
    }
  });

  it.each([
    [403, "forbidden"],
    [422, "unprocessable"],
  ])("goes on to the next run when GitHub refuses one (%i)", async (status, _kind) => {
    const pr = ready();
    const refused = run(pr);
    const next = run(pr);
    w.gh.answer(new RegExp(`/runs/${refused.id}/approve$`), () => json({}, status));
    await release(b, ask(pr));
    expect([refused.approved, next.approved]).toEqual([false, true]);
    expect(logged()[0]).toEqual({ msg: "approve refused", repo: SANDBOX, pr: pr.number, status });
  });

  it.each([401, 404, 429, 500])("stops, to be retried or told, on any other failure (%i)", async (status) => {
    const pr = ready();
    const r = run(pr);
    run(pr);
    w.gh.answer(new RegExp(`/runs/${r.id}/approve$`), () => json({}, status));
    await expect(release(b, ask(pr))).rejects.toBeInstanceOf(GitHubError);
    expect(approvals()).toHaveLength(1);
    expect(queued()).toEqual([]);
  });

  it("stops when the Worker's own code fails", async () => {
    const pr = ready();
    run(pr);
    // It looks like GitHub's refusal and is not.
    const bug = Object.assign(new TypeError("bug"), { kind: "forbidden" });
    const request = b.gh.request.bind(b.gh);
    vi.spyOn(b.gh, "request").mockImplementation((method, url, ...rest) => (url.endsWith("/approve") ? Promise.reject(bug) : request(method, url, ...rest)));
    await expect(release(b, ask(pr))).rejects.toBe(bug);
  });

  it.each([
    [undefined, 30],
    [0, 30],
    [1, 60],
    [2, 120],
  ])("that finds no held run at look %j looks again in %i seconds", async (attempt, delaySeconds) => {
    const pr = ready();
    await release(b, ask(pr, attempt === undefined ? {} : { attempt }));
    expect(queued()).toEqual([{ body: ask(pr, { attempt: (attempt ?? 0) + 1 }), delaySeconds }]);
    expect(logged()).toEqual([{ msg: "released", repo: SANDBOX, pr: pr.number, count: 0, attempt: attempt ?? 0 }]);
    expect(RELEASE_DELAYS).toHaveLength(3);
  });

  it("that finds none at the fourth look stops looking", async () => {
    await release(b, ask(ready(), { attempt: 3 }));
    expect(queued()).toEqual([]);
  });

  it("that finds one does not look again, approved or not", async () => {
    const pr = ready();
    run(pr, { jobs: [{ labels: ["bench"] }] });
    await release(b, ask(pr));
    expect(queued()).toEqual([]);
  });
});

describe("a held run", () => {
  it("has the open pull requests of its commit evaluated, and no other", async () => {
    const pr = openPr(w, alice);
    const twin = openPr(w, bob);
    twin.head.sha = pr.head.sha;
    openPr(w, bob);
    await held(b, { kind: "held", repo: SANDBOX, sha: pr.head.sha });
    expect(send.mock.calls).toEqual([
      [{ kind: "evaluate", repo: SANDBOX, pr: pr.number }, undefined],
      [{ kind: "evaluate", repo: SANDBOX, pr: twin.number }, undefined],
    ]);
    expect(tokens().at(-1)).toEqual({ pull_requests: "read" });
  });

  it("of a commit of no open pull request does nothing", async () => {
    openPr(w, alice);
    await held(b, { kind: "held", repo: SANDBOX, sha: sha() });
    expect(queued()).toEqual([]);
  });

  it("in a repository that is not served does nothing", async () => {
    await held(b, { kind: "held", repo: "kleidos-dev/boards", sha: sha() });
    expect(tokens()).toEqual([{ contents: "read" }]);
    expect(queued()).toEqual([]);
  });

  it("reads three pages of pull requests at most", async () => {
    const list = Array.from({ length: 301 }, () => openPr(w, alice));
    for (const pr of list) pr.head.sha = "c".repeat(40);
    await held(b, { kind: "held", repo: SANDBOX, sha: "c".repeat(40) });
    expect(queued()).toHaveLength(300);
  });
});

describe("a merged pull request", () => {
  it("has its coverage recorded", async () => {
    await coverage(b, { kind: "coverage", repo: SANDBOX, pr: 7 });
    expect(w.gh.dispatches).toEqual([{ kind: "coverage", repo: SANDBOX, pr: "7", comment_id: "" }]);
  });

  it("of a repository that is not served has not", async () => {
    await coverage(b, { kind: "coverage", repo: "kleidos-dev/boards", pr: 7 });
    expect(w.gh.dispatches).toEqual([]);
  });

  it("of a name every object has is not served", async () => {
    await coverage(b, { kind: "coverage", repo: "kleidos-dev/cla-sandbox2", pr: 7 });
    expect(w.gh.dispatches).toEqual([]);
  });
});

describe("an installation", () => {
  it("on an allowed account stays", async () => {
    await installation(b, { kind: "installation", installation: 1 });
    expect(w.gh.deletedInstallations).toEqual([]);
    expect(w.gh.requests).toEqual([{ method: "GET", url: "/app/installations/1", auth: "jwt" }]);
    expect(logged()).toEqual([]);
  });

  it("on any other account is removed, as it is read now and not as the message said", async () => {
    w.gh.installations.set(66, { account: 4242 });
    await installation(b, { kind: "installation", installation: 66 });
    expect(w.gh.deletedInstallations).toEqual([66]);
    expect(logged()).toEqual([{ msg: "installation removed", installation: 66 }]);
  });

  it("on no account is removed", async () => {
    w.gh.installations.set(66, { account: 4242 });
    w.gh.answer(/^GET \/app\/installations\/66$/, () => json({ id: 66, account: null }));
    await installation(b, { kind: "installation", installation: 66 });
    expect(w.gh.deletedInstallations).toEqual([66]);
  });

  it("is never removed on an empty allowlist", async () => {
    w.gh.installations.set(66, { account: 4242 });
    w.env.ALLOWED_ACCOUNT_IDS = "";
    await expect(installation(b, { kind: "installation", installation: 66 })).rejects.toThrow("ALLOWED_ACCOUNT_IDS is empty");
    expect(w.gh.deletedInstallations).toEqual([]);
  });

  it("that is already gone is an error, and nothing is removed", async () => {
    await expect(installation(b, { kind: "installation", installation: 67 })).rejects.toMatchObject({ kind: "not_found" });
    expect(w.gh.deletedInstallations).toEqual([]);
  });
});

describe("a message", () => {
  it("of each kind goes to its own handler", async () => {
    const pr = openPr(w, alice);
    w.gh.installations.set(66, { account: 4242 });
    await handleMessage(b, evaluation(pr));
    expect(deeds).toEqual([`POST /repos/${SANDBOX}/check-runs`, `POST /repos/${SANDBOX}/issues/${pr.number}/comments`]);
    deeds.length = 0;
    await handleMessage(b, { kind: "release", repo: SANDBOX, pr: pr.number, sha: pr.head.sha });
    expect(logged().at(-1)).toMatchObject({ msg: "release skipped", reason: "check_not_success" });
    await handleMessage(b, { kind: "held", repo: SANDBOX, sha: pr.head.sha });
    await handleMessage(b, { kind: "coverage", repo: SANDBOX, pr: 7 });
    await handleMessage(b, { kind: "installation", installation: 66 });
    expect(deeds).toEqual(["send evaluate", `POST /repos/${REGISTRY}/actions/workflows/record.yml/dispatches`, "DELETE /app/installations/66"]);
  });

  it("that fails is passed on to the queue", async () => {
    await expect(handleMessage(b, { kind: "installation", installation: 67 })).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("the cron", () => {
  const delivery = (over: Partial<World["gh"]["deliveries"][number]> = {}) => {
    const d = { id: w.gh.next(), guid: `g${w.gh.next()}`, status_code: 500, delivered_at: time(NOW - HOUR), redelivery: false, ...over };
    w.gh.deliveries.push(d);
    return d;
  };
  const merged = (age: number, over: Partial<FakePr> = {}) => {
    const pr = openPr(w, alice);
    Object.assign(pr, { state: "closed", merged: true, merged_at: time(NOW - age), ...over });
    return pr;
  };
  const coverageAsked = () => queued().flatMap((s) => (s.body.kind === "coverage" ? [s.body.pr] : []));
  /** CONFIG serves two repositories; these tests look at one, and from a day before everything they merge. */
  const only = (repos: string[] = [SANDBOX], over: object = { coverage_from: "2026-11-01" }) => {
    w.gh.setFile("main", "registry/config.json", JSON.stringify({ ...CONFIG, coverage_from: undefined, served_repositories: Object.fromEntries(repos.map((r) => [r, { auto_approve: true }])), ...over }));
  };

  it("with nothing to do reads, writes nothing and says so", async () => {
    await cron(b);
    expect(w.gh.writes()).toEqual([]);
    expect(queued()).toEqual([]);
    expect(logged()).toEqual([{ msg: "cron done", count: 0, outcome: "coverage_0" }]);
    expect(w.gh.seen(/^GET \/app/)).toEqual([
      { method: "GET", url: "/app/installations?per_page=100", auth: "jwt" },
      { method: "GET", url: "/app/hook/deliveries?per_page=100", auth: "jwt" },
    ]);
  });

  it("looks at every installation and queues the ones that are not allowed", async () => {
    w.gh.answer(/^GET \/app\/installations\?/, () => json([{ id: 1, account: { id: 357318718 } }, { id: 66, account: { id: 4242 } }, { id: 67, account: null }]));
    await cron(b);
    expect(send.mock.calls).toEqual([
      [{ kind: "installation", installation: 66 }, undefined],
      [{ kind: "installation", installation: 67 }, undefined],
    ]);
    expect(w.gh.deletedInstallations).toEqual([]);
  });

  it("touches nothing on an empty allowlist", async () => {
    w.env.ALLOWED_ACCOUNT_IDS = "";
    await expect(cron(b)).rejects.toThrow("ALLOWED_ACCOUNT_IDS is empty");
    expect(w.gh.requests).toEqual([]);
  });

  it("asks again for the deliveries that failed, once each", async () => {
    only([]);
    const list = [delivery(), delivery({ status_code: 0 }), delivery({ status_code: 199 }), delivery({ status_code: 300 }), delivery({ status_code: 404 })];
    for (const status_code of [200, 202, 299]) delivery({ status_code });
    await cron(b);
    expect(w.gh.redelivered).toEqual(list.map((d) => d.id));
    expect(logged()).toEqual([{ msg: "cron done", count: 5, outcome: "coverage_0" }]);
  });

  it("not for one that another attempt delivered, nor for an attempt of its own", async () => {
    only([]);
    delivery({ guid: "a" });
    delivery({ guid: "a", status_code: 202, redelivery: true });
    delivery({ guid: "b", redelivery: true });
    await cron(b);
    expect(w.gh.redelivered).toEqual([]);
  });

  it("not twice for one that failed twice", async () => {
    only([]);
    const first = delivery({ guid: "a" });
    delivery({ guid: "a" });
    await cron(b);
    expect(w.gh.redelivered).toEqual([first.id]);
  });

  it("not for one of seven hours ago, which the cron before this one saw", async () => {
    only([]);
    delivery({ delivered_at: time(NOW - 7 * HOUR) });
    const inside = delivery({ delivered_at: time(NOW - 7 * HOUR + 1000) });
    await cron(b);
    expect(w.gh.redelivered).toEqual([inside.id]);
  });

  it("for fifty at most", async () => {
    only([]);
    const list = Array.from({ length: 51 }, () => delivery());
    await cron(b);
    expect(w.gh.redelivered).toEqual(list.slice(0, 50).map((d) => d.id));
    expect(logged()[0]).toMatchObject({ count: 50 });
  });

  it("a repeated one does not count towards the fifty", async () => {
    only([]);
    const first = delivery({ guid: "a" });
    delivery({ guid: "a" });
    const rest = Array.from({ length: 49 }, () => delivery());
    await cron(b);
    expect(w.gh.redelivered).toEqual([first.id, ...rest.map((d) => d.id)]);
  });

  it("one that GitHub refuses to repeat does not stop the others", async () => {
    only([]);
    const refused = delivery();
    const next = delivery();
    w.gh.answer(new RegExp(`/deliveries/${refused.id}/attempts$`), () => new Response(null, { status: 422 }));
    await cron(b);
    expect(w.gh.redelivered).toEqual([next.id]);
  });

  it("reads five pages of deliveries, the newest first", async () => {
    only([]);
    for (let i = 0; i < 500; i++) delivery({ status_code: 200 });
    delivery();
    await cron(b);
    expect(w.gh.redelivered).toEqual([]);
    expect(w.gh.seen(/deliveries\?/)).toHaveLength(5);
  });

  it("evaluates every open pull request of every served repository", async () => {
    const [a, c, other] = [openPr(w, alice), openPr(w, alice), openPr(w, alice, { repo: REGISTRY })];
    openPr(w, alice, { repo: "kleidos-dev/boards" });
    await cron(b);
    const asked = queued().map((s) => s.body);
    expect(asked).toEqual([
      { kind: "evaluate", repo: REGISTRY, pr: other.number },
      { kind: "evaluate", repo: SANDBOX, pr: a.number },
      { kind: "evaluate", repo: SANDBOX, pr: c.number },
    ]);
    expect(send.mock.calls[0]).toEqual([{ kind: "evaluate", repo: REGISTRY, pr: other.number }, undefined]);
    expect(tokens()).toEqual([{ contents: "read" }, { pull_requests: "read" }, { pull_requests: "read" }]);
  });

  it("asks for the coverage of a merged pull request that has none", async () => {
    only();
    const [covered, missing] = [merged(HOUR), merged(HOUR)];
    w.gh.setFile("signatures", `coverage/${SANDBOX}/${covered.number}.json`, "{}");
    await cron(b);
    expect(send.mock.calls).toEqual([[{ kind: "coverage", repo: SANDBOX, pr: missing.number }, undefined]]);
    expect(logged()).toEqual([{ msg: "cron done", count: 0, outcome: "coverage_1" }]);
  });

  it("of half an hour ago, when its own run had time, to seven days ago", async () => {
    only();
    merged(30 * MINUTE);
    const young = merged(30 * MINUTE + 1000);
    const old = merged(7 * DAY - 1000);
    merged(7 * DAY);
    await cron(b);
    expect(coverageAsked()).toEqual([young.number, old.number]);
    expect(logged()[0]).toMatchObject({ outcome: "coverage_2" });
  });

  it("not of one closed without merging", async () => {
    only();
    merged(HOUR, { merged: false, merged_at: null });
    await cron(b);
    expect(coverageAsked()).toEqual([]);
  });

  it("not of one merged before the register keeps coverage", async () => {
    only([SANDBOX], { coverage_from: "2026-11-23" });
    const [before, from] = [merged(0, { merged_at: "2026-11-22T23:59:59Z" }), merged(0, { merged_at: "2026-11-23T00:00:00Z" })];
    await cron(b);
    expect(coverageAsked()).toEqual([from.number]);
    expect(before.number).not.toBe(from.number);
  });

  it("of any date when the register does not say from when", async () => {
    only([SANDBOX], {});
    const pr = merged(HOUR);
    await cron(b);
    expect(coverageAsked()).toEqual([pr.number]);
  });

  it("and reads no coverage directory when nothing was merged", async () => {
    only();
    openPr(w, alice);
    merged(30 * MINUTE);
    await cron(b);
    expect(w.gh.seen(/coverage/)).toEqual([]);
  });

  it("of one behind a hundred that changed after it is asked for too, and behind three hundred is not", async () => {
    only();
    const behind = merged(HOUR, { updated_at: time(NOW - HOUR) });
    const later = (n: number) => {
      for (let i = 0; i < n; i++) merged(HOUR, { merged: false, merged_at: null, updated_at: time(NOW) });
    };
    later(299);
    await cron(b);
    expect(coverageAsked()).toEqual([behind.number]);
    expect(w.gh.seen(/state=closed/)).toHaveLength(3);
    later(1);
    w.queue.sent.length = 0;
    await cron(b);
    expect(coverageAsked()).toEqual([]);
  });

  it("of one whose record is past the thousand files GitHub lists is not asked for again", async () => {
    only();
    const [covered, missing] = [merged(HOUR, { updated_at: time(NOW) }), merged(HOUR)];
    w.gh.answer(new RegExp(`/contents/coverage/${SANDBOX}\\?`), () => json(Array.from({ length: 1000 }, (_, i) => ({ name: `${100_000 + i}.json`, type: "file" }))));
    w.gh.setFile("signatures", `coverage/${SANDBOX}/${covered.number}.json`, "{}");
    await cron(b);
    expect(coverageAsked()).toEqual([missing.number]);
  });

  it("goes on to the next repository when the app is not installed on one, or on an account not allowed", async () => {
    w.gh.addRepo("stranger/repo", { installation: 9, account: 4242 });
    only(["kleidos-dev/gone", "stranger/repo", SANDBOX]);
    const pr = openPr(w, alice);
    await cron(b);
    expect(queued().map((s) => s.body)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: pr.number }]);
    expect(logged()[0]).toMatchObject({ msg: "cron done" });
  });

  it.each([500, 403, 401])("stops at a repository that fails otherwise (%i), and what was queued stays", async (status) => {
    only([REGISTRY, SANDBOX]);
    const first = openPr(w, alice, { repo: REGISTRY });
    w.gh.answer(new RegExp(`^GET /repos/${SANDBOX}/pulls`), () => new Response(null, { status }));
    await expect(cron(b)).rejects.toBeInstanceOf(GitHubError);
    expect(queued().map((s) => s.body)).toEqual([{ kind: "evaluate", repo: REGISTRY, pr: first.number }]);
    expect(logged()).toEqual([]);
  });

  it("stops at an error of the Worker's own, whatever it looks like", async () => {
    only();
    const bug = Object.assign(new TypeError("bug"), { kind: "not_found" });
    vi.spyOn(b.registry, "coverageNumbers").mockRejectedValue(bug);
    merged(HOUR);
    await expect(cron(b)).rejects.toBe(bug);
  });
});
