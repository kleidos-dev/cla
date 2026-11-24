# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Mutation testing of one Python module by its unittest suite, standard library only.

Every mutant changes one node of the module's syntax tree, at the module's own level as well as in
its functions, and runs in a process of its own the tests that reach the statement it is in, the
fastest first, until one fails. A mutant is

- killed: a test failed;
- timeout: a test did not end in its time, so the process was killed;
- invalid: the module could not be loaded, so no test was asked (a compile error, told apart from a
  kill);
- survived: every test that reaches it passed;
- no test: no test reaches it.

A survivor, a mutant no test reaches and one killed by a timeout are in the list of equivalents with
their reason, or the run fails; an entry of the list that is none of these any more fails it too.
A whole campaign runs under a memory and a time limit (AGENTS.md), with two workers at most.

    python tests/tools/py/mutate.py registry/cla.py registry/tests \\
        --list tests/exclusions/register.toml
"""

from __future__ import annotations

import argparse
import ast
import collections
import contextlib
import copy
import email.utils
import hashlib
import http.client
import json
import multiprocessing
import os
import random
import re
import resource
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import types
import unicodedata
import unittest
import unittest.mock
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pysource import Source, atoms, entries, is_literal, places, ratchet

# Loaded once here and not again in every mutant's process.
_PRELOADED = (email.utils, hashlib, http.client, secrets, shutil, subprocess, tomllib)
_PRELOADED_TOO = (unicodedata, unittest.mock, urllib.request)

MEMORY = 2 << 30
COMPARED: dict[type[ast.cmpop], type[ast.cmpop]] = {
    ast.Eq: ast.NotEq,
    ast.NotEq: ast.Eq,
    ast.Lt: ast.LtE,
    ast.LtE: ast.Lt,
    ast.Gt: ast.GtE,
    ast.GtE: ast.Gt,
    ast.In: ast.NotIn,
    ast.NotIn: ast.In,
    ast.Is: ast.IsNot,
    ast.IsNot: ast.Is,
}
Edit = Callable[[Any], ast.AST]


@dataclass
class Mutant:
    operator: str
    #: The node it changes, as its number in ast.walk's order.
    number: int
    edit: Edit


def regex_mutants(pattern: str) -> list[str]:
    """Patterns that differ in one quantifier, class, escape or anchor, and still compile."""
    out = {pattern.removeprefix("^"), pattern.removesuffix("$")}
    for m in re.finditer(r"\[\^?", pattern):
        out.add(pattern[: m.start()] + ("[" if m[0] == "[^" else "[^") + pattern[m.end() :])
    for m in re.finditer(r"\{(\d+)(,(\d*))?\}", pattern):
        low, rest, high = int(m[1]), m[2] or "", m[3]
        new = [f"{{{low + 1}{rest}}}"]
        if low:
            new.append(f"{{{low - 1}{rest}}}")
        if high:
            new += [f"{{{low},{int(high) + 1}}}", f"{{{low},{int(high) - 1}}}"]
        out |= {pattern[: m.start()] + n + pattern[m.end() :] for n in new}
    for m in re.finditer(r"(?<![(\\])[+*?](?![+*?])", pattern):
        out.add(pattern[: m.start()] + {"+": "*", "*": "+", "?": ""}[m[0]] + pattern[m.end() :])
    for m in re.finditer(r"\\([dwsDWS])", pattern):
        out.add(f"{pattern[: m.start()]}\\{m[1].swapcase()}{pattern[m.end() :]}")
    for m in re.finditer(r"\\\.", pattern):
        out.add(f"{pattern[: m.start()]}.{pattern[m.end() :]}")
    return sorted(p for p in out if p != pattern and _compiles(p))


def _compiles(pattern: str) -> bool:
    try:
        re.compile(pattern)
    except re.error:
        return False
    return True


class Mutator:
    """Every mutant of a module."""

    def __init__(self, source: Source) -> None:
        self.source = source
        self.nodes = list(ast.walk(source.tree))
        self.numbers = {id(n): i for i, n in enumerate(self.nodes)}
        self.mutants = list(self._all())

    def _all(self) -> Iterator[Mutant]:
        for number, node in enumerate(self.nodes):
            if id(node) in self.source.never_run:
                continue
            yield from self._conditions(node)
            for operator, edit in self._edits(node):
                yield Mutant(operator, number, edit)

    def _conditions(self, node: ast.AST) -> Iterator[Mutant]:
        """Each atomic condition of each decision forced to true and to false."""
        tests: list[ast.expr] = []
        if isinstance(node, ast.If | ast.While | ast.IfExp | ast.Assert):
            tests = [node.test]
        elif isinstance(node, ast.comprehension):
            tests = node.ifs
        elif isinstance(node, ast.BoolOp):
            place = self.source.places[id(node)]
            nested = isinstance(place.parent, ast.BoolOp | ast.UnaryOp)
            if not nested and place.field not in ("test", "ifs"):
                tests = [node]
        for atom in (a for t in tests for a in atoms(t)):
            if not is_literal(atom):
                for value in (True, False):
                    yield Mutant(
                        f"condition {str(value).lower()}",
                        self.numbers[id(atom)],
                        partial(_put, value),
                    )

    def _edits(self, node: ast.AST) -> Iterator[tuple[str, Edit]]:
        if isinstance(node, ast.BoolOp):
            yield "and/or", _swap_bool
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            yield "not", lambda n: n.operand
        elif isinstance(node, ast.Compare):
            for k in range(len(node.ops)):
                yield "comparison", partial(_swap_comparison, k)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add | ast.Sub):
            yield "arithmetic", _swap_sum
        elif isinstance(node, ast.Constant):
            yield from self._constants(node)
        elif isinstance(node, ast.Return):
            if node.value is not None and not _is_none(node.value):
                yield "return", lambda _: ast.Return(ast.Constant(None))
        elif isinstance(node, ast.Raise | ast.AugAssign | ast.Continue | ast.Break) or (
            isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
        ):
            yield "deletion", lambda _: ast.Pass()
        elif (
            isinstance(node, ast.Set | ast.Tuple | ast.List)
            and len(node.elts) > 1
            and isinstance(getattr(node, "ctx", ast.Load()), ast.Load)
        ):
            for k in range(len(node.elts)):
                yield "element", partial(_without, k)

    def _constants(self, node: ast.Constant) -> Iterator[tuple[str, Edit]]:
        value, parent = node.value, self.source.places[id(node)].parent
        if isinstance(parent, ast.Expr):
            return  # a docstring
        if isinstance(value, bool):
            yield "constant", lambda n: ast.Constant(not n.value)
        elif isinstance(value, int):
            yield "constant", lambda n: ast.Constant(n.value + 1)
            yield "constant", lambda n: ast.Constant(n.value - 1)
        elif isinstance(value, bytes):
            yield "string", lambda n: ast.Constant(n.value + b"XX")
        elif isinstance(value, str):
            if _is_pattern(node, parent):
                for other in regex_mutants(value):
                    yield "regex", partial(_put, other)
            elif isinstance(parent, ast.JoinedStr):
                yield "string", lambda n: ast.Constant("XX" + n.value)
            else:
                if value:
                    yield "string", lambda _: ast.Constant("")
                yield "string", lambda n: ast.Constant(n.value + "XX")

    def describe(self, mutant: Mutant) -> dict[str, str]:
        """How a person finds it, and how the list of equivalents names it."""
        node = self.nodes[mutant.number]
        return {
            "kind": "mutant",
            "function": self.source.function(node),
            "in": self.source.line(node),
            "text": ast.unparse(node),
            "operator": mutant.operator,
            "replacement": _text(mutant.edit(copy.deepcopy(node))),
            "line": str(getattr(node, "lineno", 0)),
        }

    def build(self, mutant: Mutant) -> ast.Module:
        """The module with that one change."""
        tree = copy.deepcopy(self.source.tree)
        node = list(ast.walk(tree))[mutant.number]
        place = places(tree)[id(node)]
        new = mutant.edit(node)
        if new is not node:
            ast.copy_location(new, node)
            if place.index is None:
                setattr(place.parent, place.field, new)
            else:
                getattr(place.parent, place.field)[place.index] = new
        return ast.fix_missing_locations(tree)

    def starts_the_file(self, mutant: Mutant) -> bool:
        """Whether it is in the block that runs when the file is started, not imported."""
        node = self.nodes[mutant.number]
        return any(
            isinstance(n, ast.If) and "__name__" in ast.unparse(n.test)
            for n in (node, *self.source.parents(node))
        )

    def lines(self, mutant: Mutant) -> set[int] | None:
        """The lines a test must run to reach it; None when the module itself runs it, on import."""
        node = self.nodes[mutant.number]
        statement = self.source.statement(node)
        around = list(self.source.parents(node))
        if isinstance(statement, ast.FunctionDef):
            # A default or a decorator: the tests that run the function.
            return {n.lineno for n in ast.walk(statement) if isinstance(n, ast.stmt)}
        if not any(isinstance(p, ast.FunctionDef) for p in around):
            return None
        return set(self.source.header(statement))


def _swap_bool(n: Any) -> ast.AST:
    return ast.BoolOp(ast.Or() if isinstance(n.op, ast.And) else ast.And(), n.values)


def _swap_sum(n: Any) -> ast.AST:
    return ast.BinOp(n.left, ast.Sub() if isinstance(n.op, ast.Add) else ast.Add(), n.right)


def _put(value: bool | str, _: Any) -> ast.AST:
    return ast.Constant(value)


def _swap_comparison(k: int, n: Any) -> ast.AST:
    n.ops[k] = COMPARED[type(n.ops[k])]()
    found: ast.AST = n
    return found


def _without(k: int, n: Any) -> ast.AST:
    del n.elts[k]
    found: ast.AST = n
    return found


def _is_none(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and node.value is None


def _is_pattern(node: ast.Constant, parent: ast.AST) -> bool:
    """Whether it is the pattern of a call of the re module."""
    if isinstance(parent, ast.Call) and parent.args and parent.args[0] is node:
        function = parent.func
        return (
            isinstance(function, ast.Attribute)
            and isinstance(function.value, ast.Name)
            and function.value.id == "re"
        )
    return False


def _text(node: ast.AST) -> str:
    return "" if isinstance(node, ast.Pass) else ast.unparse(node)


# --- which tests reach which line --------------------------------------------------


@dataclass
class Reach:
    """For each test, how long it takes and the lines of the module it runs."""

    seconds: dict[str, float]
    lines: dict[str, set[int]]

    def tests(self, lines: set[int] | None) -> list[str]:
        """The tests that run one of these lines (all of them for None), the fastest first."""
        found = [t for t, ran in self.lines.items() if lines is None or ran & lines]
        return sorted(found, key=lambda t: self.seconds[t])


class _Result(unittest.TestResult):
    def __init__(self, start: Callable[[str], None], stop: Callable[[str], None]) -> None:
        super().__init__()
        self._start, self._stop = start, stop

    def startTest(self, test: unittest.TestCase) -> None:
        super().startTest(test)
        self._start(test.id())

    def stopTest(self, test: unittest.TestCase) -> None:
        self._stop(test.id())
        super().stopTest(test)


def _import(source: Source, tree: ast.Module, path: Path) -> types.ModuleType:
    name = source.path.stem
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(tree, str(path), "exec"), module.__dict__)  # noqa: S102  the module under test
    return module


def _codes(code: types.CodeType) -> Iterator[types.CodeType]:
    yield code
    for c in code.co_consts:
        if isinstance(c, types.CodeType):
            yield from _codes(c)


def measure(source: Source, tests: Path) -> Reach:
    """One run of the suite on the module as it is, the lines of each test kept."""
    monitoring, tool = sys.monitoring, sys.monitoring.COVERAGE_ID
    name = source.path.stem
    module = types.ModuleType(name)
    module.__file__ = str(source.path)
    sys.modules[name] = module
    code = compile(source.tree, str(source.path), "exec")
    exec(code, module.__dict__)  # noqa: S102  the module under test
    ran: set[int] = set()

    def line(_: types.CodeType, number: int) -> Any:
        ran.add(number)
        return monitoring.DISABLE

    monitoring.use_tool_id(tool, "mutate")
    monitoring.register_callback(tool, monitoring.events.LINE, line)
    for c in _codes(code):
        monitoring.set_local_events(tool, c, monitoring.events.LINE)
    reach = Reach({}, {})
    begun = 0.0

    def start(_: str) -> None:
        nonlocal begun
        ran.clear()
        monitoring.restart_events()
        begun = time.monotonic()

    def stop(test: str) -> None:
        reach.seconds[test] = time.monotonic() - begun
        reach.lines[test] = set(ran)

    result = _Result(start, stop)
    unittest.defaultTestLoader.discover(str(tests)).run(result)
    if not result.wasSuccessful():
        for _, trace in (*result.failures, *result.errors):
            print(trace)
        raise SystemExit("the suite fails on the module as it is")
    return reach


def _measured(source: Source, tests: Path, end: Any) -> None:
    sys.path[:0] = [str(source.path.parent), str(tests)]
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 2)
    end.send(measure(source, tests))


def reach_of(source: Source, tests: Path) -> Reach:
    """measure(), in a process of its own: the mutants' processes import nothing before them."""
    ours, theirs = multiprocessing.get_context("fork").Pipe()
    process = multiprocessing.get_context("fork").Process(
        target=_measured, args=(source, tests, theirs)
    )
    process.start()
    theirs.close()
    try:
        found: Reach = ours.recv()
    except EOFError:
        raise SystemExit("the suite could not be measured") from None
    process.join()
    return found


