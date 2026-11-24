#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// The build gate of the agreement texts: every file SHA256SUMS lists hashes
// to its line, and the set digest (the SHA-256 of SHA256SUMS) and the
// acceptance sentence are the ones registry/config.json names for the
// version. `npm run deploy` runs it first; CI runs it on every push.
// scripts/test/check-agreement.test.ts calls check() on tampered copies.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The acceptance sentence of a version, built from its set digest (worker/src/web.ts builds the same).
 * @param {string} version
 * @param {string} set
 */
export function sentenceFor(version, set) {
  return `I have read and I accept the Kleidos Contributor Agreement, version ${version} (SHA-256 ${set.slice(0, 12)}), made of the Contributor Agreement text and its Addendum. I understand that it lets José M. Requena Plens license my contributions under other terms as well, including paid commercial licences. I am of legal age and I am entitled to license what I contribute.`;
}

/**
 * Checks the agreement texts of the checkout at `root`, and says whether all of them pass. Each
 * failure goes to `error`; each version that passes goes to `log`, until one has failed.
 * @param {string} root
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [out]
 * @returns {boolean}
 */
export function check(root, { log = console.log, error = console.error } = {}) {
  const config = JSON.parse(readFileSync(join(root, "registry/config.json"), "utf8"));
  const sha = (/** @type {Buffer} */ b) => createHash("sha256").update(b).digest("hex");
  let failed = false;
  const fail = (/** @type {string} */ m) => {
    error(`check-agreement: ${m}`);
    failed = true;
  };

  for (const [version, info] of Object.entries(config.versions)) {
    const dir = join(root, info.path);
    const sums = readFileSync(join(dir, "SHA256SUMS"));
    const listed = new Map();
    for (const line of sums.toString("utf8").split("\n").filter(Boolean)) {
      const m = /^([0-9a-f]{64}) {2}([a-z.]+)$/.exec(line);
      if (!m) fail(`v${version}: bad SHA256SUMS line ${JSON.stringify(line)}`);
      else listed.set(m[2], m[1]);
    }
    for (const name of ["individual.md", "entity.md", "addendum.md"]) {
      if (!listed.has(name)) fail(`v${version}: SHA256SUMS does not list ${name}`);
    }
    for (const [name, digest] of listed) {
      const actual = sha(readFileSync(join(dir, name)));
      if (actual !== digest) fail(`v${version}: ${name} hashes to ${actual}, SHA256SUMS says ${digest}`);
      if (info.files[name] !== digest) fail(`v${version}: config.json names ${info.files[name]} for ${name}, SHA256SUMS ${digest}`);
    }
    const set = sha(sums);
    if (set !== info.set_sha256) fail(`v${version}: set digest ${set}, config.json says ${info.set_sha256}`);
    if (info.sentence !== sentenceFor(version, set)) fail(`v${version}: the sentence in config.json is not the one built from the digest`);
    if (info.flow !== "comment" && info.flow !== "signin") fail(`v${version}: flow must be "comment" or "signin"`);
    if (!failed) log(`check-agreement: v${version} ok, set SHA-256 ${set}`);
  }
  if (!config.accepted_versions.includes(config.current_version)) fail("current_version is not an accepted version");
  return !failed;
}

if (import.meta.main) process.exit(check(join(dirname(fileURLToPath(import.meta.url)), "..", "..")) ? 0 : 1);
