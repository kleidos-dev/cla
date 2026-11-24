// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The vectors the recorder's tests read too (registry/tests/vectors/): who
 * wrote a commit and what is a record must be the same on both sides. A
 * file that is not there, or a list with no cases, fails: a suite that reads
 * them from a list can lose every case without a word.
 */
import { describe, expect, it } from "vitest";
import authorsFile from "../../../registry/tests/vectors/authors.json";
import recordsFile from "../../../registry/tests/vectors/records.json";
import type { CommitNode } from "../../src/authors";
import { coAuthorEmails, commitAuthors, parseNoreply } from "../../src/authors";
import { isSignatureRecord } from "../../src/registry";

interface Authors {
  noreply: { name: string; email: unknown; account: unknown }[];
  trailers: { name: string; message: string; emails: string[] }[];
  commits: { name: string; commit: CommitNode; accounts: unknown; unidentified: number; tooMany: boolean }[];
}
interface Records {
  bases: Record<string, { record: Record<string, unknown> }>;
  vectors: { name: string; of: string; at?: string[]; value?: unknown; shape: boolean }[];
}

const authors = authorsFile as unknown as Authors;
const records = recordsFile as unknown as Records;
// A coverage record is no signature: the Worker only reads its name.
const signatures = records.vectors.filter((v) => v.of !== "coverage");

describe("the vectors", () => {
  it.each(["noreply", "trailers", "commits"] as const)("of authors hold cases of %s", (list) => {
    expect(authors[list].length).toBeGreaterThan(0);
  });

  it.each(["comment", "signin"])("hold records of the kind %s that are ones and that are not", (kind) => {
    expect(Object.keys(records.bases)).toContain(kind);
    const shapes = signatures.filter((v) => v.of === kind).map((v) => v.shape);
    expect([shapes.includes(true), shapes.includes(false)]).toEqual([true, true]);
  });
});

describe("who wrote a commit, as the recorder says", () => {
  it.each(authors.noreply)("a no-reply address: $name", ({ email, account }) => {
    expect(parseNoreply(email)).toEqual(account);
  });

  it.each(authors.trailers)("the trailers of a message: $name", ({ message, emails }) => {
    expect(coAuthorEmails(message)).toEqual(emails);
  });

  it.each(authors.commits)("the authors of a commit: $name", ({ commit, accounts, unidentified, tooMany }) => {
    expect(commitAuthors(commit)).toMatchObject({ accounts, unidentified, tooMany });
  });
});

describe("what is a record, as the schema says", () => {
  it.each(signatures)("$name", ({ of, at, value, shape }) => {
    const record = structuredClone(records.bases[of]?.record ?? {});
    const id = Number(record.github_id);
    if (at) {
      const last = at.slice(-1).join("");
      const outer = at.slice(0, -1).reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, record);
      if (value !== undefined) outer[last] = value;
      else Reflect.deleteProperty(outer, last);
    }
    expect(isSignatureRecord(record, id)).toBe(shape);
  });
});
