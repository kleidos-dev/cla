// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The inputs .github/workflows/record.yml declares for workflow_dispatch:
 * a choice's options, or null for a string. The fake GitHub refuses a
 * dispatch with any other input, as GitHub answers 422; and
 * tests/workflows/record.test.mts holds this table to the file, so neither
 * side can drift from the other unnoticed.
 */
export const RECORD_INPUTS: Readonly<Record<string, readonly string[] | null>> = {
  kind: ["sign", "coverage", "signin", "stamp"],
  repo: null,
  pr: null,
  comment_id: null,
  github_id: null,
  version: null,
  lang: null,
  site_commit: null,
  signin_token: null,
};
