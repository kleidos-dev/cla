#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Run mypy over a repository, once per group of folders when it declares groups.

mypy names a file that sits in no package after its file name, so one run
over two folders that each hold a `score.py` stops at "Duplicate module
named 'score'". A repository of loose scripts in folders of their own
declares groups in pyproject.toml, beside its [tool.mypy]:

    [[tool.kleidos-quality.mypy-groups]]
    name = "video-01"
    files = ["youtube/video-01/source"]

and every group is one mypy run over its folders (a glob such as
`music/*.py` names the files of a folder without its subfolders). A
group names folders and nothing else: every run reads the same
[tool.mypy], the kit's strict block included, so no group can weaken it.
With groups, [tool.mypy] sets no `files` (the groups are the roots).
check_quality.py holds every tracked Python file to exactly one group
(docs/quality.md, "The rules"). Without groups this runs a bare `mypy`,
as the kit always has.

Usage:
    mypy_groups.py [--repo DIR] [--group NAME ...] [--github]

--group runs only the groups named (a local shortcut; the CI runs them
all). --github folds each group's output, annotates each failing group
and appends a table to GITHUB_STEP_SUMMARY. Exit status: 0 every run
clean, 1 mypy found errors, 2 a bad declaration, mypy missing, or a run
mypy could not finish (a duplicate module, an unreadable root).

Python 3.15 or newer; standard library only (mypy comes from the PATH).
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

TABLE = "tool.kleidos-quality.mypy-groups"
GROUP_KEYS = frozenset({"name", "files"})
NAME_RULE = "[a-z0-9][a-z0-9._-]*"
NAME = re.compile(NAME_RULE + r"\Z")
SUMMARY_LINE = re.compile(r"^(?:Found \d+ errors? in|Success: no issues found in)\b.*$")
DEFAULT_CACHE = ".mypy_cache"
GLOB = re.compile(r"[*?[]")


@dataclass(frozen=True)
class Group:
    """One mypy run: a name and the folders (or files) it checks."""

    name: str
    files: tuple[str, ...]


def root_of(path: str) -> str:
    """A `files` entry as a repository-relative POSIX path ("." for the root)."""
    return str(path).strip().strip("/").removeprefix("./") or "."


def _bad_root(raw: str) -> str | None:
    """Why a group's folder is refused, or None."""
    if not raw.strip():
        return "an empty path"
    if raw.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", raw):
        return "an absolute path"
    if "\\" in raw:
        return "a backslash (write POSIX paths)"
    if ".." in PurePosixPath(root_of(raw)).parts:
        return "a path out of the repository"
    return None


def declared(pyproject: dict[str, Any]) -> tuple[list[Group], list[str]]:
    """The groups a parsed pyproject.toml declares, and what is wrong with them.

    No groups (no table) is not a problem: the repository runs one bare
    mypy. Every problem is a refusal; none can be waived.
    """
    tool = pyproject.get("tool")
    kit = tool.get("kleidos-quality") if isinstance(tool, dict) else None
    if kit is None:
        return [], []
    if not isinstance(kit, dict):
        return [], ["[tool.kleidos-quality] must be a table"]
    problems = [
        f"[tool.kleidos-quality] {key} is not a setting of the kit (only mypy-groups is)"
        for key in sorted(set(kit) - {"mypy-groups"})
    ]
    raw = kit.get("mypy-groups")
    if raw is None:
        return [], problems
    if not isinstance(raw, list) or not raw or not all(isinstance(e, dict) for e in raw):
        return [], [*problems, f"[[{TABLE}]] must be one or more tables"]
    groups: list[Group] = []
    names: set[str] = set()
    for i, entry in enumerate(raw):
        name = entry.get("name")
        label = f"group {name!r}" if isinstance(name, str) else f"group {i + 1}"
        extra = sorted(set(entry) - GROUP_KEYS)
        if extra:
            problems.append(
                f"{label}: {', '.join(extra)}: a group names its folders and nothing else;"
                " every group runs under the same [tool.mypy] (no waiver)"
            )
        if not isinstance(name, str) or not NAME.match(name):
            problems.append(f"{label}: name must match {NAME_RULE}")
        elif name in names:
            problems.append(f"{label}: the name is used twice")
        else:
            names.add(name)
        files = entry.get("files")
        if not isinstance(files, list) or not files or not all(isinstance(f, str) for f in files):
            problems.append(f"{label}: files must be a non-empty list of paths")
            continue
        roots: list[str] = []
        for f in files:
            why = _bad_root(f)
            if why:
                problems.append(f"{label}: {f!r} is {why}")
            elif root_of(f) in roots:
                problems.append(f"{label}: {f!r} is listed twice")
            else:
                roots.append(root_of(f))
        if isinstance(name, str):
            groups.append(Group(name, tuple(roots)))
    mypy = tool.get("mypy") if isinstance(tool, dict) else None
    if isinstance(mypy, dict) and "files" in mypy:
        problems.append(
            "[tool.mypy] files is set beside the groups: the groups are the roots, so remove it"
        )
    return groups, problems


