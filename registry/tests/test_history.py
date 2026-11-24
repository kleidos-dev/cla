# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The verifier over whole histories of the signatures branch, and what each commit may do."""

from __future__ import annotations

import sys
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import (
    BAD_GATEWAY,
    CONFIG,
    CONFIG_V2,
    OTHER_CLIENT_ID,
    OWNER,
    RECORDER,
    REGISTRY,
    REPO,
    SENTENCE,
    SIGNIN_CLIENT_ID,
    FakeGitHub,
    FakeWitness,
    RegisterTest,
    comment_record,
    config_with,
    coverage_record,
    dump,
    fake_verify_tsr,
    github,
    individual,
    ok,
    signin_record,
    token_for,
)
from test_timestamps import PINNED


class Shape(unittest.TestCase):
    """What a recorder commit may change: one record, or one signature and its token."""

    JSON, TSR = individual(1), individual(1, "tsr")
    COVERAGE = "coverage/kleidos-dev/cla/7.json"

    def test_one_record_added_or_changed(self) -> None:
        for path in (self.JSON, self.COVERAGE):
            for status in "AM":
                self.assertIsNone(cla.change_shape([(status, path)]))

    def test_one_signature_and_its_token(self) -> None:
        for changes in (
            [("A", self.TSR)],
            [("A", self.JSON), ("A", self.TSR)],
            [("M", self.JSON), ("A", self.TSR)],
            [("M", self.JSON), ("M", self.TSR)],
            [("M", self.JSON), ("D", self.TSR)],
        ):
            with self.subTest(changes):
                self.assertIsNone(cla.change_shape(changes))
                self.assertIsNone(cla.change_shape(changes[::-1]))

    def test_nothing(self) -> None:
        self.assertEqual(cla.change_shape([]), "changes nothing")

    def test_a_record_deleted(self) -> None:
        for path in (self.JSON, self.COVERAGE):
            self.assertEqual(
                cla.change_shape([("D", path)]),
                f"D {path}: only adding or changing one record is allowed",
            )

    def test_a_token_changed_or_deleted_alone(self) -> None:
        for status in "MD":
            self.assertEqual(
                cla.change_shape([(status, self.TSR)]),
                f"{status} {self.TSR}: a token is only ever added, or replaced with its record",
            )

    def test_a_record_and_a_token_that_do_not_go_together(self) -> None:
        for record, token in (("A", "M"), ("A", "D"), ("D", "A"), ("D", "M"), ("D", "D")):
            with self.subTest(record=record, token=token):
                self.assertEqual(
                    cla.change_shape([(record, self.JSON), (token, self.TSR)]),
                    f"record {record} with token {token}: not a record written with its token",
                )

    def test_more_than_one_record(self) -> None:
        for paths in (
            [individual(1), individual(2)],
            [individual(1, "tsr"), individual(2, "tsr")],
            [individual(1), individual(2, "tsr")],
            [self.COVERAGE, "coverage/kleidos-dev/cla/8.json"],
            [individual(1), individual(1, "tsr"), self.COVERAGE],
        ):
            with self.subTest(paths):
                self.assertEqual(
                    cla.change_shape([("A", p) for p in paths]),
                    f"changes {len(paths)} files, not one record (and its token)",
                )

    def test_a_signature_and_a_coverage_record(self) -> None:
        for path, said in (
            (individual(1), "record A with token None"),
            (individual(1, "tsr"), "record None with token A"),
        ):
            self.assertEqual(
                cla.change_shape([("A", path), ("A", self.COVERAGE)]),
                f"{said}: not a record written with its token",
            )

    def test_any_other_status(self) -> None:
        for status in ("T", "R100", "C75", "U", "X", "B"):
            self.assertEqual(
                cla.change_shape([(status, self.JSON)]),
                f"{status} {self.JSON}: only adding or changing one record (and its token) "
                "is allowed",
            )

    def test_any_other_path(self) -> None:
        other = "only adding or changing one record (and its token) is allowed"
        for path in (
            "README.md",
            "signatures/individual/0.json",
            "signatures/individual/01.json",
            "signatures/individual/x.json",
            "signatures/individual/1.txt",
            "signatures/individual/1.json.bak",
            "signatures/individual/1xjson",
            "signatures/individual/1.json\n",
            "signatures/individual/\u0661.json",
            "signatures/individual/" + "1" * 17 + ".json",
            "signatures/individual/a/1.json",
            "signatures/entity/1.json",
            "x/signatures/individual/1.json",
            '"signatures/individual/1.json"',
            "coverage/kleidos-dev/cla/7.tsr",
            "coverage/kleidos-dev/cla/0.json",
            "coverage/kleidos-dev/cla/07.json",
            "coverage/kleidos-dev/cla/7xjson",
            "coverage/kleidos-dev/cla/" + "1" * 11 + ".json",
            "coverage/kleidos-dev/7.json",
            "coverage/kleidos-dev/cla/x/7.json",
            "coverage/" + "a" * 40 + "/cla/7.json",
            "coverage/a/" + "b" * 101 + "/7.json",
            "coverage/a.b/cla/7.json",
            "coverage/a/b c/7.json",
            "coverage//cla/7.json",
            "coverage/a//7.json",
            "x/coverage/kleidos-dev/cla/7.json",
        ):
            with self.subTest(path):
                self.assertEqual(cla.change_shape([("A", path)]), f"A {path}: {other}")
                self.assertEqual(
                    cla.change_shape([("A", individual(1)), ("A", path)]), f"A {path}: {other}"
                )

    def test_the_longest_paths(self) -> None:
        for path in (
            "signatures/individual/" + "9" * 16 + ".json",
            "signatures/individual/" + "9" * 16 + ".tsr",
            "coverage/" + "a" * 39 + "/" + "B.c_-" * 20 + "/" + "9" * 10 + ".json",
            "coverage/a/b/1.json",
        ):
            self.assertIsNone(cla.change_shape([("A", path)]))


