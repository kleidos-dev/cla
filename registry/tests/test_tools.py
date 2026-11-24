# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The measuring tools report what is planted for them, and the register's own lists hold.

tests/tools/py/mcdc.py (statements and conditions) runs here over the whole suite. mutate.py is a
campaign of minutes, so only its planted mutants run here."""

from __future__ import annotations

import argparse
import ast
import importlib
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import time
import tomllib
import unittest
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla

TOOLS = cla.ROOT / "tests" / "tools" / "py"
LIST = cla.ROOT / "tests" / "exclusions" / "register.toml"
FLOORS = cla.ROOT / "tests" / "floors" / "register.toml"
sys.path.insert(0, str(TOOLS))
mcdc: Any = importlib.import_module("mcdc")
mutate: Any = importlib.import_module("mutate")
pysource: Any = importlib.import_module("pysource")

Vector = tuple[bool | None, ...]

MODULE = '''
"""A module to measure."""

LIMIT = 10


def small(n, flag):
    """Whether it is small."""
    if n < LIMIT and flag:
        return "small"
    return "large"


def unused():
    return 1


if __name__ == "__main__":
    print(small(1, True))
'''
SUITE = """
import runpy, unittest, planted

class T(unittest.TestCase):
    def test_small(self):
        self.assertEqual(planted.small(1, True), "small")
        self.assertEqual(planted.small(10, True), "large")
"""
FLAG = """
    def test_flag(self):
        self.assertEqual(planted.small(1, False), "large")
        self.assertEqual(planted.unused(), 1)
        self.assertEqual(planted.LIMIT, 10)
"""
STARTED = """
    def test_started(self):
        import contextlib, io
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            runpy.run_path(planted.__file__, run_name="__main__")
        self.assertEqual(said.getvalue(), "small\\n")
