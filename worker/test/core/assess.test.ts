// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/** Who must sign a pull request, who has, and what still blocks it, read from GitHub and changing nothing there. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assessment, IssueComment, PullRequest } from "../../src/assess";
import { CHECK_NAME, HeadMovedError, MARKER, MAX_COMMITS, acceptedSentences, allClear, assess, isBotComment } from "../../src/assess";
import { makeBot } from "../../src/bot";
import type { ConfiguredEnv } from "../../src/env";
import type { Config } from "../../src/registry";
import type { FakeComment, FakePr, User } from "../fakegh";
import { APP_ID, BOT_ID, commit, sha } from "../fakegh";
import type { World } from "../helpers";
import { CONFIG, CONFIG_V2, SANDBOX, openPr, world } from "../helpers";

const alice = { id: 123456, login: "alice", type: "User" as const };
const bob = { id: 234567, login: "bob", type: "User" as const };
const carol = { id: 345678, login: "carol", type: "User" as const };
const bot = { id: 555, login: "some-bot[bot]", type: "Bot" as const };
const org = { id: 777, login: "some-org", type: "Organization" as const };
const exempt = { id: 49699333, login: "dependabot[bot]", type: "Bot" as const };
const SENTENCE = CONFIG.versions["1"].sentence;

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function assessed(pr: FakePr, config: unknown = CONFIG): Promise<Assessment> {
  const b = makeBot(w.env as ConfiguredEnv);
  const token = await b.gh.token([pr.repo], { pull_requests: "write", checks: "write", contents: "read" });
  return assess(b.gh, b.registry, config as Config, pr.repo, pr.number, token);
}
const ids = (xs: { id: number }[]) => xs.map((x) => x.id);
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

function comment(pr: FakePr, over: Partial<FakeComment> = {}): FakeComment {
  const c: FakeComment = { id: w.gh.next(), repo: pr.repo, pr: pr.number, body: SENTENCE, user: alice, created_at: "2026-11-21T10:00:00Z", updated_at: "2026-11-21T10:00:00Z", via_app: false, ...over };
  w.gh.comments.push(c);
  return c;
}

/** Plays one page of commits after another, as GitHub would answer the query. */
function pages(pr: FakePr, ...list: { nodes: FakePr["commits"]; total: number; next?: string | null; more?: boolean; head?: string }[]) {
  let i = 0;
  w.gh.answer(/^POST \/graphql$/, () => {
    const p = list[Math.min(i++, list.length - 1)];
    if (i > 9) throw new Error("asked without end");
    return json({ data: { repository: { pullRequest: { headRefOid: p?.head ?? pr.head.sha, commits: { totalCount: p?.total, pageInfo: { hasNextPage: p?.more ?? false, endCursor: p?.next ?? null }, nodes: p?.nodes.map((c) => ({ commit: c })) } } } } });
  });
}
const queries = () => w.gh.seen(/^POST \/graphql$/).map((r) => (r.body as { variables: unknown }).variables);

describe("what names the bot's work", () => {
  it("is the check, the comment's marker and the number of commits GitHub lists", () => {
    expect([CHECK_NAME, MARKER, MAX_COMMITS]).toEqual(["📝 CLA", "<!-- kleidos-cla:v1 -->", 250]);
    expect(new HeadMovedError().message).toBe("head moved");
  });
});

