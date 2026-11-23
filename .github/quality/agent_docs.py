#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The agent instruction files of a repository keep the kleidos-dev standard.

The standard is kleidos-dev/.github docs/agent-docs.md: AGENTS.md holds every
rule of a repository, for any agent; CLAUDE.md imports it and adds only what
Claude alone can use. This script checks one repository, from its root:

  files    AGENTS.md and CLAUDE.md exist at the root; every nested AGENTS.md
           has a CLAUDE.md beside it, and the reverse; each is a readable
           file, not a symbolic link
  import   each CLAUDE.md opens, after its licensing comment, with the line
           @AGENTS.md
  at       no other @name stands outside code in either file (Claude reads
           it as an import, in an imported AGENTS.md too)
  local    CLAUDE.local.md is git-ignored beside every AGENTS.md and tracked
           nowhere
  single   no rules file for one other tool (copilot-instructions.md,
           GEMINI.md, .cursorrules, .cursor/rules/, AGENTS.override.md, ...),
           at the root or below it
  size     every chain of AGENTS.md files Codex concatenates (the root down
           to a nested one) is at most 32 KiB, with a warning above the 20 KiB
           target for one file; CLAUDE.md holds at most 4 KiB under the
           import, code included
  paths    a path in a code span or a fenced block whose first folder exists
           in the repository exists (tracked or git-ignored); a path that
           starts with kleidos-dev/<repo>/ is another repository's
  links    every relative Markdown link resolves to a tracked file
  kit      every skill and subagent under .claude/ is named in AGENTS.md or
           CLAUDE.md
  block    the root AGENTS.md holds the quality kit's organization-rules
           block once, unedited (the SHA-256 .github/quality/SOURCE.json
           records), and no hand-written "Organization rules" section

Usage:
    agent_docs.py [--repo DIR] [--github]

--github also prints each finding as a GitHub Actions annotation. Exit status:
0 clean (warnings allowed), 1 findings, 2 not a git work tree. Standard
library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HARD_BYTES = 32 * 1024
TARGET_BYTES = 20 * 1024
CLAUDE_OWN_BYTES = 4 * 1024
NAMES = ("AGENTS.md", "CLAUDE.md")
IMPORT_LINE = "@AGENTS.md"
OTHER_TOOL_FILES = (
    ".github/copilot-instructions.md",
    "GEMINI.md",
    ".cursorrules",
    ".windsurfrules",
    ".clinerules",
    "AGENTS.override.md",
    "AGENT.md",
)
# The names above that a tool also reads in a subfolder.
ONE_TOOL_NAMES = (
    "GEMINI.md",
    ".cursorrules",
    ".windsurfrules",
    ".clinerules",
    "AGENTS.override.md",
    "AGENT.md",
)
OTHER_TOOL_DIRS = (
    ".cursor/rules/",
    ".github/instructions/",
    ".windsurf/rules/",
    ".agents/",
    ".claude/rules/",
)
# AGENTS.md and CLAUDE.md files that are content, not this repository's rules:
# a plugin's or skill's own files, test fixtures.
CONTENT_PREFIXES = (".claude/", "plugins/")
CONTENT_PARTS = ("fixtures", "testdata")
BLOCK_ID = "organization-rules"
BLOCK_SOURCE = "quality/agents/block.md"
SOURCE_JSON = ".github/quality/SOURCE.json"
BLOCK_START = re.compile(r"^<!-- >>> kleidos-quality (?P<id>[a-z0-9-]+)(?:[ \t].*)?-->\s*$")
BLOCK_END = re.compile(r"^<!-- <<< kleidos-quality (?P<id>[a-z0-9-]+)\s*-->\s*$")
ORG_HEADING = re.compile(r"^#{1,6}\s+(?:\d+\.\s+)?Organization rules\s*$")
OTHER_REPO = ("kleidos-dev/", "jmrplens/")
PATH_TOKEN = re.compile(r"^[A-Za-z0-9_.\-/]+$")
FENCE = re.compile(r"^\s*(```|~~~)")
SPAN = re.compile(r"`([^`\n]+)`")
STRAY_AT = re.compile(r"(?<![\w`@])@[A-Za-z~./][\w./~-]*")
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
SCHEME = re.compile(r"[a-z][a-z0-9+.-]*:")


@dataclass(frozen=True)
class Finding:
    check: str
    path: str
    line: int
    message: str
    warning: bool = False

    def __str__(self) -> str:
        where = f"{self.path}:{self.line}" if self.line else self.path
        return f"{where}: [{self.check}] {self.message}"