def load(repo: Path) -> tuple[dict[str, Any], list[Group], list[str]]:
    """pyproject.toml's [tool.mypy], its groups and the problems with them."""
    path = repo / "pyproject.toml"
    if not path.is_file():
        return {}, [], []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        return {}, [], [f"pyproject.toml is not valid TOML: {exc}"]
    tool = data.get("tool")
    mypy = tool.get("mypy") if isinstance(tool, dict) else None
    groups, problems = declared(data)
    return (mypy if isinstance(mypy, dict) else {}), groups, problems


def expand(repo: Path, roots: Sequence[str]) -> list[tuple[str, list[str]]]:
    """Each root with the paths it stands for: itself, or what its glob matches.

    A glob (`*`, `?`, `[`, and `**` for any depth, as mypy's own `files`
    reads them) names files of one folder without its subfolders, say
    `music/*.py` beside a `music/test-cue/` that is a group of its own.
    Matches are sorted, and dot-files are not matched. A glob that matches
    nothing stays as written, so mypy cannot read it and the run fails.
    """
    out: list[tuple[str, list[str]]] = []
    for root in roots:
        if GLOB.search(root):
            found = glob.glob(root, root_dir=repo, recursive=True)
            out.append((root, sorted(Path(f).as_posix() for f in found) or [root]))
        else:
            out.append((root, [root]))
    return out


def paths_of(repo: Path, group: Group) -> list[str]:
    """The paths one group's mypy run is given, globs expanded."""
    return [p for _root, paths in expand(repo, group.files) for p in paths]


def command(
    mypy: str, group: Group | None, cache_base: str, paths: Sequence[str] = ()
) -> list[str]:
    """The mypy command line of one run: the group's folders and its own cache, nothing else.

    Each group has a cache directory of its own, since two groups may each
    hold a module of the same name and mypy's cache is keyed by module.
    """
    if group is None:
        return [mypy]
    targets = list(paths) or list(group.files)
    return [mypy, "--cache-dir", f"{cache_base.rstrip('/')}/{group.name}", "--", *targets]


def escape(text: str) -> str:
    """Text for a GitHub workflow command's message."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def run_all(
    repo: Path, only: Sequence[str] = (), github: bool = False, summary: Path | None = None
) -> int:
    """Run mypy once per group (or once, bare); print as it goes; return the exit status."""
    mypy_conf, groups, problems = load(repo)
    for p in problems:
        print(f"mypy_groups: pyproject.toml: {p}", file=sys.stderr)
    if problems:
        return 2
    unknown = sorted(set(only) - {g.name for g in groups})
    if unknown:
        print(f"mypy_groups: no group named {', '.join(unknown)}", file=sys.stderr)
        return 2
    mypy = shutil.which("mypy")
    if mypy is None:
        print(
            "mypy_groups: mypy is not on the PATH (install the kit's"
            " quality/requirements-tools.txt)",
            file=sys.stderr,
        )
        return 2
    cache_base = str(mypy_conf.get("cache_dir") or DEFAULT_CACHE)
    runs: list[Group | None] = [g for g in groups if not only or g.name in only] or [None]
    results: list[tuple[str, str, int, str]] = []
    for group in runs:
        name = group.name if group else "all files"
        where = ", ".join(group.files) if group else "[tool.mypy] files"
        if github:
            print(f"::group::mypy {name}: {where}", flush=True)
        else:
            print(f"--- mypy {name}: {where}", flush=True)
        done = subprocess.run(
            command(mypy, group, cache_base, paths_of(repo, group) if group else ()),
            cwd=repo,
            capture_output=True,
            text=True,
            check=False,
        )
        out = done.stdout + done.stderr
        sys.stdout.write(out if out.endswith("\n") or not out else out + "\n")
        if github:
            print("::endgroup::", flush=True)
        last = next(
            (ln for ln in reversed(out.splitlines()) if SUMMARY_LINE.match(ln)),
            f"mypy exited {done.returncode}",
        )
        results.append((name, where, done.returncode, last))
    failed = [r for r in results if r[2] != 0]
    for name, where, status, last in results:
        verdict = "clean" if status == 0 else ("errors" if status == 1 else "could not finish")
        print(f"mypy {name} ({where}): {verdict}: {last}")
        if github and status != 0:
            print(f"::error title=mypy {escape(name)}::{escape(f'{where}: {last}')}")
    if summary is not None:
        rows = [
            "## mypy (strict)",
            "",
            f"{len(results) - len(failed)} of {len(results)} run(s) clean.",
            "",
            "| Group | Folders | Result |",
            "| --- | --- | --- |",
        ]
        rows += [
            f"| {'✅' if s == 0 else '❌'} {n} | `{w}` | {last.replace('|', '/')} |"
            for n, w, s, last in results
        ]
        with summary.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(rows) + "\n\n")
    if not failed:
        return 0
    return 2 if any(r[2] not in (0, 1) for r in failed) else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--repo", type=Path, default=Path())
    ap.add_argument(
        "--group", action="append", default=[], metavar="NAME", help="run only this group"
    )
    ap.add_argument(
        "--github",
        action="store_true",
        help="fold each group, annotate failures, write GITHUB_STEP_SUMMARY",
    )
    args = ap.parse_args(argv)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY") if args.github else None
    return run_all(
        args.repo.resolve(),
        only=args.group,
        github=args.github,
        summary=Path(step_summary) if step_summary else None,
    )


if __name__ == "__main__":
    sys.exit(main())
