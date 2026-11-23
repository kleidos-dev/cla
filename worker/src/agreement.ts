// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import addendum1 from "../../agreements/v1/addendum.md";
import addendumEs1 from "../../agreements/v1/addendum.es.md";
import entity1 from "../../agreements/v1/entity.md";
import individual1 from "../../agreements/v1/individual.md";
import individualEs1 from "../../agreements/v1/individual.es.md";
import sums1 from "../../agreements/v1/SHA256SUMS";
import summaryEs1 from "../../agreements/v1/summary.es.md";
import addendum2 from "../../agreements/v2/addendum.md";
import addendumEs2 from "../../agreements/v2/addendum.es.md";
import entity2 from "../../agreements/v2/entity.md";
import individual2 from "../../agreements/v2/individual.md";
import individualEs2 from "../../agreements/v2/individual.es.md";
import sums2 from "../../agreements/v2/SHA256SUMS";
import summaryEs2 from "../../agreements/v2/summary.es.md";
import privacy from "../../PRIVACY.md";
import privacyEs from "../../PRIVACY.es.md";
import { must, sha256Hex } from "./util";

/**
 * Every published version this Worker was built with, its texts bundled
 * from agreements/vN/. Which one is signed is registry/config.json's
 * current_version, read at run time: making a bundled version current is a
 * change of that file alone, with no deploy.
 */
export const AGREEMENTS: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  1: {
    "individual.md": individual1,
    "entity.md": entity1,
    "addendum.md": addendum1,
    "addendum.es.md": addendumEs1,
    "individual.es.md": individualEs1,
    "summary.es.md": summaryEs1,
    SHA256SUMS: sums1,
  },
  2: {
    "individual.md": individual2,
    "entity.md": entity2,
    "addendum.md": addendum2,
    "addendum.es.md": addendumEs2,
    "individual.es.md": individualEs2,
    "summary.es.md": summaryEs2,
    SHA256SUMS: sums2,
  },
};

/** The version the public pages show when the register cannot be read and none was read before in this isolate. */
export const FALLBACK_VERSION = 1;

export function isBundled(version: number): boolean {
  return Object.hasOwn(AGREEMENTS, version);
}

/** The bundled files of a version; throws for one this Worker was not built with (callers check isBundled first). */
export function filesOf(version: number): Readonly<Record<string, string>> {
  const f = AGREEMENTS[version];
  if (!f) throw new Error(`agreement version ${version} is not bundled`);
  return f;
}

export const NOTICES = { privacy, privacyEs };

export interface Integrity {
  ok: boolean;
  setSha256: string;
  files: Record<string, string>;
}

const integrity = new Map<number, Promise<Integrity>>();

/**
 * Hashes the bundled bytes of a version again: every file SHA256SUMS lists
 * must match it, and the set digest is the SHA-256 of SHA256SUMS itself. A
 * mismatch switches signing off; no text is shown under a digest it does
 * not have. A version that is not bundled is never ok.
 */
export function checkIntegrity(version: number): Promise<Integrity> {
  let hit = integrity.get(version);
  if (!hit) {
    hit = (async () => {
      if (!isBundled(version)) return { ok: false, setSha256: "", files: {} };
      const bundle = filesOf(version);
      const sums = must(bundle.SHA256SUMS);
      const files: Record<string, string> = {};
      let ok = true;
      const listed = sums
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => /^([0-9a-f]{64}) {2}([a-z.]+)$/.exec(l));
      for (const m of listed) {
        if (!m) {
          ok = false;
          continue;
        }
        const name = must(m[2]);
        const text = Object.hasOwn(bundle, name) ? bundle[name] : undefined;
        const actual = text === undefined ? "" : await sha256Hex(text);
        files[name] = actual;
        if (actual !== m[1]) ok = false;
      }
      for (const required of ["individual.md", "entity.md", "addendum.md"]) if (!(required in files)) ok = false;
      return { ok, setSha256: await sha256Hex(sums), files };
    })();
    integrity.set(version, hit);
  }
  return hit;
}
