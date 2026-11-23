// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Queue messages carry identifiers only: every fact is read again from
 * GitHub when a message is handled, so a lost, repeated or replayed message
 * only causes a recomputation.
 */
export type QueueMessage =
  | { kind: "evaluate"; repo: string; pr: number; record_comment?: number; attempt?: number }
  | { kind: "release"; repo: string; pr: number; sha: string; attempt?: number }
  | { kind: "held"; repo: string; sha: string }
  | { kind: "coverage"; repo: string; pr: number }
  | { kind: "installation"; installation: number };

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

function posInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Parses a message body defensively; anything unexpected is dropped. */
export function parseMessage(body: unknown): QueueMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const attempt = b.attempt === undefined ? undefined : posIntOrZero(b.attempt);
  if (b.attempt !== undefined && attempt === undefined) return null;
  switch (b.kind) {
    case "evaluate":
      if (typeof b.repo !== "string" || !REPO.test(b.repo) || !posInt(b.pr)) return null;
      if (b.record_comment !== undefined && !posInt(b.record_comment)) return null;
      return { kind: "evaluate", repo: b.repo, pr: b.pr, ...(b.record_comment ? { record_comment: b.record_comment } : {}), ...(attempt !== undefined ? { attempt } : {}) };
    case "release":
      if (typeof b.repo !== "string" || !REPO.test(b.repo) || !posInt(b.pr) || typeof b.sha !== "string" || !SHA.test(b.sha)) return null;
      return { kind: "release", repo: b.repo, pr: b.pr, sha: b.sha, ...(attempt !== undefined ? { attempt } : {}) };
    case "held":
      if (typeof b.repo !== "string" || !REPO.test(b.repo) || typeof b.sha !== "string" || !SHA.test(b.sha)) return null;
      return { kind: "held", repo: b.repo, sha: b.sha };
    case "coverage":
      if (typeof b.repo !== "string" || !REPO.test(b.repo) || !posInt(b.pr)) return null;
      return { kind: "coverage", repo: b.repo, pr: b.pr };
    case "installation":
      if (!posInt(b.installation)) return null;
      return { kind: "installation", installation: b.installation };
    default:
      return null;
  }
}

function posIntOrZero(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

export function isRepoName(s: string): boolean {
  return REPO.test(s);
}
