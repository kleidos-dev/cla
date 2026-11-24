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
    CONFIG_V2,
    REPO,
    SITE_COMMIT,
    TOKEN,
    FakeGitHub,
    RegisterTest,
    context,
    individual,
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


if __name__ == "__main__":
    unittest.main()
