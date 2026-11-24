// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * What a test passes on to a Node child it starts, so that the child is
 * measured as the test is: the MC/DC load hook (mcdc-hook.mjs) when the run
 * loaded it. Coverage needs nothing: Node hands its directory to children.
 */
export function hookArgs(): string[] {
  const at = process.execArgv.findIndex((a, i) => a === "--import" && /\/mcdc-hook\.mjs(\?|$)/.test(process.execArgv[i + 1] ?? ""));
  return at < 0 ? [] : ["--import", process.execArgv[at + 1]!];
}