"""


#: Set in the processes of the measures, which do not measure themselves.
MEASURED = os.environ.get("REGISTER_MEASURED")


@unittest.skipIf(MEASURED, "this is the measure itself")
class Planted(unittest.TestCase):
    """A small module and suite of its own."""

    def setUp(self) -> None:
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.root = Path(d.name).resolve()
        (self.root / "src").mkdir()
        (self.root / "tests").mkdir()
        self.write(MODULE, SUITE)

    def write(self, module: str, suite: str) -> None:
        (self.root / "src" / "planted.py").write_text(module, "utf-8")
        (self.root / "tests" / "test_planted.py").write_text(suite, "utf-8")

    def run_tool(self, tool: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(TOOLS / tool), "src/planted.py", "tests", *args],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )

    def listed(self, *entries: dict[str, str]) -> str:
        path = self.root / "list.toml"
        path.write_text(
            "\n".join(
                "[[entry]]\n"
                + "\n".join(f"{json.dumps(k)} = {json.dumps(v)}" for k, v in e.items())
                for e in entries
            ),
            "utf-8",
        )
        return str(path)


CONDITION = {
    "kind": "condition",
    "file": "src/planted.py",
    "function": "small",
    "text": "flag",
    "on": "n < LIMIT and flag",
    "reason": "unreachable",
    "why": "planted",
}
STARTING = {
    **CONDITION,
    "function": "",
    "text": "__name__ == '__main__'",
    "on": "__name__ == '__main__'",
}
RETURNED = {**CONDITION, "kind": "line", "function": "unused", "text": "return 1"}
PRINTED = {**RETURNED, "function": "", "text": "print(small(1, True))"}


class Mcdc(Planted):
    def test_a_statement_and_a_condition_no_test_shows_are_reported(self) -> None:
        done = self.run_tool("mcdc.py")
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertEqual(
            done.stdout.splitlines(),
            [
                "statements 7/9  decisions 1/2  MC/DC 1/3",
                "line: src/planted.py:15 unused: return 1 (never run)",
                "line: src/planted.py:19 : print(small(1, True)) (never run)",
                "condition: src/planted.py:9 small: flag (seen ['True'])",
                "condition: src/planted.py:18 : __name__ == '__main__' (seen ['False'])",
            ],
        )

    def test_what_the_list_excuses_passes_and_what_it_need_not_excuse_fails(self) -> None:
        self.write(MODULE, SUITE + FLAG)
        path = self.listed(STARTING, PRINTED)
        self.assertEqual(self.run_tool("mcdc.py", "--list", path).returncode, 0)
        path = self.listed(STARTING, PRINTED, CONDITION, RETURNED)
        done = self.run_tool("mcdc.py", "--list", path)
        self.assertEqual(done.returncode, 1)
        self.assertIn("condition listed and covered, or gone: small: flag\n", done.stdout)
        self.assertIn("line listed and covered, or gone: unused: return 1\n", done.stdout)

    def test_a_list_that_is_no_list_is_an_error_of_a_campaign_too(self) -> None:
        path = self.listed({**SURVIVOR, "why": ""})
        self.assertEqual(self.run_tool("mutate.py", "--list", path).returncode, 2)

    def test_an_entry_without_its_reason_is_an_error(self) -> None:
        for change in (
            {"reason": "hard to test"},
            {"why": " "},
            {"reason": "boundary"},
            {"reason": "tool"},
        ):
            with self.subTest(change):
                path = self.listed({**CONDITION, **change})
                self.assertEqual(self.run_tool("mcdc.py", "--list", path).returncode, 2)

    def test_a_suite_that_fails_is_no_measure(self) -> None:
        self.write(MODULE, SUITE.replace('"large"', '"x"'))
        self.assertEqual(self.run_tool("mcdc.py").returncode, 2)

    def test_a_condition_shown_to_decide_alone(self) -> None:
        yes, no = True, False
        seen: set[tuple[Vector, bool]] = {((yes, yes, None), yes), ((no, None, None), no)}
        self.assertEqual([mcdc.covered(seen, i) for i in range(3)], [True, False, False])
        seen.add(((yes, no, no), no))  # a and (b or c)
        self.assertEqual([mcdc.covered(seen, i) for i in range(3)], [True, True, False])
        seen.add(((yes, no, yes), yes))
        self.assertEqual([mcdc.covered(seen, i) for i in range(3)], [True, True, True])
        coupled: set[tuple[Vector, bool]] = {((yes, yes), yes), ((no, no), no)}
        self.assertEqual([mcdc.covered(coupled, i) for i in range(2)], [False, False])

    def test_a_decision_left_by_an_exception_leaves_no_vector(self) -> None:
        self.write(
            textwrap.dedent(
                """
                def broken():
                    raise ValueError

                def f(x):
                    if x and broken():
                        return 1
                    return 2

                def g(x):
                    return f(x) if x else 3
                """
            ),
            textwrap.dedent(
                """
                import unittest, planted

                class T(unittest.TestCase):
                    def test(self):
                        for _ in range(2):
                            with self.assertRaises(ValueError):
                                planted.g(1)
                        self.assertEqual((planted.g(0), planted.f(0)), (3, 2))
                """
            ),
        )
        done = self.run_tool("mcdc.py")
        self.assertIn("condition: src/planted.py:6 f: x (seen ['False'])\n", done.stdout)
        self.assertIn("condition: src/planted.py:6 f: broken() (seen [])\n", done.stdout)
        self.assertNotIn(" g: x", done.stdout)


SURVIVOR = {
    "kind": "mutant",
    "file": "src/planted.py",
    "function": "small",
    "on": "if n < LIMIT and flag:",
    "text": "flag",
    "operator": "condition true",
    "replacement": "True",
    "reason": "equivalent",
    "why": "planted",
}


class Mutate(Planted):
    def results(self, *args: str) -> tuple[int, list[dict[str, Any]], str]:
        out = self.root / "out.json"
        done = self.run_tool("mutate.py", "--out", str(out), *args)
        found: list[dict[str, Any]] = json.loads(out.read_text("utf-8")) if out.exists() else []
        return done.returncode, found, done.stdout + done.stderr

    def test_a_mutant_no_test_notices_and_one_no_test_reaches_are_reported(self) -> None:
        code, found, said = self.results()
        self.assertEqual(code, 1, said)
        stayed = {
            (f["function"], f["operator"], f["text"], f["result"])
            for f in found
            if f["result"] in ("survived", "no test")
        }
        self.assertIn(("small", "condition true", "flag", "survived"), stayed)
        self.assertIn(("unused", "return", "return 1", "no test"), stayed)
        self.assertIn(
            "survived: src/planted.py:9 small: condition true: 'flag' -> 'True' on "
            "'if n < LIMIT and flag:'\n",
            said,
        )

    def test_a_suite_that_checks_everything_leaves_none(self) -> None:
        self.write(MODULE, SUITE + FLAG + STARTED)
        code, found, said = self.results()
        self.assertEqual((code, {f["result"] for f in found}), (0, {"killed"}), said)
        self.assertGreater(len(found), 20)
        self.assertLessEqual(
            {"", "small", "unused"}, {f["function"] for f in found}, "the module's level is mutated"
        )

    def test_the_list_excuses_survivors_and_nothing_else(self) -> None:
        only = ("--functions", "small", "--operators", "condition true")
        self.assertEqual(self.results(*only)[0], 1)
        self.assertEqual(self.results(*only, "--list", self.listed(SURVIVOR))[0], 0)
        self.write(MODULE, SUITE + FLAG + STARTED)
        code, _, said = self.results("--list", self.listed(SURVIVOR))
        self.assertEqual(code, 1)
        self.assertIn("listed and killed, or gone: small: flag -> True\n", said)

    def test_a_mutant_that_never_ends_is_told_apart(self) -> None:
        self.write(
            "def count(n):\n    while n > 0:\n        n -= 1\n    return n\n",
            "import unittest, planted\n\nclass T(unittest.TestCase):\n"
            "    def test(self):\n        self.assertEqual(planted.count(3), 0)\n",
        )
        code, found, _ = self.results("--operators", "deletion", "--seconds", "1")
        self.assertEqual((code, [f["result"] for f in found]), (1, ["timeout"]))

    def test_a_mutant_that_does_not_load_is_no_kill(self) -> None:
        self.write(
            'import re\nP = re.compile("a")\nX = {"k": 1}["k"]\n',
            "import unittest, planted\n\nclass T(unittest.TestCase):\n"
            "    def test(self):\n        self.assertEqual(planted.X, 1)\n",
        )
        _, found, _ = self.results("--operators", "string")
        self.assertEqual({f["result"] for f in found}, {"invalid"})

    def test_a_suite_that_fails_is_no_campaign(self) -> None:
        self.write(MODULE, SUITE.replace('"large"', '"x"'))
        code, found, _ = self.results()
        self.assertEqual((code, found), (1, []))

    def test_parts_of_a_campaign(self) -> None:
        mutator = mutate.Mutator(pysource.Source(self.root / "src" / "planted.py"))

        def chosen(**over: Any) -> list[int]:
            nothing = {"functions": None, "operators": None, "lines": None, "shard": None}
            nothing |= {"since": None}
            args = argparse.Namespace(**{**nothing, "sample": None, "seed": 0, **over})
            order = {id(m): i for i, m in enumerate(mutator.mutants)}
            return [order[id(m)] for m in mutate.choose(mutator, args)]

        whole = chosen()
        self.assertEqual(whole, list(range(len(mutator.mutants))))
        self.assertEqual(chosen(shard="1/2"), whole[::2])
        self.assertEqual(chosen(shard="2/2"), whole[1::2])
        sample = chosen(sample=3, seed=5)
        self.assertEqual(len(sample), 3)
        self.assertEqual(chosen(sample=3, seed=5), sample)
        self.assertNotEqual(chosen(sample=3, seed=6), sample)
        self.assertEqual(chosen(sample=10_000), whole)
        for over, key, value in (
            ({"lines": "9-9"}, "line", {"9"}),
            ({"functions": "unused"}, "function", {"unused"}),
            ({"operators": "return,not"}, "operator", {"return"}),
        ):
            found = {mutator.describe(mutator.mutants[i])[key] for i in chosen(**over)}
            self.assertEqual(found, value)
        done = self.run_tool("mutate.py", "--count")
        self.assertEqual((done.returncode, len(done.stdout.splitlines())), (0, 1))

    def test_the_mutants_of_the_lines_a_change_made(self) -> None:
        git = ("git", "-c", "user.name=t", "-c", "user.email=t@example.org")
        for command in (("init", "-q"), ("add", "."), ("commit", "-q", "--no-gpg-sign", "-m", "p")):
            subprocess.run([*git, *command], cwd=self.root, check=True, capture_output=True)
        planted = self.root / "src" / "planted.py"
        planted.write_text(
            MODULE.replace('return "large"', 'return "large" if flag else "large"'), "utf-8"
        )
        mutator = mutate.Mutator(pysource.Source(planted))
        nothing = {"functions": None, "operators": None, "lines": None, "shard": None}
        args = argparse.Namespace(**nothing, since="HEAD", sample=None, seed=0)
        chosen = mutate.choose(mutator, args)
        self.assertEqual({mutator.describe(m)["line"] for m in chosen}, {"11"})
        self.assertIn("flag", {mutator.describe(m)["text"] for m in chosen})
        self.assertEqual(mutate.changed_lines(planted, "HEAD"), {11})
        planted.write_text(MODULE, "utf-8")
        self.assertEqual(mutate.changed_lines(planted, "HEAD"), set())
        done = self.run_tool("mutate.py", "--since", "HEAD", "--count")
        self.assertRegex(done.stdout, r"^0 of \d+ mutants: \{\}\n$")

    def test_a_change_of_the_tests_plants_the_mutants_its_tests_run(self) -> None:
        git = ("git", "-c", "user.name=t", "-c", "user.email=t@example.org")
        other = "import unittest, planted\n\nclass O(unittest.TestCase):\n"
        other += "    def test_unused(self):\n        self.assertEqual(planted.unused(), 1)\n"
        (self.root / "tests" / "test_other.py").write_text(other, "utf-8")
        for command in (("init", "-q"), ("add", "."), ("commit", "-q", "--no-gpg-sign", "-m", "p")):
            subprocess.run([*git, *command], cwd=self.root, check=True, capture_output=True)
        asked = ("--since", "HEAD", "--tests-sample", "500", "--seed", "3")
        unchanged = self.run_tool("mutate.py", *asked, "--count")
        self.assertRegex(unchanged.stdout, r"^0 of \d+ mutants: \{\}\n$")
        # The planted suite loses the assertion that tells n < LIMIT from n <= LIMIT.
        weaker = SUITE.replace('        self.assertEqual(planted.small(10, True), "large")\n', "")
        self.write(MODULE, weaker)
        counted = self.run_tool("mutate.py", *asked, "--count")
        notice = r"notice: (\d+) of the (\d+) other mutants test_planted runs, seed 3"
        sampled = re.search(notice, counted.stdout)
        self.assertIsNotNone(sampled, counted.stdout)
        assert sampled is not None
        self.assertEqual(sampled[1], sampled[2])
        mutator = mutate.Mutator(pysource.Source(self.root / "src" / "planted.py"))
        functions = {mutator.describe(m)["function"] for m in mutator.mutants}
        self.assertIn("unused", functions)
        self.assertLess(int(sampled[1]), len(mutator.mutants), "not those test_other alone runs")
        self.assertEqual(mutate.changed_tests(self.root / "tests", "HEAD"), {"test_planted"})
        code, found, said = self.results(*asked)
        self.assertEqual(code, 1, said)
        self.assertIn("n <= LIMIT", said)
        self.assertNotIn("unused", {f["function"] for f in found}, "test_planted never runs it")
        (self.root / "tests" / "helper.py").write_text("X = 1\n", "utf-8")
        subprocess.run([*git, "add", "."], cwd=self.root, check=True, capture_output=True)
        self.assertIsNone(mutate.changed_tests(self.root / "tests", "HEAD"), "a helper: every test")
        every = self.run_tool("mutate.py", *asked, "--count")
        self.assertIn("other mutants every test runs, seed 3", every.stdout)

    def test_a_sample_says_so(self) -> None:
        done = self.run_tool("mutate.py", "--sample", "2", "--seed", "7", "--count")
        self.assertEqual(done.returncode, 0)
        self.assertRegex(done.stdout, r"^notice: 2 of \d+ mutants, a sample by seed 7\n2 of ")

    def test_the_shards_of_a_campaign_are_judged_whole(self) -> None:
        self.write(MODULE, SUITE + FLAG + STARTED)
        one, two = self.root / "1.json", self.root / "2.json"
        for share, out in (("1/2", one), ("2/2", two)):
            done = self.run_tool("mutate.py", "--shard", share, "--out", str(out))
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        stale = self.listed(SURVIVOR)
        alone = self.run_tool("mutate.py", "--shard", "1/2", "--list", stale)
        self.assertEqual(alone.returncode, 0, "a shard alone cannot tell a stale entry")
        whole = self.run_tool("mutate.py", "--merged", str(one), str(two))
        self.assertEqual(whole.returncode, 0, whole.stdout)
        self.assertRegex(whole.stdout, r"^(\d+) of \1 mutants: \{'killed': \1\}\n$")
        listed = self.run_tool("mutate.py", "--merged", str(one), str(two), "--list", stale)
        self.assertEqual(listed.returncode, 1)
        self.assertIn("listed and killed, or gone: small: flag -> True\n", listed.stdout)
        half = self.run_tool("mutate.py", "--merged", str(one))
        self.assertEqual(half.returncode, 1)
        self.assertRegex(half.stdout, r"the reports miss \d+ mutants and hold 0 more\n$")
        twice = self.run_tool("mutate.py", "--merged", str(one), str(two), str(two))
        self.assertEqual(twice.returncode, 1)
        self.assertRegex(twice.stdout, r"the reports miss 0 mutants and hold \d+ more\n$")

    def test_the_mutants_of_a_pattern(self) -> None:
        self.assertEqual(
            mutate.regex_mutants(r"^a{1,2}[b-c]+\.\d?$"),
            sorted(
                {
                    r"a{1,2}[b-c]+\.\d?$",
                    r"^a{1,2}[b-c]+\.\d?",
                    r"^a{2,2}[b-c]+\.\d?$",
                    r"^a{0,2}[b-c]+\.\d?$",
                    r"^a{1,3}[b-c]+\.\d?$",
                    r"^a{1,1}[b-c]+\.\d?$",
                    r"^a{1,2}[^b-c]+\.\d?$",
                    r"^a{1,2}[b-c]*\.\d?$",
                    r"^a{1,2}[b-c]+.\d?$",
                    r"^a{1,2}[b-c]+\.\D?$",
                    r"^a{1,2}[b-c]+\.\d$",
                }
            ),
        )
        self.assertEqual(mutate.regex_mutants("[^a]"), ["[a]"])


@unittest.skipIf(MEASURED, "this is the measure itself")
class Lists(unittest.TestCase):
    """The register's own lists: short, whole, and as long as their floors say."""

    def entries(self) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = tomllib.loads(LIST.read_text("utf-8"))["entry"]
        return found

    def test_the_floors_are_what_the_list_holds(self) -> None:
        kinds = Counter(e["kind"] for e in self.entries())
        floors = tomllib.loads(FLOORS.read_text("utf-8"))
        self.assertEqual(
            floors["misses"],
            {**dict.fromkeys(("line", "branch", "condition", "mutant"), 0), **kinds}
            | {"exclusions": len(self.entries())},
        )
        self.assertEqual(floors["files"], ["registry/cla.py"])
        self.assertEqual({e["file"] for e in self.entries()}, set(floors["files"]))

    def test_every_text_is_still_in_the_source(self) -> None:
        source = pysource.Source(Path(cla.__file__))
        found = {
            (source.function(n), pysource.ast.unparse(n))
            for n in pysource.ast.walk(source.tree)
            if isinstance(n, pysource.ast.expr | pysource.ast.stmt)
        }
        for e in self.entries():
            self.assertIn((e["function"], e["text"]), found)

    def test_every_listed_mutant_exists(self) -> None:
        mutator = mutate.Mutator(pysource.Source(Path(cla.__file__)))
        listed = pysource.entries(LIST, "mutant", "registry/cla.py")
        texts = {(e["operator"], e["text"]) for e in listed}
        near = [
            m
            for m in mutator.mutants
            if m.operator in {o for o, _ in texts}
            and (m.operator, ast.unparse(mutator.nodes[m.number])) in texts
        ]
        made = {tuple(mutator.describe(m)[k] for k in mutate.KEYS) for m in near}
        self.assertEqual(len({tuple(e[k] for k in mutate.KEYS) for e in listed}), len(listed))
        for e in listed:
            self.assertIn(tuple(e[k] for k in mutate.KEYS), made)

    def test_no_pragma_hides_anything(self) -> None:
        for path in (Path(cla.__file__), *Path(__file__).parent.glob("*.py"), *TOOLS.glob("*.py")):
            for hidden in ("pragma: no " + "cover", "pragma: no " + "branch", "NO" + "SONAR"):
                self.assertNotIn(hidden, path.read_text("utf-8"), path.name)


