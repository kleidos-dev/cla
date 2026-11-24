// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * A queue message is the Worker's own writing, but it is read back by a
 * consumer that trusts nothing: parseMessage keeps the five kinds with
 * their identifiers only, refuses every field that is wrong, and never
 * throws, whatever JSON it is handed.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { QueueMessage } from "../../src/messages";
import { isRepoName, parseMessage } from "../../src/messages";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "kleidos-dev/cla-sandbox";

/** One valid message of each kind, with every optional field set. */
const FULL: Record<QueueMessage["kind"], Record<string, unknown>> = {
  evaluate: { kind: "evaluate", repo: REPO, pr: 7, record_comment: 11, await_signin: 13, attempt: 2 },
  release: { kind: "release", repo: REPO, pr: 7, sha: SHA, attempt: 0 },
  held: { kind: "held", repo: REPO, sha: SHA },
  coverage: { kind: "coverage", repo: REPO, pr: 7 },
  installation: { kind: "installation", installation: 66 },
};

/** Values that are not a positive safe integer. */
const NOT_POSITIVE = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "7", true, null, [7], { n: 7 }];

describe("a queue message of each kind", () => {
  it("is kept with its identifiers and nothing else", () => {
    for (const m of Object.values(FULL)) expect(parseMessage({ ...m, title: "<script>", token: "ghu_x" })).toEqual(m);
  });

  it("drops an optional field that is absent rather than writing it as undefined", () => {
    const evaluate = parseMessage({ kind: "evaluate", repo: REPO, pr: 7 });
    expect(evaluate).toEqual({ kind: "evaluate", repo: REPO, pr: 7 });
    expect(Object.keys(evaluate ?? {})).toEqual(["kind", "repo", "pr"]);
    expect(Object.keys(parseMessage({ kind: "release", repo: REPO, pr: 7, sha: SHA }) ?? {})).toEqual(["kind", "repo", "pr", "sha"]);
  });

  it("keeps an attempt of zero, which is a count and not an absence", () => {
    expect(parseMessage({ ...FULL.evaluate, attempt: 0 })).toEqual({ ...FULL.evaluate, attempt: 0 });
    expect(parseMessage({ kind: "release", repo: REPO, pr: 7, sha: SHA, attempt: 0 })).toEqual({ kind: "release", repo: REPO, pr: 7, sha: SHA, attempt: 0 });
  });
});

describe("a queue message that is not one", () => {
  it("is refused when it is no object", () => {
    for (const body of [null, undefined, 0, 1, "evaluate", true, Symbol.for("x")]) expect(parseMessage(body)).toBeNull();
  });

  it("is refused when its kind is not one of the five", () => {
    for (const kind of [undefined, "", "Evaluate", "evaluate ", "cron", "__proto__", 1]) expect(parseMessage({ ...FULL.evaluate, kind })).toBeNull();
  });

  it("is refused when an attempt is negative, fractional, too large or not a number, whatever its kind", () => {
    for (const attempt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "1", null, true]) {
      for (const m of Object.values(FULL)) expect(parseMessage({ ...m, attempt })).toBeNull();
    }
  });

  it("is refused when its repository is missing, not text, or not a GitHub owner/name", () => {
    const bad = [undefined, 7, null, ["a/b"], "", "kleidos-dev", "/cla", "kleidos-dev/", "a/b/c", "kleidos dev/cla", "kleidos-dev/cla\n", "kleidos-dev/cl@", `${"o".repeat(40)}/cla`, `kleidos-dev/${"r".repeat(101)}`];
    for (const kind of ["evaluate", "release", "held", "coverage"] as const) {
      for (const repo of bad) expect(parseMessage({ ...FULL[kind], repo }), `${kind} ${String(repo)}`).toBeNull();
    }
  });

  it("is refused when its pull request number is not a positive safe integer", () => {
    for (const kind of ["evaluate", "release", "coverage"] as const) {
      for (const pr of [undefined, ...NOT_POSITIVE]) expect(parseMessage({ ...FULL[kind], pr }), `${kind} ${JSON.stringify(pr)}`).toBeNull();
    }
  });

  it("is refused when its head commit is not forty lowercase hex digits", () => {
    for (const kind of ["release", "held"] as const) {
      for (const sha of [undefined, 7, null, "", SHA.slice(1), `${SHA}0`, SHA.toUpperCase(), `${SHA.slice(1)}g`, `${SHA}\n`]) expect(parseMessage({ ...FULL[kind], sha }), `${kind} ${String(sha)}`).toBeNull();
    }
  });

  it("is refused when the comment to record or the sign-in to await is not a positive safe integer", () => {
    for (const v of NOT_POSITIVE) {
      expect(parseMessage({ ...FULL.evaluate, record_comment: v })).toBeNull();
      expect(parseMessage({ ...FULL.evaluate, await_signin: v })).toBeNull();
    }
  });

  it("is refused when its installation is not a positive safe integer", () => {
    for (const installation of [undefined, ...NOT_POSITIVE]) expect(parseMessage({ kind: "installation", installation })).toBeNull();
  });
});

describe("the repository names a queue message may carry", () => {
  it("are the owner and the name GitHub allows, at their longest", () => {
    expect(isRepoName(`${"o".repeat(39)}/${"r".repeat(100)}`)).toBe(true);
    expect(isRepoName("Kleidos-Dev/cla.v2_x")).toBe(true);
    expect(isRepoName(`${"o".repeat(40)}/r`)).toBe(false);
    expect(isRepoName(`o/${"r".repeat(101)}`)).toBe(false);
    expect(isRepoName("o_x/r")).toBe(false);
    expect(isRepoName(" o/r")).toBe(false);
    expect(isRepoName("o/r ")).toBe(false);
  });
});

/** Any valid message, as the Worker writes them. */
const message: fc.Arbitrary<QueueMessage> = (() => {
  const repo = fc.tuple(fc.stringMatching(/^[A-Za-z0-9-]{1,39}$/), fc.stringMatching(/^[A-Za-z0-9._-]{1,100}$/)).map(([o, r]) => `${o}/${r}`);
  const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
  const attempt = fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined });
  const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
  const strip = (o: object): QueueMessage => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as QueueMessage;
  return fc.oneof(
    fc.record({ repo, pr: id, record_comment: fc.option(id, { nil: undefined }), await_signin: fc.option(id, { nil: undefined }), attempt }).map((m) => strip({ kind: "evaluate" as const, ...m })),
    fc.record({ repo, pr: id, sha, attempt }).map((m) => strip({ kind: "release" as const, ...m })),
    fc.record({ repo, sha }).map((m) => ({ kind: "held" as const, ...m })),
    fc.record({ repo, pr: id }).map((m) => ({ kind: "coverage" as const, ...m })),
    id.map((installation) => ({ kind: "installation" as const, installation })),
  );
})();

describe("parseMessage over generated input", () => {
  it("gives back every valid message as it was written, through JSON as the queue carries it", () => {
    fc.assert(
      fc.property(message, (m) => {
        expect(parseMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
      }),
      { seed: 2026, numRuns: 500 },
    );
  });

  it("never throws, and keeps nothing it was not asked for, on any JSON value", () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ kind: fc.constantFrom("evaluate", "release", "held", "coverage", "installation"), repo: fc.jsonValue(), pr: fc.jsonValue(), sha: fc.jsonValue(), installation: fc.jsonValue(), attempt: fc.jsonValue() }, { requiredKeys: ["kind"] })), (v) => {
        const m = parseMessage(v);
        if (m !== null) expect(parseMessage(m)).toEqual(m);
      }),
      { seed: 2027, numRuns: 1000 },
    );
  });
});
