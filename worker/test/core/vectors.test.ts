// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The vectors the recorder's tests read too (registry/tests/vectors/): who
 * wrote a commit and what is a record must be the same on both sides. The
 * register's own change adds the files; until they are in the tree this
 * suite says that it is skipped, and once they are it runs by itself.
 */
import { describe, expect, it } from "vitest";
import type { CommitNode } from "../../src/authors";
import { coAuthorEmails, commitAuthors, parseNoreply } from "../../src/authors";
import { isSignatureRecord } from "../../src/registry";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true; import: "default" }): Record<string, T>;
  }
}

interface Authors {
  noreply: { name: string; email: unknown; account: unknown }[];
  trailers: { name: string; message: string; emails: string[] }[];
  commits: { name: string; commit: CommitNode; accounts: unknown; unidentified: number; tooMany: boolean }[];
}
interface Records {
  bases: Record<string, { record: Record<string, unknown> }>;
  vectors: { name: string; of: string; at?: string[]; value?: unknown; shape: boolean }[];
}

const only = <T>(files: Record<string, T>): T | undefined => Object.values(files)[0];
const authors = only(import.meta.glob<Authors>("../../../registry/tests/vectors/authors.json", { eager: true, import: "default" }));
const records = only(import.meta.glob<Records>("../../../registry/tests/vectors/records.json", { eager: true, import: "default" }));

describe.skipIf(!authors)("who wrote a commit, as the recorder says", () => {
  it.each(authors?.noreply ?? [])("a no-reply address: $name", ({ email, account }) => {
    expect(parseNoreply(email)).toEqual(account);
  });

  it.each(authors?.trailers ?? [])("the trailers of a message: $name", ({ message, emails }) => {
    expect(coAuthorEmails(message)).toEqual(emails);
  });

  it.each(authors?.commits ?? [])("the authors of a commit: $name", ({ commit, accounts, unidentified, tooMany }) => {
    expect(commitAuthors(commit)).toMatchObject({ accounts, unidentified, tooMany });
  });
});

describe.skipIf(!records)("what is a record, as the schema says", () => {
  // A coverage record is no signature: the Worker only reads its name.
  it.each((records?.vectors ?? []).filter((v) => v.of !== "coverage"))("$name", ({ of, at, value, shape }) => {
    const record = structuredClone(records?.bases[of]?.record ?? {});
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