class Repo:
    """A git work tree: what it tracks, what it ignores, and its files' text."""

    def __init__(self, root: Path) -> None:
        self.root = root
        listing = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=False
        )
        if listing.returncode != 0:
            raise NotAWorkTreeError(f"{root} is not a git work tree")
        self.tracked = {p for p in listing.stdout.decode("utf-8").split("\0") if p}
        self.dirs = {p[: i + 1] for p in self.tracked for i, c in enumerate(p) if c == "/"}
        self.top = {p.split("/", 1)[0] for p in self.tracked}
        self._ignored: dict[str, bool] = {}

    def read(self, rel: str) -> str | None:
        try:
            return (self.root / rel).read_text(encoding="utf-8")
        except OSError, UnicodeDecodeError:
            return None

    def exists(self, rel: str) -> bool:
        rel = rel.rstrip("/")
        return rel in self.tracked or rel + "/" in self.dirs

    def ignored(self, rel: str) -> bool:
        if rel not in self._ignored:
            done = subprocess.run(
                ["git", "-C", str(self.root), "check-ignore", "-q", "--no-index", rel],
                capture_output=True,
                check=False,
            )
            self._ignored[rel] = done.returncode == 0
        return self._ignored[rel]


class NotAWorkTreeError(Exception):
    """The directory is not a git work tree."""


def split_code(text: str) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
    """(prose lines, code texts) by line number: fenced blocks and code spans are code.

    HTML comments are neither: Claude Code strips them before the model reads
    the file. In a prose line every code span is replaced by `x`.
    """
    prose: list[tuple[int, str]] = []
    code: list[tuple[int, str]] = []
    for num, line, kind in classify(text):
        if kind == "code":
            code.append((num, line))
        elif kind == "prose":
            code.extend((num, m.group(1)) for m in SPAN.finditer(line))
            prose.append((num, SPAN.sub("`x`", line)))
    return prose, code


def classify(text: str) -> list[tuple[int, str, str]]:
    """Each line with its kind: "prose", "code" (fenced, fences included) or "comment"."""
    out: list[tuple[int, str, str]] = []
    fenced = False
    in_comment = False
    for num, line in enumerate(text.splitlines(), 1):
        if not in_comment and FENCE.match(line):
            fenced = not fenced
            out.append((num, line, "code"))
        elif fenced:
            out.append((num, line, "code"))
        elif in_comment or line.lstrip().startswith("<!--"):
            in_comment = "-->" not in line
            out.append((num, line, "comment"))
        else:
            out.append((num, line, "prose"))
    return out


def path_tokens(code: str) -> list[str]:
    """The words of a code span or a command line that read as repository paths."""
    found = []
    for raw in re.split(r"[\s()\[\],;\"'=|<>]+", code):
        tok = raw.rstrip(".:")
        if not tok or tok.startswith(("-", "/", "~", "..", "http", "@", "$")) or "//" in tok:
            continue
        if tok.startswith(OTHER_REPO):
            continue  # another repository's path, written with its repository first
        if "/" not in tok.rstrip("/") or not PATH_TOKEN.match(tok):
            continue
        if not tok.endswith("/") and not re.search(r"\.[A-Za-z0-9]{1,10}$", tok):
            continue  # neither a folder nor a file with an extension: a ratio, a macro list
        found.append(tok.removeprefix("./"))
    return found


def is_content(rel: str) -> bool:
    """An AGENTS.md or CLAUDE.md that is content (a plugin's, a fixture), not rules here."""
    parts = rel.split("/")[:-1]
    return rel.startswith(CONTENT_PREFIXES) or any(p in CONTENT_PARTS for p in parts)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_files(repo: Repo, docs: list[str], out: list[Finding]) -> None:
    out.extend(
        Finding("files", name, 0, "missing at the root (docs/agent-docs.md)")
        for name in NAMES
        if name not in repo.tracked
    )
    for doc in docs:
        folder = posixpath.dirname(doc)
        if not folder:
            continue
        other = "CLAUDE.md" if doc.endswith("AGENTS.md") else "AGENTS.md"
        if f"{folder}/{other}" not in repo.tracked:
            out.append(Finding("files", doc, 0, f"has no {other} beside it"))


