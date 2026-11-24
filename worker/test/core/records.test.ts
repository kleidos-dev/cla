// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/** Whether a file of the register is a signature, whether it counts, and whom an entity covers: no request is made here. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Config, Entity, SignatureRecord } from "../../src/registry";
import { coveringEntity, flowOf, isSignatureRecord, recordValid } from "../../src/registry";
import { CONFIG, CONFIG_V2 } from "../helpers";

const ID = 123456;
type Fields = Record<string, unknown>;

const COMMENT: Fields = {
  schema: 1,
  kind: "individual",
  github_id: ID,
  login_at_signing: "alice",
  agreement: "kleidos-ca",
  version: 1,
  set_sha256: "a".repeat(64),
  accepted_at: "2026-11-20T10:00:00Z",
  method: "web",
  evidence: { pr_url: "https://github.com/kleidos-dev/cla/pull/7", comment_url: "https://github.com/kleidos-dev/cla/pull/7#issuecomment-99", comment_id: 99, comment_body_sha256: "b".repeat(64) },
  recorded_at: "2026-11-20T10:00:09Z",
  recorder_run_id: 5,
};
const SIGNIN: Fields = {
  schema: 2,
  kind: "individual",
  github_id: ID,
  login_at_signing: "alice",
  agreement: "kleidos-ca",
  version: 2,
  set_sha256: "a".repeat(64),
  sentence_sha256: "c".repeat(64),
  accepted_at: "2026-11-20T10:00:05Z",
  method: "signin",
  evidence: { authorized_at: "2026-11-20T10:00:00Z", signin_client_id: "Iv23liSIGNINTEST0001", context_pr_url: "https://github.com/kleidos-dev/cla/pull/7", site_commit: "d".repeat(40), lang: "en" },
  recorded_at: "2026-11-20T10:00:09Z",
  recorder_run_id: 5,
  recorder_commit: "e".repeat(40),
};

/** A record with one field replaced, in the evidence when the path says so; a field given as undefined is removed. */
function withField(base: Fields, path: string, value: unknown): Fields {
  const out = structuredClone(base);
  const [outer, inner] = path.split(".") as [string, string?];
  const at = inner === undefined ? out : (out[outer] as Fields);
  const key = inner ?? outer;
  if (value === undefined) Reflect.deleteProperty(at, key);
  else at[key] = value;
  return out;
}

const TIMES = {
  good: ["2026-11-20T10:00:00Z", "0000-00-00T00:00:00Z"],
  bad: ["2026-11-20T10:00:00", "2026-11-20T10:00:00z", "2026-11-20T10:00:00Z\n", " 2026-11-20T10:00:00Z", "2026-11-20 10:00:00Z", "2026-11-20T10:00:00.5Z", "2026-11-20T10:00:00+00:00", "2026-1-20T10:00:00Z", "26-11-20T10:00:00Z", "2026-11-2T10:00:00Z", "2026-11-20T1:00:00Z", "2026-11-20T10:0:00Z", "2026-11-20T10:00:0Z", "٢026-11-20T10:00:00Z", "x2026-11-20T10:00:00Z", ""],
};
const HASHES = (n: number) => ({ good: ["0".repeat(n), "9af".padEnd(n, "e")], bad: ["a".repeat(n - 1), "a".repeat(n + 1), "A".repeat(n), "g".repeat(n), `${"a".repeat(n)}\n`, `x${"a".repeat(n)}`, ""] });
const IDS = { good: [1, 2 ** 31, Number.MAX_SAFE_INTEGER], bad: [0, -1, 1.5, 2 ** 53, NaN, Infinity, "5", true, [5], null] };
const LOGINS = {
  good: ["a", "A-1", "a".repeat(39), "al-ice"],
  bad: ["", "-a", "a-", "a--b", "a_b", "a b", "a".repeat(40), "alice\n", "alice[bot]", "ſam", "xalice!"],
};
const PRS = {
  good: ["https://github.com/a/b/pull/1", "https://github.com/a-b/c.d_e-f/pull/9999999999", `https://github.com/${"a".repeat(39)}/${"b".repeat(100)}/pull/10`],
  bad: [
    "http://github.com/a/b/pull/1",
    "https://github.com/a/b/pull/0",
    "https://github.com/a/b/pull/01",
    "https://github.com/a/b/pull/",
    "https://github.com/a/b/pull/x",
    "https://github.com/a/b/pull/10000000000",
    "https://github.com/a/b/issues/1",
    "https://github.com/a/b/pull/1/files",
    "https://github.com/a/b/pull/1\n",
    "https://github.com/a/pull/1",
    "https://github.com//b/pull/1",
    "https://github.com/a//pull/1",
    "https://githubXcom/a/b/pull/1",
    "https://github.com.evil.example/a/b/pull/1",
    "https://evil.example/?https://github.com/a/b/pull/1",
    "https://github.com/a_b/c/pull/1",
    "https://github.com/a/b!/pull/1",
    `https://github.com/${"a".repeat(40)}/b/pull/1`,
    `https://github.com/a/${"b".repeat(101)}/pull/1`,
  ],
};
/** A value of another type, and an array that reads like the text it holds. */
const notText = (text: unknown) => [1, true, null, {}, [text]];