describe("who must sign", () => {
  it("is the opener and every author, each once, in the order they are found", async () => {
    const pr = openPr(w, alice, { commits: [commit(bob, { coAuthors: [carol] }), commit(alice), commit(bob)] });
    const a = await assessed(pr);
    expect(a.required).toEqual([alice, bob, carol]);
    expect(a).toMatchObject({ repo: SANDBOX, opener: alice, exempt: [], entityCovered: [], unknownCommits: [], unlistedBots: [], tooManyCommits: false, acceptances: [], botComment: null });
    expect(a.pr).toMatchObject({ number: pr.number, state: "open", head: { sha: pr.head.sha } });
    expect(ids(a.missing)).toEqual([alice.id, bob.id, carol.id]);
    expect(a.signed.size).toBe(0);
  });

  it("is read and nothing is written", async () => {
    await assessed(openPr(w, alice));
    expect(w.gh.writes()).toEqual([]);
  });

  it("is nobody who is exempt, and why is told", async () => {
    const pr = openPr(w, exempt, { commits: [commit(exempt), commit(alice)] });
    const a = await assessed(pr);
    expect(a.exempt).toEqual([{ account: exempt, why: "Kleidos automation" }]);
    expect(a.required).toEqual([alice]);
  });

  it("is exempt by its id and never by its login", async () => {
    const pr = openPr(w, { id: 666, login: "dependabot[bot]", type: "Bot" }, { commits: [commit({ id: 667, login: "jmrplens", type: "User" })] });
    const a = await assessed(pr);
    expect(a.exempt).toEqual([]);
    expect(ids(a.required)).toEqual([667]);
    expect(a.unlistedBots).toEqual([{ login: "dependabot[bot]", commit: "" }]);
  });

  it("is exempt even when the reason is empty", async () => {
    const a = await assessed(openPr(w, alice), { ...CONFIG, exempt: [{ id: alice.id, login: "alice", why: "" }] });
    expect(a.exempt).toEqual([{ account: alice, why: "" }]);
    expect(a.required).toEqual([]);
  });

  it.each([
    ["a bot", bot, "Bot"],
    ["an organization", org, "Organization"],
  ])("is not %s, which cannot sign: a maintainer looks", async (_what, opener, type) => {
    const a = await assessed(openPr(w, opener, { commits: [commit(alice)] }));
    expect(a.opener).toEqual({ ...opener, type });
    expect(a.unlistedBots).toEqual([{ login: opener.login, commit: "" }]);
    expect(ids(a.required)).toEqual([alice.id]);
    expect(allClear(a)).toBe(false);
  });

  it("an opener of a type nobody knows is a person, who signs", async () => {
    const a = await assessed(openPr(w, { ...alice, type: "Mannequin" as User["type"] }));
    expect(a.opener).toEqual(alice);
    expect(ids(a.required)).toEqual([alice.id]);
  });

  it("is also whoever opened another pull request with the same head commit, which shares its check", async () => {
    const pr = openPr(w, alice);
    const twin = openPr(w, bob, { commits: pr.commits });
    twin.head.sha = pr.head.sha;
    expect(ids((await assessed(pr)).required)).toEqual([alice.id, bob.id]);
  });

  it("is not the opener of an unrelated pull request, nor of a closed one, nor of one elsewhere", async () => {
    const pr = openPr(w, alice);
    openPr(w, bob);
    const closed = openPr(w, carol);
    Object.assign(closed, { state: "closed", head: { ...closed.head, sha: pr.head.sha } });
    const elsewhere = openPr(w, carol, { repo: "kleidos-dev/cla" });
    elsewhere.head.sha = pr.head.sha;
    expect(ids((await assessed(pr)).required)).toEqual([alice.id]);
  });

  it("a closed pull request is assessed without looking for others of its head", async () => {
    const pr = openPr(w, alice);
    pr.state = "closed";
    const twin = openPr(w, bob);
    twin.head.sha = pr.head.sha;
    expect(ids((await assessed(pr)).required)).toEqual([alice.id]);
    expect(w.gh.seen(/\/pulls\?/)).toEqual([]);
  });

  it("the opener is not asked twice for being in the list of open pull requests", async () => {
    const pr = openPr(w, alice, { commits: [commit(bob)] });
    pr.created_at = "2026-11-03T09:00:00Z";
    w.gh.setFile("main", "registry/entities.json", entities([{ github_id: alice.id, from: "2026-11-03", until: "2026-11-03" }]));
    expect((await assessed(pr)).entityCovered).toEqual([{ account: alice, entity: "Example GmbH" }]);
  });
});

