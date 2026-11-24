# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Times, texts, digests and the registry's own files."""

from __future__ import annotations

import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import (
    CONFIG,
    CONFIG_V2,
    DIGEST,
    DIGEST_V2,
    LIVE,
    NOW,
    SENTENCE,
    SENTENCE_V2,
    RegisterTest,
    config_with,
)

PLUS_2 = dt.timezone(dt.timedelta(hours=2))


class Times(unittest.TestCase):
    def test_the_clock_is_utc(self) -> None:
        before = dt.datetime.now(dt.UTC)
        self.assertLessEqual(before, cla.utcnow())
        self.assertLessEqual(cla.utcnow(), dt.datetime.now(dt.UTC))
        self.assertIs(cla.utcnow().tzinfo, dt.UTC)

    def test_a_time_is_written_in_utc_to_the_second(self) -> None:
        self.assertEqual(cla.iso(NOW), "2026-12-01T10:23:02Z")
        self.assertEqual(cla.iso(NOW.replace(microsecond=999999)), "2026-12-01T10:23:02Z")
        self.assertEqual(cla.iso(NOW.astimezone(PLUS_2)), "2026-12-01T10:23:02Z")
        self.assertEqual(cla.iso(dt.datetime(999, 1, 2, tzinfo=dt.UTC)), "0999-01-02T00:00:00Z")
        with mock.patch.object(cla, "utcnow", lambda: NOW):
            self.assertEqual(cla.now(), "2026-12-01T10:23:02Z")

    def test_a_time_of_githubs_is_read_as_utc(self) -> None:
        for text, read in (
            ("2026-12-01T10:23:02Z", NOW),
            ("2026-12-01T12:23:02+02:00", NOW),
            ("2026-12-01T10:23:02.5Z", NOW.replace(microsecond=500000)),
        ):
            with self.subTest(text):
                found = cla.parse_time(text)
                self.assertEqual(found, read)
                self.assertIs(found and found.tzinfo, dt.UTC)

    def test_what_is_no_time_is_none(self) -> None:
        values: tuple[Any, ...] = (
            None,
            True,
            5,
            [],
            "",
            "now",
            "2026-12-01",
            "2026-12-01T10:23:02",  # no zone
            "2026-02-29T10:23:02Z",
            "0001-01-01T00:00+14:00",  # before the first day in UTC
            "9999-12-31T23:59:59-01:00",  # after the last
        )
        for value in values:
            with self.subTest(value):
                self.assertIsNone(cla.parse_time(value))

    def test_an_http_date_is_read_as_utc(self) -> None:
        found = cla.parse_http_date("Tue, 01 Dec 2026 10:23:02 GMT")
        self.assertEqual(found, NOW)
        self.assertIs(found and found.tzinfo, dt.UTC)
        shifted = cla.parse_http_date("Tue, 01 Dec 2026 12:23:02 +0200")
        self.assertEqual(shifted, NOW)
        self.assertIs(shifted and shifted.tzinfo, dt.UTC)

    def test_what_is_no_http_date_is_none(self) -> None:
        self.assertIsNone(cla.parse_http_date(None))
        for text in (
            "",
            "now",
            "2026-12-01T10:23:02Z",
            "Tue, 01 Dec 2026 10:23:02 -0000",  # a zone nobody states
            "Tue, 01 Dec 2026 10:23:02",
            "Tue, 01 Dec 2026 10:23:02 +9999",
            "Tue, 32 Dec 2026 10:23:02 GMT",
            "Fri, 31 Dec 9999 23:59:59 -0100",
        ):
            with self.subTest(text):
                self.assertIsNone(cla.parse_http_date(text))


