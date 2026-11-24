// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The scripts' measuring tools on planted code: a condition no test made
 * decide is reported and one that was is not; a copy of a measured file is
 * measured as itself and an edited copy is not; a mutant no test notices
 * survives, one a test notices is killed, one that hangs is killed by
 * timeout, one that ends the run early with fewer tests is killed, and a
 * survivor the list does not name is reported. Runs before every measured
 * run of the scripts (ci.yml).
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEASURED, ROOT, measuredAs } from "./mcdc-hook.mjs";
import { merged, report } from "./scripts-mcdc.mjs";
import { apply, loads, mutantsOf, sample, unlisted, verdict } from "./scripts-mut.mjs";

const dir = mkdtempSync(join(tmpdir(), "cla-selftest-"));
try {
  // A copy of a measured file is that file; a copy with one byte changed, or another file, is nothing.
  const copy = join(dir, "worker", "scripts", "check-agreement.mjs");
  mkdirSync(join(dir, "worker", "scripts"), { recursive: true });
  cpSync(join(ROOT, MEASURED[2]), copy);
  assert.equal(measuredAs(copy), "worker/scripts/check-agreement.mjs");
  assert.equal(measuredAs(join(ROOT, MEASURED[0])), "scripts/create-github-app.ts");
  writeFileSync(copy, "// edited\n");
  assert.equal(measuredAs(copy), null);
  assert.equal(measuredAs(join(ROOT, "worker", "src", "util.ts")), null);

  // Two processes' vectors merge per decision, and a condition seen only true is reported as the ratchet reads it.
  const out = join(dir, "mcdc");
  mkdirSync(out);
  const key = "worker/scripts/check-agreement.mjs#0";
  writeFileSync(join(out, "1.json"), JSON.stringify({ [key]: ["T>T"] }));
  writeFileSync(join(out, "2.json"), JSON.stringify({ [key]: ["T>T"], other: ["F>F"] }));
  const seen = merged(out);
  assert.deepEqual([...seen.get(key)], ["T>T"]);
  const r = report(seen);
  const first = r.misses.find((m) => m.file === "worker/scripts/check-agreement.mjs" && m.why === "only true");
  assert.ok(first, "a condition seen only true is reported");
  assert.ok(r.misses.every((m) => !m.file.startsWith("worker/worker/") && (m.file.startsWith("scripts/") || m.file.startsWith("worker/scripts/"))));
  assert.deepEqual(Object.keys(r.totals).sort(), [...MEASURED].sort());

  // A planted module and one test that sees one case of it.
  writeFileSync(join(dir, "m.mjs"), 'export const size = (a) => (a > 1 ? "big" : "small");\n');
  writeFileSync(join(dir, "m.test.mjs"), 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nimport { size } from "./m.mjs";\nit("five is big", () => assert.equal(size(5), "big"));\n');
  const source = 'export const size = (a) => (a > 1 ? "big" : "small");\n';
  const verdicts = {};
  for (const m of await mutantsOf("m.mjs", source)) {
    writeFileSync(join(dir, "m.mjs"), apply(source, m));
    verdicts[`${m.mutatorName} ${m.replacement}`] = (await verdict(dir, ["m.test.mjs"], 30_000, 1)).status;
  }
  writeFileSync(join(dir, "m.mjs"), source);
  assert.equal(verdicts["EqualityOperator a >= 1"], "Survived", JSON.stringify(verdicts));
  assert.equal(verdicts["ConditionalExpression false"], "Killed", JSON.stringify(verdicts));

  // A test that never ends is killed by timeout; a module that ends the process before its tests run is killed.
  writeFileSync(join(dir, "hang.test.mjs"), 'import { it } from "node:test";\nit("waits", () => new Promise(() => {}));\n');
  assert.equal((await verdict(dir, ["hang.test.mjs"], 30_000, 1, 1000)).status, "Timeout");
  writeFileSync(join(dir, "m.mjs"), "process.exit(0);\n");
  assert.equal((await verdict(dir, ["m.test.mjs"], 30_000, 1)).status, "Killed");
  writeFileSync(join(dir, "m.mjs"), source);
  assert.deepEqual(await verdict(dir, ["m.test.mjs"], 30_000, 1), { status: "Survived", passed: 1 });

  // A module that does not parse does not load; one that ends the process as it loads does.
  writeFileSync(join(dir, "broken.mjs"), "export const = ;\n");
  writeFileSync(join(dir, "exits.mjs"), "process.exit(2);\n");
  assert.deepEqual([loads(dir, "broken.mjs"), loads(dir, "exits.mjs"), loads(dir, "m.mjs")], [false, true, true]);

  // A survivor of a report that the list does not name is reported; a killed one is not.
  const mutant = (status) => ({ status, mutatorName: "Planted", replacement: "x", location: { start: { line: 1, column: 1 }, end: { line: 1, column: 7 } } });
  const planted = join(dir, "mutation.json");
  writeFileSync(planted, JSON.stringify({ files: { "worker/scripts/check-agreement.mjs": { source: "#!/usr/bin/env node\n", mutants: [mutant("Killed"), mutant("Survived")] } } }));
  const said = unlisted(planted);
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], /^mutant in worker\/scripts\/check-agreement\.mjs, .*: #!/);

  // The sample of a changed-lines run is the same for a seed, and keeps the order.
  assert.deepEqual(sample([1, 2, 3, 4, 5, 6], 3, 7), sample([1, 2, 3, 4, 5, 6], 3, 7));
  assert.deepEqual(sample([1, 2], 3, 7), [1, 2]);
  const s = sample([...Array(50).keys()], 10, 3);
  assert.deepEqual([...s].sort((a, b) => a - b), s);
  assert.equal(new Set(s).size, 10);
  console.log("scripts tools selftest: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