@unittest.skipIf(MEASURED, "this is the measure itself")
class Limited(unittest.TestCase):
    """tests/tools/limited.py: a campaign ends at its time or memory, its children's counted."""

    def limited(self, seconds: str, gib: str, code: str) -> tuple[int, str, float]:
        begun = time.monotonic()
        done = subprocess.run(
            [sys.executable, str(TOOLS.parent / "limited.py"), seconds, gib, "--"]
            + [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            check=False,
        )
        return done.returncode, done.stdout + done.stderr, time.monotonic() - begun

    def test_the_command_s_own_exit_code_and_output_pass_through(self) -> None:
        code, said, _ = self.limited("30", "1", "print('done'); raise SystemExit(3)")
        self.assertEqual((code, said), (3, "done\n"))

    def test_past_its_time_the_run_is_killed_and_says_so(self) -> None:
        code, said, took = self.limited("0.5", "1", "import time; time.sleep(60)")
        self.assertEqual(code, 137)
        self.assertRegex(said, r"^limited: killed, over 0.5 s: ")
        self.assertLess(took, 20)

    def test_past_its_memory_the_run_is_killed_and_says_so(self) -> None:
        held = "import time; x = b'x' * (600 << 20); time.sleep(60)"
        code, said, took = self.limited("120", "0.25", held)
        self.assertEqual(code, 137)
        self.assertRegex(said, r"^limited: killed, over 0.25 GiB: ")
        self.assertLess(took, 60)

    def test_the_memory_of_what_it_starts_counts_too(self) -> None:
        child = "import time; x = b'x' * (200 << 20); time.sleep(60)"
        parent = (
            "import subprocess, sys, time\n"
            f"kids = [subprocess.Popen([sys.executable, '-c', {child!r}]) for _ in range(3)]\n"
            "time.sleep(60)"
        )
        code, said, _ = self.limited("120", "0.5", parent)
        self.assertEqual(code, 137)
        self.assertIn("over 0.5 GiB", said)

    def test_a_run_with_no_command_is_refused(self) -> None:
        done = subprocess.run(
            [sys.executable, str(TOOLS.parent / "limited.py"), "1", "1", "--"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(done.returncode, 2)
        self.assertIn("no command", done.stderr)


@unittest.skipIf(MEASURED, "this is the measure itself")
class Measured(unittest.TestCase):
    """The whole suite, once more, with every statement and condition of the register measured."""

    def test_nothing_is_missed_but_what_the_list_says(self) -> None:
        done = subprocess.run(
            [sys.executable, str(TOOLS / "mcdc.py"), "registry/cla.py", "registry/tests"]
            + ["--list", str(LIST)],
            cwd=cla.ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main()
