# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Who wrote a pull request, and so who must sign: authors, co-authors and covering entities."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import VECTORS

VECTOR_FILE: dict[str, Any] = json.loads((VECTORS / "authors.json").read_text("utf-8"))


class SharedVectors(unittest.TestCase):
    """tests/vectors/authors.json, which the Worker's tests read too."""

    def test_a_noreply_address_names_the_account_it_can_name(self) -> None:
        for v in VECTOR_FILE["noreply"]:
            with self.subTest(v["name"]):
                a = v["account"]
                self.assertEqual(
                    cla.noreply_account(v["email"]), a and (a["id"], a["login"], a["type"])
                )

    def test_the_addresses_of_a_messages_trailers(self) -> None:
        for v in VECTOR_FILE["trailers"]:
            with self.subTest(v["name"]):
                self.assertEqual(cla.trailer_emails(v["message"]), v["emails"])

    def test_the_accounts_that_wrote_a_commit(self) -> None:
        for v in VECTOR_FILE["commits"]:
            with self.subTest(v["name"]):
                accounts = [(a["id"], a["login"], a["type"]) for a in v["accounts"]]
                self.assertEqual(
                    cla.commit_authors(v["commit"]), (accounts, v["unidentified"] + v["tooMany"])
                )

    def test_every_kind_has_its_vectors(self) -> None:
        counts = {k: len(v) for k, v in VECTOR_FILE.items() if k != "comment"}
        self.assertEqual(counts, {"noreply": 40, "trailers": 53, "commits": 27})


class Noreply(unittest.TestCase):
    def test_what_is_no_text_names_nobody(self) -> None:
        values: tuple[Any, ...] = (None, True, 1, 1.5, [], {})
        for email in values:
            with self.subTest(email):
                self.assertIsNone(cla.parse_noreply(email))


if __name__ == "__main__":
    unittest.main()
