# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""A unittest suite run as ``python -m unittest discover -s FOLDER -v`` runs it, and how many
tests of each file ran, were skipped, were expected to fail or failed, written as
tests/tools/ratchet.py ``tests`` reads them against the [tests] of a floors file. Standard library
only; its exit code is the suite's.

    python -m coverage run tests/tools/py/count.py registry/tests coverage/register-tests.json
"""

from __future__ import annotations

import json
import sys
import unittest
from collections import defaultdict
from pathlib import Path
from typing import Any

KEYS = ("tests", "skipped", "todo", "failed")


def file_of(start: Path, test: unittest.TestCase) -> str:
    """The test file a test is of, from its id: a module the loader could not load or skipped whole
    is named by the last part of its id (unittest.loader._FailedTest.test_x, ModuleSkipped)."""
    parts = test.id().split(".")
    module = parts[-1] if parts[0] == "unittest" else parts[0]
    return (start / f"{module}.py").as_posix()


class Counted(unittest.TextTestResult):
    """A result that counts by file as well."""

    start = Path()

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.files: defaultdict[str, dict[str, int]] = defaultdict(dict.fromkeys(KEYS, 0).copy)

    def _add(self, test: unittest.TestCase, key: str) -> None:
        self.files[file_of(self.start, test)][key] += 1

    def startTest(self, test: unittest.TestCase) -> None:
        super().startTest(test)
        self._add(test, "tests")

    def addSkip(self, test: unittest.TestCase, reason: str) -> None:
        super().addSkip(test, reason)
        self.files[file_of(self.start, test)]["tests"] -= 1
        self._add(test, "skipped")

    def addExpectedFailure(self, test: unittest.TestCase, err: Any) -> None:
        super().addExpectedFailure(test, err)
        self._add(test, "todo")

    def addUnexpectedSuccess(self, test: unittest.TestCase) -> None:
        super().addUnexpectedSuccess(test)
        self._add(test, "todo")

    def addFailure(self, test: unittest.TestCase, err: Any) -> None:
        super().addFailure(test, err)
        self._add(test, "failed")

    def addError(self, test: unittest.TestCase, err: Any) -> None:
        super().addError(test, err)
        self._add(test, "failed")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: count.py FOLDER REPORT.json", file=sys.stderr)
        return 2
    start, report = Path(argv[0]), Path(argv[1])
    # As ``python -m unittest`` has it: the working folder first, not this file's.
    sys.path[0] = str(Path.cwd())
    Counted.start = start
    suite = unittest.defaultTestLoader.discover(str(start))
    result = unittest.TextTestRunner(verbosity=2, resultclass=Counted).run(suite)
    assert isinstance(result, Counted)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"files": dict(sorted(result.files.items()))}, indent=1), "utf-8")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
