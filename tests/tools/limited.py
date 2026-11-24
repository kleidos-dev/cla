# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
r"""Runs a command under a time and a memory limit, the whole of what it starts included.

The command runs in a process group of its own. Four times a second the resident memory of every
process of that group is added up; past the limit, or past the time, the whole group is killed and
the run ends with 137 and a line that says which limit it passed. Otherwise the command's own exit
code is the run's, and what it left running is killed. A limit per process (``ulimit -v``) cannot
hold this: Node and workerd reserve far more address space than they use, and a campaign's memory
is the sum of its workers. Every mutation, fuzz, property or hostile-input campaign runs under it
(AGENTS.md), here and in CI. Standard library only; ``ps`` as on Linux and macOS.

    python3 tests/tools/limited.py 2700 6 -- npm run test:mutation -- --mutate src/web.ts
"""

import argparse
import contextlib
import os
import signal
import subprocess
import sys
import time

KILLED = 137
#: How often the group's memory is read, in seconds.
EVERY = 0.25


def resident(group: int) -> int:
    """The resident memory of every process of a group, in KiB."""
    table = subprocess.run(["ps", "-axo", "pgid=,rss="], capture_output=True, text=True, check=True)
    total = 0
    for row in table.stdout.splitlines():
        pgid, rss = row.split()
        if int(pgid) == group:
            total += int(rss)
    return total


def run(seconds: float, gib: float, command: list[str]) -> int:
    child = subprocess.Popen(command, start_new_session=True)
    end = time.monotonic() + seconds
    why = ""
    while child.poll() is None:
        if resident(child.pid) > gib * 1024**2:
            why = f"over {gib:g} GiB"
        elif time.monotonic() > end:
            why = f"over {seconds:g} s"
        if why:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            print(f"limited: killed, {why}: {' '.join(command)}", file=sys.stderr, flush=True)
            return KILLED
        time.sleep(EVERY)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(child.pid, signal.SIGKILL)  # whatever it left running behind it
    return child.returncode


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("seconds", type=float, help="the time the whole run may take")
    parser.add_argument("gib", type=float, help="the memory all its processes may hold together")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- and the command")
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("no command")
    return run(args.seconds, args.gib, command)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
