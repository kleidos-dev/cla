#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Check a repository against the Kleidos quality kit (kleidos-dev/.github).

The kit is the one place the estate's analysis rules live (docs/quality.md
there). A repository that adopts it carries byte copies of some kit files,
managed blocks of kit text inside files of its own, and calls to the kit's
reusable workflows, all recorded in .github/quality/SOURCE.json at one kit
commit. This script checks, from the repository's root:

  copies       every copy is the bytes SOURCE.json records (and, given the
               kit, the bytes the kit holds at that commit)
  blocks       every managed block is present once, in its place, unedited
  workflows    every call to a kit workflow names the recorded commit
  profiles     the profiles recorded cover the languages the tree holds
  conformance  the repository's own configs do not weaken a kit rule
               (ruff, mypy, gitleaks, OSV, Dependabot, CI conventions,
               markdownlint, tsconfig, ESLint, clang-tidy, inline
               suppressions) unless .github/quality/waivers.toml records why
  waivers      every waiver has a reason, matches a weakening, and is live

Usage:
    check_quality.py [--repo DIR] [--kit DIR | --kit-git DIR] [--summary FILE] [--json FILE]
    check_quality.py --plant-mac [--repo DIR]     the MAC rules fire on real shapes (needs gitleaks)

Without --kit the copies are checked against SOURCE.json only (offline, the
pre-commit hook); the CI fetches the kit at the recorded commit and passes
--kit, so an edited local checker cannot pass itself. Exit status: 0 clean,
1 problems found, 2 a usage or setup error, 3 the recorded kit commit is not
in the --kit-git clone (fetch it).

