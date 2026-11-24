// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/** What the Worker reads from the register and asks of its recorder, request by request. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBot } from "../../src/bot";
import type { ConfiguredEnv } from "../../src/env";
import type { Registry } from "../../src/registry";
import { ACTIONS_BOT_ID, resetRegistryCache } from "../../src/registry";
import { must } from "../../src/util";
import type { World } from "../helpers";
import { CONFIG, SANDBOX, world } from "../helpers";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const alice = { id: 123456, login: "alice", type: "User" as const };
const CONFIG_REQUEST = "GET /repos/kleidos-dev/cla/contents/registry/config.json?ref=main";
const RECORD = "GET /repos/kleidos-dev/cla/contents/signatures/individual/123456.json?ref=signatures";
const COMMITS = "GET /repos/kleidos-dev/cla/commits?sha=signatures&path=signatures/individual/123456.json&per_page=1";

let w: World;
let registry: Registry;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  w = await world();
  registry = makeBot(w.env as ConfiguredEnv).registry;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const exactly = (request: string) => new RegExp(`^${request.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const asked = () => w.gh.requests.map((r) => `${r.method} ${r.url}`).filter((r) => !/access_tokens$|installation$/.test(r));
const permissions = (request: string) => w.gh.seen(exactly(request)).map((r) => r.permissions);
const raw = (body: string) => () => new Response(body);
const bad = { name: "Error", status: 200, kind: "bad_response" };

describe("the configuration", () => {
  it("is read from main with a token that only reads contents", async () => {
    expect(await registry.config()).toEqual(CONFIG);
    expect(asked()).toEqual([CONFIG_REQUEST]);
    expect(permissions(CONFIG_REQUEST)).toEqual([{ contents: "read" }]);
  });

  it("is kept for sixty seconds and read again at the sixtieth", async () => {
    await registry.config();
    vi.setSystemTime(NOW + 59_999);
    await registry.config();
    expect(asked()).toHaveLength(1);
    w.gh.setFile("main", "registry/config.json", JSON.stringify({ ...CONFIG, current_version: 2 }));
    expect((await registry.config()).current_version).toBe(1);
    vi.setSystemTime(NOW + 60_000);
    expect((await registry.config()).current_version).toBe(2);
    expect(asked()).toHaveLength(2);
  });

  it("is kept apart from the entities, and forgotten when the cache is", async () => {
    await registry.config();
    expect(await registry.entities()).toEqual([]);
    resetRegistryCache();
    await registry.config();
    expect(asked()).toEqual([CONFIG_REQUEST, "GET /repos/kleidos-dev/cla/contents/registry/entities.json?ref=main", CONFIG_REQUEST]);
  });

  it("that cannot be read is an error, not a default", async () => {
    w.gh.files.delete("main:registry/config.json");
    await expect(registry.config()).rejects.toMatchObject(bad);
    w.gh.answer(exactly(CONFIG_REQUEST), () => new Response(null, { status: 502 }), 1);
    resetRegistryCache();
    await expect(registry.config()).rejects.toMatchObject({ kind: "transient" });
  });

  it("that is not JSON is refused and not kept", async () => {
    w.gh.answer(exactly(CONFIG_REQUEST), raw("{"), 1);
    await expect(registry.config()).rejects.toMatchObject(bad);
    expect(await registry.config()).toEqual(CONFIG);
  });

  it.each([
    ["null", null],
    ["a text", "x"],
    ["a list", []],
    ["nothing in it", {}],
    ["another schema", { ...CONFIG, schema: 2 }],
    ["the schema as text", { ...CONFIG, schema: "1" }],
    ["a current version that is no number", { ...CONFIG, current_version: "1" }],
    ["accepted versions that are no list", { ...CONFIG, accepted_versions: 1 }],
    ["accepted versions that are an object", { ...CONFIG, accepted_versions: { 1: true } }],
    ["no versions", { ...CONFIG, versions: undefined }],
    ["versions that are null", { ...CONFIG, versions: null }],
    ["versions that are a text", { ...CONFIG, versions: "1" }],
    ["no served repositories", { ...CONFIG, served_repositories: undefined }],
    ["served repositories that are null", { ...CONFIG, served_repositories: null }],
    ["served repositories that are a text", { ...CONFIG, served_repositories: "kleidos-dev/cla" }],
    ["no exemption list", { ...CONFIG, exempt: undefined }],
    ["an exemption list that is an object", { ...CONFIG, exempt: {} }],
    ["an exemption that is null", { ...CONFIG, exempt: [...CONFIG.exempt, null] }],
    ["an exemption by login", { ...CONFIG, exempt: [{ login: "jmrplens", why: "x" }] }],
    ["an exemption whose id is a text", { ...CONFIG, exempt: [{ id: "28966312", login: "jmrplens", why: "x" }] }],
  ])("with %s is refused", async (_what, config) => {
    w.gh.setFile("main", "registry/config.json", JSON.stringify(config));
    await expect(registry.config()).rejects.toMatchObject(bad);
  });

  it("with nobody exempt and nothing served is a configuration", async () => {
    const empty = { ...CONFIG, exempt: [], served_repositories: {}, versions: {}, accepted_versions: [] };
    w.gh.setFile("main", "registry/config.json", JSON.stringify(empty));
    expect(await registry.config()).toEqual(empty);
  });
});

describe("the entities", () => {
  const entity = { slug: "e", name: "Example GmbH", version: 1, set_sha256: "a".repeat(64), signed_at: "2026-11-01", covered: [] };

  it("are the file's list", async () => {
    w.gh.setFile("main", "registry/entities.json", JSON.stringify({ schema: 1, entities: [entity] }));
    expect(await registry.entities()).toEqual([entity]);
  });

  it("are kept for sixty seconds", async () => {
    await registry.entities();
    vi.setSystemTime(NOW + 59_000);
    await registry.entities();
    expect(asked()).toHaveLength(1);
    vi.setSystemTime(NOW + 60_000);
    await registry.entities();
    expect(asked()).toHaveLength(2);
  });

  it.each(["null", "[]", "{}", '{"entities":null}', '{"entities":{"0":{}}}', '"x"'])("are none in %s", async (text) => {
    w.gh.setFile("main", "registry/entities.json", text);
    expect(await registry.entities()).toEqual([]);
  });

  it("are none when there is no file, which is kept like any other answer", async () => {
    w.gh.files.delete("main:registry/entities.json");
    expect(await registry.entities()).toEqual([]);
    expect(await registry.entities()).toEqual([]);
    expect(asked()).toHaveLength(1);
  });

  it("that are not JSON are an error: an entity is never lost silently", async () => {
    w.gh.setFile("main", "registry/entities.json", "{");
    await expect(registry.entities()).rejects.toMatchObject(bad);
  });
});

describe("the signature of an account", () => {
  it("is its record, when the recorder's is the last commit that touched it", async () => {
    await w.gh.signDirectly(alice);
    expect(await registry.signature(alice.id)).toMatchObject({ github_id: alice.id, login_at_signing: "alice", version: 1 });
    expect(asked()).toEqual([RECORD, COMMITS]);
    expect([...permissions(RECORD), ...permissions(COMMITS)]).toEqual([{ contents: "read" }, { contents: "read" }]);
  });

  it("is none when there is no record, and no commit is asked for", async () => {
    expect(await registry.signature(alice.id)).toBeNull();
    expect(asked()).toEqual([RECORD]);
  });

  it("is none when the file is not JSON, or no record of that account", async () => {
    await w.gh.signDirectly(alice);
    const text = must(w.gh.files.get("signatures:signatures/individual/123456.json"));
    w.gh.setFile("signatures", "signatures/individual/123456.json", text.slice(1));
    expect(await registry.signature(alice.id)).toBeNull();
    w.gh.setFile("signatures", "signatures/individual/123456.json", text.replace("123456", "123457"));
    expect(await registry.signature(alice.id)).toBeNull();
    expect(asked()).toEqual([RECORD, RECORD]);
  });

  it("is read again every time: a new record shows at once", async () => {
    expect(await registry.signature(alice.id)).toBeNull();
    await w.gh.signDirectly(alice);
    expect(await registry.signature(alice.id)).not.toBeNull();
  });

  it("is not taken for absent on an error that only looks like GitHub's", async () => {
    vi.spyOn(registry.gh, "request").mockRejectedValue({ kind: "not_found" });
    await expect(registry.signature(alice.id)).rejects.toEqual({ kind: "not_found" });
    await expect(registry.coverageNumbers(SANDBOX, [])).rejects.toEqual({ kind: "not_found" });
  });

  it("that cannot be read is an error, not the absence of one", async () => {
    w.gh.answer(exactly(RECORD), () => new Response(null, { status: 500 }));
    await expect(registry.signature(alice.id)).rejects.toMatchObject({ kind: "transient" });
  });

  const sha = "f".repeat(40);
  const facts = { sha, author: { id: ACTIONS_BOT_ID }, committer: { login: "web-flow" }, commit: { verification: { verified: true, reason: "valid" } } };
  const lastCommit = (c: unknown) => {
    w.gh.answer(exactly(COMMITS), () => new Response(JSON.stringify(c === undefined ? [] : [c]), { headers: { "content-type": "application/json" } }));
  };

  it("counts with the recorder's commit", async () => {
    await w.gh.signDirectly(alice);
    lastCommit(facts);
    expect(await registry.signature(alice.id)).not.toBeNull();
  });

  it.each([
    ["no commit at all", undefined],
    ["another author", { ...facts, author: { id: 666666 } }],
    ["an author GitHub does not know", { ...facts, author: null }],
    ["another committer", { ...facts, committer: { login: "mallory" } }],
    ["a committer GitHub does not know", { ...facts, committer: null }],
    ["a signature that is not verified", { ...facts, commit: { verification: { verified: false, reason: "valid" } } }],
    ["a signature verified as text", { ...facts, commit: { verification: { verified: "true", reason: "valid" } } }],
    ["a signature with another reason", { ...facts, commit: { verification: { verified: true, reason: "unsigned" } } }],
    ["no verification", { ...facts, commit: {} }],
    ["no commit facts", { ...facts, commit: undefined }],
    ["a short hash", { ...facts, sha: sha.slice(1) }],
    ["a long hash", { ...facts, sha: `${sha}f` }],
    ["a hash in another alphabet", { ...facts, sha: "F".repeat(40) }],
    ["a hash after something else", { ...facts, sha: `x${sha}` }],
    ["a hash with a line end", { ...facts, sha: `${sha}\n` }],
  ])("does not count with %s", async (_what, c) => {
    await w.gh.signDirectly(alice);
    lastCommit(c);
    expect(await registry.signature(alice.id)).toBeNull();
  });
});

describe("the commit that added a record", () => {
  it("is asked once for the confirmation and the signature", async () => {
    await w.gh.signDirectly(alice);
    const sha = w.gh.recordCommits.get(alice.id);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await registry.recordCommit(alice.id)).toBe(sha);
    await registry.signature(alice.id);
    await registry.recordCommit(alice.id);
    expect(asked()).toEqual([COMMITS, RECORD]);
  });

  it("is told even when it is not the recorder's: it is only a link", async () => {
    await w.gh.signDirectly(alice);
    w.gh.forgedRecords.add(alice.id);
    expect(await registry.recordCommit(alice.id)).toBe(w.gh.recordCommits.get(alice.id));
  });

  it("is none when nothing was committed", async () => {
    expect(await registry.recordCommit(alice.id)).toBeNull();
  });

  it("is asked again after a failure", async () => {
    await w.gh.signDirectly(alice);
    w.gh.answer(exactly(COMMITS), () => new Response(null, { status: 502 }), 1);
    await expect(registry.recordCommit(alice.id)).rejects.toMatchObject({ kind: "transient" });
    expect(await registry.recordCommit(alice.id)).toBe(w.gh.recordCommits.get(alice.id));
  });

  it("is each account's own", async () => {
    await w.gh.signDirectly(alice);
    await registry.recordCommit(alice.id);
    expect(await registry.recordCommit(7)).toBeNull();
  });
});

describe("the recorder", () => {
  const DISPATCH = /^POST \/repos\/kleidos-dev\/cla\/actions\/workflows\/record\.yml\/dispatches$/;

  it("is asked to record a comment, with every input a text and a token that only runs workflows", async () => {
    await registry.dispatchRecorder({ kind: "sign", repo: SANDBOX, pr: 7, comment_id: 99 });
    expect(w.gh.seen(DISPATCH)).toMatchObject([{ permissions: { actions: "write" }, body: { ref: "main", inputs: { kind: "sign", repo: SANDBOX, pr: "7", comment_id: "99" } } }]);
    expect(w.gh.dispatches).toEqual([{ kind: "sign", repo: SANDBOX, pr: "7", comment_id: "99" }]);
  });

  it("is asked for a coverage record with no comment", async () => {
    await registry.dispatchRecorder({ kind: "coverage", repo: SANDBOX, pr: 7 });
    expect(w.gh.dispatches).toEqual([{ kind: "coverage", repo: SANDBOX, pr: "7", comment_id: "" }]);
  });

  it("is handed a sign-in: the account, the version, the language, the site's commit and the signer's token", async () => {
    await registry.dispatchSignin({ repo: SANDBOX, pr: 7, github_id: 123456, version: 2, lang: "es", site_commit: "a".repeat(40), signin_token: "ghu_made_up" });
    expect(w.gh.seen(DISPATCH)).toMatchObject([
      { permissions: { actions: "write" }, body: { ref: "main", inputs: { kind: "signin", repo: SANDBOX, pr: "7", github_id: "123456", version: "2", lang: "es", site_commit: "a".repeat(40), signin_token: "ghu_made_up" } } },
    ]);
    expect(Object.keys(must(w.gh.dispatches[0]))).toHaveLength(8);
  });

  it("that cannot be dispatched is an error", async () => {
    w.gh.answer(DISPATCH, () => new Response(null, { status: 422 }));
    await expect(registry.dispatchRecorder({ kind: "coverage", repo: SANDBOX, pr: 7 })).rejects.toMatchObject({ kind: "unprocessable" });
    await expect(registry.dispatchSignin({ repo: SANDBOX, pr: 7, github_id: 1, version: 2, lang: "en", site_commit: "a".repeat(40), signin_token: "x" })).rejects.toMatchObject({ kind: "unprocessable" });
  });
});

describe("how the run of one sign-in ended", () => {
  const SINCE = "2026-11-24T10:00:00Z";
  const run = (over: Record<string, unknown> = {}) => ({ display_title: `Record signin ${SANDBOX}#7 123456`, created_at: SINCE, status: "completed", conclusion: "success", head_branch: "main", ...over }) as World["gh"]["recordRuns"][number];
  const outcome = (...runs: World["gh"]["recordRuns"]) => {
    w.gh.recordRuns = runs;
    return registry.signinRun(SANDBOX, 7, 123456, SINCE);
  };

  it("is asked of the recorder's dispatched runs on main, with a token that only reads them", async () => {
    await outcome();
    const [r] = w.gh.seen(/record\.yml\/runs/);
    expect(r).toMatchObject({ url: "/repos/kleidos-dev/cla/actions/workflows/record.yml/runs?event=workflow_dispatch&branch=main&per_page=30", permissions: { actions: "read" } });
  });

  it("is not known while none is listed", async () => {
    expect(await outcome()).toBeNull();
    w.gh.answer(/record\.yml\/runs/, () => new Response("{}", { headers: { "content-type": "application/json" } }));
    expect(await outcome()).toBeNull();
  });

  it.each([
    ["success", "completed", "success", "succeeded"],
    ["failure", "completed", "failure", "failed"],
    ["a cancellation", "completed", "cancelled", "failed"],
    ["no conclusion", "completed", null, "failed"],
    ["a run in progress", "in_progress", null, "running"],
    ["a queued run", "queued", null, "running"],
    // A conclusion without completion is no outcome yet.
    ["a success not completed", "in_progress", "success", "running"],
  ])("%s", async (_what, status, conclusion, ended) => {
    expect(await outcome(run({ status, conclusion }))).toBe(ended);
  });

  it("is a success when any run succeeded, else running while any runs, else failed", async () => {
    const failed = run({ conclusion: "failure" });
    const running = run({ status: "queued", conclusion: null });
    expect(await outcome(running, failed, run())).toBe("succeeded");
    expect(await outcome(failed, running)).toBe("running");
    expect(await outcome(failed, failed)).toBe("failed");
  });

  it.each([
    ["another pull request", `Record signin ${SANDBOX}#71 123456`],
    ["another account", `Record signin ${SANDBOX}#7 1234567`],
    ["another kind", `Record sign ${SANDBOX}#7 123456`],
    ["more after it", `Record signin ${SANDBOX}#7 123456 x`],
    ["no title", undefined],
  ])("ignores a run of %s", async (_what, display_title) => {
    expect(await outcome(run({ display_title }))).toBeNull();
  });

  it("reads a title whatever its white space", async () => {
    expect(await outcome(run({ display_title: `Record  signin\t${SANDBOX}#7 \n 123456` }))).toBe("succeeded");
    expect(await outcome(run({ display_title: `Recordsignin${SANDBOX}#7123456` }))).toBeNull();
  });

  it("ignores a run from more than a minute before, whose clock may differ from ours by that much", async () => {
    expect(await outcome(run({ created_at: "2026-11-24T09:59:00Z" }))).toBe("succeeded");
    expect(await outcome(run({ created_at: "2026-11-24T09:58:59Z" }))).toBeNull();
    expect(await outcome(run({ created_at: undefined }))).toBeNull();
    expect(await outcome(run({ created_at: "some day" }))).toBeNull();
  });
});