# --- running ------------------------------------------------------------------------

INVALID = 3


def _child(source: Source, tree: ast.Module, names: list[str], tests: Path) -> int:
    """The tests on one mutant, in the forked process that is all its own."""
    sys.path[:0] = [str(source.path.parent), str(tests)]
    try:
        _import(source, tree, source.path)
    except Exception:  # noqa: BLE001  whatever the change broke
        return INVALID
    result = unittest.TestResult()
    result.failfast = True
    unittest.defaultTestLoader.loadTestsFromNames(names).run(result)
    return 0 if result.wasSuccessful() else 1


def _child_file(source: Source, tree: ast.Module, tests: Path) -> int:
    """The whole suite on a copy of the tree with the mutant in its file."""
    root = source.path.parent.parent
    skipped = shutil.ignore_patterns(".git", ".venv", "node_modules", "worker")
    with tempfile.TemporaryDirectory() as d:
        copied = Path(d) / "copy"
        shutil.copytree(root, copied, ignore=skipped, symlinks=True)
        (copied / source.path.relative_to(root)).write_text(ast.unparse(tree), "utf-8")
        command = [sys.executable, "-m", "unittest", "discover", "-f", "-s"]
        done = subprocess.run(
            [*command, str(tests.relative_to(root))], cwd=copied, capture_output=True, check=False
        )
    return 0 if done.returncode == 0 else 1


