// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The MC/DC of the setup scripts and the agreement gate, measured in every
 * Node process that loads them: `node --import <this file>?out=<folder>`.
 * The load hook hands Node each measured file with every atomic condition
 * wrapped by the Worker's own instrumenter (worker/test/tools/mcdc.mjs),
 * and at exit the process leaves the vectors it saw in the folder, one file
 * per process. The tests pass the flag on to the children they start
 * (child.mts); scripts-mcdc.mjs runs the suite this way and sums it up.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME, instrument } from "../../../worker/test/tools/mcdc.mjs";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** The files of the area `scripts`, as tests/floors/scripts.toml names them. */
export const MEASURED = ["scripts/create-github-app.ts", "scripts/create-signin-app.ts", "worker/scripts/check-agreement.mjs"];

/** The source Node runs for a measured file read at `path`: its shebang blanked (the line stays), every condition wrapped. */
export function measuredSource(file, path = join(ROOT, file)) {
  return RUNTIME + instrument(readFileSync(path, "utf8").replace(/^#!.*/, ""), file).code;
}

/** Which measured file a loaded path is: itself, or a byte-for-byte copy a test made elsewhere (check-agreement's tree). */
export function measuredAs(path) {
  const file = relative(ROOT, path);
  if (MEASURED.includes(file)) return file;
  const same = (m) => path.endsWith(`/${m}`) && readFileSync(path).equals(readFileSync(join(ROOT, m)));
  return MEASURED.find(same) ?? null;
}

const out = new URL(import.meta.url).searchParams.get("out");
if (out) {
  registerHooks({
    load(url, context, next) {
      const path = url.startsWith("file:") ? fileURLToPath(url) : "";
      const file = path ? measuredAs(path) : null;
      if (!file) return next(url, context);
      return { format: file.endsWith(".ts") ? "module-typescript" : "module", shortCircuit: true, source: measuredSource(file, path) };
    },
  });
  process.on("exit", () => {
    const m = globalThis.__mcdc;
    if (!m) return;
    mkdirSync(out, { recursive: true });
    const seen = Object.fromEntries([...m.seen].map(([k, v]) => [k, [...v]]));
    writeFileSync(join(out, `${process.pid}-${randomBytes(4).toString("hex")}.json`), JSON.stringify(seen));
  });
}