describe("the coverage records of a repository", () => {
  const LISTING = "GET /repos/kleidos-dev/cla/contents/coverage/kleidos-dev/cla-sandbox?ref=signatures";
  const listing = (files: unknown) => {
    w.gh.answer(exactly(LISTING), () => new Response(JSON.stringify(files), { headers: { "content-type": "application/json" } }));
  };

  it("are the numbers of the files in its directory, read once with a token that only reads contents", async () => {
    w.gh.setFile("signatures", `coverage/${SANDBOX}/7.json`, "{}");
    w.gh.setFile("signatures", `coverage/${SANDBOX}/1234567890.json`, "{}");
    expect([...(await registry.coverageNumbers(SANDBOX, []))]).toEqual([7, 1234567890]);
    expect(asked()).toEqual([LISTING]);
    expect(permissions(LISTING)).toEqual([{ contents: "read" }]);
  });

  it("are none when the directory is not there", async () => {
    expect([...(await registry.coverageNumbers(SANDBOX, []))]).toEqual([]);
  });

  it("are the files named by a number only", async () => {
    const file = (name: string, type = "file") => ({ name, type });
    listing([file("8.json"), file("08.json"), file("0.json"), file("8.json.bak"), file("x8.json"), file("8xjson"), file("12345678901.json"), file("9.json", "dir"), file("README.md")]);
    expect([...(await registry.coverageNumbers(SANDBOX, []))]).toEqual([8]);
  });

  it("are none when what is there is a file", async () => {
    listing({ name: "cla-sandbox", type: "file" });
    expect([...(await registry.coverageNumbers(SANDBOX, []))]).toEqual([]);
  });

  it("that cannot be read are an error, not the absence of them", async () => {
    w.gh.answer(exactly(LISTING), () => new Response(null, { status: 503 }));
    await expect(registry.coverageNumbers(SANDBOX, [])).rejects.toMatchObject({ kind: "transient" });
  });

  const directory = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `${i + 1}.json`, type: "file" }));

  it("are asked one by one where GitHub's listing of a thousand may not hold them", async () => {
    listing(directory(1000));
    w.gh.setFile("signatures", `coverage/${SANDBOX}/1001.json`, "{}");
    const numbers = await registry.coverageNumbers(SANDBOX, [7, 1001, 1002]);
    expect([numbers.has(7), numbers.has(1000), numbers.has(1001), numbers.has(1002)]).toEqual([true, true, true, false]);
    const file = (n: number) => `GET /repos/kleidos-dev/cla/contents/coverage/${SANDBOX}/${n}.json?ref=signatures`;
    expect(asked()).toEqual([LISTING, file(1001), file(1002)]);
    expect(permissions(file(1001))).toEqual([{ contents: "read" }]);
  });

  it("are not asked again where the listing is whole", async () => {
    listing(directory(999));
    expect((await registry.coverageNumbers(SANDBOX, [1001])).has(1001)).toBe(false);
    expect(asked()).toEqual([LISTING]);
  });

  it("that cannot be asked one by one are an error, not the absence of them", async () => {
    listing(directory(1000));
    w.gh.answer(/1001\.json/, () => new Response(null, { status: 503 }));
    await expect(registry.coverageNumbers(SANDBOX, [1001])).rejects.toMatchObject({ kind: "transient" });
  });
});
