// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The Worker's only logger. A line carries the fields of an allowlist, each
 * a number, a boolean or a short string of a safe alphabet; any other value
 * is written as "redacted", and any other field not at all. No request body,
 * header, cookie, token, email, address, OAuth parameter or account id can
 * reach the logs through it (PRIVACY.md: nothing is kept of a sign-in that
 * does not accept).
 */
const FIELDS = new Set([
  "event",
  "action",
  "delivery",
  "kind",
  "repo",
  "pr",
  "installation",
  "outcome",
  "reason",
  "status",
  "request_id",
  "duration_ms",
  "attempt",
  "count",
  "route",
  "method",
  "sha",
]);

const SAFE = /^[A-Za-z0-9_./:#,\- [\]]{0,120}$/;
const FORBIDDEN = /gh[uprso]_|-----BEGIN|@|code=|state=/i;

export type LogValue = string | number | boolean | undefined | null;

/** A short text of the safe alphabet as it is; "redacted" for any other, and for what is no text whatever its type says. */
function safe(v: unknown): string {
  return typeof v === "string" && SAFE.test(v) && !FORBIDDEN.test(v) ? v : "redacted";
}

export function log(message: string, fields: Record<string, LogValue> = {}): void {
  const line: Record<string, string | number | boolean> = { msg: safe(message) };
  for (const [k, value] of Object.entries(fields)) {
    const v = value ?? null;
    if (FIELDS.has(k) && v !== null) line[k] = typeof v === "number" || typeof v === "boolean" ? v : safe(v);
  }
  console.log(JSON.stringify(line));
}
