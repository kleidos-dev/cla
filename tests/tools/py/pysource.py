# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""What the condition measure and the mutation runner share: a module's syntax tree, and the lists
of what stays excluded, each entry with its reason.
"""

from __future__ import annotations

import ast
import tomllib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: The only reasons an entry may have (docs/testing.md of kleidos-dev/.github, section 3).
REASONS = ("unreachable", "equivalent", "boundary", "tool")


def atoms(node: ast.expr) -> list[ast.expr]:
    """The atomic conditions of a decision, as the short circuit meets them."""
    if isinstance(node, ast.BoolOp):
        return [a for v in node.values for a in atoms(v)]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return atoms(node.operand)
    return [node]


def is_literal(node: ast.expr) -> bool:
    """Whether it has one truth value whatever happens: no condition (``x or {}``)."""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.BinOp):
        return is_literal(node.left) and is_literal(node.right)
    if isinstance(node, ast.Name):
        return node.id.isupper()  # a constant of the module
    if isinstance(node, ast.Dict):
        return not node.keys
    return isinstance(node, ast.List | ast.Set | ast.Tuple) and not node.elts


@dataclass
class Place:
    """Where a node hangs: in its parent's field, at an index when the field is a list."""

    parent: ast.AST
    field: str
    index: int | None


def places(tree: ast.AST) -> dict[int, Place]:
    """Every node's place, by its id()."""
    found: dict[int, Place] = {}
    for node in ast.walk(tree):
        for name, value in ast.iter_fields(node):
            if isinstance(value, ast.AST):
                found[id(value)] = Place(node, name, None)
            elif isinstance(value, list):
                for i, child in enumerate(value):
                    if isinstance(child, ast.AST):
                        found[id(child)] = Place(node, name, i)
    return found


class Source:
    """A module, and how to name a node of it without its line number."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = path.read_text("utf-8")
        self.tree = ast.parse(self.text, str(path))
        self.places = places(self.tree)
        #: Nodes that never run: annotations are text under ``from __future__ import annotations``,
        #: and what a ``type`` statement names is evaluated only when asked for.
        self.never_run: set[int] = set()
        for node in ast.walk(self.tree):
            for name in ("annotation", "returns"):
                note = getattr(node, name, None)
                if isinstance(note, ast.AST):
                    self.never_run |= {id(n) for n in ast.walk(note)}
            if isinstance(node, ast.TypeAlias):
                self.never_run |= {id(n) for n in ast.walk(node)}

    def parents(self, node: ast.AST) -> Iterator[ast.AST]:
        while id(node) in self.places:
            node = self.places[id(node)].parent
            yield node

    def function(self, node: ast.AST) -> str:
        """The function or class it is in, dotted; "" at the module's own level."""
        names = [
            p.name
            for p in self.parents(node)
            if isinstance(p, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
        ]
        return ".".join(reversed(names))

    def statement(self, node: ast.AST) -> ast.stmt:
        """The innermost statement it is part of."""
        for n in (node, *self.parents(node)):
            if isinstance(n, ast.stmt):
                return n
        raise ValueError("a node outside every statement")

    def header(self, statement: ast.stmt) -> range:
        """The lines of a statement, less those of the statements inside it."""
        last = statement.end_lineno or statement.lineno
        body = getattr(statement, "body", None)
        if body and not isinstance(statement, ast.FunctionDef | ast.ClassDef):
            last = max(statement.lineno, body[0].lineno - 1)
        elif body:
            last = statement.lineno
        return range(statement.lineno, last + 1)

    def line(self, node: ast.AST) -> str:
        """The first line of that statement: where a reader finds it."""
        return ast.unparse(self.statement(node)).splitlines()[0].strip()


def entries(path: Path, kind: str, file: str) -> list[dict[str, Any]]:
    """The list's entries of one kind for one file, each checked to be whole."""
    listed = tomllib.loads(path.read_text("utf-8")).get("entry", []) if path.exists() else []
    found = []
    for e in listed:
        if e.get("reason") not in REASONS or not str(e.get("why", "")).strip():
            raise ValueError(f"an entry with no valid reason or no why: {e}")
        if e["reason"] in ("boundary", "tool") and not e.get("test"):
            raise ValueError(f"an entry that names no test: {e}")
        if e["kind"] == kind and e["file"] == file:
            found.append(e)
    return found


def floor(path: Path, name: str) -> int:
    """How many entries of a kind the list may have (tests/floors/)."""
    return int(tomllib.loads(path.read_text("utf-8"))["listed"][name])


def ratchet(
    misses: list[dict[str, str]], listed: list[dict[str, Any]], keys: tuple[str, ...]
) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    """The misses no entry excuses, and the entries that excuse nothing: both must be empty."""

    def key(e: dict[str, Any]) -> tuple[str, ...]:
        return tuple(str(e.get(k, "")) for k in keys)

    excused, missed = {key(e) for e in listed}, {key(m) for m in misses}
    return [m for m in misses if key(m) not in excused], [e for e in listed if key(e) not in missed]