def check_local_and_single(repo: Repo, docs: list[str], out: list[Finding]) -> None:
    """CLAUDE.local.md and the files of one other tool, at the root and in every folder."""
    folders = sorted({posixpath.dirname(d) for d in docs} | {""})
    for folder in folders:
        local = posixpath.join(folder, "CLAUDE.local.md")
        if not repo.ignored(local):
            out.append(Finding("local", ".gitignore", 0, f"does not ignore {local}"))
    for rel in sorted(repo.tracked):
        if is_content(rel):
            continue
        name = posixpath.basename(rel)
        if name == "CLAUDE.local.md":
            out.append(Finding("local", rel, 0, "is tracked; it is one person's file"))
        elif rel in OTHER_TOOL_FILES or name in ONE_TOOL_NAMES:
            out.append(Finding("single", rel, 0, "a rules file for one tool: AGENTS.md is the one"))
    out.extend(
        Finding("single", rel, 0, "rules for one tool: AGENTS.md is the one")
        for rel in sorted(repo.dirs)
        if rel in OTHER_TOOL_DIRS
        or (not is_content(rel) and any(rel.endswith("/" + d) for d in OTHER_TOOL_DIRS))
    )


def chain_of(repo: Repo, doc: str) -> list[str]:
    """The AGENTS.md files Codex concatenates for a working directory at doc's folder."""
    parts = posixpath.dirname(doc).split("/") if "/" in doc else []
    folders = [""] + ["/".join(parts[: n + 1]) for n in range(len(parts))]
    return [p for f in folders if (p := posixpath.join(f, "AGENTS.md")) in repo.tracked]


def check_size(repo: Repo, doc: str, text: str, out: list[Finding]) -> None:
    size = len(text.encode("utf-8"))
    if doc.endswith("AGENTS.md"):
        chain = chain_of(repo, doc)
        total = sum(len((repo.read(p) or "").encode("utf-8")) for p in chain)
        if total > HARD_BYTES:
            what = f"with {', '.join(p for p in chain if p != doc)} " if len(chain) > 1 else ""
            out.append(
                Finding(
                    "size",
                    doc,
                    0,
                    f"{what}is {total} bytes, over {HARD_BYTES} (Codex stops adding files there)",
                )
            )
        elif size > TARGET_BYTES:
            out.append(
                Finding("size", doc, 0, f"is {size} bytes, over the {TARGET_BYTES} target", True)
            )
        return
    # What Claude reads under the import, code included: everything but HTML comments.
    seen = [(line, kind) for _, line, kind in classify(text) if kind != "comment"]
    filled = [(line, kind) for line, kind in seen if line.strip()]
    if not filled or filled[0] != (IMPORT_LINE, "prose"):
        out.append(Finding("import", doc, 0, f"does not open with the line {IMPORT_LINE}"))
        return
    after = seen[seen.index(filled[0]) + 1 :]
    own = sum(len(line.encode("utf-8")) + 1 for line, _ in after)
    if own > CLAUDE_OWN_BYTES:
        out.append(
            Finding("size", doc, 0, f"holds {own} bytes under the import, over {CLAUDE_OWN_BYTES}")
        )


def check_at(doc: str, prose: list[tuple[int, str]], out: list[Finding]) -> None:
    for num, line in prose:
        if line.strip() == IMPORT_LINE and doc.endswith("CLAUDE.md"):
            continue
        out.extend(
            Finding("at", doc, num, f"{m.group(0)} outside code: Claude reads it as an import")
            for m in STRAY_AT.finditer(line)
        )


def check_paths(repo: Repo, doc: str, code: list[tuple[int, str]], out: list[Finding]) -> None:
    base = posixpath.dirname(doc)
    local_top = {
        p[len(base) + 1 :].split("/", 1)[0]
        for p in repo.tracked
        if base and p.startswith(base + "/")
    }
    seen: set[str] = set()
    for num, chunk in code:
        for tok in path_tokens(chunk):
            first = tok.split("/", 1)[0]
            if tok in seen or (first not in repo.top and first not in local_top):
                continue
            seen.add(tok)
            cands = [tok] + ([posixpath.join(base, tok)] if base else [])
            if not any(repo.exists(c) or repo.ignored(c) for c in cands):
                out.append(Finding("paths", doc, num, f"names `{tok}`, which is not in the tree"))


def check_links(repo: Repo, doc: str, prose: list[tuple[int, str]], out: list[Finding]) -> None:
    base = posixpath.dirname(doc)
    for num, line in prose:
        for m in LINK.finditer(line):
            target = m.group(1).strip("<>").split("#", 1)[0]
            if not target or SCHEME.match(target):
                continue
            rel = posixpath.normpath(posixpath.join(base, target))
            if not repo.exists(rel):
                out.append(Finding("links", doc, num, f"links to {target}, which does not exist"))


