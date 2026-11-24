# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""What the recorder writes, and what it refuses: signatures, sign-ins, removals and stamps."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import (
    ALICE,
    APP,
    BAD_GATEWAY,
    CONFIG_V2,
    REGISTRY,
    REPO,
    SITE_COMMIT,
    TOKEN,
    FakeGitHub,
    FakeStamper,
    RegisterTest,
    context,
    individual,
    ok,
    recorder_commit,
    redact_commit,
)
from test_timestamps import UNREACHABLE

DELETE = f"DELETE /applications/{APP.client_id}/grant"


def signin(
    fake: FakeGitHub,
    *,
    config: dict[str, Any] = CONFIG_V2,
    repo: str = REPO,
    pr: int = 7,
    gid: int = ALICE,
    version: int = 2,
    lang: str = "en",
    site_commit: str = SITE_COMMIT,
    token: str = TOKEN,
    app: cla.SigninApp = APP,
    stamper: cla.Stamper | None = None,
    commit: str = "f" * 40,
) -> str:
    """The record of a sign-in, as ``record --kind signin`` asks for it."""
    ctx = context(fake, config=config, stamper=stamper, commit=commit)
    return cla.record_signin(ctx, app, repo, pr, gid, version, lang, site_commit, token)


def ready() -> FakeGitHub:
    """A GitHub on which that sign-in is recorded."""
    fake = FakeGitHub()
    fake.add_signin()
    fake.pulls[7] = {"number": 7}
    return fake


class Grant(RegisterTest):
    """The grant that cannot be deleted changes nothing of what was recorded or refused."""

    def test_the_run_of_a_written_record_does_not_fail(self) -> None:
        for error in UNREACHABLE:
            with self.subTest(type(error).__name__):
                self.err.truncate(self.err.seek(0))
                fake = ready()
                fake.next(DELETE, error)
                self.assertEqual(signin(fake), f"recorded in {fake.head} (no time-stamp token yet)")
                self.assertEqual(list(fake.files), [individual(ALICE)])
                self.assertEqual(
                    self.err.getvalue(),
                    "sign-in grant not deleted: GitHub cannot be reached "
                    f"({type(error).__name__})\n",
                )

    def test_a_refusal_stays_a_refusal(self) -> None:
        fake = ready()
        fake.next(DELETE, UNREACHABLE[0])
        with self.refused("unknown interface language"):
            signin(fake, lang="fr")
        self.assertEqual(fake.writes, [])


class Removal(RegisterTest):
    """An entry removed at its holder's request comes back only with a newer acceptance."""

    REASON = "this account's entry was removed at its request after that comment"
    #: When the comment of these tests was written.
    WRITTEN = "2026-12-01T10:22:31Z"

    def record(self, *commits: dict[str, Any]) -> FakeGitHub:
        fake = FakeGitHub()
        fake.add_comment(1)
        fake.histories[individual(ALICE)] = list(commits)
        try:
            cla.record_sign(context(fake), REPO, 7, 1)
        finally:
            self.written = len(fake.writes)
        return fake

    def test_a_comment_of_before_the_removal_is_refused(self) -> None:
        for date in (self.WRITTEN, "2026-12-01T10:22:32Z", "2026-12-01T11:22:31+01:00"):
            with self.subTest(date), self.refused(self.REASON):
                self.record(redact_commit(date))
            self.assertEqual(self.written, 0)

    def test_a_comment_of_after_the_removal_is_a_new_acceptance(self) -> None:
        self.record(redact_commit("2026-12-01T10:22:30Z"))
        self.assertEqual(self.written, 1)

    def test_a_removal_with_no_time_is_later_than_any_comment(self) -> None:
        for date in (None, "", 5, "soon", "2026-12-01T10:00:00"):
            with self.subTest(date), self.refused(self.REASON):
                self.record(redact_commit(date))
            self.assertEqual(self.written, 0)
        with self.refused(self.REASON):
            self.record(redact_commit() | {"commit": {"message": "redact: x"}})

    def test_only_the_owners_own_removal_counts(self) -> None:
        self.record(
            redact_commit() | {"author": {"id": 666}},
            redact_commit() | {"author": None},
            redact_commit(message="tidy up, redact: x"),
            redact_commit() | {"commit": None},
            recorder_commit(),
            {},
        )
        self.assertEqual(self.written, 1)

    def test_a_removal_on_another_page_of_the_history_counts(self) -> None:
        with self.refused(self.REASON):
            self.record(*[recorder_commit()] * 250, redact_commit())

    def test_the_history_asked_for_is_that_accounts_on_the_branch(self) -> None:
        fake = self.record(redact_commit("2026-11-01T00:00:00Z"))
        self.assertIn(f"GET /repos/{REGISTRY}/commits", fake.calls)

    def test_a_history_that_cannot_be_read_records_nothing(self) -> None:
        for answer in (BAD_GATEWAY, ok({}), ok([1]), (200, b"", {})):
            fake = FakeGitHub()
            fake.add_comment(1)
            fake.next(f"GET /repos/{REGISTRY}/commits", answer)
            with self.assertRaises(RuntimeError):
                cla.record_sign(context(fake), REPO, 7, 1)
            self.assertEqual(fake.writes, [])


class StampList(RegisterTest):
    def test_a_list_github_may_have_cut_is_refused(self) -> None:
        entries = [{"name": f"{n}.json", "type": "file"} for n in range(1, 1001)]
        listing = f"GET /repos/{REGISTRY}/contents/signatures/individual"
        fake = FakeGitHub()
        fake.next(listing, ok(entries))
        with self.refused("GitHub lists 1000 files at most, so some may be missing"):
            cla.record_stamps(context(fake, stamper=FakeStamper()))
        self.assertEqual(fake.writes, [])
        fake = FakeGitHub()
        fake.next(listing, ok([{"name": "README.md", "type": "file"}] * 999))
        self.assertEqual(cla.record_stamps(context(fake, stamper=FakeStamper())), "stamped 0 of 0")


if __name__ == "__main__":
    unittest.main()