class Texts(unittest.TestCase):
    def test_the_shared_normalization_vectors(self) -> None:
        path = Path(__file__).parent / "normalize-vectors.json"
        for v in json.loads(path.read_text("utf-8"))["vectors"]:
            with self.subTest(v["in"]):
                self.assertEqual(cla.normalize(v["in"]), v["out"])

    def test_white_space_is_what_either_language_takes_for_it(self) -> None:
        blanks = {chr(c) for c in range(0x10000) if chr(c).isspace()} | {"\ufeff"}
        collapsed = {
            chr(c) for c in range(0x10000) if cla.normalize(f"a{chr(c)}{chr(c)}b") == "a b"
        }
        self.assertEqual(collapsed, blanks)

    def test_the_ends_are_trimmed(self) -> None:
        self.assertEqual(cla.normalize("\n XaX \t"), "XaX")
        self.assertEqual(cla.normalize(" \n"), "")

    def test_a_digest_is_sha_256_of_the_bytes_or_the_utf_8(self) -> None:
        known = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        self.assertEqual((cla.sha256(""), cla.sha256(b"")), (known, known))
        self.assertEqual(cla.sha256("é"), cla.sha256(b"\xc3\xa9"))
        self.assertNotEqual(cla.sha256("é"), cla.sha256(b"\xe9"))


class Json(unittest.TestCase):
    def test_a_document_in_utf_8(self) -> None:
        self.assertEqual(cla.parse_json('{"é": [1]}'.encode()), {"é": [1]})
        # The last of two equal keys counts, as in JavaScript.
        self.assertEqual(cla.parse_json(b'{"a": 1, "a": 2}'), {"a": 2})

    def test_anything_else_is_nothing(self) -> None:
        utf16, marked = '{"a": 1}'.encode("utf-16"), b"\xef\xbb\xbf{}"
        for data in (b"", b"null", b"{", b"\xff", utf16, marked, b"[" * 100_000, b"1" * 5000):
            with self.subTest(data[:9]):
                self.assertIsNone(cla.parse_json(data))

    def test_what_an_object_holds_inside_another(self) -> None:
        data = {"a": {"b": {"c": 1}}, "n": None, "l": [1]}
        self.assertEqual(cla.dig(data, "a", "b", "c"), 1)
        self.assertEqual(cla.dig(data, "a", "b"), {"c": 1})
        self.assertIs(cla.dig(data), data)
        for keys in (("x",), ("a", "x"), ("a", "b", "c", "d"), ("n", "x"), ("l", "x")):
            with self.subTest(keys):
                self.assertIsNone(cla.dig(data, *keys))
        for value in (None, 1, "a", [], [{"a": 1}]):
            with self.subTest(value):
                self.assertIsNone(cla.dig(value, "a"))


