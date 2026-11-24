# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Whether a record is valid: every field, alone, as registry/schema/ defines it."""

from __future__ import annotations

import datetime as dt
import json
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import make_vectors
from support import ALICE, BOB, CONFIG, NOW, REPO, VECTORS, coverage_record, dump

COVERAGE_PATH = f"coverage/{REPO}/7.json"


def without(record: dict[str, Any], key: str) -> dict[str, Any]:
    return {k: v for k, v in record.items() if k != key}


class CoverageRecord(unittest.TestCase):
    def check(self, record: dict[str, Any]) -> str | None:
        return cla.check_record(CONFIG, COVERAGE_PATH, dump(record))

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


class Vectors(unittest.TestCase):
    """tests/vectors/records.json, which the Worker's tests read too."""

    def vectors(self) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = json.loads((VECTORS / "records.json").read_text("utf-8"))[
            "vectors"
        ]
        self.assertGreater(len(found), 600)
        return found

    def test_the_committed_vectors_are_what_the_schemas_and_the_verifier_give(self) -> None:
        self.assertEqual(
            (VECTORS / "records.json").read_text("utf-8").splitlines(),
            make_vectors.document().splitlines(),
            "run registry/tests/make_vectors.py",
        )

    def test_a_record_the_schema_refuses_does_not_verify(self) -> None:
        self.assertEqual(
            [v["name"] for v in self.vectors() if not v["shape"] and v["problem"] is None], []
        )


class Times(unittest.TestCase):
    """A time that does not exist is no time, whatever the schema's pattern says."""

    def test_a_record_time_is_whole_seconds_in_utc_of_a_day_that_exists(self) -> None:
        self.assertEqual(cla.record_time("2026-12-01T10:22:58Z"), NOW.replace(minute=22, second=58))
        self.assertEqual(
            cla.record_time("2028-02-29T23:59:59Z"),
            dt.datetime(2028, 2, 29, 23, 59, 59, tzinfo=dt.UTC),
        )
        self.assertEqual(
            cla.record_time("0999-01-01T00:00:00Z"), dt.datetime(999, 1, 1, tzinfo=dt.UTC)
        )
        for text in (
            None,
            1,
            "",
            "2026-12-01",
            "2026-12-01T10:22:58",
            "2026-12-01T10:22:58Z\n",
            "2026-12-01 10:22:58Z",
            "2026-12-01T10:22:58.5Z",
            "2026-12-01T10:22:58+00:00",
            "2026-12-01T12:22:58+02:00",
            "20261201T102258Z",
            "2026-W49-2T10:22:58Z",
            "2026-12-01T24:00:00Z",
            "2026-12-01T10:22:60Z",
            "2026-02-29T10:22:58Z",
            "9999-99-99T99:99:99Z",
            "\u0662026-12-01T10:22:58Z",
        ):
            with self.subTest(text):
                self.assertIsNone(cla.record_time(text))


if __name__ == "__main__":
    unittest.main()
