// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What the bot writes on a pull request: its one comment and the output of
 * the `📝 CLA` check, by equality for each kind of assessment. Names come
 * from GitHub and from the register: one that is not a login is never
 * written as one, and an entity's name is escaped as Markdown.
 */
import { describe, expect, it } from "vitest";
import type { Assessment } from "../../src/assess";
import type { Account } from "../../src/authors";
import type { SignatureRecord } from "../../src/registry";
import type { TextContext } from "../../src/texts";
import { checkOutput, commentBody, signUrl, who } from "../../src/texts";
import { CONFIG, restoring } from "./support";

restoring();

const ORIGIN = "https://cla.example";
const REPO = "kleidos-dev/cla-sandbox";
const alice: Account = { id: 11, login: "alice", type: "User" };
const bob: Account = { id: 22, login: "bob", type: "User" };
const carol: Account = { id: 33, login: "carol", type: "User" };
const COMMIT = "c".repeat(40);
const SIGN = `${ORIGIN}/sign/${REPO}/7`;
const FOOT = `<sub>[Agreement](${ORIGIN}/agreement) · [Privacy](${ORIGIN}/privacy) · Employer or under 18? [Who signs](https://github.com/kleidos-dev/cla#who-signs)</sub>`;

function record(acc: Account, version = 1): SignatureRecord {
  return { github_id: acc.id, version, set_sha256: "89c1d46b9b1048508d9acdba113620b08a45c57d7e067ee41dd2b816a839a61e", accepted_at: "2026-11-01T10:00:00Z" } as SignatureRecord;
}

function assessment(o: Partial<Assessment> & { signedBy?: Account[] } = {}): Assessment {
  const required = o.required ?? [alice];
  const signed = o.signed ?? new Map((o.signedBy ?? []).map((a) => [a.id, record(a)]));
  return {
    repo: REPO,
    pr: { number: 7 } as Assessment["pr"],
    opener: alice,
    required,
    signed,
    missing: o.missing ?? required.filter((r) => !signed.has(r.id)),
    exempt: [],
    entityCovered: [],
    unknownCommits: [],
    unlistedBots: [],
    tooManyCommits: false,
    acceptances: [],
    botComment: null,
    ...o,
  };
}

function ctx(o: Partial<TextContext> = {}): TextContext {
  return { origin: ORIGIN, registry: "kleidos-dev/cla", buildCommit: COMMIT, config: CONFIG as unknown as TextContext["config"], recordCommits: new Map(), github: "untouched", autoApprove: true, lateRecording: [], now: new Date(0), ...o };
}

const MARKER = "<!-- kleidos-cla:v1 -->";

describe("an account as the comment names it", () => {
  it("mentions the opener, links anybody else without a notification, and never writes what is no login", () => {
    expect(who(alice, alice.id)).toBe("@alice");
    expect(who(bob, alice.id)).toBe("[bob](https://github.com/bob)");
    expect(who({ id: 9, login: "renovate[bot]", type: "Bot" }, alice.id)).toBe("[renovate[bot]](https://github.com/renovate%5Bbot%5D)");
    for (const login of ["", "-x", "x-", "a--b", "a".repeat(40), "a b", "a\u0007", "ñandú", "a](https://evil)"]) expect(who({ id: 9, login, type: "User" }, 9), login).toBe("account id 9");
  });

  it("is signed at the sign page of its pull request", () => {
    expect(signUrl(ctx(), REPO, 7)).toBe(SIGN);
  });
});