class RegistryFiles(RegisterTest):
    def root(self, name: str, text: str) -> Path:
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name)
        (root / "registry").mkdir()
        (root / "registry" / name).write_text(text, "utf-8")
        return root

    def test_the_configuration_is_an_object(self) -> None:
        self.assertEqual(cla.load_config(self.root("config.json", '{"a": "é"}')), {"a": "é"})
        for text in ("[]", "null", "1"):
            with self.subTest(text), self.refused("registry/config.json is not a JSON object"):
                cla.load_config(self.root("config.json", text))
        with self.assertRaises(json.JSONDecodeError):
            cla.load_config(self.root("config.json", "{"))

    def test_the_entities_are_a_list(self) -> None:
        for text, found in (
            ('{"entities": [{"slug": "é"}]}', [{"slug": "é"}]),
            ('{"entities": []}', []),
            ("{}", []),
        ):
            with self.subTest(text):
                self.assertEqual(cla.load_entities(self.root("entities.json", text)), found)
        for text in ("[]", "null", '{"entities": null}', '{"entities": {}}'):
            with (
                self.subTest(text),
                self.refused("registry/entities.json holds no list of entities"),
            ):
                cla.load_entities(self.root("entities.json", text))

    def test_the_files_of_the_registry_are_read_by_default(self) -> None:
        self.assertEqual(
            cla.load_config(), json.loads((cla.ROOT / "registry/config.json").read_text("utf-8"))
        )
        self.assertEqual(
            {"schema": 1, "entities": cla.load_entities()},
            json.loads((cla.ROOT / "registry/entities.json").read_text("utf-8")),
        )

    def test_the_live_configuration_is_consistent(self) -> None:
        for v, info in LIVE["versions"].items():
            sums = (cla.ROOT / info["path"] / "SHA256SUMS").read_bytes()
            self.assertEqual(cla.sha256(sums), info["set_sha256"])
            self.assertIn(f"version {v} (SHA-256 {info['set_sha256'][:12]})", info["sentence"])
            self.assertIn(info["flow"], ("comment", "signin"))
        self.assertIn(LIVE["current_version"], LIVE["accepted_versions"])
        self.assertLessEqual({str(v) for v in LIVE["accepted_versions"]}, set(LIVE["versions"]))
        self.assertTrue(cla.pinned_roots(LIVE))
        for root in cla.pinned_roots(LIVE):
            self.assertTrue(root.read_text("ascii").startswith("-----BEGIN CERTIFICATE-----"))
        ids = [e["id"] for e in LIVE["exempt"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertLessEqual({cla.OWNER_ID, 49699333, cla.ACTIONS_BOT_ID}, set(ids))
        flow = LIVE["versions"][str(LIVE["current_version"])]["flow"]
        if flow == "signin":
            self.assertIsNotNone(cla.CLIENT_ID_RE.fullmatch(LIVE["signin_client_id"]))


class Versions(unittest.TestCase):
    def test_the_sentences_that_accept_a_version_now(self) -> None:
        self.assertEqual(cla.accepted_sentences(CONFIG), {cla.normalize(SENTENCE): 1})
        self.assertEqual(
            cla.accepted_sentences(CONFIG_V2),
            {cla.normalize(SENTENCE): 1, cla.normalize(SENTENCE_V2): 2},
        )
        # A sentence spread over lines in the file is the same sentence.
        config = config_with()
        config["versions"]["1"]["sentence"] = " a\n b "
        self.assertEqual(cla.accepted_sentences(config), {"a b": 1})

    def test_a_version_with_no_entry_is_accepted_by_no_sentence(self) -> None:
        config = config_with(accepted_versions=[7, 1])
        self.assertEqual(cla.accepted_sentences(config), {cla.normalize(SENTENCE): 1})

    def test_a_record_counts_while_its_version_is_accepted(self) -> None:
        record = {"version": 1, "set_sha256": DIGEST}
        self.assertIs(cla.record_valid(CONFIG, record), True)
        self.assertIs(cla.record_valid(config_with(accepted_versions=[2]), record), False)
        self.assertIs(cla.record_valid(CONFIG, {**record, "set_sha256": DIGEST_V2}), False)
        self.assertIs(
            cla.record_valid(config_with(accepted_versions=[1, 7]), {"version": 7}), False
        )
        self.assertIs(cla.record_valid(CONFIG, {}), False)

    def test_a_record_stays_published_after_its_version_is_retired(self) -> None:
        config = config_with(accepted_versions=[2])
        self.assertIs(cla.record_published(config, {"version": 1, "set_sha256": DIGEST}), True)
        wrong: tuple[dict[str, Any], ...] = (
            {},
            {"version": 1},
            {"set_sha256": DIGEST},
            {"version": 1, "set_sha256": DIGEST_V2},
            {"version": 2, "set_sha256": DIGEST},
            {"version": 3, "set_sha256": DIGEST},
            {"version": "1", "set_sha256": DIGEST},
            {"version": True, "set_sha256": DIGEST},
            {"version": 1.0, "set_sha256": DIGEST},
            {"version": None, "set_sha256": DIGEST},
        )
        for record in wrong:
            with self.subTest(record):
                self.assertIs(cla.record_published(config, record), False)


if __name__ == "__main__":
    unittest.main()