interface Rule {
  path: string;
  good: unknown[];
  bad: unknown[];
}
const COMMON: Rule[] = [
  { path: "kind", good: ["individual"], bad: ["entity", "Individual", "", ...notText("individual")] },
  { path: "github_id", good: [ID], bad: [ID + 1, String(ID), null, [ID]] },
  { path: "login_at_signing", good: LOGINS.good, bad: [...LOGINS.bad, ...notText("alice")] },
  { path: "agreement", good: ["kleidos-ca"], bad: ["kleidos", "kleidos-CA", "", ...notText("kleidos-ca")] },
  { path: "version", ...IDS },
  { path: "set_sha256", good: HASHES(64).good, bad: [...HASHES(64).bad, ...notText("a".repeat(64))] },
  { path: "accepted_at", good: TIMES.good, bad: [...TIMES.bad, ...notText("2026-11-20T10:00:00Z")] },
  { path: "recorded_at", good: TIMES.good, bad: [...TIMES.bad, ...notText("2026-11-20T10:00:00Z")] },
  { path: "recorder_run_id", ...IDS },
];
const COMMENT_RULES: Rule[] = [
  ...COMMON,
  { path: "schema", good: [1], bad: [0, 2, 3, "1", true, null] },
  { path: "method", good: ["web", "comment"], bad: ["signin", "Web", "", ...notText("web")] },
  { path: "evidence", good: [], bad: [{}, [], "evidence", 5, true, null] },
  { path: "evidence.comment_body_sha256", good: HASHES(64).good, bad: [...HASHES(64).bad, ...notText("b".repeat(64))] },
];
const SIGNIN_RULES: Rule[] = [
  ...COMMON,
  { path: "schema", good: [2], bad: [0, 1, 3, "2", true, null] },
  { path: "method", good: ["signin"], bad: ["web", "comment", "Signin", "", ...notText("signin")] },
  { path: "sentence_sha256", good: HASHES(64).good, bad: [...HASHES(64).bad, ...notText("c".repeat(64))] },
  { path: "recorder_commit", good: HASHES(40).good, bad: [...HASHES(40).bad, ...notText("e".repeat(40))] },
  { path: "evidence", good: [], bad: [{}, [], "evidence", 5, true, null] },
  { path: "evidence.authorized_at", good: TIMES.good, bad: [...TIMES.bad, ...notText("2026-11-20T10:00:00Z")] },
  { path: "evidence.signin_client_id", good: ["a".repeat(16), "A.9".padEnd(40, "z")], bad: ["a".repeat(15), "a".repeat(41), "a".repeat(15) + "-", `${"a".repeat(16)}\n`, `!${"a".repeat(16)}`, "", ...notText("a".repeat(16))] },
  { path: "evidence.context_pr_url", good: PRS.good, bad: [...PRS.bad, ...notText("https://github.com/a/b/pull/1")] },
  { path: "evidence.site_commit", good: HASHES(40).good, bad: [...HASHES(40).bad, ...notText("d".repeat(40))] },
  { path: "evidence.lang", good: ["en", "es"], bad: ["fr", "EN", "", ...notText("en")] },
];

