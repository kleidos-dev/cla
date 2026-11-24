// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * A reporter of `node --test` that counts, for each test file, the tests
 * that ran, those skipped (a suite skipped whole counts once: Node reports
 * none of the tests inside it), those left to do and those that failed, as
 * tests/tools/ratchet.py `tests` reads them against the [tests] of a
 * floors file:
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./tests/tools/node/count-reporter.mjs \
 *     --test-reporter-destination=coverage/<suite>-tests.json <files>
 */
import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));

/** The counts of a stream of test events, by file relative to the repository. */
export function count(events) {
  const files = {};
  for (const { type, data } of events) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    const file = data.file ? relative(ROOT, data.file).split(sep).join("/") : "(no file)";
    const f = (files[file] ??= { tests: 0, skipped: 0, todo: 0, failed: 0 });
    if (data.skip !== undefined) f.skipped++;
    else if (data.todo !== undefined) f.todo++;
    else if (data.details?.type !== "suite") {
      f.tests++;
      if (type === "test:fail") f.failed++;
    }
  }
  return { files };
}

export default async function* reporter(source) {
  const events = [];
  for await (const event of source) events.push({ type: event.type, data: event.data });
  yield `${JSON.stringify(count(events), null, 1)}\n`;
}
