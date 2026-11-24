// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** PROPERTY_SEED of the run (vitest.config.ts), 0 when it gives none. */
    propertySeed: number;
  }
}

/**
 * The seed of one property: its own, the same in every run, so a pull request
 * sees what was reviewed; moved by PROPERTY_SEED when the weekly run gives one
 * (mutation.yml prints it), so every Monday tries inputs no run tried before.
 * A failure found that way becomes a named example.
 */
export function seed(own: number): number {
  const fresh = inject("propertySeed");
  return fresh ? (fresh + own) >>> 0 : own;
}