describe("the comment", () => {
  it("before anyone signed names who still signs and where", () => {
    expect(commentBody(assessment({ required: [alice, bob] }), ctx())).toBe(
      [MARKER, "**Contributor Agreement needed.** Sign it once and the checks of this pull request start; it covers every Kleidos repository. Still to sign: @alice, [bob](https://github.com/bob).", "", `[![Sign the Kleidos Contributor Agreement: 0 of 2 authors signed](${ORIGIN}/button/v2/needed-0-2.svg)](${SIGN})`, "", FOOT].join("\n"),
    );
  });

  it("before anyone signed, where a maintainer starts the checks, says so twice", () => {
    expect(commentBody(assessment(), ctx({ autoApprove: false }))).toBe(
      [
        MARKER,
        "**Contributor Agreement needed.** Sign it once and a maintainer starts the checks of this pull request; it covers every Kleidos repository. Still to sign: @alice.",
        "",
        `[![Sign the Kleidos Contributor Agreement: 0 of 1 author signed](${ORIGIN}/button/v2/needed-0-1.svg)](${SIGN})`,
        "",
        FOOT,
      ].join("\n"),
    );
  });

  it("when one of two signed says who did, and who still signs", () => {
    expect(commentBody(assessment({ required: [alice, bob], signedBy: [bob] }), ctx())).toBe(
      [MARKER, "**Contributor Agreement: 1 of 2 signed.** [bob](https://github.com/bob) has signed; still to sign: @alice.", "", `[![Sign the Kleidos Contributor Agreement: 1 of 2 authors signed](${ORIGIN}/button/v2/partial-1-2.svg)](${SIGN})`, "", FOOT].join("\n"),
    );
  });

  it("when one of two signed names who needs none, then the button", () => {
    const body = commentBody(assessment({ required: [alice, bob], signedBy: [bob], exempt: [{ account: { id: 5, login: "dependabot[bot]", type: "Bot" }, why: "automation" }] }), ctx());
    expect(body.split("\n").slice(1, 6)).toEqual(["**Contributor Agreement: 1 of 2 signed.** [bob](https://github.com/bob) has signed; still to sign: @alice.", "", "No signature needed: `dependabot[bot]` (automation).", "", `[![Sign the Kleidos Contributor Agreement: 1 of 2 authors signed](${ORIGIN}/button/v2/partial-1-2.svg)](${SIGN})`]);
  });

  it("when two of three signed says they have", () => {
    const body = commentBody(assessment({ required: [alice, bob, carol], signedBy: [alice, bob] }), ctx());
    expect(body.split("\n")[1]).toBe("**Contributor Agreement: 2 of 3 signed.** @alice, [bob](https://github.com/bob) have signed; still to sign: [carol](https://github.com/carol).");
  });

  it("when everyone signed but a commit cannot be placed says who signed and nothing still to sign", () => {
    const body = commentBody(assessment({ required: [alice], signedBy: [alice], unknownCommits: ["abc123"] }), ctx());
    expect(body.split("\n").slice(1, 5)).toEqual([
      "**Contributor Agreement: 1 of 1 signed.** @alice has signed.",
      "",
      "**Cannot tell who wrote commit `abc123`.** Its author email is not linked to a GitHub account. Add that email to your account (Settings → Emails) or rewrite the commit's author, then push again. No email address is shown or stored here.",
      "",
    ]);
  });

  it("with nobody required and no author known says only that it is needed", () => {
    const body = commentBody(assessment({ required: [], tooManyCommits: true }), ctx());
    expect(body.split("\n").slice(1, 6)).toEqual([
      "**Contributor Agreement needed.** Sign it once and the checks of this pull request start; it covers every Kleidos repository.",
      "",
      "This pull request has too many commits to check automatically; a maintainer will look at it.",
      "",
      `[![Sign the Kleidos Contributor Agreement: 0 of 0 authors signed](${ORIGIN}/button/v2/needed-0-0.svg)](${SIGN})`,
    ]);
  });

  it("names the automation accounts, by login only when it is one", () => {
    const body = commentBody(assessment({ unlistedBots: [{ login: "helper[bot]", commit: "a" }, { login: "not a login", commit: "b" }] }), ctx());
    expect(body).toContain("\n\nThis pull request names `helper[bot]` as an author. An automation account cannot sign; a maintainer will look at it.\n\nThis pull request names `an automation account` as an author. An automation account cannot sign; a maintainer will look at it.\n\n");
  });

  it("says an acceptance is late only for an author it requires", () => {
    const body = commentBody(assessment({ required: [alice, bob] }), ctx({ lateRecording: [bob.id, 999] }));
    expect(body).toContain("\n\n[bob](https://github.com/bob)'s acceptance was posted but is not in the register yet. Nothing is lost: it is retried automatically. If this line is still here in an hour, write to mail@kleidos.dev.\n\n");
    expect(body.match(/acceptance was posted/g)).toHaveLength(1);
  });

  it("names who needs no signature, escaping an entity's name, beside who still signs", () => {
    const body = commentBody(
      assessment({ required: [alice], exempt: [{ account: { id: 5, login: "dependabot[bot]", type: "Bot" }, why: "Kleidos automation" }, { account: { id: 6, login: "-bad", type: "Bot" }, why: "x" }], entityCovered: [{ account: bob, entity: "Ñandú <b>*_Co_*</b> | #1 @x !" }] }),
      ctx(),
    );
    expect(body.split("\n").slice(3, 4)).toEqual(["No signature needed: `dependabot[bot]` (Kleidos automation), account id 6 (x), [bob](https://github.com/bob) (covered by the agreement of Ñandú \\<b\\>\\*\\_Co\\_\\*\\</b\\> \\| \\#1 \\@x \\!)."]);
  });

  it("escapes the brackets of an entity's name, so that no name is a link", () => {
    const body = commentBody(assessment({ required: [alice], entityCovered: [{ account: bob, entity: "[x](https://e.example)" }] }), ctx());
    expect(body).toContain("[bob](https://github.com/bob) (covered by the agreement of \\[x\\](https://e.example)).");
    expect(checkOutput(assessment({ required: [alice], entityCovered: [{ account: bob, entity: "[x](https://e.example)" }] }), ctx()).summary).toContain("- `bob` (id 22) is covered by the agreement of \\[x\\](https://e.example).");
  });

  it("links a register entry at a commit only when it is 40 lowercase hex digits, and on the branch otherwise", () => {
    for (const commit of [COMMIT.slice(0, 7), COMMIT.slice(0, 39), COMMIT.toUpperCase(), `${COMMIT}\n`]) {
      const body = commentBody(assessment({ required: [alice], signedBy: [alice] }), ctx({ recordCommits: new Map([[alice.id, commit]]) }));
      expect(body, commit).toContain("<sub>Register entries: [alice](https://github.com/kleidos-dev/cla/blob/signatures/signatures/individual/11.json) · ");
    }
  });

  it("when everyone signed links each register entry at the commit that added it, and says the checks run", () => {
    const body = commentBody(assessment({ required: [alice, bob, { id: 44, login: "x y", type: "User" }], signedBy: [alice, bob, { id: 44, login: "x y", type: "User" }] }), ctx({ recordCommits: new Map([[alice.id, COMMIT], [bob.id, `${COMMIT}0`], [44, `x${COMMIT}`]]) }));
    expect(body).toBe(
      [
        MARKER,
        "**Contributor Agreement signed.** Everyone who wrote this pull request has accepted it, so its checks run by themselves from now on.",
        "",
        `[![Kleidos Contributor Agreement signed by all 3 authors](${ORIGIN}/button/v2/signed-3-3.svg)](${SIGN})`,
        "",
        `<sub>Register entries: [alice](https://github.com/kleidos-dev/cla/blob/${COMMIT}/signatures/individual/11.json), [bob](https://github.com/kleidos-dev/cla/blob/signatures/signatures/individual/22.json), [account id 44](https://github.com/kleidos-dev/cla/blob/signatures/signatures/individual/44.json) · [Agreement](${ORIGIN}/agreement) · [Privacy](${ORIGIN}/privacy)</sub>`,
      ].join("\n"),
    );
  });

  it("when everyone signed and a maintainer starts the checks says so, and who needed nothing", () => {
    const body = commentBody(assessment({ required: [alice], signedBy: [alice], exempt: [{ account: { id: 5, login: "dependabot[bot]", type: "Bot" }, why: "automation" }] }), ctx({ github: "touched" }));
    expect(body.split("\n").slice(0, 7)).toEqual([
      MARKER,
      "**Contributor Agreement signed.** Everyone who wrote this pull request has accepted it; a maintainer starts its checks.",
      "",
      "No signature needed: `dependabot[bot]` (automation).",
      "",
      "This pull request changes files under `.github/`, so its checks are started by a maintainer, not automatically.",
      "",
    ]);
  });

  it("when no author needs to sign says so with the agreement's button, and no register line", () => {
    const exempt = [{ account: { id: 5, login: "dependabot[bot]", type: "Bot" as const }, why: "automation" }];
    expect(commentBody(assessment({ required: [], exempt }), ctx())).toBe([MARKER, "**No signature needed.** Every author of this pull request is covered: `dependabot[bot]` (automation).", "", `[![No signature needed on this pull request](${ORIGIN}/button/v2/none-0-0.svg)](${ORIGIN}/agreement)`, "", `<sub>[Agreement](${ORIGIN}/agreement) · [Privacy](${ORIGIN}/privacy)</sub>`].join("\n"));
    expect(commentBody(assessment({ required: [] }), ctx({ github: "unknown" }))).toBe(
      [
        MARKER,
        "**No signature needed.** Every author of this pull request is covered.",
        "",
        "Whether this pull request changes `.github/` could not be checked automatically, so its checks are started by a maintainer.",
        "",
        `[![No signature needed on this pull request](${ORIGIN}/button/v2/none-0-0.svg)](${ORIGIN}/agreement)`,
        "",
        `<sub>[Agreement](${ORIGIN}/agreement) · [Privacy](${ORIGIN}/privacy)</sub>`,
      ].join("\n"),
    );
  });
});