const entities = (covered: { github_id: number; from: string; until?: string }[], more: object[] = []) =>
  JSON.stringify({ schema: 1, entities: [{ slug: "example", name: "Example GmbH", version: 1, set_sha256: CONFIG.versions["1"].set_sha256, signed_at: "2026-11-01", covered }, ...more] });

describe("who an entity covers", () => {
  it("signs nothing, on the dates of every one of their commits", async () => {
    w.gh.setFile("main", "registry/entities.json", entities([{ github_id: bob.id, from: "2026-11-05", until: "2026-11-10" }]));
    const pr = openPr(w, alice, { commits: [commit(bob, { date: "2026-11-05T23:59:59Z" }), commit(bob, { date: "2026-11-10T00:00:00Z" })] });
    const a = await assessed(pr);
    expect(a.entityCovered).toEqual([{ account: bob, entity: "Example GmbH" }]);
    expect(ids(a.required)).toEqual([alice.id]);
  });

  it("signs as soon as one commit is outside the dates", async () => {
    w.gh.setFile("main", "registry/entities.json", entities([{ github_id: bob.id, from: "2026-11-05", until: "2026-11-10" }]));
    const pr = openPr(w, alice, { commits: [commit(bob, { date: "2026-11-06T10:00:00Z" }), commit(bob, { date: "2026-11-11T00:00:00Z" })] });
    const a = await assessed(pr);
    expect(a.entityCovered).toEqual([]);
    expect(ids(a.required)).toEqual([alice.id, bob.id]);
  });

  it("the opener is dated by the pull request, the opener of another of the same head by that one", async () => {
    w.gh.setFile("main", "registry/entities.json", entities([{ github_id: alice.id, from: "2026-11-06", until: "2026-11-06" }, { github_id: bob.id, from: "2026-11-07", until: "2026-11-07" }]));
    const pr = openPr(w, alice, { commits: [commit(carol)] });
    pr.created_at = "2026-11-06T09:00:00Z";
    const twin = openPr(w, bob, { commits: pr.commits });
    Object.assign(twin, { created_at: "2026-11-07T09:00:00Z", head: { ...twin.head, sha: pr.head.sha } });
    const a = await assessed(pr);
    expect(a.entityCovered.map((e) => e.account.id)).toEqual([alice.id, bob.id]);
    expect(ids(a.required)).toEqual([carol.id]);
  });

  it("is named after the entity that covers the first date", async () => {
    const other = { slug: "other", name: "Other SL", version: 1, set_sha256: CONFIG.versions["1"].set_sha256, signed_at: "2026-11-01", covered: [{ github_id: bob.id, from: "2026-11-11" }] };
    w.gh.setFile("main", "registry/entities.json", entities([{ github_id: bob.id, from: "2026-11-05", until: "2026-11-10" }], [other]));
    const pr = openPr(w, alice, { commits: [commit(bob, { date: "2026-11-06T10:00:00Z" }), commit(bob, { date: "2026-11-12T10:00:00Z" })] });
    expect((await assessed(pr)).entityCovered).toEqual([{ account: bob, entity: "Example GmbH" }]);
  });

  it("is a bot as well as a person, and an exemption comes first", async () => {
    w.gh.setFile("main", "registry/entities.json", entities([{ github_id: bot.id, from: "2026-01-01" }, { github_id: exempt.id, from: "2026-01-01" }]));
    const a = await assessed(openPr(w, bot, { commits: [commit(exempt)] }));
    expect(a.entityCovered).toEqual([{ account: bot, entity: "Example GmbH" }]);
    expect(ids(a.exempt.map((e) => e.account))).toEqual([exempt.id]);
    expect(a.unlistedBots).toEqual([]);
  });
});