class WhoMade(unittest.TestCase):
    """Each fact of a commit alone decides: GitHub says them all, git's metadata says none."""

    def test_the_recorder(self) -> None:
        self.assertIs(cla.by_recorder(RECORDER), True)
        self.assertIs(cla.by_recorder(replace(RECORDER, committer_id=5)), True)
        for over in (
            {"author_id": 666},
            {"author_id": None},
            {"author_id": cla.OWNER_ID},
            {"signature_valid": False},
            {"signed_by_github": False},
            {"committer_email": "x@example.org"},
            {"committer_email": "evil-noreply@github.com"},
            {"committer_email": "noreply@github.com.example.org"},
            {"committer_email": ""},
        ):
            with self.subTest(over):
                changed: dict[str, Any] = over
                self.assertIs(cla.by_recorder(replace(RECORDER, **changed)), False)

    def test_the_owner(self) -> None:
        for facts in (
            OWNER,
            replace(OWNER, signed_by_github=True),
            replace(OWNER, committer_id=None, signed_by_github=True),
        ):
            self.assertIs(cla.by_owner(facts), True)
        for over in (
            {"author_id": 666},
            {"author_id": None},
            {"author_id": cla.ACTIONS_BOT_ID},
            {"signature_valid": False},
            {"committer_id": 666},
            {"committer_id": None},
        ):
            with self.subTest(over):
                changed: dict[str, Any] = over
                self.assertIs(cla.by_owner(replace(OWNER, **changed)), False)