describe.each([
  ["an acceptance comment (schema 1)", COMMENT, COMMENT_RULES],
  ["an acceptance by signing in (schema 2)", SIGNIN, SIGNIN_RULES],
])("the record of %s", (_what, base, rules) => {
  it("is a signature as the recorder writes it", () => {
    expect(isSignatureRecord(base, ID)).toBe(true);
  });

  it("is one of its own account only", () => {
    expect(isSignatureRecord(base, ID + 1)).toBe(false);
  });

  for (const { path, good, bad } of rules) {
    for (const v of good) it(`is one with ${path} ${JSON.stringify(v).slice(0, 60)}`, () => {
      expect(isSignatureRecord(withField(base, path, v), ID)).toBe(true);
    });
    for (const v of bad) it(`is none with ${path} ${JSON.stringify(v).slice(0, 60)}`, () => {
      expect(isSignatureRecord(withField(base, path, v), ID)).toBe(false);
    });
  }

  const paths = [...Object.keys(base), ...Object.keys(base.evidence as object).map((k) => `evidence.${k}`)];
  it.each(paths)("is none without %s", (path) => {
    expect(isSignatureRecord(withField(base, path, undefined), ID)).toBe(false);
  });

  it.each(["extra", "evidence.extra"])("is none with a field the schema does not have: %s", (path) => {
    expect(isSignatureRecord(withField(base, path, "x"), ID)).toBe(false);
  });

  it.each(paths)("is none with another field in the place of %s", (path) => {
    const inner = path.includes(".") ? "evidence.other" : "other";
    expect(isSignatureRecord(withField(withField(base, path, undefined), inner, "x"), ID)).toBe(false);
  });

  it("is none when a field is only inherited", () => {
    const inherited = withField(base, "kind", undefined);
    inherited.other = "x";
    Object.setPrototypeOf(inherited, { kind: "individual" });
    expect(isSignatureRecord(inherited, ID)).toBe(false);
  });

  it("no one value put in the place of one field turns another record into it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...paths.filter((p) => p !== "evidence")), fc.jsonValue(), (path, v) => {
        const r = withField(base, path, v);
        // What passes is exactly a value the field's own rule takes: a text or a number, never a container.
        if (isSignatureRecord(r, ID)) expect(["string", "number"]).toContain(typeof v);
      }),
      { seed: 21, numRuns: 500 },
    );
  });
});

describe("the evidence of an acceptance comment", () => {
  it.each([...PRS.good.map((u) => [u, true] as const), ...PRS.bad.map((u) => [u, false] as const)])("pull request %j: %j, its comment being of that pull request", (pr_url, ok) => {
    const evidence = { ...(COMMENT.evidence as object), pr_url, comment_url: `${pr_url}#issuecomment-99` };
    expect(isSignatureRecord({ ...COMMENT, evidence }, ID)).toBe(ok);
  });

  it.each([1, true, null, {}, ["https://github.com/kleidos-dev/cla/pull/7"]])("a pull request that is no text (%j) is refused", (pr_url) => {
    expect(isSignatureRecord({ ...COMMENT, evidence: { ...(COMMENT.evidence as object), pr_url } }, ID)).toBe(false);
  });

  it.each([...IDS.good.map((v) => [v, true] as const), ...IDS.bad.map((v) => [v, false] as const)])("comment %j: %j, its address ending in that number", (comment_id, ok) => {
    const evidence = { ...(COMMENT.evidence as object), comment_id, comment_url: `https://github.com/kleidos-dev/cla/pull/7#issuecomment-${String(comment_id)}` };
    expect(isSignatureRecord({ ...COMMENT, evidence }, ID)).toBe(ok);
  });

  it.each(["https://github.com/kleidos-dev/cla/pull/7#issuecomment-98", "https://github.com/kleidos-dev/cla/pull/8#issuecomment-99", "https://github.com/kleidos-dev/cla/pull/7#issuecomment-99 ", "https://evil.example/", "", null, 99])("the address %j is not that comment's", (comment_url) => {
    expect(isSignatureRecord(withField(COMMENT, "evidence.comment_url", comment_url), ID)).toBe(false);
  });
});

describe("what is no record at all", () => {
  it.each([undefined, null, "text", "", 5, true, [], {}, { schema: 1 }, { schema: 2 }, [COMMENT]])("%j", (v) => {
    expect(isSignatureRecord(v, ID)).toBe(false);
  });

  it("evidence that is not there is refused, not a crash", () => {
    expect(isSignatureRecord({ ...COMMENT, evidence: undefined }, ID)).toBe(false);
    expect(isSignatureRecord({ ...SIGNIN, evidence: undefined }, ID)).toBe(false);
  });

  it("any JSON value is answered, never thrown on", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(isSignatureRecord(v, ID)).toBe(false);
      }),
      { seed: 22 },
    );
  });
});