describe("who signed", () => {
  it("is every required account with a record that counts", async () => {
    await w.gh.signDirectly(alice);
    const a = await assessed(openPr(w, alice, { commits: [commit(bob)] }));
    expect([...a.signed.keys()]).toEqual([alice.id]);
    expect(a.signed.get(alice.id)).toMatchObject({ github_id: alice.id, version: 1 });
    expect(ids(a.missing)).toEqual([bob.id]);
  });

  it("is not who signed a version that is no longer accepted", async () => {
    await w.gh.signDirectly(alice);
    const a = await assessed(openPr(w, alice), { ...CONFIG_V2, accepted_versions: [2] });
    expect(a.signed.size).toBe(0);
    expect(ids(a.missing)).toEqual([alice.id]);
  });

  it("is only asked of the accounts that must sign", async () => {
    const pr = openPr(w, exempt, { commits: [commit(alice), commit(bot)] });
    await assessed(pr);
    expect(w.gh.seen(/signatures\/individual/).map((r) => r.url)).toEqual(["/repos/kleidos-dev/cla/contents/signatures/individual/123456.json?ref=signatures"]);
  });
});

describe("the commits", () => {
  it("are asked page by page, from the cursor of the one before, with the pull request's own repository", async () => {
    const pr = openPr(w, alice, { commits: Array.from({ length: 101 }, (_, i) => commit(i === 100 ? bob : alice)) });
    const a = await assessed(pr);
    expect(queries()).toEqual([
      { owner: "kleidos-dev", name: "cla-sandbox", number: pr.number, cursor: null },
      { owner: "kleidos-dev", name: "cla-sandbox", number: pr.number, cursor: "100" },
    ]);
    expect(ids(a.required)).toEqual([alice.id, bob.id]);
  });

  it("with no known author are named by the first seven digits", async () => {
    const unknown = commit({ email: "x@example.org" });
    const a = await assessed(openPr(w, alice, { commits: [commit(alice), unknown] }));
    expect(a.unknownCommits).toEqual([unknown.oid.slice(0, 7)]);
    expect(allClear(a)).toBe(false);
  });

  it("with more authors than GitHub lists are not known, though every listed one is", async () => {
    const crowd = commit(alice, { coAuthors: Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, login: `u${i}`, type: "User" as const })) });
    // The trailers name everybody by a no-reply address: only the count says that somebody is missing.
    crowd.message = "Change";
    const a = await assessed(openPr(w, alice, { commits: [crowd] }));
    expect(a.unknownCommits).toEqual([crowd.oid.slice(0, 7)]);
  });

  it("with twenty authors are known", async () => {
    const crowd = commit(alice, { coAuthors: Array.from({ length: 19 }, (_, i) => ({ id: 1000 + i, login: `u${i}`, type: "User" as const })) });
    const a = await assessed(openPr(w, alice, { commits: [crowd] }));
    expect(a.unknownCommits).toEqual([]);
    expect(a.required).toHaveLength(20);
  });

  it("over 250 are too many: not one of them is read", async () => {
    const pr = openPr(w, alice);
    pages(pr, { nodes: [commit(bob)], total: 251, more: true, next: "1" });
    const a = await assessed(pr);
    expect(a.tooManyCommits).toBe(true);
    expect(ids(a.required)).toEqual([alice.id]);
    expect(queries()).toHaveLength(1);
    expect(allClear(a)).toBe(false);
  });

  it("of exactly 250 are read to the last", async () => {
    const pr = openPr(w, alice, { commits: Array.from({ length: 250 }, (_, i) => commit(i === 249 ? bob : alice)) });
    const a = await assessed(pr);
    expect([a.tooManyCommits, ids(a.required)]).toEqual([false, [alice.id, bob.id]]);
    expect(queries()).toHaveLength(3);
  });

  it("GitHub counts and does not list are authors nobody knows", async () => {
    const pr = openPr(w, alice);
    pages(pr, { nodes: [commit(alice)], total: 2 });
    expect((await assessed(pr)).tooManyCommits).toBe(true);
  });

  it("GitHub lists as counted are whole", async () => {
    const pr = openPr(w, alice);
    pages(pr, { nodes: [commit(alice), commit(alice)], total: 2 });
    expect((await assessed(pr)).tooManyCommits).toBe(false);
  });

  it("that moved while they were read are never assessed, on any page", async () => {
    const pr = openPr(w, alice);
    pages(pr, { nodes: [commit(alice)], total: 1, head: sha() });
    await expect(assessed(pr)).rejects.toBeInstanceOf(HeadMovedError);
    pages(pr, { nodes: [commit(alice)], total: 2, more: true, next: "1" }, { nodes: [commit(alice)], total: 2, head: sha() });
    await expect(assessed(openPr(w, alice))).rejects.toBeInstanceOf(HeadMovedError);
  });

  it.each([[{ repository: null }], [{ repository: { pullRequest: null } }], [{ repository: { pullRequest: { headRefOid: "x", commits: null } } }], [{}]])("that GitHub does not give (%j) are an error, not none", async (data) => {
    const pr = openPr(w, alice);
    w.gh.answer(/^POST \/graphql$/, () => json({ data }));
    await expect(assessed(pr)).rejects.toMatchObject({ status: 200, kind: "bad_response" });
  });
});