class CrossCheck(unittest.TestCase):
    """The evidence a record cites, read again."""

    def setUp(self) -> None:
        self.witness = FakeWitness()

    def check(
        self, record: dict[str, Any], config: Any = CONFIG_V2, genuine: bool = True
    ) -> str | None:
        if genuine and cla._pos_int(record["recorder_run_id"]):
            found = FakeWitness()
            found.genuine(record)
            found.comments |= self.witness.comments
            found.runs |= self.witness.runs
            found.asked = self.witness.asked
            self.witness = found
        return cla.cross_check(config, REGISTRY, record, self.witness)

    def test_a_genuine_record_of_each_kind(self) -> None:
        for record, asked in (
            (comment_record(1), ["comment 5001", "run 1001"]),
            (signin_record(1), ["run 1001"]),
            (coverage_record(), ["run 2007"]),
        ):
            self.witness = FakeWitness()
            with self.subTest(record["kind"], schema=record["schema"]):
                self.assertIsNone(self.check(record))
                self.assertEqual(self.witness.asked, asked)

    def test_a_run_is_named_as_the_recorders_workflow_names_it(self) -> None:
        for record, title in (
            (comment_record(1), f"Record sign {REPO}#7 5001"),
            (signin_record(1), f"Record signin {REPO}#7 1"),
            (coverage_record(8), f"Record coverage {REPO}#8"),
        ):
            with self.subTest(title):
                self.witness = FakeWitness()
                self.witness.genuine(record)
                run = self.witness.runs[record["recorder_run_id"]] or {}
                self.assertEqual(run["display_title"].rstrip(), title)
                self.witness.spoil_run(record["recorder_run_id"], display_title=title)
                self.assertIsNone(self.check(record, genuine=False))

    def test_the_text_of_a_comment_is_hashed_as_it_was_written(self) -> None:
        body = f"  {SENTENCE.replace(' ', chr(10), 1)}\n\n"
        record = comment_record(1)
        record["evidence"]["comment_body_sha256"] = cla.sha256(body)
        self.witness.genuine(record, body)
        self.assertIsNone(self.check(record, genuine=False))
        self.witness.genuine(record, SENTENCE)
        self.assertEqual(
            self.check(record, genuine=False),
            "the comment's text does not hash to comment_body_sha256",
        )

    def test_a_record_with_no_run(self) -> None:
        for value in cast("tuple[Any, ...]", (None, 0, -1, "1", True, 1.0)):
            with self.subTest(value):
                self.assertEqual(
                    self.check(comment_record(1, recorder_run_id=value)), "no recorder run id"
                )
        record = coverage_record()
        del record["recorder_run_id"]
        self.assertEqual(
            cla.cross_check(CONFIG, REGISTRY, record, self.witness),
            "no recorder run id",
        )
        self.assertEqual(self.witness.asked, [])

    def test_an_address_that_is_no_pull_request(self) -> None:
        for url in ("", "https://example.org/a/b/pull/7", f"https://github.com/{REPO}/pull/7\n"):
            comment, signin = comment_record(1), signin_record(1)
            comment["evidence"]["pr_url"] = signin["evidence"]["context_pr_url"] = url
            self.assertEqual(
                self.check(comment, genuine=False),
                "the evidence's pr_url is not a pull request address",
            )
            self.assertEqual(
                self.check(signin, genuine=False),
                "the evidence's context_pr_url is not a pull request address",
            )

    def test_a_comment_that_does_not_vouch_for_the_record(self) -> None:
        for change, problem in (
            (None, "the acceptance comment 5001 cannot be read"),
            ({"author_id": 2}, "the acceptance comment was written by another account"),
            ({"author_id": None}, "the acceptance comment was written by another account"),
            ({"edited": True}, "the acceptance comment was edited"),
            (
                {"created_at": "2026-12-01T10:22:32Z"},
                "accepted_at is not the comment's creation time",
            ),
            (
                {"body": SENTENCE + " x"},
                "the comment's text does not hash to comment_body_sha256",
            ),
            ({"pr": 8}, "the comment is not on the pull request the record names"),
            ({"repo": "a/b"}, "the comment is not on the pull request the record names"),
        ):
            with self.subTest(problem):
                self.witness = FakeWitness()
                record = comment_record(1)
                self.witness.genuine(record)
                if change is None:
                    self.witness.comments.clear()
                else:
                    self.witness.spoil_comment(5001, **cast("dict[str, Any]", change))
                self.assertEqual(self.check(record, genuine=False), problem)
                self.assertEqual(self.witness.asked, ["comment 5001"])

    def test_a_run_that_does_not_vouch_for_the_record(self) -> None:
        elsewhere = f"run 1001 is not .github/workflows/record.yml dispatched on main of {REGISTRY}"
        other = "run 1001 recorded something else"
        for over, problem in (
            ({"repository": {"full_name": "mallory/cla"}}, elsewhere),
            ({"repository": None}, elsewhere),
            ({"path": ".github/workflows/ci.yml"}, elsewhere),
            ({"path": None}, elsewhere),
            ({"event": "push"}, elsewhere),
            ({"head_branch": "evil"}, elsewhere),
            ({"display_title": f"Record sign {REPO}#7 5002"}, other),
            ({"display_title": f"Record sign {REPO}#7 1"}, other),
            ({"display_title": f"Record sign {REPO}#8 5001"}, other),
            ({"display_title": "Record sign a/b#7 5001"}, other),
            ({"display_title": f"Record signin {REPO}#7 5001"}, other),
            ({"display_title": f"Record coverage {REPO}#7"}, other),
            ({"display_title": ""}, other),
            ({"display_title": None}, other),
            ({"conclusion": "failure"}, "run 1001 did not succeed"),
            ({"conclusion": None}, "run 1001 did not succeed"),
        ):
            with self.subTest(over):
                record = comment_record(1)
                self.witness = FakeWitness()
                self.witness.genuine(record)
                self.witness.spoil_run(1001, **cast("dict[str, Any]", over))
                self.assertEqual(self.check(record, genuine=False), problem)
        for key in ("repository", "path", "event", "head_branch", "display_title", "conclusion"):
            with self.subTest(missing=key):
                record = comment_record(1)
                self.witness = FakeWitness()
                self.witness.genuine(record)
                del (self.witness.runs[1001] or {})[key]
                self.assertIsNotNone(self.check(record, genuine=False))
        self.witness = FakeWitness()
        self.witness.genuine(comment_record(1))
        self.witness.runs.clear()
        self.assertEqual(
            self.check(comment_record(1), genuine=False),
            f"recorder run 1001 is not a run of {REGISTRY}",
        )

    def test_blanks_do_not_change_a_run_name(self) -> None:
        self.witness.genuine(comment_record(1))
        self.witness.spoil_run(1001, display_title=f"  Record  sign {REPO}#7 5001\n")
        self.assertIsNone(self.check(comment_record(1), genuine=False))

    def test_a_run_that_has_not_ended_is_waited_for(self) -> None:
        for status in ("in_progress", "queued", None):
            self.witness.genuine(comment_record(1))
            self.witness.spoil_run(1001, status=status, conclusion=None)
            with self.assertRaises(cla.Pending) as caught:
                self.check(comment_record(1), genuine=False)
            self.assertEqual(caught.exception.args, (1001,))

    def test_a_sign_in_names_the_commit_its_run_ran(self) -> None:
        record = signin_record(1)
        for over, problem in (
            ({"head_sha": "d" * 40}, "run 1001 did not run the commit the record names"),
            ({"head_sha": None}, "run 1001 did not run the commit the record names"),
            ({"display_title": f"Record signin {REPO}#7 2"}, "run 1001 recorded something else"),
            ({"display_title": f"Record sign {REPO}#7 1"}, "run 1001 recorded something else"),
            ({"display_title": f"Record signin {REPO}#8 1"}, "run 1001 recorded something else"),
        ):
            with self.subTest(over):
                self.witness = FakeWitness()
                self.witness.genuine(record)
                self.witness.spoil_run(1001, **cast("dict[str, Any]", over))
                self.assertEqual(self.check(record, genuine=False), problem)

    def test_a_signature_by_comment_names_no_commit(self) -> None:
        for record in (comment_record(1), coverage_record()):
            self.witness = FakeWitness()
            self.witness.genuine(record)
            self.witness.spoil_run(record["recorder_run_id"], head_sha=None)
            self.assertIsNone(self.check(record, genuine=False))

    def test_a_sign_in_through_the_app_of_then_or_of_now(self) -> None:
        record = signin_record(1)
        unknown = "signed in through an app registry/config.json does not name"
        for current, retired, problem in (
            (SIGNIN_CLIENT_ID, [], None),
            (OTHER_CLIENT_ID, [SIGNIN_CLIENT_ID], None),
            (OTHER_CLIENT_ID, [], unknown),
            (OTHER_CLIENT_ID, ["Iv23liSOMEOTHERAPP02"], unknown),
            (None, [], unknown),
            (None, [None, 5], unknown),
        ):
            with self.subTest(current=current, retired=retired):
                config = config_with(
                    CONFIG_V2, signin_client_id=current, retired_signin_client_ids=retired
                )
                self.assertEqual(self.check(record, config), problem)
        config = config_with(CONFIG_V2)
        del config["retired_signin_client_ids"], config["signin_client_id"]
        self.assertEqual(self.check(record, config), unknown)

    def test_the_ids_of_the_sign_in_apps(self) -> None:
        for config, ids in (
            ({}, set()),
            ({"signin_client_id": "a"}, {"a"}),
            ({"signin_client_id": None, "retired_signin_client_ids": ["b", 5, None]}, {"b"}),
            ({"signin_client_id": "a", "retired_signin_client_ids": ["a", "b"]}, {"a", "b"}),
        ):
            self.assertEqual(cla.signin_client_ids(cast("dict[str, Any]", config)), ids)


