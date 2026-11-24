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
from support import (
    ALICE,
    BOB,
    CONFIG,
    DIGEST,
    NOW,
    REPO,
    SENTENCE,
    VECTORS,
    comment_record,
    config_with,
    coverage_record,
    dump,
    individual,
    signin_record,
)

COVERAGE_PATH = f"coverage/{REPO}/7.json"


def without(record: dict[str, Any], key: str) -> dict[str, Any]:
    return {k: v for k, v in record.items() if k != key}


def _nothing(*_: object) -> None:
    """An assertion that checks nothing (planted)."""


class Individual(unittest.TestCase):
    """What no schema can say of a signature: its path, its version's flow and its times."""

    def check(self, record: Any, path: str = individual(1), config: Any = CONFIG) -> str | None:
        return cla.check_record(config, path, dump(record))

    def test_the_path_names_the_account(self) -> None:
        longest = 10**15
        _nothing(self.check(comment_record(longest), individual(longest)))
        _nothing(self.check(comment_record(2), individual(2)))
        for path in (
            individual(2),
            "signatures/individual/1.txt",
            "signatures/individual/1xjson",
            "signatures/individual/01.json",
            "signatures/individual/x/1.json",
            "signatures/entity/1.json",
            "signatures/individual/" + "1" * 5000 + ".json",
        ):
            with self.subTest(path):
                _nothing(self.check(comment_record(1), path), "the record does not match its path")

    def test_a_number_too_long_for_an_account(self) -> None:
        record = comment_record(10**16)
        _nothing(self.check(record, individual(10**16)), "the record does not match its path")

    def test_the_address_of_a_pull_request(self) -> None:
        for url, good in (
            ("https://github.com/a/b/pull/7", True),
            (f"https://github.com/{'a' * 39}/{'b' * 100}/pull/{'9' * 10}", True),
            ("https://github.com/A-9/b.C_-9/pull/1", True),
            (f"https://github.com/{'a' * 40}/b/pull/7", False),
            (f"https://github.com/a/{'b' * 101}/pull/7", False),
            (f"https://github.com/a/b/pull/{'9' * 11}", False),
            ("https://github.com//b/pull/7", False),
            ("https://github.com/a//pull/7", False),
            ("https://github.com/a/b/pull/0", False),
            ("https://github.com/a/b/pull/", False),
            ("https://github.com/a/b/pull/7/files", False),
            ("https://githubxcom/a/b/pull/7", False),
            ("http://github.com/a/b/pull/7", False),
            ("https://github.com.example.org/a/b/pull/7", False),
            ("https://github.com/a/b/issues/7", False),
            ("https://github.com/a/b/pull/7\n", False),
            ("", False),
        ):
            with self.subTest(url):
                problem = None if good else "malformed record"
                record = comment_record(1)
                record["evidence"] |= {"pr_url": url, "comment_url": f"{url}#issuecomment-5001"}
                _nothing(self.check(record), problem)
                _nothing(self.check(signin_record(1, {"context_pr_url": url})), problem)

    def test_the_largest_number_the_worker_reads(self) -> None:
        for run, good in ((2**53 - 1, True), (2**53, False)):
            record = comment_record(1, recorder_run_id=run)
            _nothing(self.check(record), None if good else "malformed record")

    def test_a_comment_posted_through_the_app_is_not_of_a_sign_in_version(self) -> None:
        for method, problem in (("comment", None), ("web", "malformed record")):
            record = comment_record(1, version=2, method=method)
            _nothing(self.check(record), problem)
        config = config_with()
        del config["versions"]["1"]["flow"]  # a version of before there were flows
        _nothing(self.check(comment_record(1), config=config))

    def test_a_sign_in_is_of_a_sign_in_version_and_its_sentence(self) -> None:
        v1: dict[str, Any] = {
            "version": 1,
            "set_sha256": DIGEST,
            "sentence_sha256": cla.sha256(SENTENCE),
        }
        _nothing(self.check(signin_record(1, **v1)), "malformed record")
        config = config_with()
        config["versions"]["1"]["flow"] = "signin"
        _nothing(self.check(signin_record(1, **v1), config=config))
        config["versions"]["1"]["sentence"] += "x"
        _nothing(self.check(signin_record(1, **v1), config=config), "malformed record")

    def test_the_agreement_is_that_of_the_registry(self) -> None:
        config = config_with(agreement="another")
        for record in (comment_record(1), signin_record(1)):
            _nothing(self.check(record, config=config), "malformed record")

    def test_the_times_of_a_sign_in_are_in_order_to_the_second(self) -> None:
        wrong = "the authorization, acceptance and recording times are out of order"
        for authorized, accepted, recorded, problem in (
            ("10:00:00", "10:00:00", "10:00:00", None),
            ("10:01:00", "10:00:00", "10:00:00", None),
            ("10:01:01", "10:00:00", "10:00:00", wrong),
            ("10:00:00", "12:00:00", "12:00:00", None),
            ("10:00:00", "12:00:01", "12:00:01", wrong),
            ("10:00:00", "10:01:00", "10:00:00", None),
            ("10:00:00", "10:01:01", "10:00:00", wrong),
            ("10:00:00", "10:00:00", "23:59:59", None),
        ):
            with self.subTest(authorized=authorized, accepted=accepted, recorded=recorded):
                record = signin_record(
                    1,
                    {"authorized_at": f"2026-12-01T{authorized}Z"},
                    accepted_at=f"2026-12-01T{accepted}Z",
                    recorded_at=f"2026-12-01T{recorded}Z",
                )
                _nothing(self.check(record), problem)

    def test_a_file_that_holds_no_object(self) -> None:
        for content in (b"", b"[]", b"null", b"1", b"\xff", b"[" * 100_000):
            for path in (individual(1), COVERAGE_PATH):
                _nothing(cla.check_record(CONFIG, path, content), "not a JSON object")

    def test_the_schema_of_each_kind_is_a_whole_number_and_its_own(self) -> None:
        """JavaScript reads 2.0 as 2, so no vector it shares can tell them apart."""
        comment, signin = comment_record(1), signin_record(1)
        of_signin = "unexpected or missing fields ['recorder_commit', 'sentence_sha256']"
        for record, schema, problem in (
            (comment, 1.0, "malformed record"),
            (comment, True, "malformed record"),
            (comment, 2.0, "malformed record"),
            (signin, 2.0, of_signin),
            (signin, 1.0, of_signin),
            (signin, True, of_signin),
            (signin, "2", of_signin),
        ):
            with self.subTest(method=record["method"], schema=schema):
                content = dump({**record, "schema": schema})
                self.assertIn(f'"schema": {json.dumps(schema)}'.encode(), content)
                _nothing(cla.check_record(CONFIG, individual(1), content), problem)

    def test_a_number_with_a_point_is_no_number_of_a_record(self) -> None:
        for key, problem in (
            ("github_id", "the record does not match its path"),
            ("version", "the version or digest is not a published one"),
            ("recorder_run_id", "malformed record"),
        ):
            for record in (comment_record(1), signin_record(1)):
                with self.subTest(key, method=record["method"]):
                    _nothing(self.check({**record, key: float(record[key])}), problem)
        record = comment_record(1)
        record["evidence"]["comment_id"] = 5001.0
        _nothing(self.check(record), "malformed record")


