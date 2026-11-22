// SPDX-License-Identifier: MIT
import addendum from "../../agreements/v1/addendum.md";
import addendumEs from "../../agreements/v1/addendum.es.md";
import entity from "../../agreements/v1/entity.md";
import individual from "../../agreements/v1/individual.md";
import sums from "../../agreements/v1/SHA256SUMS";
import summaryEs from "../../agreements/v1/summary.es.md";
import privacy from "../../PRIVACY.md";
import privacyEs from "../../PRIVACY.es.md";
import { sha256Hex } from "./util";

/** The version this Worker was built with; its texts are bundled from agreements/v1/. */
export const AGREEMENT_VERSION = 1;

export const FILES: Record<string, string> = {
  "individual.md": individual,
  "entity.md": entity,
  "addendum.md": addendum,
  "addendum.es.md": addendumEs,
  "summary.es.md": summaryEs,
  SHA256SUMS: sums,
};

export const NOTICES = { privacy, privacyEs };

export interface Integrity {
  ok: boolean;
  setSha256: string;
  files: Record<string, string>;
}

let integrity: Promise<Integrity> | null = null;

/**
 * Hashes the bundled bytes again: every file SHA256SUMS lists must match
 * it, and the set digest is the SHA-256 of SHA256SUMS itself. A mismatch
 * switches signing off; no text is shown under a digest it does not have.
 */
export function checkIntegrity(): Promise<Integrity> {
  integrity ??= (async () => {
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
      const text = FILES[m[2]!];
      const actual = text === undefined ? "" : await sha256Hex(text);
      files[m[2]!] = actual;
      if (actual !== m[1]) ok = false;
    }
    for (const required of ["individual.md", "entity.md", "addendum.md"]) if (!(required in files)) ok = false;
    return { ok, setSha256: await sha256Hex(sums), files };
  })();
  return integrity;
}
