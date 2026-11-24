// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogValue } from "../../src/log";
import { log } from "../../src/log";

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const written = (message: string, fields?: Record<string, LogValue>): Record<string, unknown> => {
  lines.length = 0;
  if (fields === undefined) log(message);
  else log(message, fields);
  expect(lines).toHaveLength(1);
  return JSON.parse(String(lines[0])) as Record<string, unknown>;
};

/** What may reach the logs. A field added here is a decision about privacy, not a convenience. */
const ALLOWED = ["event", "action", "delivery", "kind", "repo", "pr", "installation", "outcome", "reason", "status", "request_id", "duration_ms", "attempt", "count", "route", "method", "sha"];

describe("the message", () => {
  it("is written as it is when it is short and safe, alone on its line", () => {
    log("evaluate skipped");
    expect(lines).toEqual(['{"msg":"evaluate skipped"}']);
  });

  it.each(["", "a".repeat(120), "A-z_0.9/:#,- [x]"])("%j is safe", (m) => {
    expect(written(m)).toEqual({ msg: m });
  });

  it.each(["a".repeat(121), "a\nb", "a\tb", "a=b", 'a"b', "a<b", "a;b", "señal", "a{b", "a(b", "a%b", "a+b", "a&b", "a?b", "x@example.org"])("%j is not, and is written as redacted", (m) => {
    expect(written(m)).toEqual({ msg: "redacted" });
  });

  it.each(["ghu_abc", "ghp_abc", "ghr_abc", "ghs_abc", "gho_abc", "GHU_ABC", "xghs_x", "a -----BEGIN key"])("%j carries a credential's mark and is redacted", (m) => {
    expect(written(m)).toEqual({ msg: "redacted" });
  });
});

describe("the fields", () => {
  it.each(ALLOWED)("%s is written", (name) => {
    expect(written("m", { [name]: "value" })).toEqual({ msg: "m", [name]: "value" });
  });

  it.each(["id", "account", "login", "email", "ip", "token", "code", "state", "cookie", "user", "body", "url", "Event", "msg", "__proto__", "constructor"])("%s is not", (name) => {
    expect(written("m", Object.fromEntries([[name, "value"]]))).toEqual({ msg: "m" });
  });

  it.each([0, -1, 1.5, 200, 1e21, true, false])("a number or a boolean is written as it is: %j", (v) => {
    expect(written("m", { status: v })).toEqual({ msg: "m", status: v });
  });

  it.each([undefined, null])("%j is left out", (v) => {
    expect(written("m", { status: v, pr: 7 })).toEqual({ msg: "m", pr: 7 });
  });

  it.each(["", "kleidos-dev/cla#7", "a".repeat(120)])("a short safe string is written as it is: %j", (v) => {
    expect(written("m", { reason: v })).toEqual({ msg: "m", reason: v });
  });

  it.each(["a".repeat(121), "two\nlines", "x@example.org", "code=abc", "state=abc", "CODE=ABC", "ghu_abc", "gho_abc", "GHS_abc", "-----BEGIN RSA", "ñ"])("any other string is written as redacted: %j", (v) => {
    expect(written("m", { reason: v })).toEqual({ msg: "m", reason: "redacted" });
  });

  it("one field's redaction does not touch another's value, and the order is the caller's", () => {
    log("m", { repo: "a/b", reason: "a=b", pr: 1, secret: "x", count: 2 });
    expect(lines).toEqual(['{"msg":"m","repo":"a/b","reason":"redacted","pr":1,"count":2}']);
  });

  it("whatever is logged, the line is one JSON object with allowed names and safe values only", () => {
    fc.assert(
      fc.property(fc.string(), fc.dictionary(fc.oneof(fc.constantFrom(...ALLOWED), fc.string()), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))), (m, fields) => {
        for (const [k, v] of Object.entries(written(m, fields))) {
          expect(k === "msg" || ALLOWED.includes(k)).toBe(true);
          if (typeof v === "string") expect(v).toMatch(/^[A-Za-z0-9_./:#,\- [\]]{0,120}$/);
        }
      }),
      { seed: 5 },
    );
  });
});