def check_kit(repo: Repo, mentioned: str, out: list[Finding]) -> None:
    kinds = (
        ("skill", re.compile(r"^\.claude/skills/([^/]+)/SKILL\.md$")),
        ("subagent", re.compile(r"^\.claude/agents/([^/]+)\.md$")),
    )
    for kind, pattern in kinds:
        for path in sorted(repo.tracked):
            m = pattern.match(path)
            if m and f"`{m.group(1)}`" not in mentioned:
                out.append(
                    Finding(
                        "kit",
                        path,
                        0,
                        f"the {kind} `{m.group(1)}` is named in no AGENTS.md or CLAUDE.md",
                    )
                )


def recorded_block(repo: Repo) -> str | None:
    """The block text this repository must hold, or None when nothing records it.

    In kleidos-dev/.github (SOURCE.json records commit "self") it is the kit's
    own source; anywhere else, only its SHA-256 is known, from SOURCE.json.
    """
    raw = repo.read(SOURCE_JSON)
    if raw is None:
        return None
    try:
        record = json.loads(raw)
    except ValueError:
        return None
    if record.get("commit") == "self":
        return repo.read(BLOCK_SOURCE)
    for entry in record.get("blocks") or []:
        if entry.get("id") == BLOCK_ID and entry.get("path") == "AGENTS.md":
            return "sha256:" + str(entry.get("sha256", ""))
    return None


def check_block(repo: Repo, out: list[Finding]) -> None:
    text = repo.read("AGENTS.md")
    if text is None:
        return
    lines = text.splitlines(keepends=True)
    starts = [
        i for i, ln in enumerate(lines) if (m := BLOCK_START.match(ln)) and m["id"] == BLOCK_ID
    ]
    ends = [i for i, ln in enumerate(lines) if (m := BLOCK_END.match(ln)) and m["id"] == BLOCK_ID]
    if not starts:
        out.append(
            Finding(
                "block",
                "AGENTS.md",
                0,
                f"holds no {BLOCK_ID} block: the quality kit's sync.py --write puts it in",
            )
        )
        return
    if len(starts) > 1 or len(ends) != 1 or ends[0] < starts[0]:
        out.append(
            Finding("block", "AGENTS.md", starts[0] + 1, f"the {BLOCK_ID} markers do not pair")
        )
        return
    start, end = starts[0], ends[0]
    inner = "".join(lines[start + 1 : end])
    for i, line in enumerate(lines):
        if ORG_HEADING.match(line.rstrip("\n")) and not start < i < end:
            out.append(
                Finding(
                    "block",
                    "AGENTS.md",
                    i + 1,
                    "an Organization rules section outside the managed block: remove it",
                )
            )
    want = recorded_block(repo)
    if want is None:
        return
    same = want == "sha256:" + sha256(inner) if want.startswith("sha256:") else want == inner
    if not same:
        out.append(
            Finding(
                "block",
                "AGENTS.md",
                start + 1,
                f"the {BLOCK_ID} block differs from the kit's: never edit it, sync the kit",
            )
        )


def check(repo: Repo) -> list[Finding]:
    out: list[Finding] = []
    docs = sorted(p for p in repo.tracked if posixpath.basename(p) in NAMES and not is_content(p))
    check_files(repo, docs, out)
    check_local_and_single(repo, docs, out)
    mentioned = ""
    for doc in docs:
        if (repo.root / doc).is_symlink():
            out.append(Finding("files", doc, 0, "is a symbolic link: commit the file itself"))
            continue
        text = repo.read(doc)
        if text is None:
            out.append(Finding("files", doc, 0, "cannot be read as UTF-8 text"))
            continue
        mentioned += text
        prose, code = split_code(text)
        check_size(repo, doc, text, out)
        check_at(doc, prose, out)
        check_paths(repo, doc, code, out)
        check_links(repo, doc, prose, out)
    check_kit(repo, mentioned, out)
    check_block(repo, out)
    return out


def annotation(f: Finding) -> str:
    level = "warning" if f.warning else "error"
    line = f",line={f.line}" if f.line else ""
    return f"::{level} file={f.path}{line},title=Agent docs ({f.check})::{f.message}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--repo", type=Path, default=Path("."), help="the repository's root")
    ap.add_argument("--github", action="store_true", help="also print GitHub annotations")
    args = ap.parse_args(argv)
    try:
        findings = check(Repo(args.repo))
    except NotAWorkTreeError as exc:
        print(f"agent-docs: {exc}", file=sys.stderr)
        return 2
    errors = [f for f in findings if not f.warning]
    warnings = [f for f in findings if f.warning]
    for f in warnings + errors:
        print(f"{'warning' if f.warning else 'error'}: {f}")
        if args.github:
            print(annotation(f))
    print(f"agent-docs: {len(errors)} error(s), {len(warnings)} warning(s) (docs/agent-docs.md)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
