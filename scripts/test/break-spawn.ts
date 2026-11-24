// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// Loaded with --import into a setup script run as a child, under a low
// `ulimit -n`: it makes the script's first start of a command fail as a
// machine would, at the first existsSync() (the call just before main()
// starts wrangler). BREAK_SPAWN names how:
//   descriptors  every file descriptor is taken, so spawn() starts nothing
//                and gives the child no pipes (EMFILE); they are given back
//                once that spawn() has returned.
//   error        spawn() throws an Error, as it does for ENOMEM.
//   value        spawn() throws something that is not an Error.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const how = process.env.BREAK_SPAWN;
const realExists = fs.existsSync;
const realSpawn = childProcess.spawn;
let armed = false;

fs.existsSync = (path: fs.PathLike): boolean => {
  const found = realExists(path);
  if (armed) return found;
  armed = true;
  if (how === "descriptors") {
    const held: number[] = [];
    try {
      for (;;) held.push(fs.openSync("/dev/null", "r"));
    } catch {
      // EMFILE: none is left.
    }
    // Given back as soon as the code that called existsSync() (and so spawn()) has run, before the run ends and Node writes its coverage.
    process.nextTick(() => {
      for (const fd of held) fs.closeSync(fd);
    });
  } else {
    (childProcess as { spawn: unknown }).spawn = () => {
      (childProcess as { spawn: unknown }).spawn = realSpawn;
      syncBuiltinESMExports();
      throw how === "error" ? new Error("spawn ENOMEM") : 7;
    };
    syncBuiltinESMExports();
  }
  return found;
};
syncBuiltinESMExports();