def _start(
    source: Source, mutator: Mutator, mutant: Mutant, names: list[str], tests: Path, limit: float
) -> int:
    """Forks the process of one mutant, in a group of its own, with its limits; its id."""
    pid = os.fork()
    if pid:
        return pid
    code = 1
    try:
        os.setsid()
        signal.alarm(int(limit) + 1)
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (MEMORY, MEMORY))
        quiet = os.open(os.devnull, os.O_WRONLY)
        os.dup2(quiet, 1)
        os.dup2(quiet, 2)
        tree = mutator.build(mutant)
        if mutator.starts_the_file(mutant):
            code = _child_file(source, tree, tests)
        else:
            code = _child(source, tree, names, tests)
    except BaseException:  # noqa: BLE001  SystemExit and KeyboardInterrupt out of a test too
        code = 1
    finally:
        os._exit(code)


@dataclass
class Outcome:
    mutant: Mutant
    result: str
    seconds: float


def campaign(
    source: Source,
    mutator: Mutator,
    chosen: list[Mutant],
    reach: Reach,
    tests: Path,
    args: argparse.Namespace,
) -> list[Outcome]:
    """Every chosen mutant, so many at a time."""
    running: dict[int, tuple[Mutant, float]] = {}
    outcomes: list[Outcome] = []
    queue = collections.deque(chosen)
    suite = sum(reach.seconds.values())
    while queue or running:
        while queue and len(running) < args.workers:
            mutant = queue.popleft()
            names = reach.tests(mutator.lines(mutant))
            if not names:
                outcomes.append(Outcome(mutant, "no test", 0.0))
                continue
            needed = sum(reach.seconds[n] for n in names)
            limit = args.seconds + 5 * (suite if mutator.starts_the_file(mutant) else needed)
            pid = _start(source, mutator, mutant, names, tests, limit)
            running[pid] = (mutant, time.monotonic())
        if not running:
            break
        pid, status = os.wait()
        if pid not in running:
            continue
        mutant, begun = running.pop(pid)
        with contextlib.suppress(OSError):
            os.killpg(pid, signal.SIGKILL)  # whatever a test left behind
        result = "killed"
        if os.WIFEXITED(status):
            result = {0: "survived", INVALID: "invalid"}.get(os.WEXITSTATUS(status), "killed")
        elif os.WTERMSIG(status) == signal.SIGALRM:
            result = "timeout"
        outcomes.append(Outcome(mutant, result, time.monotonic() - begun))
        if len(outcomes) % 200 == 0:
            print(f"  {len(outcomes)} of {len(chosen)}", file=sys.stderr, flush=True)
    return outcomes


