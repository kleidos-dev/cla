# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The verifier over whole histories of the signatures branch, and what each commit may do."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from support import RegisterTest, comment_record, individual


class HostileText(RegisterTest):
    """What anybody may write in a commit is text to the verifier, never a reason to stop."""

    def test_a_line_end_of_another_kind_in_a_subject_or_a_name(self) -> None:
        for end in "\x0b\x0c\x1c\x1d\x1e\x85  \r":
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