class CoverageRecord(unittest.TestCase):
    def check(self, record: dict[str, Any]) -> str | None:
        return cla.check_record(CONFIG, COVERAGE_PATH, dump(record))

    def test_what_the_recorder_writes_is_valid(self) -> None:
        for record in (
            coverage_record(),
            coverage_record(github_ids=[], versions={}),
            coverage_record(github_ids=[ALICE, BOB], versions={str(ALICE): 1, str(BOB): 2}),
        ):
            _nothing(self.check(record))

    def test_it_holds_every_field_and_no_other(self) -> None:
        for key in coverage_record():
            if key in ("kind", "repo", "pr"):
                expected = "the coverage record does not match its path"
            else:
                expected = f"unexpected or missing fields ['{key}']"
            with self.subTest(missing=key):
                _nothing(self.check(without(coverage_record(), key)), expected)
        _nothing(
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
                _nothing(
                    self.check(coverage_record(**over)),
                    "the coverage record does not match its path",
                )

    def test_every_field_is_of_its_form(self) -> None:
        cases: tuple[dict[str, Any], ...] = (
            {"schema": 2},
            {"schema": True},
            {"schema": 1.0},
            {"merge_sha": "d" * 39},
            {"merge_sha": "D" * 40},
            {"merge_sha": None},
            {"merged_at": "2026-12-01"},
            {"merged_at": 1},
            {"recorded_at": "yesterday"},
            {"recorder_run_id": 0},
            {"recorder_run_id": "1"},
            {"recorder_run_id": 1.0},
            {"github_ids": None},
            {"github_ids": {}},
            {"github_ids": [0], "versions": {"0": 1}},
            {"github_ids": [str(ALICE)]},
            {"github_ids": [True], "versions": {"True": 1}},
            {"github_ids": [float(ALICE)], "versions": {str(float(ALICE)): 1}},
            {"github_ids": [ALICE, ALICE]},
            {"github_ids": [{}]},
            {"versions": None},
            {"versions": []},
            {"versions": {}},
            {"versions": {str(ALICE): 1, str(BOB): 1}},
            {"versions": {str(BOB): 1}},
            {"versions": {str(ALICE): 0}},
            {"versions": {str(ALICE): "1"}},
            {"versions": {str(ALICE): 1.0}},
            {"github_ids": [2**53], "versions": {str(2**53): 1}},
        )
        for over in cases:
            with self.subTest(over):
                _nothing(self.check(coverage_record(**over)), "malformed record")


class Vectors(unittest.TestCase):
    """tests/vectors/records.json, which the Worker's tests read too."""

    def vectors(self) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = json.loads((VECTORS / "records.json").read_text("utf-8"))[
            "vectors"
        ]
        self.assertGreater(len(found), 600)
        return found

    def test_the_committed_vectors_are_what_the_schemas_and_the_verifier_give(self) -> None:
        _nothing(
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
