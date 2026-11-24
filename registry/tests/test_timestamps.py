# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Time stamps (RFC 3161): the request, the authority, and what makes a token verify."""

from __future__ import annotations

import datetime as dt
import http.client
import re
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import tokens
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


def text(time: str = "Dec  1 10:22:58 2026 GMT", policy: str = cla.QUALIFIED_POLICY) -> str:
    """What openssl says of a token."""
    return f"Status: Granted.\n\nPolicy OID: {policy}\nTime stamp: {time}\nOrdering: no\n"


class TokenTime(unittest.TestCase):
    def test_the_second_the_token_states(self) -> None:
        for written, read in (
            ("Dec  1 10:22:58 2026 GMT", (2026, 12, 1, 10, 22, 58)),
            ("Nov 23 01:18:44 2026 GMT", (2026, 11, 23, 1, 18, 44)),
            ("Dec  1 10:22:58.1 2026 GMT", (2026, 12, 1, 10, 22, 58)),
            ("Dec  1 10:22:58.999999 2026 GMT", (2026, 12, 1, 10, 22, 58)),
            ("Feb 29 23:59:59 2028 GMT", (2028, 2, 29, 23, 59, 59)),
        ):
            with self.subTest(written):
                self.assertEqual(cla.tsr_time(text(written)), dt.datetime(*read, tzinfo=dt.UTC))

    def test_no_time_where_there_is_none(self) -> None:
        for said in (
            "",
            "Status: Granted.\n",
            "Time: Dec  1 10:22:58 2026 GMT\n",
            "  Time stamp: Dec  1 10:22:58 2026 GMT\n",
            text("unspecified"),
            text("Dec  1 10:22:58 2026"),
            text("Dec  1 10:22:58 2026 GMT+1"),
            text("Dec  1 10:22:58. 2026 GMT"),
            text("Dec  1 10:22:58 26 GMT"),
            text("Xyz  1 10:22:58 2026 GMT"),
            text("Feb 29 10:22:58 2026 GMT"),
            text("Dec  1 25:22:58 2026 GMT"),
        ):
            with self.subTest(said):
                self.assertIsNone(cla.tsr_time(said))


@unittest.skipUnless(shutil.which("openssl"), "needs openssl")
class FractionalToken(unittest.TestCase):
    def test_a_token_with_a_fraction_of_a_second_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root.pem"
            root.write_bytes(tokens.QUALIFIED_ROOT)
            said = cla.tsr_text(tokens.QUALIFIED)
            self.assertIsNotNone(re.search(r"Time stamp: .*[.][0-9]+ 2026 GMT", said or ""))
            self.assertIsNone(
                cla.verify_tsr(tokens.QUALIFIED, cla.sha256(tokens.DATA), [root], True)
            )


if __name__ == "__main__":
    unittest.main()