def choose(mutator: Mutator, args: argparse.Namespace) -> list[Mutant]:
    """The mutants of this run: of some functions, operators or lines, a shard, or a sample."""
    chosen = list(mutator.mutants)
    described = {id(m): mutator.describe(m) for m in chosen}
    if args.functions:
        wanted = set(args.functions.split(","))
        chosen = [m for m in chosen if described[id(m)]["function"] in wanted]
    if args.operators:
        wanted = set(args.operators.split(","))
        chosen = [m for m in chosen if m.operator in wanted]
    if args.lines:
        low, high = (int(x) for x in args.lines.split("-"))
        chosen = [m for m in chosen if low <= int(described[id(m)]["line"]) <= high]
    if args.shard:
        number, of = (int(x) for x in args.shard.split("/"))
        chosen = chosen[number - 1 :: of]
    if args.sample and args.sample < len(chosen):
        chosen = random.Random(args.seed).sample(chosen, args.sample)  # noqa: S311  no secret
    return chosen


KEYS = ("function", "in", "text", "operator", "replacement")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    ap.add_argument("module", type=Path)
    ap.add_argument("tests", type=Path)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument(
        "--seconds", type=int, default=20, help="what a mutant has beyond five times its tests"
    )
    ap.add_argument("--list", type=Path, help="the mutants that stay, and why")
    ap.add_argument("--functions", help="only these functions, with a comma between them")
    ap.add_argument("--operators", help="only these operators, with a comma between them")
    ap.add_argument("--lines", help="only these lines: FIRST-LAST")
    ap.add_argument("--shard", help="a part of them: NUMBER/OF")
    ap.add_argument("--sample", type=int, help="at most so many of them, at random")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--count", action="store_true", help="say how many there are and stop")
    ap.add_argument("--out", type=Path, help="every outcome, as JSON")
    args = ap.parse_args(argv)
    source, tests = Source(args.module.resolve()), args.tests.resolve()
    mutator = Mutator(source)
    chosen = choose(mutator, args)
    counts = collections.Counter(m.operator for m in chosen)
    print(f"{len(chosen)} of {len(mutator.mutants)} mutants: {dict(sorted(counts.items()))}")
    if args.count:
        return 0
    file = args.module.as_posix()
    try:
        listed = entries(args.list, "mutant", file) if args.list else []
    except ValueError as e:
        print(e)
        return 2
    os.environ["REGISTER_MEASURED"] = "1"  # the tests of this tool do not run in it
    begun = time.monotonic()
    reach = reach_of(source, tests)
    outcomes = campaign(source, mutator, chosen, reach, tests, args)
    found = [
        {**mutator.describe(o.mutant), "file": file, "result": o.result, "seconds": o.seconds}
        for o in outcomes
    ]
    if args.out:
        args.out.write_text(json.dumps(found, indent=1), "utf-8")
    results = collections.Counter(o.result for o in outcomes)
    took = time.monotonic() - begun
    print(f"{dict(sorted(results.items()))} in {took:.0f} s")
    stayed = [
        {k: str(v) for k, v in f.items()}
        for f in found
        if f["result"] in ("survived", "no test", "timeout")
    ]
    unlisted, stale = ratchet(stayed, listed, KEYS)
    for m in sorted(unlisted, key=lambda m: int(m["line"])):
        print(
            f"{m['result']}: {file}:{m['line']} {m['function']}: {m['operator']}: {m['text']!r} "
            f"-> {m['replacement']!r} in {m['in']!r}"
        )
    whole = len(chosen) == len(mutator.mutants)
    for s in stale if whole else ():
        print(f"listed and killed, or gone: {s['function']}: {s['text']} -> {s['replacement']}")
    return 1 if unlisted or (stale and whole) else 0


if __name__ == "__main__":
    sys.exit(main())
