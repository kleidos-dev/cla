// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommitNode, GitActor } from "../../src/authors";
import { coAuthorEmails, commitAuthors, parseNoreply } from "../../src/authors";
import { isLogin } from "../../src/util";

const NOREPLY = "@users.noreply.github.com";

describe("a GitHub no-reply address", () => {
  it.each([
    ["1+a", 1, "a", "User"],
    ["123456+alice", 123456, "alice", "User"],
    ["999999999999+al-ice", 999999999999, "al-ice", "User"],
    ["00012+alice", 12, "alice", "User"],
    ["49699333+dependabot[bot]", 49699333, "dependabot[bot]", "Bot"],
    [`1+${"a".repeat(39)}`, 1, "a".repeat(39), "User"],
    [`1+${"a".repeat(39)}[bot]`, 1, `${"a".repeat(39)}[bot]`, "Bot"],
  ])("%s names the account", (local, id, login, type) => {
    expect(parseNoreply(local + NOREPLY)).toEqual({ id, login, type });
    expect(parseNoreply(`  ${local}${NOREPLY}\n`)).toEqual({ id, login, type });
    expect(parseNoreply(local + NOREPLY.toUpperCase())).toEqual({ id, login, type });
  });

  it.each([
    "",
    " ",
    "alice@example.org",
    `alice${NOREPLY}`,
    `+alice${NOREPLY}`,
    `1+${NOREPLY}`,
    `1 +alice${NOREPLY}`,
    `a1+alice${NOREPLY}`,
    `x 1+alice${NOREPLY}`,
    `1+alice${NOREPLY}.evil.example`,
    `1+alice${NOREPLY}>`,
    "1+alice@users-noreply.github.com",
    "1+alice@users.noreplyXgithub.com",
    "1+alice@users.noreply.githubXcom",
    "1+alice@usersXnoreply.github.com",
    `1234567890123+alice${NOREPLY}`,
    `-1+alice${NOREPLY}`,
    `1+al_ice${NOREPLY}`,
    `1+alice[bot]x${NOREPLY}`,
    `1+alice[${NOREPLY}`,
  ])("%j is none", (email) => {
    expect(parseNoreply(email)).toBeNull();
  });

  it("no address names nobody", () => {
    expect(parseNoreply(null)).toBeNull();
  });

  it.each([`0+alice${NOREPLY}`, `000+alice${NOREPLY}`, `\u0661\u0662+alice${NOREPLY}`, `1+-a${NOREPLY}`, `1+a-${NOREPLY}`, `1+al--ice${NOREPLY}`, `1+\u017fam${NOREPLY}`, `1+\u212aelvin${NOREPLY}`, `1+${"a".repeat(40)}${NOREPLY}`, `1+alice[BOT]${NOREPLY}`])("%j would name an account GitHub cannot have, so it names none", (email) => {
    expect(parseNoreply(email)).toBeNull();
  });

  it("never throws, and an account it names has an id and a login GitHub can have", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.tuple(fc.string({ unit: fc.constantFrom("0", "1", "9", "\u0661", "-") }), fc.string({ unit: fc.constantFrom("a", "-", "_", "[bot]", "\u017f") })).map(([id, l]) => `${id}+${l}${NOREPLY}`)), (s) => {
        const a = parseNoreply(s);
        if (a) expect(Number.isSafeInteger(a.id) && a.id > 0 && isLogin(a.login)).toBe(true);
      }),
      { seed: 11, numRuns: 1000 },
    );
  });
});

