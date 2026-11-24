# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Statement, condition and MC/DC coverage of one Python module by its unittest suite, on the
standard library alone.

The module is loaded with every atomic condition of every decision reporting its truth value, so
each evaluation of a decision leaves one vector: a value per condition, none for what the short
circuit skipped. A condition is covered when two vectors differ in it and in the outcome, and agree
in every other condition both evaluated (the masking form LLVM defines for such languages).

A decision is the test of an if, a while, an assert or a conditional expression, the filter of a
comprehension, and any and/or used as a value.

    python tests/tools/py/mcdc.py registry/cla.py registry/tests \\
        --list tests/exclusions/register.toml
"""

from __future__ import annotations

import argparse
import ast
import atexit
import collections
import io
import itertools
import os
import sys
import types
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pysource import Source, atoms, entries, is_literal, ratchet

Vector = tuple[bool | None, ...]


@dataclass
class Decision:
    function: str
    line: int
    text: str
    conditions: list[str]
    seen: set[tuple[Vector, bool]] = field(default_factory=set)


class Frames:
    """The decisions being evaluated, the innermost last."""

    def __init__(self) -> None:
        self.decisions: list[Decision] = []
        self.stack: list[tuple[int, list[bool | None]]] = []

    def begin(self, number: int) -> tuple[int, list[bool | None]]:
        values: list[bool | None] = [None] * len(self.decisions[number].conditions)
        frame = (number, values)
        self.stack.append(frame)
        return frame

    def condition(self, number: int, index: int, value: Any) -> Any:
        # A decision left by an exception leaves its frame: the nearest of this number is ours.
        frame = next(f for f in reversed(self.stack) if f[0] == number)
        frame[1][index] = bool(value)
        return value

    def end(self, frame: tuple[int, list[bool | None]], value: Any) -> Any:
        while self.stack.pop() is not frame:
            pass
        self.decisions[frame[0]].seen.add((tuple(frame[1]), bool(value)))
        return value


BEGIN, CONDITION, END = "_mcdc_begin", "_mcdc_condition", "_mcdc_end"


class Rewrite(ast.NodeTransformer):
    """Wraps each decision and each condition in a call; a walrus keeps its scope (no lambda)."""

    def __init__(self, source: Source, frames: Frames) -> None:
        self.source, self.frames = source, frames

    def decision(self, node: ast.expr) -> ast.expr:
        found = [a for a in atoms(node) if not is_literal(a)]
        if not found or id(node) in self.source.never_run:
            return node
        number = len(self.frames.decisions)
        self.frames.decisions.append(
            Decision(
                self.source.function(node),
                node.lineno,
                ast.unparse(node),
                [ast.unparse(a) for a in found],
            )
        )
        index = {id(a): i for i, a in enumerate(found)}

        def wrap(n: ast.expr) -> ast.expr:
            if isinstance(n, ast.BoolOp):
                n.values = [wrap(v) for v in n.values]
                return n
            if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
                n.operand = wrap(n.operand)
                return n
            inner: ast.expr = self.visit(n)
            if id(n) not in index:
                return inner
            return call(CONDITION, ast.Constant(number), ast.Constant(index[id(n)]), inner)

        return call(END, call(BEGIN, ast.Constant(number)), wrap(node))

    def visit_test(self, node: Any) -> Any:
        node.test = self.decision(node.test)
        for name in ("body", "orelse"):
            value = getattr(node, name, None)
            if isinstance(value, list):
                setattr(node, name, [self.visit(n) for n in value])
            elif isinstance(value, ast.AST):
                setattr(node, name, self.visit(value))
        return node

    visit_If = visit_While = visit_IfExp = visit_Assert = visit_test

    def visit_comprehension(self, node: ast.comprehension) -> ast.comprehension:
        node.iter = self.visit(node.iter)
        node.ifs = [self.decision(i) for i in node.ifs]
        return node

    def visit_BoolOp(self, node: ast.BoolOp) -> ast.expr:
        return self.decision(node)


def call(name: str, *args: ast.expr) -> ast.expr:
    return ast.Call(ast.Name(name, ast.Load()), list(args), [])


class Lines:
    """The lines of the module that ran."""

    def __init__(self) -> None:
        self.ran: set[int] = set()

    def ran_line(self, _: types.CodeType, number: int) -> Any:
        self.ran.add(number)
        return sys.monitoring.DISABLE

    def watch(self, code: types.CodeType) -> None:
        events = sys.monitoring.events
        sys.monitoring.use_tool_id(sys.monitoring.PROFILER_ID, "mcdc")
        sys.monitoring.register_callback(sys.monitoring.PROFILER_ID, events.LINE, self.ran_line)
        waiting = [code]
        while waiting:
            c = waiting.pop()
            sys.monitoring.set_local_events(sys.monitoring.PROFILER_ID, c, events.LINE)
            waiting += [x for x in c.co_consts if isinstance(x, types.CodeType)]


def load(path: Path, name: str) -> tuple[Frames, Lines]:
    """Puts the instrumented module where an import finds it."""
    source, frames, lines = Source(path), Frames(), Lines()
    tree = ast.fix_missing_locations(Rewrite(source, frames).visit(source.tree))
    module = types.ModuleType(name)
    module.__file__ = str(path)
    module.__dict__.update({BEGIN: frames.begin, CONDITION: frames.condition, END: frames.end})
    sys.modules[name] = module
    code = compile(tree, str(path), "exec")
    lines.watch(code)
    exec(code, module.__dict__)  # noqa: S102  the module under test
    return frames, lines


def covered(seen: set[tuple[Vector, bool]], i: int) -> bool:
    """Whether two vectors show condition ``i`` deciding alone."""
    return any(
        out_a != out_b
        and a[i] is not None
        and b[i] is not None
        and a[i] != b[i]
        and all(
            x == y or x is None or y is None
            for j, (x, y) in enumerate(zip(a, b, strict=True))
            if j != i
        )
        for (a, out_a), (b, out_b) in itertools.combinations(seen, 2)
    )


def misses(frames: Frames, file: str) -> list[dict[str, str]]:
    """Every condition without MC/DC, and how far it got."""
    out = []
    for d in frames.decisions:
        for i, condition in enumerate(d.conditions):
            if covered(d.seen, i):
                continue
            values = {v[i] for v, _ in d.seen} - {None}
            why = "not independent" if len(values) == 2 else f"seen {sorted(map(str, values))}"
            out.append(
                {
                    "kind": "condition",
                    "file": file,
                    "function": d.function,
                    "text": condition,
                    "on": d.text,
                    "line": str(d.line),
                    "got": why,
                }
            )
    return out


def statements(path: Path) -> tuple[Source, list[ast.stmt]]:
    """Every statement that runs: no docstring, no type alias, no import of the future."""
    source = Source(path)
    found = [
        n
        for n in ast.walk(source.tree)
        if isinstance(n, ast.stmt)
        and id(n) not in source.never_run
        and not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))
        and not (isinstance(n, ast.ImportFrom) and n.module == "__future__")
        and not isinstance(n, ast.Pass)
    ]
    return source, found


def unrun(path: Path, lines: Lines, file: str) -> list[dict[str, str]]:
    """Every statement no test ran."""
    source, found = statements(path)
    return [
        {
            "kind": "line",
            "file": file,
            "function": source.function(n),
            "text": source.line(n),
            "line": str(n.lineno),
        }
        for n in found
        if not lines.ran.intersection(source.header(n))
    ]


def run_suite(tests: Path, out: io.TextIOBase) -> bool:
    """The suite, in this process."""
    sys.path.insert(0, str(tests))
    suite = unittest.defaultTestLoader.discover(str(tests))
    return unittest.TextTestRunner(stream=out, verbosity=0).run(suite).wasSuccessful()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    ap.add_argument("module", type=Path)
    ap.add_argument("tests", type=Path)
    ap.add_argument("--list", type=Path, help="the conditions that stay without MC/DC, and why")
    args = ap.parse_args(argv)
    sys.path.insert(0, str(args.module.resolve().parent))
    sys.setrecursionlimit(5000)  # an instrumented call is two frames where there was one
    os.environ["REGISTER_MEASURED"] = "1"  # the test that runs this tool does not run it again
    atexit.register(sys.stdout.flush)
    file = args.module.as_posix()
    try:
        lists = {k: entries(args.list, k, file) if args.list else [] for k in ("line", "condition")}
    except ValueError as e:
        print(e)
        return 2
    frames, lines = load(args.module.resolve(), args.module.stem)
    said = io.StringIO()
    if not run_suite(args.tests.resolve(), said):
        print(said.getvalue())
        return 2
    missed, not_run = misses(frames, file), unrun(args.module.resolve(), lines, file)
    total = sum(len(d.conditions) for d in frames.decisions)
    every = len(statements(args.module.resolve())[1])
    outcomes = collections.Counter(len({r for _, r in d.seen}) == 2 for d in frames.decisions)
    print(
        f"statements {every - len(not_run)}/{every}  "
        f"decisions {outcomes[True]}/{len(frames.decisions)}  MC/DC {total - len(missed)}/{total}"
    )
    code = 0
    for kind, found, keys in (
        ("line", not_run, ("function", "text")),
        ("condition", missed, ("function", "text", "on")),
    ):
        unlisted, stale = ratchet(found, lists[kind], keys)
        for m in unlisted:
            why = m.get("got", "never run")
            print(f"{kind}: {m['file']}:{m['line']} {m['function']}: {m['text']} ({why})")
        for s in stale:
            print(f"{kind} listed and covered, or gone: {s['function']}: {s['text']}")
        code |= bool(unlisted or stale)
    return code


if __name__ == "__main__":
    sys.exit(main())