class Histories(RegisterTest):
    """The whole history, finding by finding."""

    def test_a_clean_history_of_every_kind_of_commit(self) -> None:
        history = self.history()
        history.config = CONFIG_V2
        with mock.patch.object(cla, "verify_tsr", fake_verify_tsr):
            history.record(comment_record(1))
            history.record(coverage_record())
            both = signin_record(2)
            history.witness.genuine(both)
            history.add(
                "sign",
                {individual(2): dump(both), individual(2, "tsr"): token_for(dump(both))},
            )
            later = signin_record(3)
            history.record(later)
            history.add("stamp: 3", {individual(3, "tsr"): token_for(dump(later))})
            again = signin_record(1, recorder_run_id=1901)
            history.record(again)
            last = history.add(
                "redact: 2", {individual(2): None, individual(2, "tsr"): None}, OWNER
            )
            verified = history.verify()
        self.assertEqual(verified, cla.Verified([], history.sha(last)))

    def test_a_register_with_nothing_in_it(self) -> None:
        history = self.history()
        self.assertEqual(history.verify(), cla.Verified([], None))

    def test_the_first_commit_is_the_owners_to_make(self) -> None:
        """It is the root the branch was started with, and no commit fact is asked for it."""
        history = self.history()
        history.build()
        asked: list[str] = []

        def info(sha: str) -> cla.Facts | None:
            asked.append(sha)
            return None

        ref = "refs/heads/signatures"
        found = cla.verify_history(history.root, CONFIG, ref, None, info)
        self.assertEqual((found, asked), (cla.Verified([], None), []))

    def test_a_version_no_longer_accepted_still_verifies(self) -> None:
        history = self.history()
        history.config = config_with(CONFIG_V2, accepted_versions=[2])
        history.record(comment_record(1))
        self.assertEqual(history.found(), [])

    def test_a_commit_nobody_of_the_recorder_made(self) -> None:
        for facts in (
            cla.Facts(666, 666, "m@example.org", True, False),
            replace(RECORDER, signed_by_github=False),
            OWNER,
        ):
            history = self.history()
            bad = history.record(comment_record(1), facts=facts, author="mal'lory")
            self.assertEqual(
                history.found(),
                [
                    (
                        bad,
                        'made by "mal\'lory", not by the recorder '
                        "(author, committer or GitHub's signature)",
                    )
                ],
            )

    def test_a_commit_github_does_not_know(self) -> None:
        history = self.history()
        bad = history.record(comment_record(1), facts=None)
        self.assertEqual(history.found(), [(bad, "GitHub does not know this commit on the branch")])
        self.assertEqual(history.witness.asked, [])

    def test_a_merge_commit(self) -> None:
        history = self.history()
        first = history.record(comment_record(1))
        history.record(comment_record(2))
        bad = history.add("merge", {individual(3): dump(comment_record(3))}, merges=first - 1)
        history.witness.genuine(comment_record(3))
        self.assertEqual(
            history.found(),
            [(bad, "a merge commit: the history must be linear"), (bad, "changes nothing")],
        )

    def test_a_commit_that_changes_nothing(self) -> None:
        history = self.history()
        bad = history.add("sign", {})
        self.assertEqual(history.found(), [(bad, "changes nothing")])

    def test_a_deletion_a_file_elsewhere_and_a_change_of_type(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        history.record(comment_record(2))
        deleted = history.add("drop", {individual(1): None})
        other = history.add("other", {"notes.txt": b"x"})
        link = history.add("link", {individual(2): ("120000", b"/etc/passwd")})
        self.assertEqual(
            history.found(),
            [
                (deleted, f"D {individual(1)}: only adding or changing one record is allowed"),
                (
                    other,
                    "A notes.txt: only adding or changing one record (and its token) is allowed",
                ),
                (
                    link,
                    f"T {individual(2)}: only adding or changing one record (and its token) "
                    "is allowed",
                ),
            ],
        )

    def test_a_path_git_quotes_is_shown_on_one_line(self) -> None:
        history = self.history()
        bad = history.add("sign", {"a\u00e9.json": b"x"})
        self.assertEqual(
            history.found(),
            [
                (
                    bad,
                    'A "a\\303\\251.json": only adding or changing one record (and its token) '
                    "is allowed",
                )
            ],
        )

    def test_every_record_of_a_commit_is_checked_though_its_shape_is_wrong(self) -> None:
        history = self.history()
        bad = history.add(
            "sign",
            {
                individual(1): dump(comment_record(1, agreement="x")),
                individual(2): dump(comment_record(2, set_sha256="0" * 64)),
                individual(3): dump(comment_record(4)),
                f"coverage/{REPO}/7.json": dump(coverage_record(8)),
            },
        )
        self.assertEqual(
            history.found(),
            [
                (bad, "changes 4 files, not one record (and its token)"),
                (
                    bad,
                    f"coverage/{REPO}/7.json: the coverage record does not match its path",
                ),
                (bad, f"{individual(1)}: malformed record"),
                (bad, f"{individual(2)}: the version or digest is not a published one"),
                (bad, f"{individual(3)}: the record does not match its path"),
            ],
        )
        self.assertEqual(history.witness.asked, [])

    def test_a_record_changed_is_checked_as_it_then_was(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        bad = history.record(comment_record(1, method="x"))
        history.record(comment_record(1))
        self.assertEqual(history.found(), [(bad, f"{individual(1)}: malformed record")])

    def test_evidence_that_does_not_vouch_is_a_finding_of_its_record(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        bad = history.record(comment_record(2), genuine=False)
        history.record(comment_record(3))
        self.assertEqual(
            history.found(), [(bad, f"{individual(2)}: the acceptance comment 5002 cannot be read")]
        )
        self.assertIsNone(history.verify().checked_through)

    def test_the_records_are_checked_against_the_registry_of_the_call(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        history.build()
        args = (history.root, CONFIG, "refs/heads/signatures", None, history.info, history.witness)
        self.assertEqual(cla.verify_history(*args).findings, [])
        found = cla.verify_history(*args, "another/cla").findings
        self.assertEqual(
            [f.problem for f in found],
            [
                f"{individual(1)}: run 1001 is not .github/workflows/record.yml dispatched on "
                "main of another/cla"
            ],
        )

    def test_without_a_witness_nothing_is_read_again(self) -> None:
        history = self.history()
        last = history.record(comment_record(1), genuine=False)
        self.assertEqual(history.verify(witness=False), cla.Verified([], history.sha(last)))


class Since(RegisterTest):
    """What an earlier run checked is not read again, and a running recorder is waited for."""

    def test_only_the_records_after_it_are_read_again(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        since = history.record(comment_record(2), genuine=False)
        last = history.record(comment_record(3))
        self.assertEqual(history.verify(history.sha(since)), cla.Verified([], history.sha(last)))
        self.assertEqual(history.witness.asked, ["comment 5003", "run 1003"])

    def test_nothing_after_it_leaves_it_where_it_is(self) -> None:
        history = self.history()
        since = history.record(comment_record(1))
        self.assertEqual(history.verify(history.sha(since)), cla.Verified([], history.sha(since)))
        root = history.sha(0)
        self.assertEqual(
            history.verify(root).checked_through, history.sha(since), "the root is no record"
        )

    def test_the_shape_of_what_came_before_is_still_checked(self) -> None:
        history = self.history()
        bad = history.add("other", {"x.txt": b"x"})
        since = history.record(comment_record(1))
        history.record(comment_record(2))
        self.assertEqual(
            history.found(history.sha(since)),
            [(bad, "A x.txt: only adding or changing one record (and its token) is allowed")],
        )
        self.assertEqual(history.verify(history.sha(since)).checked_through, history.sha(since))

    def test_a_history_that_was_rewritten(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        problem = "the previous head is no longer in the history (rewritten?)"
        for since in ("1" * 40, "HEAD"):
            self.assertEqual(
                history.verify(since), cla.Verified([cla.Finding(since, problem)], None)
            )
        self.assertEqual(history.witness.asked, [])

    def test_the_check_stops_before_a_run_that_has_not_ended(self) -> None:
        history = self.history()
        first = history.record(comment_record(1))
        history.record(comment_record(2))
        history.record(comment_record(3))
        history.witness.spoil_run(1002, status="in_progress")
        self.assertEqual(history.verify(), cla.Verified([], history.sha(first)))
        self.assertEqual(
            history.witness.asked, ["comment 5001", "run 1001", "comment 5002", "run 1002"]
        )

    def test_a_problem_after_a_run_that_has_not_ended_is_still_found(self) -> None:
        history = self.history()
        since = history.record(comment_record(1))
        history.record(comment_record(2))
        history.witness.spoil_run(1002, status="queued")
        bad = history.add("other", {"x.txt": b"x"})
        self.assertEqual(
            history.found(history.sha(since)),
            [(bad, "A x.txt: only adding or changing one record (and its token) is allowed")],
        )
        self.assertEqual(history.verify(history.sha(since)).checked_through, history.sha(since))


class Owner(RegisterTest):
    """The owner's own commits delete records at their holders' request, and do nothing else."""

    def test_a_removal(self) -> None:
        for facts in (OWNER, replace(OWNER, committer_id=None, signed_by_github=True)):
            history = self.history()
            history.record(comment_record(1))
            history.record(coverage_record())
            last = history.add(
                "redact: 1", {individual(1): None, f"coverage/{REPO}/7.json": None}, facts
            )
            self.assertEqual(history.verify(), cla.Verified([], history.sha(last)))

    def test_a_removal_takes_the_token_with_the_record(self) -> None:
        with mock.patch.object(cla, "verify_tsr", fake_verify_tsr):
            history = self.history()
            record = comment_record(1)
            history.witness.genuine(record)
            history.add(
                "sign",
                {individual(1): dump(record), individual(1, "tsr"): token_for(dump(record))},
            )
            bad = history.add("redact: 1", {individual(1): None}, OWNER)
            self.assertEqual(
                history.found(), [(bad, f"{individual(1, 'tsr')}: a token with no record")]
            )

    def test_anything_else_under_redact_is_a_finding_each(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        history.add("redact: x", {individual(1): b"{}", individual(9): b"{}"}, OWNER)
        other = history.add("redact: x", {"README.md": None, "x.txt": b"x"}, OWNER)
        only = "a redact: commit only deletes records"
        self.assertEqual(
            history.found(),
            [
                (other - 1, f"M {individual(1)}: {only}"),
                (other - 1, f"A {individual(9)}: {only}"),
                (other, f"D README.md: {only}"),
                (other, f"A x.txt: {only}"),
            ],
        )

    def test_a_removal_under_another_subject_or_by_somebody_else(self) -> None:
        not_allowed = f"D {individual(1)}: only adding or changing one record is allowed"
        for subject, facts, name in (
            ("tidy up", OWNER, "jmrplens"),
            (" redact: 1", replace(OWNER, author_id=666), "jmrplens"),
            ("x redact: 1", OWNER, "jmrplens"),
            ("redact 1", OWNER, "jmrplens"),
            ("redaction: 1", OWNER, "jmrplens"),
            ("redacted at its holder's request", OWNER, "jmrplens"),
            ("redact: 1", replace(OWNER, signature_valid=False), "jmrplens"),
            ("redact: 1", replace(OWNER, committer_id=666), "jmrplens"),
            ("Redact: 1", OWNER, "jmrplens"),
        ):
            with self.subTest(subject, facts=facts):
                history = self.history()
                history.record(comment_record(1))
                bad = history.add(subject, {individual(1): None}, facts, author=name)
                self.assertEqual(
                    history.found(),
                    [
                        (
                            bad,
                            "made by 'jmrplens', not by the recorder "
                            "(author, committer or GitHub's signature)",
                        ),
                        (bad, not_allowed),
                    ],
                )

    def test_the_recorder_may_not_remove(self) -> None:
        history = self.history()
        history.record(comment_record(1))
        bad = history.add("redact: 1", {individual(1): None})
        self.assertEqual(
            history.found(),
            [(bad, f"D {individual(1)}: only adding or changing one record is allowed")],
        )


class Tokens(RegisterTest):
    """Every token on the branch verifies over its record as it is at that commit."""

    def setUp(self) -> None:
        super().setUp()
        patch = mock.patch.object(cla, "verify_tsr", fake_verify_tsr)
        patch.start()
        self.addCleanup(patch.stop)
        self.log = self.history()
        self.record = comment_record(1)
        self.log.witness.genuine(self.record)
        self.token = individual(1, "tsr")
        self.first = self.log.add(
            "sign",
            {individual(1): dump(self.record), self.token: token_for(dump(self.record))},
        )

    def test_a_token_left_behind_by_its_record(self) -> None:
        changed = comment_record(1, login_at_signing="alice2")
        bad = self.log.record(changed)
        self.assertEqual(
            self.log.found(), [(bad, f"{self.token}: the time-stamp token does not verify")]
        )

    def test_a_token_changed_alone_or_over_something_else(self) -> None:
        alone = self.log.add("stamp", {self.token: b"x"})
        self.assertEqual(
            self.log.found(),
            [
                (
                    alone,
                    f"M {self.token}: a token is only ever added, or replaced with its record",
                ),
                (alone, f"{self.token}: the time-stamp token does not verify"),
            ],
        )

    def test_a_token_with_no_record(self) -> None:
        bad = self.log.add("stamp", {individual(2, "tsr"): b"x"})
        self.assertEqual(
            self.log.found(), [(bad, f"{individual(2, 'tsr')}: a token with no record")]
        )

    def test_a_finding_of_a_token_stops_the_marker(self) -> None:
        self.log.add("stamp", {individual(2, "tsr"): b"x"})
        self.assertIsNone(self.log.verify().checked_through)

    def test_the_accounts_of_a_commit_are_checked_in_their_order(self) -> None:
        bad = self.log.add("stamp", {individual(n, "tsr"): b"x" for n in (3, 2)})
        self.assertEqual(
            self.log.found()[1:],
            [(bad, f"{individual(n, 'tsr')}: a token with no record") for n in (2, 3)],
        )

    def test_a_token_replaced_with_its_record(self) -> None:
        changed = comment_record(1, login_at_signing="alice2")
        self.log.witness.genuine(changed)
        last = self.log.add(
            "sign", {individual(1): dump(changed), self.token: token_for(dump(changed))}
        )
        self.assertEqual(self.log.verify(), cla.Verified([], self.log.sha(last)))


class TokenProblem(RegisterTest):
    def test_the_bytes_the_roots_and_the_kind_a_token_is_checked_with(self) -> None:
        history = self.history()
        at = history.add("x", {individual(1): b"{\r\n}", individual(1, "tsr"): b"\xff\r\n"})
        sha = history.sha(at)
        for qualified, config in (
            (True, CONFIG),
            (False, config_with(timestamping={"roots": []})),
            (False, config_with(timestamping=None)),
        ):
            with mock.patch.object(cla, "verify_tsr", return_value="why") as verify_tsr:
                self.assertEqual(cla.tsr_problem(history.root, config, sha, "1"), "why")
            verify_tsr.assert_called_once_with(
                b"\xff\r\n", cla.sha256(b"{\r\n}"), [PINNED] if qualified else [], qualified
            )

    def test_no_token_is_no_problem(self) -> None:
        history = self.history()
        at = history.record(comment_record(1))
        with mock.patch.object(cla, "verify_tsr") as verify_tsr:
            self.assertIsNone(cla.tsr_problem(history.root, CONFIG, history.sha(at), "1"))
            self.assertIsNone(cla.tsr_problem(history.root, CONFIG, history.sha(at), "2"))
        verify_tsr.assert_not_called()

    def test_a_root_that_is_not_pinned_stops_the_verifier(self) -> None:
        history = self.history()
        at = history.add("x", {individual(1): b"{}", individual(1, "tsr"): b"x"})
        config = config_with(timestamping={"roots": ["README.md"]})
        with self.fails("'README.md' is not a root pinned in registry/tsa/"):
            cla.tsr_problem(history.root, config, history.sha(at), "1")


class CoverageOfMerges(RegisterTest):
    """Every pull request merged in a served repository has its coverage file."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.config = config_with(served_repositories={REPO: {}})

    def verify(self, since: str = "2026-11-01", **kw: Any) -> list[str]:
        found = cla.verify_coverage(github(self.fake), self.config, REGISTRY, since, **kw)
        return [str(f) for f in found]

    def merged(self, *pulls: dict[str, Any]) -> None:
        self.fake.closed[REPO] = [
            {"merge_commit_sha": "d" * 40, "updated_at": "2026-12-01T00:00:00Z", **p} for p in pulls
        ]

    def test_one_with_its_file_and_one_without(self) -> None:
        self.fake.files[f"coverage/{REPO}/1.json"] = b"{}"
        self.merged(
            {"number": 1, "merged_at": "2026-11-02T00:00:00Z"},
            {"number": 2, "merged_at": "2026-11-03T00:00:00Z"},
            {"number": 3, "merged_at": None},
            {"number": 4},
        )
        self.assertEqual(
            self.verify(), [f"dddddddddddd: {REPO}#2 was merged with no coverage record"]
        )

    def test_the_day_it_begins_and_the_hour_it_waits(self) -> None:
        for merged, found in (
            ("2026-10-31T23:59:59Z", False),
            ("2026-11-01", True),
            ("2026-11-01T00:00:00Z", True),
            ("2026-12-01T09:23:02Z", True),  # an hour before the run
            ("2026-12-01T09:23:03Z", False),
        ):
            with self.subTest(merged):
                self.merged({"number": 1, "merged_at": merged})
                self.assertEqual(len(self.verify()), found)
        self.merged({"number": 1, "merged_at": "2026-12-01T10:23:02Z"})
        self.assertEqual(len(self.verify(settle_minutes=0)), 1)
        self.assertEqual(len(self.verify(settle_minutes=1)), 0)

    def test_a_merge_with_no_commit_is_found_too(self) -> None:
        self.merged({"number": 1, "merged_at": "2026-11-02T00:00:00Z", "merge_commit_sha": None})
        self.assertEqual(
            self.verify(), [f"000000000000: {REPO}#1 was merged with no coverage record"]
        )

    def test_every_served_repository(self) -> None:
        self.config["served_repositories"] = {REPO: {}, REGISTRY: {}}
        self.merged({"number": 1, "merged_at": "2026-11-02T00:00:00Z"})
        self.fake.closed[REGISTRY] = self.fake.closed[REPO]
        self.assertEqual(
            self.verify(),
            [f"dddddddddddd: {r}#1 was merged with no coverage record" for r in (REPO, REGISTRY)],
        )

    def test_the_pages_are_read_until_one_updated_before_the_day(self) -> None:
        old = {"number": 1, "merged_at": "2026-11-02T00:00:00Z"}
        idle: dict[str, Any] = {"number": 2}
        for updated in ("2026-11-01T00:00:00Z", "2026-11-01"):
            idle["updated_at"] = updated
            self.merged(*[idle] * 150, old)
            self.assertEqual(len(self.verify()), 1)
        before = {"number": 3, "updated_at": "2026-10-31T23:59:59Z"}
        self.merged(*[idle] * 99, before, *[idle] * 100, old)
        self.fake.calls.clear()
        self.assertEqual(self.verify(), [])
        self.assertEqual(self.fake.calls, [f"GET /repos/{REPO}/pulls"])

    def test_one_with_no_update_is_no_reason_to_stop(self) -> None:
        self.merged(
            {"number": 1, "updated_at": None}, {"number": 2, "merged_at": "2026-11-02T00:00:00Z"}
        )
        self.assertEqual(len(self.verify()), 1)

    def test_a_file_or_a_list_that_cannot_be_read_is_a_failure(self) -> None:
        self.merged({"number": 1, "merged_at": "2026-11-02T00:00:00Z"})
        self.fake.next(f"GET /repos/{REGISTRY}/contents/", BAD_GATEWAY)
        with self.fails(f"reading coverage/{REPO}/1.json answered 502"):
            self.verify()
        self.fake.next(f"GET /repos/{REPO}/pulls", ok({}))
        with self.fails(f"GET /repos/{REPO}/pulls answered no list of objects"):
            self.verify()


class HostileText(RegisterTest):
    """What anybody may write in a commit is text to the verifier, never a reason to stop."""

    def test_a_line_end_of_another_kind_in_a_subject_or_a_name(self) -> None:
        for end in "\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029\r":
            with self.subTest(f"U+{ord(end):04X}"):
                history = self.history()
                history.record(comment_record(1))
                bad = history.add(f"sign:{end}2", {"x.txt": b""}, author=f"a{end}b")
                history.record(comment_record(3))
                self.assertEqual(
                    history.found(),
                    [
                        (
                            bad,
                            "A x.txt: only adding or changing one record (and its token) "
                            "is allowed",
                        )
                    ],
                )

    def test_bytes_that_are_not_text_in_a_subject_or_a_name(self) -> None:
        history = self.history()
        bad = history.add(b"sign: \xff\xfe", {"x.txt": b""}, None, author=b"\xff")
        self.assertEqual(history.found(), [(bad, "GitHub does not know this commit on the branch")])

    def test_a_record_that_is_not_utf_8(self) -> None:
        history = self.history()
        bad = history.add("sign", {individual(1): b'{"kind": "\xff"}'})
        self.assertEqual(history.found(), [(bad, f"{individual(1)}: not a JSON object")])

    def test_a_record_of_another_json_kind_or_none(self) -> None:
        for content in (b"", b"[]", b"null", b"{", b"[" * 100_000, b"1" * 5000, b'"\\ud800"'):
            with self.subTest(content[:9]):
                history = self.history()
                bad = history.add("sign", {individual(1): content})
                self.assertEqual(history.found(), [(bad, f"{individual(1)}: not a JSON object")])

    def test_a_number_no_account_has_in_a_path(self) -> None:
        path = f"signatures/individual/{'9' * 5000}.json"
        history = self.history()
        bad = history.add("sign", {path: b"{}"})
        self.assertEqual(
            history.found(),
            [
                (
                    bad,
                    f"A {path}: only adding or changing one record (and its token) is allowed",
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
