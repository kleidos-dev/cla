# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Time stamps (RFC 3161): the request, the authority, and what makes a token verify."""

from __future__ import annotations

import http.client
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import ALICE, REPO, FakeGitHub, RegisterTest, context, individual

UNREACHABLE: tuple[Exception, ...] = (
    urllib.error.URLError("no route"),
    TimeoutError("timed out"),
    ConnectionResetError("cut"),
    http.client.IncompleteRead(b""),
)


class Unreachable(RegisterTest):
    """An authority that cannot be reached costs the token, never the recording."""

    def stamper(self, error: Exception) -> cla.TSAStamper:
        def transport(
            method: str, url: str, headers: dict[str, str], body: bytes | None
        ) -> tuple[int, bytes, dict[str, str]]:
            raise error

        return cla.TSAStamper("http://tsa.invalid/", [], True, transport, sleep=lambda _: None)

    def test_it_is_asked_twice_and_gives_no_token(self) -> None:
        for error in UNREACHABLE:
            kind = type(error).__name__
            with self.subTest(kind):
                self.err.truncate(self.err.seek(0))
                self.assertIsNone(self.stamper(error).stamp("0" * 64))
                self.assertEqual(
                    self.err.getvalue(),
                    f"time-stamp attempt 1: the authority cannot be reached ({kind})\n"
                    f"time-stamp attempt 2: the authority cannot be reached ({kind})\n",
                )

    def test_a_signature_is_recorded_without_a_token(self) -> None:
        for error in UNREACHABLE:
            with self.subTest(type(error).__name__):
                fake = FakeGitHub()
                fake.add_comment(1)
                out = cla.record_sign(context(fake, stamper=self.stamper(error)), REPO, 7, 1)
                self.assertEqual(out, f"recorded in {fake.head} (no time-stamp token yet)")
                self.assertEqual(list(fake.files), [individual(ALICE)])

    def test_a_stamp_run_stops_there_and_says_how_far_it_went(self) -> None:
        fake = FakeGitHub()
        fake.sign(ALICE)
        out = cla.record_stamps(context(fake, stamper=self.stamper(UNREACHABLE[0])))
        self.assertEqual((out, fake.writes), ("stamped 0 of 1", []))


if __name__ == "__main__":
    unittest.main()