describe("the acceptances on the pull request", () => {
  it("are the comments of those who must sign that say an accepted sentence", async () => {
    const pr = openPr(w, alice);
    const c = comment(pr);
    expect((await assessed(pr)).acceptances).toEqual([{ commentId: c.id, commentUrl: `https://github.com/${SANDBOX}/pull/${pr.number}#issuecomment-${c.id}`, account: alice.id, createdAt: "2026-11-21T10:00:00Z", edited: false }]);
  });

  it("are read in the order they were written, every one of an account", async () => {
    const pr = openPr(w, alice, { commits: [commit(bob)] });
    const list = [comment(pr, { user: bob }), comment(pr), comment(pr)];
    expect((await assessed(pr)).acceptances.map((a) => [a.commentId, a.account])).toEqual(list.map((c) => [c.id, c.user.id]));
  });

  it("say when they were edited", async () => {
    const pr = openPr(w, alice);
    comment(pr, { updated_at: "2026-11-21T10:00:01Z" });
    expect((await assessed(pr)).acceptances[0]?.edited).toBe(true);
  });

  it("compare as the recorder does: white space and canonical form", async () => {
    const pr = openPr(w, alice);
    comment(pr, { body: ` ${SENTENCE.replaceAll(" ", "\u00a0\n").normalize("NFD")}\r\n` });
    expect((await assessed(pr)).acceptances).toHaveLength(1);
  });

  it.each([
    ["of another sentence", { body: "I accept" }],
    ["that quotes it among other text", { body: `> ${SENTENCE}` }],
    ["of version 2, not accepted here", { body: CONFIG.versions["2"].sentence }],
    ["of somebody who need not sign", { user: carol }],
    ["of somebody who need not sign, being a bot", { user: bot }],
  ])("are not a comment %s", async (_what, over) => {
    const pr = openPr(w, alice);
    comment(pr, over);
    expect((await assessed(pr)).acceptances).toEqual([]);
  });

  it("are not a bot's, although its account must sign", async () => {
    const pr = openPr(w, alice);
    comment(pr, { user: { ...alice, type: "Bot" } });
    expect((await assessed(pr)).acceptances).toEqual([]);
  });

  it("are not those of somebody who already signed", async () => {
    await w.gh.signDirectly(alice);
    const pr = openPr(w, alice);
    comment(pr);
    expect((await assessed(pr)).acceptances).toEqual([]);
  });

  it("with a deleted account are nobody's", async () => {
    const pr = openPr(w, alice);
    w.gh.answer(/\/issues\/\d+\/comments/, () => json([{ id: 1, body: SENTENCE, html_url: "x", created_at: "a", updated_at: "a", user: null, performed_via_github_app: null }]));
    const a = await assessed(pr);
    expect([a.acceptances, a.botComment]).toEqual([[], null]);
  });

  it("of every accepted version count", async () => {
    const pr = openPr(w, alice);
    comment(pr);
    comment(pr, { body: CONFIG.versions["2"].sentence });
    expect((await assessed(pr, CONFIG_V2)).acceptances).toHaveLength(2);
  });
});