describe("the Co-authored-by trailers of a message", () => {
  it.each([
    ["one at the end", "Subject\n\nCo-authored-by: Bob <bob@example.org>", ["bob@example.org"]],
    ["two, in order", "S\n\nCo-authored-by: B <b@x.org>\nCo-authored-by: C <c@x.org>", ["b@x.org", "c@x.org"]],
    ["one that is the whole message", "Co-authored-by: B <b@x.org>", ["b@x.org"]],
    ["in any case, lower-cased", "S\n\nCO-AUTHORED-BY: B <B@X.ORG>", ["b@x.org"]],
    ["with white space after it", "S\n\nCo-authored-by: B <b@x.org> \t ", ["b@x.org"]],
    ["with no name", "S\n\nCo-authored-by: <b@x.org>", ["b@x.org"]],
    ["with no space", "S\n\nCo-authored-by:B<b@x.org>", ["b@x.org"]],
    ["of the last bracket", "S\n\nCo-authored-by: B <a@x.org> <b@x.org>", ["b@x.org"]],
    ["anywhere in the message", "S\n\nCo-authored-by: B <b@x.org>\n\nMore text", ["b@x.org"]],
    ["after a carriage return", "S\r\n\r\nCo-authored-by: B <b@x.org>\r\nEnd", ["b@x.org"]],
    ["after a lone carriage return", "S\rCo-authored-by: B <b@x.org>", ["b@x.org"]],
    ["after a Unicode line separator", "S\u2028Co-authored-by: B <b@x.org>", ["b@x.org"]],
    ["after a Unicode paragraph separator", "S\u2029Co-authored-by: B <b@x.org>\u2029End", ["b@x.org"]],
    ["that is no address at all", "S\n\nCo-authored-by: B <b>", ["b"]],
  ])("%s", (_what, message, emails) => {
    expect(coAuthorEmails(message)).toEqual(emails);
  });

  it.each([
    ["no message", ""],
    ["another trailer", "S\n\nReviewed-by: B <b@x.org>"],
    ["a line that only mentions the key", "S\n\nsee Co-authored-by: B <b@x.org>"],
    ["an indented one", "S\n\n Co-authored-by: B <b@x.org>"],
    ["no bracket", "S\n\nCo-authored-by: b@x.org"],
    ["no closing bracket", "S\n\nCo-authored-by: B <b@x.org"],
    ["text after the bracket", "S\n\nCo-authored-by: B <b@x.org> and more"],
    ["an empty address", "S\n\nCo-authored-by: B <>"],
    ["a space inside the address", "S\n\nCo-authored-by: B <b @x.org>"],
    ["two closing brackets", "S\n\nCo-authored-by: B <b@x.org>>"],
    ["the key cut short", "S\n\nCo-authored-b: B <b@x.org>"],
  ])("none in %s", (_what, message) => {
    expect(coAuthorEmails(message)).toEqual([]);
  });

  it("a trailer across two lines as JavaScript ends them is one line to the recorder, and counts", () => {
    for (const end of ["\r", "\u2028", "\u2029"]) expect(coAuthorEmails(`S\n\nCo-authored-by: B${end}<b@x.org>`)).toEqual(["b@x.org"]);
    // Read both ways it is the same address: it counts once.
    expect(coAuthorEmails("S\r\nCo-authored-by: B <b@x.org>\nEnd")).toEqual(["b@x.org"]);
  });

  it.each(["\u0085", "\u001c", "\u001d", "\u001e", "\u001f", "\ufeff"])("white space to one of the two languages only (%j) ends no address: either side would count it, so both do", (space) => {
    expect(coAuthorEmails(`S\n\nCo-authored-by: B <b${space}@x.org>`)).toEqual([`b${space}@x.org`]);
  });

  it.each(["\t", "\v", "\f", " ", "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u202f", "\u205f", "\u3000"])("white space to both languages (%j) is in no address", (space) => {
    expect(coAuthorEmails(`S\n\nCo-authored-by: B <b${space}@x.org>`)).toEqual([]);
  });

  it("is read without backtracking: every character once, whatever the message", () => {
    const line = `Co-authored-by: ${"<".repeat(50_000)}${" ".repeat(50_000)}x`;
    const message = `${line}\n${line}\n\nCo-authored-by: B <b@x.org>`;
    let reads = 0;
    const counted = new Proxy(new String(message), {
      get(s, k) {
        const v: unknown = Reflect.get(s, k);
        if (typeof v !== "function") return v;
        reads++;
        return v.bind(s) as unknown;
      },
    });
    expect(coAuthorEmails(counted as unknown as string)).toEqual(["b@x.org"]);
    // A handful of calls on the message itself, however long it is.
    expect(reads).toBeLessThan(10);
  });

  it("never throws, and every address is lower case with no bracket", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("Co-authored-by: ", "<", ">", "b@x.org", "B", " ", "\t", "\n", "\r", "\u2028", "\u0085") }), (m) => {
        for (const e of coAuthorEmails(m)) expect(e).toMatch(/^[^<>\n\r\u2028\u2029 \tA-Z]+$/);
      }),
      { seed: 12, numRuns: 1000 },
    );
  });
});