describe("the check run's output", () => {
  it("is action required with every author's state and where to sign", () => {
    const out = checkOutput(
      assessment({ required: [alice, bob, { id: 44, login: "not a login", type: "User" }], signedBy: [bob], exempt: [{ account: { id: 5, login: "dependabot[bot]", type: "Bot" }, why: "automation" }], entityCovered: [{ account: carol, entity: "Acme *Inc*" }], unknownCommits: ["abc"], unlistedBots: [{ login: "x[bot]", commit: "d" }, { login: "-", commit: "e" }], tooManyCommits: true }),
      ctx({ autoApprove: false }),
    );
    expect(out).toEqual({
      conclusion: "action_required",
      title: "2 signatures needed",
      summary: [
        "- `alice` (id 11): has not accepted yet",
        "- `bob` (id 22): accepted version 1 (SHA-256 `89c1d46b9b10`) at 2026-11-01T10:00:00Z",
        "- account id 44: has not accepted yet",
        "- `dependabot[bot]` (id 5) is on the Kleidos exemption list (automation).",
        "- `carol` (id 33) is covered by the agreement of Acme \\*Inc\\*.",
        "- Commit `abc`: an author's email is linked to no GitHub account.",
        "- `x[bot]` is an automation account that is not on the exemption list; a maintainer will look at it.",
        "- `an automation account` is an automation account that is not on the exemption list; a maintainer will look at it.",
        "- Too many commits to check automatically; a maintainer will look at it.",
        "",
        `Sign at ${SIGN}`,
      ].join("\n"),
    });
  });

  it("is titled by how many signatures are missing, or for a maintainer when none is", () => {
    expect(checkOutput(assessment(), ctx()).title).toBe("1 signature needed");
    expect(checkOutput(assessment({ required: [alice], signedBy: [alice], tooManyCommits: true }), ctx())).toEqual({ conclusion: "action_required", title: "A maintainer will look at it", summary: `- \`alice\` (id 11): accepted version 1 (SHA-256 \`89c1d46b9b10\`) at 2026-11-01T10:00:00Z\n- Too many commits to check automatically; a maintainer will look at it.\n\nSign at ${SIGN}` });
  });

  it("is success when everyone accepted, and says who starts the checks when a maintainer does", () => {
    expect(checkOutput(assessment({ signedBy: [alice] }), ctx())).toEqual({ conclusion: "success", title: "Contributor Agreement accepted", summary: "- `alice` (id 11): accepted version 1 (SHA-256 `89c1d46b9b10`) at 2026-11-01T10:00:00Z" });
    expect(checkOutput(assessment({ signedBy: [alice] }), ctx({ autoApprove: false })).summary).toBe(
      "- `alice` (id 11): accepted version 1 (SHA-256 `89c1d46b9b10`) at 2026-11-01T10:00:00Z\n\nIn this repository the checks of an outside pull request are started by a maintainer, not automatically.",
    );
  });

  it("names the repository's setting first when it and a change under .github/ both hold the checks back", () => {
    for (const github of ["touched", "unknown"] as const) {
      expect(checkOutput(assessment({ signedBy: [alice] }), ctx({ autoApprove: false, github })).summary, github).toBe(
        "- `alice` (id 11): accepted version 1 (SHA-256 `89c1d46b9b10`) at 2026-11-01T10:00:00Z\n\nIn this repository the checks of an outside pull request are started by a maintainer, not automatically.",
      );
    }
  });

  it("is success with nothing to sign when no author needs to", () => {
    expect(checkOutput(assessment({ required: [] }), ctx())).toEqual({ conclusion: "success", title: "No signature needed", summary: "" });
  });
});