describe("the accepted sentences", () => {
  it("are normalized, one per accepted version", () => {
    expect([...acceptedSentences(CONFIG_V2 as unknown as Config)]).toEqual([CONFIG.versions["1"].sentence.normalize("NFC"), CONFIG.versions["2"].sentence.normalize("NFC")]);
    const spaced = { ...CONFIG, versions: { "1": { ...CONFIG.versions["1"], sentence: "  I  accept\n" } } };
    expect([...acceptedSentences(spaced as unknown as Config)]).toEqual(["I accept"]);
  });

  it("skip an accepted version that was never published", () => {
    expect([...acceptedSentences({ ...CONFIG, accepted_versions: [7, 1] } as unknown as Config)]).toHaveLength(1);
  });
});

describe("the bot's comment", () => {
  const mine: IssueComment = { id: 1, body: `${MARKER}\nx`, html_url: "x", created_at: "a", updated_at: "a", user: { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" }, performed_via_github_app: { id: APP_ID } };

  it("is a bot's, made by this app, that starts with its marker", () => {
    expect(isBotComment(mine, APP_ID)).toBe(true);
  });

  it.each([
    ["a person's", { user: { id: 1, login: "alice", type: "User" } }],
    ["nobody's", { user: null }],
    ["made by another app", { performed_via_github_app: { id: APP_ID + 1 } }],
    ["made by no app", { performed_via_github_app: null }],
    ["without the marker", { body: "x" }],
    ["with the marker further on", { body: `x ${MARKER}` }],
  ])("is not one %s", (_what, over) => {
    expect(isBotComment({ ...mine, ...over }, APP_ID)).toBe(false);
  });

  it("is the first of them on the pull request", async () => {
    const pr = openPr(w, alice);
    const user = { id: BOT_ID, login: "kleidos-cla[bot]", type: "Bot" as const };
    comment(pr, { body: "not it", user, via_app: true });
    const first = comment(pr, { body: `${MARKER}\nfirst`, user, via_app: true });
    comment(pr, { body: `${MARKER}\nsecond`, user, via_app: true });
    expect((await assessed(pr)).botComment).toEqual({ id: first.id, body: `${MARKER}\nfirst` });
  });

  it("is told apart from a comment forged by a person through another app", async () => {
    const pr = openPr(w, alice);
    comment(pr, { body: `${MARKER}\nforged`, user: alice, via_app: true });
    expect((await assessed(pr)).botComment).toBeNull();
  });
});

describe("everything is clear", () => {
  const clear = { missing: [], unknownCommits: [], unlistedBots: [], tooManyCommits: false } as unknown as Assessment;

  it("when nobody is missing, no commit is unknown, no bot is unlisted and every commit was read", () => {
    expect(allClear(clear)).toBe(true);
  });

  it.each([{ missing: [alice] }, { unknownCommits: ["abcdef0"] }, { unlistedBots: [{ login: "x", commit: "" }] }, { tooManyCommits: true }])("not with %j", (over) => {
    expect(allClear({ ...clear, ...over })).toBe(false);
  });
});

describe("the pull request", () => {
  it("that GitHub does not know is an error", async () => {
    const pr = openPr(w, alice);
    w.gh.pulls.clear();
    await expect(assessed(pr)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("is asked with the token given, and so is everything about it", async () => {
    const pr = openPr(w, alice);
    const a = await assessed(pr);
    const about = w.gh.requests.filter((r) => r.url.startsWith(`/repos/${SANDBOX}/`) && !r.url.endsWith("/installation"));
    expect(about.map((r) => r.url)).toEqual([`/repos/${SANDBOX}/pulls/${pr.number}`, `/repos/${SANDBOX}/pulls?state=open&per_page=100`, `/repos/${SANDBOX}/issues/${pr.number}/comments?per_page=100`]);
    expect(new Set(about.map((r) => JSON.stringify(r.permissions)))).toEqual(new Set(['{"pull_requests":"write","checks":"write","contents":"read"}']));
    expect((a.pr satisfies PullRequest).base.repo.full_name).toBe(SANDBOX);
  });
});

describe("a list of commits that does not add up", () => {
  /** GitHub answering for ever what `page` says; a loop with no bound fails on the tenth question. */
  function endless(pr: FakePr, page: { nodes: FakePr["commits"]; total: number; next: string | null }) {
    let n = 0;
    w.gh.answer(/^POST \/graphql$/, () => {
      if (++n > 9) throw new Error("asked without end");
      return json({ data: { repository: { pullRequest: { headRefOid: pr.head.sha, commits: { totalCount: page.total, pageInfo: { hasNextPage: true, endCursor: page.next }, nodes: page.nodes.map((c) => ({ commit: c })) } } } } });
    });
  }

  it("that always has another page and nothing on it is cut: nobody can say who wrote the rest", async () => {
    const pr = openPr(w, alice);
    endless(pr, { nodes: [], total: 2, next: "x" });
    expect((await assessed(pr)).tooManyCommits).toBe(true);
    expect(queries()).toHaveLength(1);
  });

  it("that has another page and does not say where is cut, and is not read again from the start", async () => {
    const pr = openPr(w, alice);
    endless(pr, { nodes: Array.from({ length: 100 }, () => commit(alice)), total: 150, next: null });
    expect((await assessed(pr)).tooManyCommits).toBe(true);
    expect(queries()).toHaveLength(1);
  });

  it("that gives everything it counts and then an empty page is whole", async () => {
    const pr = openPr(w, alice);
    pages(pr, { nodes: [commit(alice)], total: 1, more: true, next: "1" }, { nodes: [], total: 1, more: true, next: "1" });
    expect((await assessed(pr)).tooManyCommits).toBe(false);
    expect(queries()).toHaveLength(2);
  });

  it("that never ends is read up to 250", async () => {
    const pr = openPr(w, alice);
    endless(pr, { nodes: Array.from({ length: 125 }, () => commit(alice)), total: 250, next: "x" });
    expect((await assessed(pr)).tooManyCommits).toBe(false);
    expect(queries()).toHaveLength(2);
  });
});

describe("a list GitHub cuts into too many pages", () => {
  const many = (n: number) => Array.from({ length: n }, () => openPr(w, carol));

  it("of open pull requests hides who else must sign: a maintainer looks", async () => {
    const pr = openPr(w, alice);
    many(300);
    // The 302nd has the same head commit, and the three pages read do not reach it.
    const twin = openPr(w, bob);
    twin.head.sha = pr.head.sha;
    const a = await assessed(pr);
    expect(ids(a.required)).toEqual([alice.id]);
    expect(a.tooManyCommits).toBe(true);
    expect(allClear(a)).toBe(false);
    expect(w.gh.seen(/\/pulls\?/)).toHaveLength(3);
  });

  it("of open pull requests that fits its three pages is whole", async () => {
    const pr = openPr(w, alice);
    many(298);
    const twin = openPr(w, bob);
    twin.head.sha = pr.head.sha;
    const a = await assessed(pr);
    expect([a.tooManyCommits, ids(a.required)]).toEqual([false, [alice.id, bob.id]]);
  });
});

describe("a list of comments GitHub cuts into too many pages", () => {
  it("may hide the bot's own, and says so", async () => {
    const pr = openPr(w, alice);
    for (let i = 0; i < 500; i++) comment(pr, { body: "x", user: carol });
    expect((await assessed(pr)).commentsCut).toBe(false);
    comment(pr, { body: "x", user: carol });
    expect((await assessed(pr)).commentsCut).toBe(true);
    expect(w.gh.seen(/\/comments\?/)).toHaveLength(10);
  });
});