Python 3.11 or newer; PyYAML (pinned in the kit's quality/requirements-tools.txt).
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tokenize
import tomllib
import unicodedata
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

KIT_REPO = "kleidos-dev/.github"
KIT_URL = "https://github.com/kleidos-dev/.github"
SOURCE_JSON = ".github/quality/SOURCE.json"
WAIVERS = ".github/quality/waivers.toml"
KIT_DIR = ".github/quality/"
COMMIT_CHECK_SOURCE = ".github/commit-check/SOURCE.json"
# The commit-message gate, copied from kleidos-dev/agents with or without a
# SOURCE.json of its own: checked there, never here. The two workflows are a
# copy only while they say so; a thin caller of the kit's
# reusable-commit-check*.yml is the repository's own.
COMMIT_CHECK_COPIES = (
    ".github/commit-check/check_commit_msg.py",
    ".github/workflows/commit-check.yml",
    ".github/workflows/commit-check-comment.yml",
)
AGENTS_COPY_MARK = "Vendored from kleidos-dev/agents"
# Every copy the kit makes, target -> source (kit.toml's [[copy]] entries; a
# kit test keeps the two equal). SOURCE.json may record these and nothing
# else, so a file cannot hide from the checks by being listed there; the
# drift test's target depends on the repository's test directory.
KIT_COPIES = {
    ".github/quality/check_quality.py": "quality/check_quality.py",
    ".github/quality/md_nowrap.py": "quality/md_nowrap.py",
    ".github/quality/spdx_headers.py": "quality/spdx_headers.py",
    ".github/quality/markdownlint.jsonc": "quality/markdownlint/base.jsonc",
    ".gitleaks-mac.toml": "quality/gitleaks/mac.toml",
    ".github/quality/ruff.toml": "quality/ruff/ruff.toml",
    ".github/zizmor.yml": "quality/zizmor/zizmor.yml",
    ".shellcheckrc": "quality/shellcheck/shellcheckrc",
    ".github/quality/eslint.base.mjs": "quality/eslint/base.mjs",
    ".github/quality/tsconfig.base.json": "quality/tsconfig/base.json",
    ".clang-tidy": "quality/clang-tidy/base.yaml",
}
KIT_TEST_COPY = ("test_quality_kit.py", "quality/templates/test_quality_kit.py")
# The files of .github/quality/ that are the repository's own, not copies.
KIT_DIR_OWN = (SOURCE_JSON, WAIVERS)
# The kit workflows every adopting repository calls, by profile; a
# repository with a sonar-project.properties also calls the SonarCloud one.
REQUIRED_WORKFLOWS = {
    "base": (
        "reusable-lint.yml",
        "reusable-reuse.yml",
        "reusable-osv.yml",
        "reusable-secrets.yml",
        "reusable-commit-check.yml",
        "reusable-commit-check-comment.yml",
        "reusable-quality-drift.yml",
    ),
    "python": ("reusable-mypy.yml",),
    "ts": ("reusable-eslint.yml",),
}
# The triggers a caller of a required kit workflow runs on: the pull
# requests and the pushes to main, except the three with fixed triggers.
REQUIRED_TRIGGERS = {
    "reusable-commit-check.yml": ("pull_request",),
    "reusable-commit-check-comment.yml": ("workflow_run",),
    "reusable-quality-drift.yml": ("schedule",),
}
DEFAULT_TRIGGERS = ("pull_request", "push")
# The only job conditions a caller of a required kit workflow may carry
# (the model's SonarCloud job, which a weekly run skips).
ALLOWED_JOB_IFS = ("github.event_name != 'schedule'",)
# The tools a cpp repository runs in a local job of its own (clang-tidy
# needs the repository's build to know its flags).
CPP_ANALYZERS = ("clang-tidy", "run-clang-tidy", "pio check")
KNOWN_PROFILES = ("base", "python", "actions", "shell", "ts", "cpp")
WAIVABLE_TOOLS = (
    "ruff",
    "eslint",
    "tsconfig",
    "clang-tidy",
    "markdownlint",
    "ci",
    "dependabot",
    "pre-commit",
    "reuse",
)
SHA40 = re.compile(r"^[0-9a-f]{40}$")

MARK_START = re.compile(r"^(?P<indent>[ \t]*)# >>> kleidos-quality (?P<id>[a-z0-9-]+)(?:[ \t].*)?$")
MARK_END = re.compile(r"^[ \t]*# <<< kleidos-quality (?P<id>[a-z0-9-]+)[ \t]*$")
KIT_USES = re.compile(
    r"kleidos-dev/\.github/\.github/workflows/(?P<file>[\w.-]+\.ya?ml)@(?P<ref>[^\s#'\"]+)"
)
USES_LINE = re.compile(r"^\s*(?:-\s+)?uses:\s*(['\"]?)(?P<ref>[^\s'\"#]+)\1\s*(?P<comment>#.*)?$")
PINNED_REF = re.compile(r"^[\w.-]+/[\w.-]+(?:/[^@\s]+)?@[0-9a-f]{40}$")

PY_SUFFIXES = (".py", ".pyi")
SHELL_SUFFIXES = (".sh", ".bash")
TS_SUFFIXES = (".ts", ".tsx", ".mts", ".cts")
JS_SUFFIXES = (".js", ".mjs", ".cjs", *TS_SUFFIXES)
CPP_SUFFIXES = (".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx")

# For mypy (owner, 2026-11-22: every error fixed, no baseline), an allowlist:
# the facts about the repository a [tool.mypy] may state, the settings that
# only change how mypy reports, and stricter flags set true. Anything else
# (always_false, untyped_calls_exclude, ignore_errors, a strict flag set
# false, ...) is refused with no waiver.
MYPY_FACT_KEYS = (
    "python_version",
    "platform",
    "files",
    "mypy_path",
    "exclude",
    "exclude_gitignore",
    "plugins",
    "namespace_packages",
    "explicit_package_bases",
    "python_executable",
    "enable_error_code",
    "overrides",
)
MYPY_REPORT_KEYS = (
    "pretty",
    "show_error_codes",
    "show_column_numbers",
    "show_error_end",
    "show_error_context",
    "show_error_code_links",
    "show_absolute_path",
    "show_traceback",
    "color_output",
    "error_summary",
    "cache_dir",
    "sqlite_cache",
    "incremental",
    "cache_fine_grained",
    "junit_xml",
)
# Flags that only make mypy stricter when set true.
MYPY_STRICT_PREFIXES = (
    "strict",
    "disallow_",
    "warn_",
    "check_untyped",
    "no_implicit",
    "extra_checks",
    "local_partial_types",
)
# Flags that make mypy stricter when set false.
MYPY_FALSE_IS_STRICT = ("implicit_reexport", "implicit_optional", "follow_untyped_imports")
RUFF_KIT_LINE_LENGTH = 100

NOQA = re.compile(r"#\s*noqa\b(?P<codes>:\s*[A-Z]+[0-9]+(?:[\s,]+[A-Z]+[0-9]+)*)?", re.IGNORECASE)
RUFF_FILE_NOQA = re.compile(r"#\s*ruff\s*:\s*noqa\b(?P<codes>:\s*\S.*)?", re.IGNORECASE)
TYPE_IGNORE = re.compile(r"#\s*type:\s*ignore(?P<codes>\[[^\]]*\])?(?P<rest>.*)$")
MYPY_INLINE = re.compile(r"^#\s*mypy:")
NOLINT = re.compile(r"NOLINT(?:NEXTLINE|BEGIN)?(?P<checks>\([^)]*\))?(?P<rest>.*)$")
ESLINT_DISABLE = re.compile(r"eslint-disable(?:-next-line|-line)?(?P<rest>[^\n*]*)")
ZIZMOR_IGNORE = re.compile(r"#\s*zizmor:\s*ignore\[")
ESLINT_IGNORES = re.compile(r"\bignores\s*:\s*\[(?P<list>[^\]]*)\]")
# Build output an ESLint config may ignore without a waiver: generated, not written.
GENERATED_DIRS = re.compile(
    r"^(?:\*\*/)?(?:node_modules|dist|build|coverage|out|\.wrangler|\.astro)(?:/.*)?$"
)
SHELLCHECK_DISABLE = re.compile(r"#\s*shellcheck\s+disable=")


# --------------------------------------------------------------------------
# Findings


@dataclass(frozen=True)
class Finding:
    """A problem: the check that found it, where, and what is wrong."""

    rule: str
    where: str
    message: str


@dataclass(frozen=True)
class Weakening:
    """Something a repository's config turns off, down or away; needs a waiver."""

    tool: str
    what: str
    where: str


@dataclass
class Report:
    """Everything one run found."""

    problems: list[Finding] = field(default_factory=list)
    weakenings: list[Weakening] = field(default_factory=list)
    waived: list[tuple[Weakening, dict[str, Any]]] = field(default_factory=list)
    suppressions: Counter[str] = field(default_factory=Counter)
    notes: list[str] = field(default_factory=list)

    def add(self, rule: str, where: str, message: str) -> None:
        self.problems.append(Finding(rule, where, message))

    def weaken(self, tool: str, what: str, where: str) -> None:
        self.weakenings.append(Weakening(tool, what, where))


class SetupError(Exception):
    """The check cannot run (exit 2)."""


class KitCommitMissingError(Exception):
    """The recorded kit commit is not in the given clone (exit 3)."""


# --------------------------------------------------------------------------
# Small helpers


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_jsonc(text: str) -> Any:
    """JSON with // and /* */ comments and trailing commas (tsconfig, markdownlint)."""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j == -1 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
        else:
            out.append(ch)
            i += 1
    cleaned = re.sub(r",(\s*[}\]])", r"\1", "".join(out))
    return json.loads(cleaned)


def find_block(text: str, block_id: str) -> tuple[int, int, str] | None:
    """(start line, end line, inner text) of one managed block, or None.

    Raises ValueError on a block that opens twice or never closes.
    """
    lines = text.splitlines(keepends=True)
    start = end = -1
    for i, line in enumerate(lines):
        m = MARK_START.match(line.rstrip("\r\n"))
        if m and m.group("id") == block_id:
            if start != -1:
                raise ValueError(f"block {block_id} opens twice")
            start = i
            continue
        m = MARK_END.match(line.rstrip("\r\n"))
        if m and m.group("id") == block_id and start != -1 and end == -1:
            end = i
    if start == -1:
        return None
    if end == -1:
        raise ValueError(f"block {block_id} never closes")
    return start, end, "".join(lines[start + 1 : end])


def block_markers(block_id: str, source: str, indent: str = "") -> tuple[str, str]:
    """The two marker lines sync.py writes around a block."""
    return (
        f"{indent}# >>> kleidos-quality {block_id}"
        f" (synced from {KIT_REPO} {source}; do not edit)\n",
        f"{indent}# <<< kleidos-quality {block_id}\n",
    )


def toml_table_of_line(lines: list[str], index: int) -> str | None:
    """The [table] (or [[array]]) header in force at a line, by its text."""
    for i in range(index, -1, -1):
        m = re.match(r"^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$", lines[i])
        if m:
            return m.group(1).replace('"', "").replace("'", "")
    return None


def under(path: str, prefix: str) -> bool:
    """Whether a posix path is the prefix itself or inside it."""
    prefix = prefix.strip("/")
    if prefix in ("", "."):
        return True
    return path == prefix or path.startswith(prefix + "/")


def has_dot_part(path: str) -> bool:
    return any(part.startswith(".") for part in PurePosixPath(path).parts[:-1])


def is_kit_target(rel: str) -> bool:
    """Whether a path is one the kit copies to (kit.toml's [[copy]] targets)."""
    if rel in KIT_COPIES:
        return True
    return PurePosixPath(rel).name == KIT_TEST_COPY[0] and not rel.startswith(KIT_DIR)


def kit_source_of(rel: str) -> str | None:
    """The kit file a copy at this path comes from, or None."""
    if rel in KIT_COPIES:
        return KIT_COPIES[rel]
    return KIT_TEST_COPY[1] if is_kit_target(rel) else None


def first_is_emoji(name: str) -> bool:
    return bool(name) and unicodedata.category(name[0]) == "So"


# --------------------------------------------------------------------------
# The kit: a directory (a checkout of kleidos-dev/.github) or a commit of a clone


class Kit:
    """Read access to the kit's files."""

    def read(self, path: str) -> bytes:
        raise NotImplementedError

    def manifest(self) -> dict[str, Any]:
        return tomllib.loads(self.read("quality/kit.toml").decode("utf-8"))

    def version(self) -> str:
        return self.read("quality/VERSION").decode("utf-8").strip()


class DirKit(Kit):
    """The kit as files in a directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        if not (root / "quality" / "kit.toml").is_file():
            raise SetupError(f"{root} holds no quality/kit.toml: not a kit checkout")

    def read(self, path: str) -> bytes:
        return (self.root / path).read_bytes()


class GitKit(Kit):
    """The kit as it is at one commit of a clone (git show)."""

    def __init__(self, clone: Path, commit: str) -> None:
        self.clone, self.commit = clone, commit
        probe = subprocess.run(
            ["git", "-C", str(clone), "cat-file", "-e", f"{commit}^{{commit}}"],
            capture_output=True,
            check=False,
        )
        if probe.returncode != 0:
            raise KitCommitMissingError(f"commit {commit[:12]} is not in {clone} (fetch it)")

    def read(self, path: str) -> bytes:
        shown = subprocess.run(
            ["git", "-C", str(self.clone), "show", f"{self.commit}:{path}"],
            capture_output=True,
            check=False,
        )
        if shown.returncode != 0:
            raise FileNotFoundError(f"{path} at {self.commit[:12]}")
        return shown.stdout


def canonical_block(kit: Kit, entry: dict[str, Any]) -> str:
    """The text a managed block holds, from the kit."""
    text = kit.read(str(entry["source"])).decode("utf-8")
    if entry.get("kind") == "pre-commit":
        found = find_block(text, str(entry["id"]))
        if found is None:
            raise SetupError(f"the kit's {entry['source']} has no block {entry['id']}")
        return found[2]
    return text


def expected(
    kit: Kit, profiles: Iterable[str], options: dict[str, str] | None = None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The copy and block entries of kit.toml that apply to these profiles and options."""
    chosen = set(profiles)
    opts = options or {}
    manifest = kit.manifest()
    copies = []
    for entry in manifest.get("copy", []):
        need = entry.get("requires")
        if entry["profile"] not in chosen or (need and not opts.get(need)):
            continue
        copies.append(
            {**entry, "target": str(entry["target"]).format(**opts) if need else entry["target"]}
        )
    blocks = [b for b in manifest.get("block", []) if b["profile"] in chosen]
    return copies, blocks


# --------------------------------------------------------------------------
# The repository under check


class Repo:
    """The tree being checked: its root and the files git knows of."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        listed = subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            capture_output=True,
            check=False,
        )
        if listed.returncode != 0:
            raise SetupError(f"{root} is not a git work tree")
        names = {p for p in listed.stdout.decode("utf-8").split("\0") if p}
        self.files = sorted(p for p in names if (self.root / p).is_file())
        self.foreign = self._foreign_copies()

    def _foreign_copies(self) -> set[str]:
        """Byte copies the repository may not edit: the kit's and the commit-check's.

        Only what the kit can have put there counts: a path SOURCE.json records
        that is one of the kit's copy targets, the two own files of
        .github/quality/, and the three commit-check paths its manifest may
        list. Anything else under .github/quality/, and any other recorded
        path, is the repository's own and is reported (check_kit_dir).
        """
        out = {p for p in KIT_DIR_OWN if p in self.files}
        out.update(p for p in self.recorded_copies() if is_kit_target(p))
        out.update(p for p in COMMIT_CHECK_COPIES if p in self.files and self._agents_copy(p))
        kit_toml = self.root / "quality" / "kit.toml"
        if kit_toml.is_file():
            # The kit's home: its non-Python sources are kit files, not this
            # repository's configs (its Python is checked like any other).
            manifest = tomllib.loads(kit_toml.read_text(encoding="utf-8"))
            for entry in [*manifest.get("copy", []), *manifest.get("seed", [])]:
                if not str(entry["source"]).endswith(PY_SUFFIXES):
                    out.add(str(entry["source"]))
        if COMMIT_CHECK_SOURCE in self.files:
            out.add(COMMIT_CHECK_SOURCE)
            out.update(p for p in self.commit_check_paths() if p in COMMIT_CHECK_COPIES)
        return out

    def recorded_copies(self) -> list[str]:
        """The copy paths .github/quality/SOURCE.json records (empty when unreadable)."""
        try:
            recorded = json.loads((self.root / SOURCE_JSON).read_text(encoding="utf-8"))
            return [str(e["path"]) for e in recorded.get("files", [])]
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return []

    def commit_check_paths(self) -> list[str]:
        """The paths .github/commit-check/SOURCE.json records (empty when unreadable)."""
        try:
            data = json.loads((self.root / COMMIT_CHECK_SOURCE).read_text(encoding="utf-8"))
            return [str(e["path"]) for e in data.get("files", [])]
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return []

    def _agents_copy(self, rel: str) -> bool:
        if rel.endswith(".py"):
            return True
        try:
            return AGENTS_COPY_MARK in (self.root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return False

    def path(self, rel: str) -> Path:
        return self.root / rel

    def exists(self, rel: str) -> bool:
        return (self.root / rel).is_file()

    def text(self, rel: str) -> str:
        return (self.root / rel).read_text(encoding="utf-8")

    def own(self, suffixes: tuple[str, ...]) -> list[str]:
        """Tracked files with these suffixes that are the repository's own."""
        return [
            p
            for p in self.files
            if p.endswith(suffixes) and p not in self.foreign and "node_modules/" not in p
        ]

    def is_central(self) -> bool:
        return (self.root / "quality" / "kit.toml").is_file()


def detect_profiles(repo: Repo) -> set[str]:
    """The profiles the tree's contents call for."""
    found = {"base"}
    if repo.own(PY_SUFFIXES):
        found.add("python")
    if any(
        p.startswith(".github/workflows/") and p.endswith((".yml", ".yaml")) for p in repo.files
    ):
        found.add("actions")
    if repo.own(SHELL_SUFFIXES):
        found.add("shell")
    if repo.own(TS_SUFFIXES) or any(
        PurePosixPath(p).name.startswith("tsconfig") for p in repo.own((".json",))
    ):
        found.add("ts")
    if repo.own(CPP_SUFFIXES):
        found.add("cpp")
    return found


# --------------------------------------------------------------------------
# SOURCE.json, copies, blocks, kit workflow references


def load_source(repo: Repo, report: Report) -> dict[str, Any] | None:
    if not repo.exists(SOURCE_JSON):
        report.add(
            "source", SOURCE_JSON, "missing: run the kit's sync.py --write on this repository"
        )
        return None
    try:
        data: dict[str, Any] = json.loads(repo.text(SOURCE_JSON))
    except ValueError as exc:
        report.add("source", SOURCE_JSON, f"not JSON: {exc}")
        return None
    commit = data.get("commit")
    if commit == "self":
        if not repo.is_central():
            report.add(
                "source", SOURCE_JSON, 'commit "self" is only for kleidos-dev/.github itself'
            )
    elif not isinstance(commit, str) or not SHA40.match(commit):
        report.add("source", SOURCE_JSON, "commit is not a 40-hex kit commit")
    profiles = data.get("profiles")
    if not isinstance(profiles, list) or "base" not in profiles:
        report.add("source", SOURCE_JSON, "profiles must be a list that includes base")
        data["profiles"] = ["base"]
    for p in data["profiles"]:
        if p not in KNOWN_PROFILES:
            report.add("source", SOURCE_JSON, f"unknown profile {p!r}")
    for key in ("files", "blocks"):
        if not isinstance(data.get(key), list):
            report.add("source", SOURCE_JSON, f"{key} must be a list")
            data[key] = []
    return data


def check_profiles(repo: Repo, source: dict[str, Any], report: Report) -> None:
    missing = sorted(detect_profiles(repo) - set(source["profiles"]))
    for p in missing:
        report.add(
            "profiles", SOURCE_JSON, f"the tree holds {p} files but the {p} profile is not adopted"
        )


def check_kit_dir(repo: Repo, source: dict[str, Any], report: Report) -> None:
    """Only kit copies live in .github/quality/, and SOURCE.json records only kit copies."""
    recorded = {str(e.get("path", "")): e for e in source["files"]}
    for rel, entry in sorted(recorded.items()):
        want = kit_source_of(rel)
        if want is None:
            report.add(
                "source",
                SOURCE_JSON,
                f"records {rel}, which is not a path the kit copies to: only kit.toml's"
                " copies may be listed",
            )
        elif str(entry.get("source_path", "")) != want:
            report.add(
                "source",
                SOURCE_JSON,
                f"records {rel} as a copy of {entry.get('source_path')}, but the kit copies"
                f" {want} there",
            )
    for rel in repo.files:
        if under(rel, KIT_DIR) and rel not in KIT_DIR_OWN and rel not in recorded:
            report.add(
                "kit-dir",
                rel,
                f"{KIT_DIR} holds only the kit's copies, {SOURCE_JSON} and {WAIVERS}:"
                " move the repository's own file elsewhere",
            )
    if COMMIT_CHECK_SOURCE in repo.files:
        for rel in repo.commit_check_paths():
            if rel not in COMMIT_CHECK_COPIES:
                report.add(
                    "source",
                    COMMIT_CHECK_SOURCE,
                    f"records {rel}: the commit-check manifest lists only"
                    f" {', '.join(COMMIT_CHECK_COPIES)}",
                )


def check_copies(repo: Repo, source: dict[str, Any], kit: Kit | None, report: Report) -> None:
    # kleidos-dev/.github (commit "self") checks its copies against its own
    # working tree only: SOURCE.json's digests there are a record, not a gate.
    is_self = source.get("commit") == "self"
    for entry in source["files"]:
        rel = str(entry.get("path", ""))
        if not repo.exists(rel):
            report.add("copies", rel, "missing (run sync.py --write)")
            continue
        digest = sha256(repo.path(rel).read_bytes())
        if not is_self and digest != entry.get("sha256"):
            report.add(
                "copies", rel, "differs from the SHA-256 SOURCE.json records: never edit a kit copy"
            )
        if kit is not None:
            try:
                want = sha256(kit.read(str(entry.get("source_path", ""))))
            except (FileNotFoundError, OSError):
                report.add("copies", rel, f"the kit has no {entry.get('source_path')}")
                continue
            if want != digest:
                report.add(
                    "copies",
                    rel,
                    f"differs from the kit's {entry.get('source_path')} at the recorded commit",
                )


def check_blocks(repo: Repo, source: dict[str, Any], kit: Kit | None, report: Report) -> None:
    canon: dict[str, str] = {}
    if kit is not None:
        for entry in kit.manifest().get("block", []):
            canon[str(entry["id"])] = canonical_block(kit, entry)
    for entry in source["blocks"]:
        rel, block_id = str(entry.get("path", "")), str(entry.get("id", ""))
        if not repo.exists(rel):
            report.add("blocks", rel, f"missing (it must hold block {block_id})")
            continue
        text = repo.text(rel)
        try:
            found = find_block(text, block_id)
        except ValueError as exc:
            report.add("blocks", rel, str(exc))
            continue
        if found is None:
            report.add("blocks", rel, f"block {block_id} is missing (run sync.py --write)")
            continue
        start, _end, inner = found
        digest = sha256(inner.encode("utf-8"))
        # In kleidos-dev/.github the block is its own source (a Dependabot
        # bump of a hook rev changes it there first), so no digest gates it.
        if source.get("commit") != "self" and digest != entry.get("sha256"):
            report.add(
                "blocks",
                rel,
                f"block {block_id} differs from the SHA-256 SOURCE.json records: never edit it",
            )
        if (
            kit is not None
            and block_id in canon
            and sha256(canon[block_id].encode("utf-8")) != digest
        ):
            report.add(
                "blocks", rel, f"block {block_id} differs from the kit's at the recorded commit"
            )
        lines = text.splitlines()
        table = entry.get("table")
        if table and toml_table_of_line(lines, start) != table:
            report.add("blocks", rel, f"block {block_id} must sit inside [{table}]")
        if rel.endswith(".pre-commit-config.yaml"):
            check_hook_block_live(text, inner, block_id, rel, report)


def check_hook_block_live(text: str, inner: str, block_id: str, rel: str, report: Report) -> None:
    """The hooks of a pre-commit block are in the parsed config (the block is not commented out)."""
    try:
        config = yaml.safe_load(text) or {}
        block = yaml.safe_load("repos:\n" + inner) or {}
    except yaml.YAMLError as exc:
        report.add("blocks", rel, f"not valid YAML: {exc}")
        return
    live = {
        h.get("alias") or h.get("id")
        for r in config.get("repos") or []
        for h in r.get("hooks") or []
    }
    want = {
        h.get("alias") or h.get("id")
        for r in block.get("repos") or []
        for h in r.get("hooks") or []
    }
    for hook in sorted(str(h) for h in want - live):
        report.add(
            "blocks", rel, f"hook {hook} of block {block_id} is not in the parsed repos list"
        )


def check_manifest_coverage(source: dict[str, Any], kit: Kit, report: Report) -> None:
    copies, blocks = expected(kit, source["profiles"], source.get("options") or {})
    have_files = {str(e.get("path")) for e in source["files"]}
    want_files = {str(c["target"]) for c in copies}
    for rel in sorted(want_files - have_files):
        report.add(
            "source",
            SOURCE_JSON,
            f"the kit's profiles call for a copy at {rel}, which is not recorded",
        )
    for rel in sorted(have_files - want_files):
        report.add("source", SOURCE_JSON, f"records a copy at {rel} that the kit no longer has")
    have_blocks = {str(e.get("id")) for e in source["blocks"]}
    want_blocks = {str(b["id"]) for b in blocks}
    for bid in sorted(want_blocks - have_blocks):
        report.add(
            "source", SOURCE_JSON, f"the kit's profiles call for block {bid}, which is not recorded"
        )
    for bid in sorted(have_blocks - want_blocks):
        report.add("source", SOURCE_JSON, f"records block {bid}, which the kit no longer has")


def workflow_files(repo: Repo) -> list[str]:
    return [
        p
        for p in repo.files
        if p.startswith(".github/workflows/") and p.endswith((".yml", ".yaml"))
    ]


def check_kit_uses(repo: Repo, source: dict[str, Any], report: Report) -> None:
    commit = source.get("commit")
    callers = 0
    for rel in workflow_files(repo):
        for num, line in enumerate(repo.text(rel).splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            for m in KIT_USES.finditer(line):
                callers += 1
                if commit == "self":
                    report.add(
                        "workflows",
                        f"{rel}:{num}",
                        "kleidos-dev/.github calls its own workflows by ./ path",
                    )
                elif m.group("ref") != commit:
                    report.add(
                        "workflows",
                        f"{rel}:{num}",
                        f"{m.group('file')} is called at {m.group('ref')[:12]}, not the"
                        f" recorded kit commit {str(commit)[:12]} (run sync.py --write)",
                    )
    required = [w for p in source["profiles"] for w in REQUIRED_WORKFLOWS.get(p, ())]
    if repo.exists("sonar-project.properties"):
        required.append("reusable-sonarcloud.yml")
    callers_of = kit_callers(repo, self_ref=commit == "self")
    for name in required:
        if commit == "self" and name == "reusable-quality-drift.yml":
            continue  # the kit's home is never behind itself
        found = callers_of.get(name, [])
        if not found:
            report.add(
                "workflows",
                ".github/workflows/",
                f"no workflow calls the kit's {name}: every check a repository runs comes"
                ' from the kit (docs/quality.md, "Reusable workflows")',
            )
            continue
        why_not = [caller_gap(c, REQUIRED_TRIGGERS.get(name, DEFAULT_TRIGGERS)) for c in found]
        if all(why_not):
            for c, why in zip(found, why_not, strict=True):
                report.add(
                    "workflows",
                    f"{c.workflow} jobs.{c.job_id}",
                    f"calls {name} but {why}, so the check may never run"
                    " (no waiver: a kit check runs on every pull request and push)",
                )
    check_lint_skip(repo, callers_of.get("reusable-lint.yml", []), report)
    report.notes.append(f"{callers} call(s) to kit workflows")


@dataclass
class Caller:
    """One job that calls a kit workflow, and what decides whether it runs."""

    workflow: str
    job_id: str
    job: dict[str, Any]
    jobs: dict[str, Any]
    triggers: dict[str, Any]


def workflow_triggers(wf: dict[Any, Any]) -> dict[str, Any]:
    """A workflow's `on:` as {event: config} (YAML 1.1 reads a bare `on` as True)."""
    raw = wf.get("on", wf.get(True))
    if isinstance(raw, str):
        return {raw: None}
    if isinstance(raw, list):
        return {str(e): None for e in raw}
    if isinstance(raw, dict):
        return {str(k): v for k, v in raw.items()}
    return {}


def kit_callers(repo: Repo, self_ref: bool) -> dict[str, list[Caller]]:
    """Kit workflow file name -> the jobs that call it."""
    out: dict[str, list[Caller]] = {}
    pattern = re.compile(
        r"^\./\.github/workflows/(?P<file>reusable-[\w.-]+\.ya?ml)$"
        if self_ref
        else r"^kleidos-dev/\.github/\.github/workflows/(?P<file>[\w.-]+\.ya?ml)@"
    )
    for rel in workflow_files(repo):
        try:
            wf = yaml.safe_load(repo.text(rel)) or {}
        except yaml.YAMLError:
            continue  # check_ci reports it
        if not isinstance(wf, dict):
            continue
        jobs = wf.get("jobs") or {}
        if not isinstance(jobs, dict):
            continue
        triggers = workflow_triggers(wf)
        for job_id, job in jobs.items():
            if not isinstance(job, dict):
                continue
            m = pattern.match(str(job.get("uses", "")))
            if m:
                out.setdefault(m.group("file"), []).append(
                    Caller(rel, str(job_id), job, jobs, triggers)
                )
    return out


def normalized_if(value: Any) -> str:
    text = str(value).strip()
    if text.startswith("${{") and text.endswith("}}"):
        text = text[3:-2]
    return re.sub(r"\s+", " ", text.replace('"', "'")).strip()


# The pull_request activity types a check must run on: a new pull request,
# every push to it, and a reopened one (GitHub's default set).
PR_TYPES = ("opened", "synchronize", "reopened")


def trigger_gap(event: str, config: Any) -> str | None:
    """Why a trigger may skip the default branch or a pull request's commits, or None."""
    if not isinstance(config, dict):
        return None
    types = config.get("types")
    if event == "pull_request" and types is not None:
        listed = [types] if isinstance(types, str) else [str(t) for t in types]
        missing = [t for t in PR_TYPES if t not in listed]
        if missing:
            return f"its pull_request trigger leaves out {', '.join(missing)}"
    if (
        event == "push"
        and ("tags" in config or "tags-ignore" in config)
        and ("branches" not in config and "branches-ignore" not in config)
    ):
        return "its push trigger runs on tags only"
    for key in ("paths", "paths-ignore"):
        if key in config:
            return f"its {event} trigger has a {key} filter"
    branches = config.get("branches")
    if branches is not None and not branch_filter_matches_main(branches):
        return f"its {event} trigger does not include main"
    ignored = config.get("branches-ignore") or []
    if any(fnmatch.fnmatch("main", str(b)) for b in ignored):
        return f"its {event} trigger ignores main"
    return None


def branch_filter_matches_main(patterns: Any) -> bool:
    """Whether a `branches:` list selects main (the last matching pattern wins, ! negates)."""
    selected = False
    for raw in [patterns] if isinstance(patterns, str) else list(patterns):
        pattern = str(raw)
        negated = pattern.startswith("!")
        if fnmatch.fnmatch("main", pattern.removeprefix("!")):
            selected = not negated
    return selected


def caller_gap(caller: Caller, events: tuple[str, ...]) -> str | None:
    """Why a caller job may not run on every pull request and push, or None."""
    for event in events:
        if event not in caller.triggers:
            return f"{caller.workflow} does not run on {event}"
        gap = trigger_gap(event, caller.triggers[event])
        if gap:
            return gap
    seen: set[str] = set()
    todo = [caller.job_id]
    while todo:
        job_id = todo.pop()
        if job_id in seen:
            continue
        seen.add(job_id)
        job = caller.jobs.get(job_id)
        if not isinstance(job, dict):
            continue
        # A scheduled caller (the drift notice) may not skip the schedule.
        allowed = () if "schedule" in events else ALLOWED_JOB_IFS
        if "if" in job and normalized_if(job["if"]) not in allowed:
            who = "it" if job_id == caller.job_id else f"the job it needs, {job_id},"
            shown = str(job["if"]).lower() if isinstance(job["if"], bool) else job["if"]
            return f"{who} carries the condition `if: {shown}`"
        needs = job.get("needs") or []
        todo.extend([needs] if isinstance(needs, str) else [str(n) for n in needs])
    return None


def kit_hook_ids(config_text: str, block_ids: Iterable[str]) -> set[str]:
    """The hook ids and aliases inside these managed blocks of a pre-commit config."""
    ids: set[str] = set()
    for block_id in block_ids:
        try:
            found = find_block(config_text, block_id)
        except ValueError:
            continue
        if found is None:
            continue
        try:
            parsed = yaml.safe_load("repos:\n" + found[2]) or {}
        except yaml.YAMLError:
            continue
        for r in parsed.get("repos") or []:
            for h in r.get("hooks") or []:
                ids.update(str(h[k]) for k in ("id", "alias") if h.get(k))
    return ids


def kit_block_hook_ids(kit: Kit) -> set[str]:
    """Every hook id and alias in the kit's pre-commit blocks."""
    ids: set[str] = set()
    for entry in kit.manifest().get("block", []):
        if entry.get("kind") == "pre-commit":
            text = kit.read(str(entry["source"])).decode("utf-8")
            ids |= kit_hook_ids(text, [str(entry["id"])])
    return ids


def refused_skips(skip: str, kit_ids: set[str]) -> list[str]:
    """The kit hook ids a lint caller's `skip` names."""
    return sorted({s.strip() for s in skip.split(",") if s.strip()} & kit_ids)


def check_lint_skip(repo: Repo, callers: list[Caller], report: Report) -> None:
    """A lint caller's `skip` names only the repository's own hooks."""
    if not repo.exists(".pre-commit-config.yaml"):
        return
    text = repo.text(".pre-commit-config.yaml")
    block_ids = [m.group("id") for m in map(MARK_START.match, text.splitlines()) if m]
    ids = kit_hook_ids(text, block_ids)
    for c in callers:
        skip = str((c.job.get("with") or {}).get("skip", ""))
        for hook in refused_skips(skip, ids):
            report.add(
                "workflows",
                f"{c.workflow} jobs.{c.job_id}",
                f"skip names the kit hook {hook}: only the repository's own hooks may be"
                " skipped (no waiver)",
            )


def check_pre_commit_globals(repo: Repo, report: Report) -> None:
    """Top-level keys of .pre-commit-config.yaml that decide whether the kit's hooks run."""
    rel = ".pre-commit-config.yaml"
    if not repo.exists(rel):
        report.add("pre-commit", rel, "missing (sync.py --write writes the kit's blocks)")
        return
    try:
        cfg = yaml.safe_load(repo.text(rel)) or {}
    except yaml.YAMLError:
        return  # check_hook_block_live reports it
    if not isinstance(cfg, dict):
        return
    # exclude '^$' is pre-commit's own default (it excludes nothing); for
    # files, any value narrows, '^$' to nothing at all.
    if cfg.get("exclude") not in (None, "", "^$"):
        report.weaken("pre-commit", f"exclude:{cfg['exclude']}", rel)
    if cfg.get("files") not in (None, ""):
        report.weaken("pre-commit", f"files:{cfg['files']}", rel)
    stages = cfg.get("default_stages")
    if stages is not None and "pre-commit" not in [str(x) for x in stages]:
        report.add(
            "pre-commit",
            rel,
            "default_stages without pre-commit stops the kit's hooks from running (no waiver)",
        )


# --------------------------------------------------------------------------
# Conformance: python


def ruff_tables(rel: str, data: dict[str, Any]) -> dict[str, Any] | None:
    if PurePosixPath(rel).name == "pyproject.toml":
        tool = data.get("tool", {})
        ruff = tool.get("ruff") if isinstance(tool, dict) else None
        return ruff if isinstance(ruff, dict) else None
    return data


def check_ruff(repo: Repo, report: Report) -> None:
    names = ("pyproject.toml", "ruff.toml", ".ruff.toml")
    configs: dict[str, dict[str, Any]] = {}
    for rel in repo.files:
        if PurePosixPath(rel).name in names and rel not in repo.foreign:
            try:
                table = ruff_tables(rel, tomllib.loads(repo.text(rel)))
            except tomllib.TOMLDecodeError as exc:
                report.add("ruff", rel, f"not valid TOML: {exc}")
                continue
            if table is not None:
                configs[rel] = table
    root_cfg = next(
        (n for n in (".ruff.toml", "ruff.toml", "pyproject.toml") if n in configs), None
    )
    if root_cfg is None:
        report.add(
            "ruff",
            "pyproject.toml",
            'no ruff config at the root: [tool.ruff] extend = ".github/quality/ruff.toml"',
        )
    kit_copy = (repo.root / KIT_DIR / "ruff.toml").resolve()
    for rel, table in sorted(configs.items()):
        chain_ok = False
        cur_rel, cur = rel, table
        for _ in range(6):
            ext = cur.get("extend")
            if not isinstance(ext, str):
                break
            target = (repo.root / PurePosixPath(cur_rel).parent / ext).resolve()
            if target == kit_copy:
                chain_ok = True
                break
            nxt = (
                target.relative_to(repo.root).as_posix() if target.is_relative_to(repo.root) else ""
            )
            if nxt not in configs:
                break
            cur_rel, cur = nxt, configs[nxt]
        if not chain_ok:
            report.add(
                "ruff",
                rel,
                f"this ruff config does not extend {KIT_DIR}ruff.toml"
                " (directly or through another)",
            )
        ruff_weakenings(rel, table, report)


def ruff_weakenings(rel: str, table: dict[str, Any], report: Report) -> None:
    lint = table.get("lint")
    scopes = [table, lint] if isinstance(lint, dict) else [table]
    for scope in scopes:
        if "select" in scope:
            report.add(
                "ruff", rel, "a local select replaces the kit's rule list: use extend-select"
            )
        for key in ("ignore", "extend-ignore"):
            for code in scope.get(key) or []:
                report.weaken("ruff", f"ignore:{code}", rel)
        for key in ("per-file-ignores", "extend-per-file-ignores"):
            for glob, codes in (scope.get(key) or {}).items():
                for code in codes:
                    report.weaken("ruff", f"per-file-ignores:{glob}:{code}", rel)
    for key in ("exclude", "extend-exclude"):
        for pattern in table.get(key) or []:
            report.weaken("ruff", f"exclude:{pattern}", rel)
    # `include` replaces ruff's file list, so it can narrow it to nothing.
    if "include" in table:
        for pattern in table.get("include") or ["(empty)"]:
            report.weaken("ruff", f"include:{pattern}", rel)
    if table.get("force-exclude") is False:
        report.weaken("ruff", "force-exclude", rel)
    length = table.get("line-length")
    if isinstance(length, int) and length > RUFF_KIT_LINE_LENGTH:
        report.weaken("ruff", f"line-length:{length}", rel)


def mypy_refusal(key: str, value: Any) -> str | None:
    """Why a [tool.mypy] setting is refused, or None when a repository may set it."""
    if key == "strict":
        return None if value is True else "strict must be true (the kit block)"
    if key in MYPY_FACT_KEYS or key in MYPY_REPORT_KEYS:
        return None
    if key == "follow_imports":
        return None if value in ("normal", "error") else f"follow_imports = {value} hides errors"
    if key.startswith(MYPY_STRICT_PREFIXES):
        return None if value is True else f"{key} = {value} turns a strict check off"
    if key in MYPY_FALSE_IS_STRICT:
        return None if value is False else f"{key} = {value} loosens a strict check"
    return (
        f"{key} is not a setting a repository may add (the kit allows the facts about the"
        " repository, the report settings and stricter flags; docs/quality.md)"
    )


def check_mypy(repo: Repo, report: Report) -> None:
    for shadow in ("mypy.ini", ".mypy.ini"):
        if repo.exists(shadow):
            report.add(
                "mypy",
                shadow,
                "mypy reads this before pyproject.toml: move its settings into [tool.mypy]",
            )
    if repo.exists("setup.cfg") and re.search(r"^\[mypy", repo.text("setup.cfg"), re.MULTILINE):
        report.add(
            "mypy",
            "setup.cfg",
            "mypy reads [mypy] here before pyproject.toml: move it into [tool.mypy]",
        )
    if not repo.exists("pyproject.toml"):
        report.add("mypy", "pyproject.toml", "missing: [tool.mypy] lives there")
        return
    text = repo.text("pyproject.toml")
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        report.add(
            "mypy", "pyproject.toml", f"not valid TOML (a key repeated from the kit block?): {exc}"
        )
        return
    mypy = data.get("tool", {}).get("mypy")
    if not isinstance(mypy, dict):
        report.add("mypy", "pyproject.toml", "no [tool.mypy] table")
        return
    where = "pyproject.toml [tool.mypy]"
    if "strict" not in mypy:
        report.add("mypy", where, "strict must be true (the kit block)")
    for key, value in mypy.items():
        refusal = mypy_refusal(key, value)
        if refusal:
            report.add("mypy", where, f"{refusal}: refused (no waiver)")
    overrides = mypy.get("overrides") or []
    for i, override in enumerate(overrides):
        extra = sorted(set(override) - {"module", "ignore_missing_imports"})
        if extra or override.get("ignore_missing_imports") is not True:
            report.add(
                "mypy",
                f"{where} overrides[{i}]",
                "an override may only set ignore_missing_imports = true"
                " for modules that ship no types (no waiver)"
                + (f"; found {', '.join(extra)}" if extra else ""),
            )
    lines = text.splitlines()
    for num, line in enumerate(lines):
        if re.match(r"^\s*\[\[\s*tool\.mypy\.overrides\s*\]\]", line):
            above = lines[num - 1].strip() if num else ""
            if not above.startswith("#"):
                report.add(
                    "mypy",
                    f"pyproject.toml:{num + 1}",
                    "an override needs a comment above it saying why each module has no types",
                )
    check_mypy_coverage(repo, mypy, report)


def check_mypy_coverage(repo: Repo, mypy: dict[str, Any], report: Report) -> None:
    files = mypy.get("files")
    if isinstance(files, str):
        files = [f.strip() for f in files.split(",") if f.strip()]
    if not files:
        report.add(
            "mypy",
            "pyproject.toml [tool.mypy]",
            "files is not set: name the roots so a bare `mypy` checks every Python file",
        )
        return
    excludes = mypy.get("exclude") or []
    if isinstance(excludes, str):
        excludes = [excludes]
    patterns = [re.compile(e if isinstance(e, str) else "") for e in excludes]
    roots = [str(f).strip("/").removeprefix("./") or "." for f in files]
    uncovered = []
    for rel in repo.own(PY_SUFFIXES):
        covered = False
        for root in roots:
            if rel == root:
                covered = True  # a file named explicitly is checked wherever it is
                break
            if root == ".":
                rest = rel
            elif under(rel, root):
                rest = rel[len(root) + 1 :]
            else:
                continue
            if not has_dot_part(rest):  # mypy skips dot-directories while it walks a root
                covered = True
                break
        if covered and any(p.search(rel) for p in patterns):
            covered = False
        if not covered:
            uncovered.append(rel)
    for rel in uncovered[:20]:
        report.add("mypy", rel, "not checked by mypy: add its root to [tool.mypy] files")
    if len(uncovered) > 20:
        report.add(
            "mypy",
            "pyproject.toml [tool.mypy]",
            f"... and {len(uncovered) - 20} more files mypy does not check",
        )


def python_comments(repo: Repo, rel: str) -> list[tuple[int, str]]:
    try:
        tokens = tokenize.generate_tokens(io.StringIO(repo.text(rel)).readline)
        return [(t.start[0], t.string) for t in tokens if t.type == tokenize.COMMENT]
    except (tokenize.TokenError, SyntaxError, UnicodeDecodeError):
        return []


def check_python_inline(repo: Repo, report: Report) -> None:
    for rel in repo.own(PY_SUFFIXES):
        for num, comment in python_comments(repo, rel):
            where = f"{rel}:{num}"
            if MYPY_INLINE.match(comment):
                report.add(
                    "mypy", where, "an inline mypy configuration comment is refused (no waiver)"
                )
            m = TYPE_IGNORE.search(comment)
            if m:
                report.suppressions["mypy ignore"] += 1
                if not m.group("codes"):
                    report.add("mypy", where, "a type-ignore comment names its error code")
                elif not re.match(r"\s*#\s*\S", m.group("rest") or ""):
                    report.add(
                        "mypy", where, "a type-ignore comment carries its reason after it (# <why>)"
                    )
            m2 = RUFF_FILE_NOQA.search(comment)
            if m2:
                report.suppressions["ruff file noqa"] += 1
                if not m2.group("codes"):
                    report.add(
                        "ruff", where, "a file-wide ruff noqa without codes silences every rule"
                    )
            elif NOQA.search(comment):
                report.suppressions["noqa"] += 1


# --------------------------------------------------------------------------
# Conformance: every repository


def check_gitleaks(repo: Repo, report: Report) -> None:
    rel = ".gitleaks.toml"
    if not repo.exists(rel):
        report.add("gitleaks", rel, "missing: the default rules config (sync.py --write seeds it)")
    else:
        try:
            cfg = tomllib.loads(repo.text(rel))
        except tomllib.TOMLDecodeError as exc:
            report.add("gitleaks", rel, f"not valid TOML: {exc}")
            cfg = {}
        extend = cfg.get("extend") or {}
        if extend.get("useDefault") is not True:
            report.add(
                "gitleaks", rel, "[extend] useDefault = true is required: every default rule"
            )
        if extend.get("disabledRules"):
            report.add(
                "gitleaks", rel, "disabledRules turns default rules off: refused (no waiver)"
            )
        if "allowlist" in cfg:
            report.add(
                "gitleaks",
                rel,
                "a global [allowlist] reaches every rule: use [[allowlists]] with targetRules",
            )
        for i, allow in enumerate(cfg.get("allowlists") or []):
            if not str(allow.get("description", "")).strip():
                report.add("gitleaks", f"{rel} allowlists[{i}]", "needs a description saying why")
            if not allow.get("targetRules"):
                report.add(
                    "gitleaks",
                    f"{rel} allowlists[{i}]",
                    "needs targetRules: an allowlist never covers every rule",
                )
    if repo.exists(".gitleaksignore"):
        prev = ""
        for num, line in enumerate(repo.text(".gitleaksignore").splitlines(), 1):
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and not prev.startswith("#"):
                report.add(
                    "gitleaks",
                    f".gitleaksignore:{num}",
                    "every fingerprint has a comment line above it saying why",
                )
            prev = stripped
            if stripped and not stripped.startswith("#"):
                report.suppressions["gitleaks fingerprint"] += 1


def check_osv(repo: Repo, report: Report, today: dt.date) -> None:
    for rel in repo.files:
        if PurePosixPath(rel).name != "osv-scanner.toml" or rel in repo.foreign:
            continue
        try:
            cfg = tomllib.loads(repo.text(rel))
        except tomllib.TOMLDecodeError as exc:
            report.add("osv", rel, f"not valid TOML: {exc}")
            continue
        for i, vuln in enumerate(cfg.get("IgnoredVulns") or []):
            where = f"{rel} IgnoredVulns[{i}] {vuln.get('id', '?')}"
            report.suppressions["osv ignore"] += 1
            if not str(vuln.get("reason", "")).strip():
                report.add("osv", where, "needs a reason")
            until = vuln.get("ignoreUntil")
            if isinstance(until, dt.datetime):
                until = until.date()
            if not isinstance(until, dt.date):
                report.add("osv", where, "needs an ignoreUntil date, at most 90 days ahead")
            elif until > today + dt.timedelta(days=90):
                report.add("osv", where, f"ignoreUntil {until} is more than 90 days ahead")
            elif until < today:
                report.add(
                    "osv", where, f"expired on {until}: fix the dependency or renew with a reason"
                )


def manifest_dirs(repo: Repo) -> dict[str, set[str]]:
    """Ecosystem -> the directories ("/x") that hold its manifests."""
    out: dict[str, set[str]] = {"pip": set(), "npm": set()}
    for rel in repo.files:
        if rel in repo.foreign or "node_modules/" in rel:
            continue
        p = PurePosixPath(rel)
        parent = str(p.parent)
        d = "/" if parent == "." else "/" + parent
        if p.name == "pyproject.toml" or re.match(r"^requirements[\w.-]*\.txt$", p.name):
            out["pip"].add(d)
        elif p.name == "package.json":
            out["npm"].add(d)
    return out


def check_dependabot(repo: Repo, report: Report, central: bool) -> None:
    rel = ".github/dependabot.yml"
    if not repo.exists(rel):
        report.add("dependabot", rel, "missing")
        return
    try:
        cfg = yaml.safe_load(repo.text(rel)) or {}
    except yaml.YAMLError as exc:
        report.add("dependabot", rel, f"not valid YAML: {exc}")
        return
    updates = cfg.get("updates") or []
    covered: dict[str, list[str]] = {}
    for u in updates:
        eco = str(u.get("package-ecosystem", ""))
        dirs = [
            str(x)
            for x in ([u["directory"]] if "directory" in u else [])
            + list(u.get("directories") or [])
        ]
        covered.setdefault(eco, []).extend(dirs)
        if not u.get("cooldown"):
            report.add(
                "dependabot",
                rel,
                f"{eco} {', '.join(dirs) or '?'}: needs a cooldown (default-days: 7), so a"
                " compromised or yanked release has time to be noticed (zizmor's"
                " dependabot-cooldown)",
            )
        for d in dirs:
            if under(d.strip("/"), ".github/quality"):
                report.add(
                    "dependabot",
                    rel,
                    f"{d}: the kit's copies are bumped by the sync, never by Dependabot",
                )
        if eco == "pre-commit" and not central:
            report.add(
                "dependabot",
                rel,
                "the pre-commit ecosystem runs in kleidos-dev/.github only:"
                " the hook versions come with the sync",
            )
        if eco == "github-actions":
            names = [str(i.get("dependency-name", "")) for i in u.get("ignore") or []]
            if not any(fnmatch.fnmatch("kleidos-dev/.github", n) for n in names):
                report.add(
                    "dependabot",
                    rel,
                    'github-actions must ignore "kleidos-dev/.github*":'
                    " the sync moves the kit's workflow references",
                )
    if "github-actions" not in covered and workflow_files(repo):
        report.add("dependabot", rel, "no github-actions ecosystem")
    aliases = {"pip": ("pip", "uv"), "npm": ("npm", "bun")}
    for eco, found in manifest_dirs(repo).items():
        listed = [d for e in aliases[eco] for d in covered.get(e, [])]
        for d in sorted(found):
            if not any(
                d in (pat, "/" + pat.strip("/")) or fnmatch.fnmatch(d, pat) for pat in listed
            ):
                report.weaken("dependabot", f"{eco}:{d}", rel)


def check_ci(repo: Repo, report: Report) -> None:
    for rel in workflow_files(repo):
        if rel in repo.foreign:
            continue
        text = repo.text(rel)
        try:
            wf = yaml.safe_load(text) or {}
        except yaml.YAMLError as exc:
            report.add("ci", rel, f"not valid YAML: {exc}")
            continue
        jobs = wf.get("jobs") or {}
        for job_id, job in jobs.items():
            where = f"{rel} jobs.{job_id}"
            if not isinstance(job, dict):
                continue
            name = str(job.get("name", ""))
            if not first_is_emoji(name):
                report.add("ci", where, "the job's name starts with an emoji (the CI convention)")
            if "uses" not in job and "timeout-minutes" not in job:
                report.add("ci", where, "needs a timeout-minutes")
            if job.get("continue-on-error") in (True, "true"):
                report.weaken("ci", f"continue-on-error:{rel}:{job_id}", rel)
        for num, line in enumerate(text.splitlines(), 1):
            m = USES_LINE.match(line)
            if not m:
                continue
            ref = m.group("ref")
            if ref.startswith(("./", "docker://")):
                continue
            if not PINNED_REF.match(ref):
                report.add("ci", f"{rel}:{num}", f"{ref} is not pinned by a full commit SHA")
            elif not (m.group("comment") or "").strip("# "):
                report.add(
                    "ci", f"{rel}:{num}", "a pinned uses: carries the version it pins in a comment"
                )
        for num, line in enumerate(text.splitlines(), 1):
            if ZIZMOR_IGNORE.search(line):
                report.suppressions["zizmor ignore"] += 1
                above = text.splitlines()[num - 2].strip() if num > 1 else ""
                if not above.startswith("#"):
                    report.add(
                        "ci",
                        f"{rel}:{num}",
                        "a zizmor ignore has its reason in a comment on the line above",
                    )


def check_markdownlint(repo: Repo, kit: Kit | None, report: Report) -> None:
    rel = ".markdownlint-cli2.jsonc"
    if not repo.exists(rel):
        report.add(
            "markdownlint",
            rel,
            f'missing: {{"config": {{"extends": "{KIT_DIR}markdownlint.jsonc"}}}}',
        )
        return
    try:
        cfg = load_jsonc(repo.text(rel))
    except ValueError as exc:
        report.add("markdownlint", rel, f"not valid JSONC: {exc}")
        return
    config = cfg.get("config") or {}
    if config.get("extends") != f"{KIT_DIR}markdownlint.jsonc":
        report.add("markdownlint", rel, f'config.extends must be "{KIT_DIR}markdownlint.jsonc"')
    base: dict[str, Any] = {}
    if repo.exists(f"{KIT_DIR}markdownlint.jsonc"):
        base = load_jsonc(repo.text(f"{KIT_DIR}markdownlint.jsonc"))
    elif kit is not None:
        base = load_jsonc(kit.read("quality/markdownlint/base.jsonc").decode("utf-8"))
    for rule, value in config.items():
        if rule == "default" and value is False:
            continue
        if base.get(rule) is True and value is False:
            report.weaken("markdownlint", rule, rel)
    for pattern in cfg.get("ignores") or []:
        if pattern not in ("node_modules/**", "**/node_modules/**"):
            report.weaken("markdownlint", f"ignores:{pattern}", rel)
    # A .markdownlint.* file beside it overrides its config (markdownlint-cli2
    # reads both, the plain one last), so one there extends the kit base too.
    for plain in (
        ".markdownlint.jsonc",
        ".markdownlint.json",
        ".markdownlint.yaml",
        ".markdownlint.yml",
    ):
        if not repo.exists(plain):
            continue
        try:
            text = repo.text(plain)
            other = (
                yaml.safe_load(text) if plain.endswith((".yaml", ".yml")) else load_jsonc(text)
            ) or {}
        except (ValueError, yaml.YAMLError) as exc:
            report.add("markdownlint", plain, f"not valid: {exc}")
            continue
        if other.get("extends") != f"{KIT_DIR}markdownlint.jsonc":
            report.add(
                "markdownlint",
                plain,
                f'overrides .markdownlint-cli2.jsonc: it must say "extends": "{KIT_DIR}'
                'markdownlint.jsonc" too',
            )
        for rule, value in other.items():
            if base.get(rule) is True and value is False:
                report.weaken("markdownlint", rule, plain)


def check_suppressions_c_js(repo: Repo, report: Report) -> None:
    for rel in repo.own(CPP_SUFFIXES):
        for num, line in enumerate(repo.text(rel).splitlines(), 1):
            if "NOLINT" not in line or "NOLINTEND" in line:
                continue
            m = NOLINT.search(line)
            if not m:
                continue
            report.suppressions["NOLINT"] += 1
            if not m.group("checks") or m.group("checks") == "()":
                report.add(
                    "clang-tidy",
                    f"{rel}:{num}",
                    "a NOLINT names the check it silences: NOLINT(<check>): <why>",
                )
            elif not re.match(r"\s*:\s*\S", m.group("rest") or ""):
                report.add(
                    "clang-tidy",
                    f"{rel}:{num}",
                    "a NOLINT carries its reason: NOLINT(<check>): <why>",
                )
    for rel in repo.own((*JS_SUFFIXES, ".astro", ".vue", ".html")):
        for num, line in enumerate(repo.text(rel).splitlines(), 1):
            m = ESLINT_DISABLE.search(line) if "eslint-disable" in line else None
            if not m:
                continue
            report.suppressions["eslint-disable"] += 1
            rest = (m.group("rest") or "").strip()
            if not rest or rest.startswith("--"):
                report.add(
                    "eslint",
                    f"{rel}:{num}",
                    "an eslint-disable names its rule: eslint-disable-next-line <rule> -- <why>",
                )
            elif "--" not in rest:
                report.add(
                    "eslint", f"{rel}:{num}", "an eslint-disable carries its reason after --"
                )
    for rel in repo.own(SHELL_SUFFIXES):
        for line in repo.text(rel).splitlines():
            if SHELLCHECK_DISABLE.search(line):
                report.suppressions["shellcheck disable"] += 1


def check_reuse(repo: Repo, report: Report) -> None:
    if not (repo.exists("REUSE.toml") or repo.exists(".reuse/dep5")):
        report.add("reuse", "REUSE.toml", "missing: every file's license is stated (reuse lint)")
    # A file that cannot carry a comment is stated in REUSE.toml, never in a
    # .license sidecar, unless REUSE.toml cannot express it (owner, 2026-11-22).
    for rel in repo.files:
        if rel.endswith(".license") and "node_modules/" not in rel:
            report.weaken("reuse", f"sidecar:{rel}", rel)


def check_typos(repo: Repo, report: Report) -> None:
    if repo.exists(".typos.toml"):
        try:
            tomllib.loads(repo.text(".typos.toml"))
        except tomllib.TOMLDecodeError as exc:
            report.add(
                "typos",
                ".typos.toml",
                f"not valid TOML (a key repeated from the kit block?): {exc}",
            )


# --------------------------------------------------------------------------
# Conformance: ts, cpp


# The flags `strict` turns on, each of which a tsconfig can turn back off.
TS_STRICT_FAMILY = (
    "alwaysStrict",
    "noImplicitAny",
    "noImplicitThis",
    "strictBindCallApply",
    "strictBuiltinIteratorReturn",
    "strictFunctionTypes",
    "strictNullChecks",
    "strictPropertyInitialization",
    "useUnknownInCatchVariables",
)


def tsconfig_reaches(repo: Repo, rel: str, cfg: dict[str, Any], base_path: Path) -> bool:
    """Whether a tsconfig's extends chain reaches the kit base (a few levels deep)."""
    todo = [(PurePosixPath(rel).parent, cfg)]
    for _ in range(8):
        if not todo:
            return False
        folder, current = todo.pop()
        ext = current.get("extends")
        for e in [ext] if isinstance(ext, str) else list(ext or []):
            if not str(e).startswith("."):
                continue  # a package base (@tsconfig/...) adds rules; it is not the kit
            target = (repo.root / folder / str(e)).resolve()
            if target == base_path:
                return True
            if target.is_file() and target.is_relative_to(repo.root):
                try:
                    parent = load_jsonc(target.read_text(encoding="utf-8"))
                except ValueError:
                    continue
                todo.append(
                    (PurePosixPath(target.relative_to(repo.root).as_posix()).parent, parent)
                )
    return False


def check_tsconfig(repo: Repo, report: Report) -> None:
    base_path = (repo.root / KIT_DIR / "tsconfig.base.json").resolve()
    base: dict[str, Any] = {}
    if base_path.is_file():
        base = load_jsonc(base_path.read_text(encoding="utf-8")).get("compilerOptions", {})
    configs = [p for p in repo.own((".json",)) if PurePosixPath(p).name.startswith("tsconfig")]
    if not configs:
        report.add(
            "tsconfig", "tsconfig.json", "the ts profile needs a tsconfig that extends the kit base"
        )
    for rel in configs:
        try:
            cfg = load_jsonc(repo.text(rel))
        except ValueError as exc:
            report.add("tsconfig", rel, f"not valid JSONC: {exc}")
            continue
        if not tsconfig_reaches(repo, rel, cfg, base_path):
            report.add(
                "tsconfig",
                rel,
                f"extends neither {KIT_DIR}tsconfig.base.json nor a local tsconfig that does",
            )
        options = cfg.get("compilerOptions") or {}
        for key, value in options.items():
            on_in_base = base.get(key) is True or (
                key in TS_STRICT_FAMILY and base.get("strict") is True
            )
            if on_in_base and value is False:
                report.weaken("tsconfig", key, rel)
        if "baseUrl" in options:
            report.weaken("tsconfig", "baseUrl", rel)


def check_eslint(repo: Repo, report: Report) -> None:
    configs = [
        p for p in repo.own(JS_SUFFIXES) if PurePosixPath(p).name.startswith("eslint.config.")
    ]
    if not configs:
        report.add(
            "eslint",
            "eslint.config.js",
            "the ts profile needs an ESLint flat config built on the kit base",
        )
    off = re.compile(
        r"""['"](?P<rule>[@\w/-]+)['"]\s*:\s*(?:\[\s*)?(?:['"](?:off|warn)['"]|[01](?![\w.]))"""
    )
    for rel in configs:
        text = repo.text(rel)
        if "eslint.base.mjs" not in text:
            report.add(
                "eslint", rel, f"does not import kleidosTypeScript from {KIT_DIR}eslint.base.mjs"
            )
        for m in off.finditer(text):
            report.weaken("eslint", m.group("rule"), rel)
        if "disableTypeChecked" in text:
            report.weaken("eslint", "disableTypeChecked", rel)
        for m in ESLINT_IGNORES.finditer(text):
            for pattern in re.findall(r"""['"]([^'"]+)['"]""", m.group("list")):
                if not GENERATED_DIRS.match(pattern):
                    report.weaken("eslint", f"ignores:{pattern}", rel)


def check_cpp_analysis(repo: Repo, report: Report) -> None:
    """A cpp repository runs clang-tidy in a job of its own on its pull requests."""
    for rel in workflow_files(repo):
        try:
            wf = yaml.safe_load(repo.text(rel)) or {}
        except yaml.YAMLError:
            continue
        triggers = workflow_triggers(wf) if isinstance(wf, dict) else {}
        if "pull_request" not in triggers or trigger_gap("pull_request", triggers["pull_request"]):
            continue
        for job in (wf.get("jobs") or {}).values():
            if not isinstance(job, dict) or never_runs(job):
                continue
            for step in job.get("steps") or []:
                if not isinstance(step, dict) or never_runs(step):
                    continue
                if any(tool in str(step.get("run", "")) for tool in CPP_ANALYZERS):
                    return
    report.add(
        "workflows",
        ".github/workflows/",
        "the cpp profile runs clang-tidy with the kit's .clang-tidy in a job of the"
        " repository's own on every pull request (the kit has no reusable job for it:"
        " clang-tidy needs the repository's build)",
    )


def never_runs(item: dict[str, Any]) -> bool:
    """A job or step whose condition is a literal false."""
    if "if" not in item:
        return False
    cond = item["if"]
    return cond is False or normalized_if(cond).strip().lower() in ("false", "0", "''")


def check_python_version(repo: Repo, report: Report) -> None:
    """The python profile names its Python in .python-version (the kit's workflows read it)."""
    if not repo.exists(".python-version"):
        report.add(
            "python",
            ".python-version",
            "missing: the kit's Python workflows (mypy, tests) read the version from it",
        )


def check_clang_tidy(repo: Repo, report: Report) -> None:
    for rel in repo.files:
        if PurePosixPath(rel).name != ".clang-tidy" or rel == ".clang-tidy" or rel in repo.foreign:
            continue
        try:
            cfg = yaml.safe_load(repo.text(rel)) or {}
        except yaml.YAMLError as exc:
            report.add("clang-tidy", rel, f"not valid YAML: {exc}")
            continue
        if cfg.get("InheritParentConfig") is not True:
            report.add(
                "clang-tidy",
                rel,
                "needs InheritParentConfig: true (the root .clang-tidy is the kit's)",
            )
        for key in ("Checks", "WarningsAsErrors"):
            value = cfg.get(key) or ""
            items = value if isinstance(value, list) else str(value).split(",")
            for item in (i.strip() for i in items):
                if item.startswith("-"):
                    report.weaken(
                        "clang-tidy", item if key == "Checks" else f"WarningsAsErrors:{item}", rel
                    )


# --------------------------------------------------------------------------
# Waivers


def apply_waivers(repo: Repo, report: Report, today: dt.date) -> None:
    waivers: list[dict[str, Any]] = []
    if repo.exists(WAIVERS):
        try:
            waivers = list(tomllib.loads(repo.text(WAIVERS)).get("waiver") or [])
        except tomllib.TOMLDecodeError as exc:
            report.add("waivers", WAIVERS, f"not valid TOML: {exc}")
    used = [False] * len(waivers)
    for i, w in enumerate(waivers):
        where = f"{WAIVERS} waiver[{i}] {w.get('tool')}:{w.get('what')}"
        if w.get("tool") not in WAIVABLE_TOOLS:
            report.add(
                "waivers",
                where,
                f"{w.get('tool')!r} cannot be waived (waivable: {', '.join(WAIVABLE_TOOLS)})",
            )
        for key in ("what", "reason", "decided"):
            if not str(w.get(key, "")).strip():
                report.add("waivers", where, f"needs {key}")
        expires = w.get("expires")
        if isinstance(expires, dt.datetime):
            expires = expires.date()
        if isinstance(expires, dt.date) and expires < today:
            report.add(
                "waivers", where, f"expired on {expires}: fix the code or renew it with a reason"
            )
    for weak in report.weakenings:
        match = None
        for i, w in enumerate(waivers):
            if (
                w.get("tool") == weak.tool
                and w.get("what") == weak.what
                and (not w.get("where") or w.get("where") == weak.where)
            ):
                match = i
                break
        if match is None:
            report.add(
                weak.tool,
                weak.where,
                f"{weak.what} weakens a kit rule and has no waiver in {WAIVERS}",
            )
        else:
            used[match] = True
            report.waived.append((weak, waivers[match]))
    for i, w in enumerate(waivers):
        if not used[i] and w.get("tool") in WAIVABLE_TOOLS:
            report.add(
                "waivers",
                f"{WAIVERS} waiver[{i}] {w.get('tool')}:{w.get('what')}",
                "matches nothing any more: remove it",
            )


# --------------------------------------------------------------------------
# The MAC plant test


def _mac(octets: tuple[str, ...], sep: str = ":") -> str:
    return sep.join(octets)


def plant_mac(repo: Repo) -> list[str]:
    """Plant real and fake MAC shapes in a temporary tree; return what went wrong."""
    gitleaks = shutil.which("gitleaks")
    if gitleaks is None:
        raise SetupError("gitleaks is not on PATH")
    config = repo.path(".gitleaks-mac.toml")
    if not config.is_file():
        raise SetupError(".gitleaks-mac.toml is missing")
    real = ("06", "5e", "3a", "91", "c7", "4d")
    dotted = "".join(real[0:2]) + "." + "".join(real[2:4]) + "." + "".join(real[4:6])
    allow = "gitleaks" + ":allow"
    fires = {
        "colon": ("plant.txt", "board = " + _mac(real)),
        "dash": ("plant.txt", "board = " + _mac(real, "-")),
        "upper": ("plant.txt", "board = " + _mac(real).upper()),
        "dotted": ("plant.txt", "board = " + dotted),
        "bare": ("plant.txt", "mac = " + "".join(real)),
        "svg": ("plant.svg", "<svg><text>" + _mac(real) + "</text></svg>"),
        "allow-comment": ("plant.txt", "board = " + _mac(real) + "  # " + allow),
    }
    spared = {
        "zeros": ("plant.txt", "board = " + _mac(("00",) * 6)),
        "broadcast": ("plant.txt", "board = " + _mac(("ff",) * 6)),
        "test-range": ("plant.txt", "board = " + _mac(("02", "00", "00", "12", "34", "56"))),
        "spelled": ("plant.txt", "board = " + _mac(("aa", "bb", "cc", "dd", "ee", "ff"))),
        "hash": ("plant.txt", "addr_hash = " + "3f2a9c4e1b7d" + "6a5f8e0c2b4d6f8a1c3e5b7d9f0a"),
    }
    wrong = []
    with tempfile.TemporaryDirectory() as tmp:
        for label, (name, body) in [*fires.items(), *spared.items()]:
            folder = Path(tmp) / label
            folder.mkdir()
            (folder / name).write_text(body + "\n", encoding="utf-8")
            out = Path(tmp) / f"{label}.json"
            subprocess.run(
                [
                    gitleaks,
                    "dir",
                    str(folder),
                    "--config",
                    str(config),
                    "--no-banner",
                    "--redact",
                    "--ignore-gitleaks-allow",
                    "--exit-code",
                    "0",
                    "--report-format",
                    "json",
                    "--report-path",
                    str(out),
                ],
                capture_output=True,
                check=True,
            )
            found = json.loads(out.read_text(encoding="utf-8") or "[]")
            if label in fires and not found:
                wrong.append(f"{label}: a real MAC shape was not found")
            if label in spared and found:
                wrong.append(f"{label}: a fake MAC shape was reported ({found[0].get('RuleID')})")
    return wrong


# --------------------------------------------------------------------------
# Running and reporting


def run(
    repo_root: Path,
    kit: Kit | None = None,
    kit_git: Path | None = None,
    today: dt.date | None = None,
) -> Report:
    """Check one repository; return the report."""
    today = today or dt.datetime.now(tz=dt.UTC).date()
    repo = Repo(repo_root)
    report = Report()
    source = load_source(repo, report)
    if source is None:
        return report
    central = repo.is_central()
    if kit is None and source.get("commit") == "self" and central:
        kit = DirKit(repo.root)
    if (
        kit is None
        and kit_git is not None
        and isinstance(source.get("commit"), str)
        and SHA40.match(source["commit"])
    ):
        kit = GitKit(kit_git, source["commit"])
    if kit is not None and source.get("version") != kit.version():
        report.add(
            "source",
            SOURCE_JSON,
            f"records kit version {source.get('version')} but the kit is at {kit.version()}",
        )
    if kit is None:
        report.notes.append("offline: copies checked against SOURCE.json only")
    profiles = set(source["profiles"])
    check_profiles(repo, source, report)
    check_copies(repo, source, kit, report)
    check_blocks(repo, source, kit, report)
    if kit is not None:
        check_manifest_coverage(source, kit, report)
    check_kit_dir(repo, source, report)
    if "actions" in profiles:
        check_kit_uses(repo, source, report)
        check_ci(repo, report)
    check_pre_commit_globals(repo, report)
    check_gitleaks(repo, report)
    check_osv(repo, report, today)
    check_dependabot(repo, report, central)
    check_markdownlint(repo, kit, report)
    check_reuse(repo, report)
    check_typos(repo, report)
    if not repo.exists(WAIVERS):
        report.add("waivers", WAIVERS, "missing (sync.py --write seeds an empty one)")
    if "python" in profiles:
        check_python_version(repo, report)
        check_ruff(repo, report)
        check_mypy(repo, report)
        check_python_inline(repo, report)
    if "ts" in profiles:
        check_tsconfig(repo, report)
        check_eslint(repo, report)
    if "cpp" in profiles:
        check_clang_tidy(repo, report)
        if "actions" in profiles:
            check_cpp_analysis(repo, report)
    check_suppressions_c_js(repo, report)
    apply_waivers(repo, report, today)
    report.notes.insert(
        0,
        f"kit {source.get('version')} at {str(source.get('commit'))[:12]},"
        f" profiles {', '.join(sorted(profiles))}",
    )
    return report


def render_markdown(report: Report) -> str:
    out = ["## Quality kit", ""]
    out += [f"- {n}" for n in report.notes]
    out.append("")
    if report.problems:
        out += [
            f"### {len(report.problems)} problem(s)",
            "",
            "| Check | Where | Problem |",
            "| --- | --- | --- |",
        ]
        out += [
            f"| {p.rule} | `{p.where}` | {p.message.replace('|', '/')} |" for p in report.problems
        ]
    else:
        out.append("No problems.")
    out.append("")
    if report.waived:
        out += [
            f"### {len(report.waived)} waiver(s) in effect",
            "",
            "| Tool | Weakening | Where | Reason | Decided |",
            "| --- | --- | --- | --- | --- |",
        ]
        out += [
            f"| {w.tool} | `{w.what}` | `{w.where}`"
            f" | {str(v.get('reason', '')).replace('|', '/')} | {v.get('decided', '')} |"
            for w, v in report.waived
        ]
        out.append("")
    if report.suppressions:
        out += ["### Inline suppressions", ""]
        out += [f"- {k}: {v}" for k, v in sorted(report.suppressions.items())]
        out.append("")
    return "\n".join(out) + "\n"


def to_json(report: Report) -> dict[str, Any]:
    return {
        "problems": [p.__dict__ for p in report.problems],
        "waived": [
            {"tool": w.tool, "what": w.what, "where": w.where, "reason": v.get("reason")}
            for w, v in report.waived
        ],
        "suppressions": dict(report.suppressions),
        "notes": report.notes,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--repo", type=Path, default=Path())
    group = ap.add_mutually_exclusive_group()
    group.add_argument(
        "--kit", type=Path, help="a checkout of kleidos-dev/.github at the recorded commit"
    )
    group.add_argument(
        "--kit-git", type=Path, help="a clone of kleidos-dev/.github that has the recorded commit"
    )
    ap.add_argument(
        "--summary", type=Path, help="append a Markdown summary here (GITHUB_STEP_SUMMARY)"
    )
    ap.add_argument("--json", type=Path, help="write the findings as JSON here")
    ap.add_argument(
        "--plant-mac", action="store_true", help="only prove the MAC rules on planted values"
    )
    ap.add_argument(
        "--lint-skip",
        default="",
        help="the lint caller's skip input: refused if it names a kit hook (needs --kit)",
    )
    ap.add_argument(
        "files", nargs="*", help=argparse.SUPPRESS
    )  # pre-commit passes names; the check is repository-wide
    args = ap.parse_args(argv)
    try:
        if args.plant_mac:
            wrong = plant_mac(Repo(args.repo))
            for line in wrong:
                print(f"plant-mac: {line}")
            print(
                "plant-mac: every real shape found, every fake spared"
                if not wrong
                else "plant-mac: FAILED"
            )
            return 1 if wrong else 0
        kit = DirKit(args.kit.resolve()) if args.kit else None
        report = run(args.repo, kit=kit, kit_git=args.kit_git)
        if args.lint_skip and kit is not None:
            for hook in refused_skips(args.lint_skip, kit_block_hook_ids(kit)):
                report.add(
                    "workflows",
                    "reusable-lint.yml skip",
                    f"names the kit hook {hook}: only the repository's own hooks may be"
                    " skipped (no waiver)",
                )
    except SetupError as exc:
        print(f"check_quality: {exc}", file=sys.stderr)
        return 2
    except KitCommitMissingError as exc:
        print(f"check_quality: {exc}", file=sys.stderr)
        return 3
    for note in report.notes:
        print(f"note: {note}")
    for p in report.problems:
        print(f"{p.where}: [{p.rule}] {p.message}")
    for w, v in report.waived:
        print(f"waived: {w.tool} {w.what} ({w.where}): {v.get('reason')}")
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as fh:
            fh.write(render_markdown(report))
    if args.json:
        args.json.write_text(json.dumps(to_json(report), indent=2) + "\n", encoding="utf-8")
    print(f"{len(report.problems)} problem(s)" if report.problems else "quality kit: clean")
    return 1 if report.problems else 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.exit(main())