describe("the authors of a commit", () => {
  const alice: GitActor = { email: "alice@example.org", user: { databaseId: 123456, login: "alice" } };
  const commit = (nodes: GitActor[], over: Partial<CommitNode> = {}): CommitNode => ({ oid: "c".repeat(40), message: "Change", authoredDate: "2026-11-20T23:30:00-05:00", parents: { totalCount: 1 }, authors: { totalCount: nodes.length, nodes }, ...over });

  it("are the accounts GitHub resolves, dated by the day the commit was authored where its author is", () => {
    expect(commitAuthors(commit([alice]))).toEqual({ oid: "c".repeat(40), date: "2026-11-20", accounts: [{ id: 123456, login: "alice", type: "User" }], unidentified: 0, tooMany: false });
  });

  it("an account listed twice is one author", () => {
    expect(commitAuthors(commit([alice, { ...alice, email: "other@example.org" }])).accounts).toHaveLength(1);
  });

  it("an author whose address is a no-reply one is its account, with no account linked", () => {
    const bot: GitActor = { email: `49699333+dependabot[bot]${NOREPLY}`, user: null };
    expect(commitAuthors(commit([alice, bot])).accounts).toEqual([
      { id: 123456, login: "alice", type: "User" },
      { id: 49699333, login: "dependabot[bot]", type: "Bot" },
    ]);
  });

  it.each([
    ["no account and an ordinary address", { email: "x@example.org", user: null }],
    ["no account and no address", { email: null, user: null }],
    ["an account with no id", { email: "x@example.org", user: { databaseId: null, login: "x" } }],
    ["an id of zero", { email: "x@example.org", user: { databaseId: 0, login: "x" } }],
    ["a negative id", { email: "x@example.org", user: { databaseId: -1, login: "x" } }],
    ["an id that is no integer", { email: "x@example.org", user: { databaseId: 1.5, login: "x" } }],
    ["an id no number holds exactly", { email: "x@example.org", user: { databaseId: 2 ** 53, login: "x" } }],
    ["an id that is not a number", { email: "x@example.org", user: { databaseId: "7", login: "x" } }],
    ["an id of true", { email: "x@example.org", user: { databaseId: true, login: "x" } }],
    ["a login GitHub cannot have", { email: "x@example.org", user: { databaseId: 7, login: "x y" } }],
    ["no login", { email: "x@example.org", user: { databaseId: 7, login: null } }],
  ])("one with %s is unidentified", (_what, actor) => {
    expect(commitAuthors(commit([alice, actor as GitActor]))).toMatchObject({ accounts: [{ id: 123456, login: "alice", type: "User" }], unidentified: 1 });
  });

  it("an account GitHub cannot have falls back to the no-reply address beside it", () => {
    expect(commitAuthors(commit([{ email: `7+bob${NOREPLY}`, user: { databaseId: 0, login: "x" } }]))).toMatchObject({ accounts: [{ id: 7, login: "bob", type: "User" }], unidentified: 0 });
  });

  it("the largest id a number holds exactly is an id", () => {
    expect(commitAuthors(commit([{ email: null, user: { databaseId: Number.MAX_SAFE_INTEGER, login: "x" } }]))).toMatchObject({ accounts: [{ id: Number.MAX_SAFE_INTEGER }], unidentified: 0 });
  });

  it("a trailer GitHub listed is not counted again, whatever its case", () => {
    const bob: GitActor = { email: "Bob@Example.org", user: { databaseId: 234567, login: "bob" } };
    expect(commitAuthors(commit([alice, bob], { message: "S\n\nCo-authored-by: Bob <bob@EXAMPLE.org>" }))).toMatchObject({ unidentified: 0, accounts: [{ id: 123456 }, { id: 234567 }] });
  });

  it("a trailer GitHub did not list is unidentified", () => {
    expect(commitAuthors(commit([alice], { message: "S\n\nCo-authored-by: X <x@example.org>\nCo-authored-by: Y <y@example.org>" }))).toMatchObject({ unidentified: 2, accounts: [{ id: 123456 }] });
  });

  it("a no-reply trailer GitHub did not list is its account", () => {
    expect(commitAuthors(commit([alice], { message: `S\n\nCo-authored-by: Bob <234567+bob${NOREPLY}>` }))).toMatchObject({ unidentified: 0, accounts: [{ id: 123456 }, { id: 234567, login: "bob", type: "User" }] });
  });

  it("an author with no address hides no trailer", () => {
    expect(commitAuthors(commit([{ email: null, user: { databaseId: 7, login: "x" } }], { message: "S\n\nCo-authored-by: X <null>" })).unidentified).toBe(1);
  });

  it("more authors than were listed is said: somebody is not known", () => {
    expect(commitAuthors(commit([alice], { authors: { totalCount: 2, nodes: [alice] } })).tooMany).toBe(true);
    expect(commitAuthors(commit([alice], { authors: { totalCount: 1, nodes: [alice] } })).tooMany).toBe(false);
  });
});