const config = CONFIG_V2 as unknown as Config;
const record = (over: Fields = {}) => ({ ...COMMENT, version: 1, set_sha256: CONFIG.versions["1"].set_sha256, ...over }) as unknown as SignatureRecord;

describe("a record counts", () => {
  it("when its version is accepted and its digest is that version's", () => {
    expect(recordValid(config, record())).toBe(true);
    expect(recordValid(config, record({ version: 2, set_sha256: CONFIG.versions["2"].set_sha256 }))).toBe(true);
  });

  it("not when there is none", () => {
    expect(recordValid(config, null)).toBe(false);
  });

  it("not with another version's digest, nor with no version's", () => {
    expect(recordValid(config, record({ set_sha256: CONFIG.versions["2"].set_sha256 }))).toBe(false);
    expect(recordValid(config, record({ set_sha256: "0".repeat(64) }))).toBe(false);
  });

  it("not when its version is no longer accepted", () => {
    expect(recordValid({ ...config, accepted_versions: [2] }, record())).toBe(false);
  });

  it("not when its version is accepted and was never published", () => {
    expect(recordValid({ ...config, accepted_versions: [1, 2, 3] }, record({ version: 3 }))).toBe(false);
  });
});

describe("how a version is accepted", () => {
  it.each([
    [1, "comment"],
    [2, "signin"],
    [3, "comment"],
  ])("version %j: by %s", (version, flow) => {
    expect(flowOf(config, version)).toBe(flow);
  });

  it("a version that names no flow is accepted by a comment", () => {
    const { path, set_sha256, files, sentence } = CONFIG.versions["2"];
    expect(flowOf({ ...config, versions: { "2": { path, set_sha256, files, sentence } } }, 2)).toBe("comment");
  });
});

describe("an entity covers an account", () => {
  const entity = (over: Partial<Entity> = {}): Entity => ({ slug: "e", name: "Example GmbH", version: 1, set_sha256: CONFIG.versions["1"].set_sha256, signed_at: "2026-11-01", covered: [{ github_id: ID, from: "2026-11-05", until: "2026-11-10" }], ...over });
  const covers = (entities: Entity[], date = "2026-11-07", id = ID) => coveringEntity(entities, config, id, date);

  it("that it lists, from its first day to its last", () => {
    const e = entity();
    for (const d of ["2026-11-05", "2026-11-07", "2026-11-10"]) expect(covers([e], d), d).toBe(e);
    for (const d of ["2026-11-04", "2026-11-11", ""]) expect(covers([e], d), d).toBeNull();
  });

  it.each([undefined, null, ""])("with no last day (%j) from then on", (until) => {
    const e = entity({ covered: [{ github_id: ID, from: "2026-11-05", ...(until === undefined ? {} : { until }) }] });
    expect(covers([e], "9999-12-31")).toBe(e);
    expect(covers([e], "2026-11-04")).toBeNull();
  });

  it("not another account", () => {
    expect(covers([entity()], "2026-11-07", ID + 1)).toBeNull();
  });

  it("not under a version that is not accepted, or not published", () => {
    expect(coveringEntity([entity()], { ...config, accepted_versions: [2] }, ID, "2026-11-07")).toBeNull();
    expect(coveringEntity([entity({ version: 3 })], { ...config, accepted_versions: [1, 2, 3] }, ID, "2026-11-07")).toBeNull();
  });

  it("not under another digest than its version's", () => {
    expect(covers([entity({ set_sha256: CONFIG.versions["2"].set_sha256 })])).toBeNull();
  });

  it("by any of its entries, and by any entity after one that does not", () => {
    const e = entity({ covered: [{ github_id: 1, from: "2026-01-01" }, { github_id: ID, from: "2027-01-01" }, { github_id: ID, from: "2026-11-01" }] });
    expect(covers([entity({ version: 9 }), entity({ covered: [] }), e])).toBe(e);
  });

  it("by the first that does, of several", () => {
    const first = entity({ slug: "first" });
    expect(covers([first, entity({ slug: "second" })])).toBe(first);
  });

  it("by none when there is none", () => {
    expect(covers([])).toBeNull();
  });
});
