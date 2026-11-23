#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Markdown prose is never hard-wrapped: one line per paragraph and list item.

The owner's rule of 2026-11-16 for every Markdown file of every Kleidos
repository. A line that continues the prose of the line above (no blank line,
no list marker, no block element, no hard break between them) is a hard wrap.
Code, tables, front matter, headings, HTML blocks and fenced or indented
blocks keep their own layout. Lifted from kleidos-dev/agents' scripts/check.py
(the "wrap" check, MIT), where the rule was first enforced.

Usage:
    md_nowrap.py FILE.md [FILE.md ...]    exit 1 and list every wrapped line
    md_nowrap.py                          every tracked *.md of the repository

Standard library only.
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

FENCE = re.compile(r"^[ \t]*(?:>[ \t]?)*[ \t]*(?P<fence>`{3,}|~{3,})")
OPEN_TAG = re.compile(r"^\s*<[A-Za-z][^>]*$")
LIST = re.compile(r"^\s*([-*+]|\d+[.)])\s+")
BLOCKISH = re.compile(r"^\s*(#|\||<|---|\*\*\*|___|\[[^\]]+\]:\s)")
QUOTE = re.compile(r"^\s*(>\s?)+(.*)$")
ALERT = re.compile(r"^\[![A-Za-z]+\]\s*$")


def markdown_lines(text: str) -> Iterator[tuple[int, str, str]]:
    """Yield (number, line, kind) for each line; kind is 'code', 'front' or 'text'."""
    lines = text.split("\n")
    start = 0
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            n = text[: end + 5].count("\n")
            for k in range(n):
                yield k + 1, lines[k], "front"
            start = n
    fence = ""  # the open fence (its character repeated), "" outside code
    in_comment = False
    in_tag = False
    prev_blank = True
    in_indented = False
    for k in range(start, len(lines)):
        ln = lines[k]
        m_fence = FENCE.match(ln)
        if fence:
            # Only a fence of the same character, at least as long, closes it.
            closer = m_fence.group("fence") if m_fence else ""
            if closer[:1] == fence[:1] and len(closer) >= len(fence):
                fence = ""
            yield k + 1, ln, "code"
            continue
        if m_fence:
            fence = m_fence.group("fence")
            yield k + 1, ln, "code"
            prev_blank = False
            continue
        # An HTML comment (the licensing header among them) and an HTML tag
        # whose attributes span lines keep their own layout.
        if in_comment or ln.lstrip().startswith("<!--"):
            opened = 0 if in_comment else ln.find("<!--") + 4
            in_comment = "-->" not in ln[opened:]
            yield k + 1, ln, "code"
            prev_blank = False
            continue
        if in_tag or OPEN_TAG.match(ln):
            in_tag = ">" not in ln if in_tag else True
            yield k + 1, ln, "code"
            prev_blank = False
            continue
        if not ln.strip():
            in_indented = False
            prev_blank = True
            yield k + 1, ln, "text"
            continue
        if (prev_blank or in_indented) and ln.startswith("    ") and not LIST.match(ln):
            in_indented = True
            prev_blank = False
            yield k + 1, ln, "code"
            continue
        prev_blank = False
        yield k + 1, ln, "text"


def _hard_break(line: str) -> bool:
    return line.endswith(("  ", "\\"))


def wrapped_lines(text: str) -> list[int]:
    """Line numbers that continue the prose of the line above (a hard wrap)."""
    found: list[int] = []
    prev: str | None = None  # previous text line, or None after a blank, code or block line
    for num, ln, kind in markdown_lines(text):
        if kind != "text" or not ln.strip():
            prev = None
            continue
        m_q = QUOTE.match(ln)
        if m_q:
            rest = m_q.group(2)
            if not rest.strip() or BLOCKISH.match(rest) or ALERT.match(rest):
                prev = None
                continue
            if (
                prev is not None
                and QUOTE.match(prev)
                and not LIST.match(rest)
                and not _hard_break(prev)
            ):
                found.append(num)
            prev = ln
            continue
        if BLOCKISH.match(ln):
            prev = None
            continue
        if LIST.match(ln):
            prev = ln
            continue
        if prev is not None and not QUOTE.match(prev) and not _hard_break(prev):
            found.append(num)
        prev = ln
    return found


def tracked_markdown() -> list[Path]:
    """Every tracked or new, not ignored, *.md file of the repository in the working directory."""
    out = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"],
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    return [Path(p) for p in sorted(set(out.split("\0"))) if p]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    paths = [Path(a) for a in args] if args else tracked_markdown()
    failed = 0
    for path in paths:
        if path.suffix.lower() != ".md" or not path.is_file():
            continue
        for num in wrapped_lines(path.read_text(encoding="utf-8")):
            print(f"{path}:{num}: hard-wrapped prose (join it to the line above)")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
