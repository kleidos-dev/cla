# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Whether a record is valid: every field, alone, as registry/schema/ defines it."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import ALICE, BOB, CONFIG, REPO, coverage_record, dump

COVERAGE_PATH = f"coverage/{REPO}/7.json"


def without(record: dict[str, Any], key: str) -> dict[str, Any]:
    return {k: v for k, v in record.items() if k != key}


class CoverageRecord(unittest.TestCase):
    def check(self, record: dict[str, Any]) -> str | None:
        return cla.check_record(CONFIG, COVERAGE_PATH, dump(record).decode())

    def test_what_the_recorder_writes_is_valid(self) -> None:
        for record in (
            coverage_record(),
            coverage_record(github_ids=[], versions={}),
            coverage_record(github_ids=[ALICE, BOB], versions={str(ALICE): 1, str(BOB): 2}),
        ):
            self.assertIsNone(self.check(record))

    def test_it_holds_every_field_and_no_other(self) -> None:
        for key in coverage_record():
            if key in ("kind", "repo", "pr"):
                expected = "the coverage record does not match its path"
            else:
                expected = f"unexpected or missing fields ['{key}']"
            with self.subTest(missing=key):
                self.assertEqual(self.check(without(coverage_record(), key)), expected)
        self.assertEqual(
            self.check(coverage_record(ip="203.0.113.7")), "unexpected or missing fields ['ip']"
        )

    def test_it_is_of_the_pull_request_its_path_names(self) -> None:
        cases: tuple[dict[str, Any], ...] = (
            {"kind": "individual"},
            {"repo": "kleidos-dev/other"},
            {"repo": "other/cla-sandbox"},
            {"repo": None},
            {"pr": 8},
            {"pr": "7"},
            {"pr": 7.0},
        )
        for over in cases:
            with self.subTest(over):
                self.assertEqual(
                    self.check(coverage_record(**over)),
                    "the coverage record does not match its path",
                )

    def test_every_field_is_of_its_form(self) -> None:
        cases: tuple[dict[str, Any], ...] = (
            {"schema": 2},
            {"schema": True},
            {"merge_sha": "d" * 39},
            {"merge_sha": "D" * 40},
            {"merge_sha": None},
            {"merged_at": "2026-12-01"},
            {"merged_at": 1},
            {"recorded_at": "yesterday"},
            {"recorder_run_id": 0},
            {"recorder_run_id": "1"},
            {"github_ids": None},
            {"github_ids": {}},
            {"github_ids": [0], "versions": {"0": 1}},
            {"github_ids": [str(ALICE)]},
            {"github_ids": [True], "versions": {"True": 1}},
            {"github_ids": [ALICE, ALICE]},
            {"github_ids": [{}]},
            {"versions": None},
            {"versions": []},
            {"versions": {}},
            {"versions": {str(ALICE): 1, str(BOB): 1}},
            {"versions": {str(BOB): 1}},
            {"versions": {str(ALICE): 0}},
            {"versions": {str(ALICE): "1"}},
        )
        for over in cases:
            with self.subTest(over):
                self.assertEqual(self.check(coverage_record(**over)), "malformed record")


if __name__ == "__main__":
    unittest.main()
