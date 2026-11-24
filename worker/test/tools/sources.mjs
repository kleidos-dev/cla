// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Which files are the Worker's source, as its own tools measure them: every
 * `.ts` under `src/`, at any depth, but a declaration file. mcdc.mjs
 * instruments these, changed.mjs plants their mutants, and
 * `tests/tools/ratchet.py areas` fails on a file of a Worker area that this
 * does not take. No dependency: the lint job runs it with no node_modules.
 */

/** Whether a path relative to `worker/` (with `/` between folders) is a source file of the Worker. */
export const isSource = (file) => /^src\/(?:[^/]+\/)*[^/]+\.ts$/.test(file) && !/\.d\.[cm]?ts$/.test(file);
