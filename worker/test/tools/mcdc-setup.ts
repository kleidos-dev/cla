// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Runs in the Workers runtime beside every test file of a measured run
 * (mcdc.mjs): hands the runtime the condition to hold, notes which test
 * reached which decision, and leaves both, with the vectors, in the file's
 * meta, which the Node side reads.
 */
import { afterAll, afterEach, beforeAll, beforeEach, inject } from "vitest";
import type { RunnerTestCase } from "vitest";

interface Measured {
  seen: Map<string, Set<string>>;
  force: { key: string; index: number; value: boolean } | null;
  reached: Record<string, Set<string>> | null;
  test: string | null;
}

interface Meta {
  mcdc?: Record<string, string[]>;
  reached?: Record<string, string[]>;
}

const measured = (): Measured | undefined => (globalThis as { __mcdc?: Measured }).__mcdc;

beforeAll(() => {
  const m = measured();
  if (!m) return;
  m.force = (inject as (key: string) => Measured["force"])("force") ?? null;
  m.reached = {};
});

beforeEach(({ task }: { task: RunnerTestCase }) => {
  const m = measured();
  if (m) m.test = task.name;
});

afterEach(() => {
  const m = measured();
  if (m) m.test = null;
});

// eslint-disable-next-line no-empty-pattern -- vitest reads the fixtures a hook wants from this pattern, and takes no other form: none.
afterAll(({}, suite) => {
  const m = measured();
  if (!m) return;
  const lists = (entries: Iterable<[string, Set<string>]>) => Object.fromEntries([...entries].map(([k, v]) => [k, [...v]]));
  const meta = suite.meta as Meta;
  meta.mcdc = lists(m.seen);
  meta.reached = lists(Object.entries(m.reached ?? {}));
});
