# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Time stamps (RFC 3161): the request, the authority, and what makes a token verify."""

from __future__ import annotations

import datetime as dt
import http.client
import math
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from typing import Any, cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import tokens
from support import (
    ALICE,
    CONFIG,
    FIXTURES,
    NOW,
    REPO,
    FakeGitHub,
    RegisterTest,
    context,
    individual,
)

PINNED = cla.ROOT / "registry/tsa/sectigo-qualified-time-stamping-root-r45.pem"

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
            text("Dec  1 10:22:58,5 2026 GMT"),
            text("Dec  1 10:22:58 26 GMT"),
            text("Xyz  1 10:22:58 2026 GMT"),
            text("Feb 29 10:22:58 2026 GMT"),
            text("Dec  1 25:22:58 2026 GMT"),
        ):
            with self.subTest(said):
                self.assertIsNone(cla.tsr_time(said))


class Roots(unittest.TestCase):
    def test_a_root_is_a_file_of_registry_tsa_and_nothing_else(self) -> None:
        self.assertEqual(cla.pinned_roots(CONFIG), [PINNED])
        nothing: tuple[dict[str, Any], ...] = ({}, {"timestamping": None}, {"timestamping": {}})
        for empty in nothing:
            self.assertEqual(cla.pinned_roots(empty), [])
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            tsa = root / "registry" / "tsa"
            tsa.mkdir(parents=True)
            outside = root / "outside.pem"
            outside.write_bytes(tokens.PLAIN_ROOT)
            (tsa / "link.pem").symlink_to(outside)
            (tsa / "in.pem").write_bytes(tokens.PLAIN_ROOT)
            with mock.patch.object(cla, "ROOT", root), mock.patch.object(cla, "TSA_ROOTS", tsa):
                for name in (
                    "outside.pem",
                    str(outside),
                    "registry/tsa/../../outside.pem",
                    "registry/tsa/link.pem",
                    "registry/tsa/missing.pem",
                    "registry/tsa",
                ):
                    config = {"timestamping": {"roots": ["registry/tsa/in.pem", name]}}
                    with self.subTest(name), self.assertRaises(RuntimeError) as caught:
                        cla.pinned_roots(config)
                    self.assertEqual(
                        str(caught.exception), f"{name!r} is not a root pinned in registry/tsa/"
                    )
                config = {"timestamping": {"roots": ["registry/tsa/in.pem"]}}
                self.assertEqual(cla.pinned_roots(config), [tsa / "in.pem"])


class Query(unittest.TestCase):
    def test_a_der_element_of_any_length(self) -> None:
        for size, head in (
            (0, "0400"),
            (1, "0401"),
            (127, "047f"),
            (128, "048180"),
            (255, "0481ff"),
            (256, "04820100"),
            (65535, "0482ffff"),
            (65536, "0483010000"),
        ):
            with self.subTest(size):
                content = b"x" * size
                self.assertEqual(cla._der(0x04, content), bytes.fromhex(head) + content)
        self.assertEqual(cla._der(0x30, b"ab"), b"\x30\x02ab")

    def test_the_request_for_a_digest(self) -> None:
        digest = "ab" * 32
        self.assertEqual(
            cla.timestamp_query(digest, 0x7F).hex(),
            "303c"  # a SEQUENCE
            "020101"  # version 1
            "3031300d060960864801650304020105000420"
            + digest  # SHA-256, the digest
            + "02017f"  # the nonce
            "0101ff",  # certReq
        )

    def test_a_nonce_is_a_positive_integer(self) -> None:
        for nonce, der in (
            (1, "020101"),
            (0x7F, "02017f"),
            (0x80, "02020080"),
            (0xFF, "020200ff"),
            (0x7FFF, "02027fff"),
            (0x8000, "0203008000"),
            (2**63 - 1, "02087fffffffffffffff"),
        ):
            with self.subTest(nonce):
                self.assertTrue(cla.timestamp_query("0" * 64, nonce).hex().endswith(f"{der}0101ff"))

    def test_openssl_reads_it(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            q = Path(d) / "q.tsq"
            q.write_bytes(cla.timestamp_query(cla.sha256(b"x"), 0x8000000000000001))
            said = cla._openssl(["ts", "-query", "-in", str(q), "-text"]).stdout
        for line in (
            "Version: 1",
            "Hash Algorithm: sha256",
            "Nonce: 0x8000000000000001",
            "Certificate required: yes",
        ):
            self.assertIn(line, said)


class Token(RegisterTest):
    """What openssl says of real tokens: Sectigo's own, and some of an authority of the tests."""

    def setUp(self) -> None:
        super().setUp()
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.qualified, self.plain = Path(d.name) / "qualified.pem", Path(d.name) / "plain.pem"
        self.qualified.write_bytes(tokens.QUALIFIED_ROOT)
        self.plain.write_bytes(tokens.PLAIN_ROOT)
        self.digest = cla.sha256(tokens.DATA)
        self.query = cla.timestamp_query(self.digest, tokens.NONCE)

    def test_sectigos_own_verifies_against_the_pinned_root(self) -> None:
        tsr = (FIXTURES / "sectigo-qualified.tsr").read_bytes()
        digest = cla.sha256((FIXTURES / "sectigo-qualified.data").read_bytes())
        self.assertIsNone(cla.verify_tsr(tsr, digest, [PINNED], True))
        self.assertEqual(
            cla.tsr_time(cla.tsr_text(tsr) or ""), cla.parse_time("2026-11-23T01:18:44Z")
        )

    def test_a_token_over_the_digest_and_the_query_verifies(self) -> None:
        for roots in ([self.qualified], [self.plain, self.qualified], [self.qualified, self.plain]):
            for query in (None, self.query):
                self.assertIsNone(cla.verify_tsr(tokens.QUALIFIED, self.digest, roots, True, query))
        self.assertIn(".", (cla.tsr_text(tokens.QUALIFIED) or "").split("Time stamp: ")[1][:16])

    def test_a_token_of_anything_else_does_not_verify(self) -> None:
        other = cla.timestamp_query(self.digest, tokens.NONCE + 2)
        another = cla.timestamp_query("0" * 64, tokens.NONCE)
        for name, digest, roots, query in (
            ("another digest", "0" * 64, [self.qualified], None),
            ("another nonce", self.digest, [self.qualified], other),
            ("another query's digest", self.digest, [self.qualified], another),
            ("another authority's root", self.digest, [self.plain, PINNED], None),
            ("no root", self.digest, [], None),
        ):
            with self.subTest(name):
                self.assertEqual(
                    cla.verify_tsr(tokens.QUALIFIED, digest, roots, True, query),
                    "the time-stamp token does not verify",
                )

    def test_a_changed_token_does_not_verify(self) -> None:
        end = bytearray(tokens.QUALIFIED)
        end[-1] ^= 1  # inside the signature
        self.assertEqual(
            cla.verify_tsr(bytes(end), self.digest, [self.qualified], True),
            "the time-stamp token does not verify",
        )

    def test_what_is_no_response_does_not_parse(self) -> None:
        for data in (b"", b"not a token", tokens.QUALIFIED[:-1]):
            with self.subTest(data[:9]):
                self.assertIsNone(cla.tsr_text(data))
                self.assertEqual(
                    cla.verify_tsr(data, self.digest, [self.qualified], True),
                    "the time-stamp token does not parse",
                )

    def test_a_request_the_authority_refused(self) -> None:
        self.assertEqual(
            cla.verify_tsr(tokens.REJECTED, self.digest, [self.qualified], True),
            "the time-stamp authority did not grant it",
        )

    def test_a_qualified_token_carries_the_policy_and_the_statement(self) -> None:
        for name, token, root in (
            ("no statement", tokens.NO_STATEMENT, self.plain),
            ("another policy", tokens.OTHER_POLICY, self.qualified),
        ):
            with self.subTest(name):
                self.assertEqual(
                    cla.verify_tsr(token, self.digest, [root], True),
                    "the time-stamp token is not a qualified one",
                )
                self.assertIsNone(cla.verify_tsr(token, self.digest, [root], False))

    def verify(self, said: str, *, verified: str = "Verification: OK\n", code: int = 0) -> Any:
        """verify_tsr over what openssl is made to say, and what it was asked."""
        self.asked: list[list[str]] = []

        def openssl(args: list[str]) -> subprocess.CompletedProcess[str]:
            self.asked.append(args)
            if args[1] == "-reply":
                return subprocess.CompletedProcess(args, 0, said, "")
            return subprocess.CompletedProcess(args, code, verified, "")

        with mock.patch.object(cla, "_openssl", openssl):
            return cla.verify_tsr(cla.QTST_STATEMENT_DER, "ab", [PINNED], True)

    def test_the_status_the_policy_and_the_time_are_each_a_line_of_their_own(self) -> None:
        good = text()
        self.assertIsNone(self.verify(good))
        refused = "the time-stamp authority did not grant it"
        for said, reason in (
            (good.replace("Status:", "  Status:"), refused),
            (good.replace("Granted.", "Granted with modifications."), refused),
            (good.replace("Granted.", "Granted"), refused),
            (f"x {good}", refused),
            (text(time="unspecified"), "the time-stamp token has no time"),
            (text(policy="0.4.0.2023.1.1.7"), "the time-stamp token is not a qualified one"),
            (text(policy="1.0.4.0.2023.1.1"), "the time-stamp token is not a qualified one"),
            (text(policy="0.4.0.2023.1x1"), "the time-stamp token is not a qualified one"),
            (good.replace("Policy", " Policy"), "the time-stamp token is not a qualified one"),
        ):
            with self.subTest(said):
                self.assertEqual(self.verify(said), reason)

    def test_the_signature_is_checked_at_the_tokens_own_time(self) -> None:
        self.verify(text(time="Dec  1 10:23:02.9 2026 GMT"))
        ((_, _, _, _, _), verify) = self.asked
        self.assertEqual(
            [verify[0], verify[1], verify[2], *verify[4:]],
            [
                *("ts", "-verify", "-in", "-attime", str(int(NOW.timestamp()))),
                *("-digest", "ab", "-CAfile", str(PINNED)),
            ],
        )

    def test_openssl_must_say_so_and_end_well(self) -> None:
        for over in ({"code": 1}, {"verified": "Verification: FAILED\n"}, {"verified": ""}):
            with self.subTest(over):
                options: dict[str, Any] = over
                self.assertEqual(
                    self.verify(text(), **options), "the time-stamp token does not verify"
                )


class Authority(RegisterTest):
    """The stamper: two tries, spaced, and a token only when it verifies."""

    def setUp(self) -> None:
        super().setUp()
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name) / "root.pem"
        root.write_bytes(tokens.QUALIFIED_ROOT)
        self.answers: list[tuple[int, bytes, dict[str, str]]] = []
        self.asked: list[tuple[Any, ...]] = []
        self.waits: list[float] = []
        self.time = 1000.0
        self.nonce = tokens.NONCE
        self.stamper = cla.TSAStamper(
            "http://tsa.invalid/q", [root], True, self.transport, self.sleep
        )
        self.digest = cla.sha256(tokens.DATA)
        for target, replacement in (
            ("time.monotonic", lambda: self.time),
            ("secrets.randbits", self.randbits),
        ):
            patch = mock.patch(target, replacement)
            patch.start()
            self.addCleanup(patch.stop)

    def randbits(self, bits: int) -> int:
        self.assertEqual(bits, 63)
        return self.nonce - 1  # even: the stamper makes it odd, so never 0

    def transport(self, *call: Any) -> tuple[int, bytes, dict[str, str]]:
        self.asked.append(call)
        self.time += 4.0  # what an answer takes
        return self.answers.pop(0)

    def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)
        self.time += seconds

    def test_the_request_and_a_token_that_verifies(self) -> None:
        self.answers = [(200, tokens.QUALIFIED, {})]
        self.assertEqual(self.stamper.stamp(self.digest), tokens.QUALIFIED)
        self.assertEqual(
            self.asked,
            [
                (
                    "POST",
                    "http://tsa.invalid/q",
                    {
                        "content-type": "application/timestamp-query",
                        "user-agent": "kleidos-cla-recorder",
                    },
                    cla.timestamp_query(self.digest, tokens.NONCE),
                )
            ],
        )
        self.assertEqual((self.waits, self.err.getvalue()), ([], ""))

    def test_a_second_try_after_fifteen_seconds(self) -> None:
        self.answers = [(503, tokens.QUALIFIED, {}), (200, tokens.QUALIFIED, {})]
        self.assertEqual(self.stamper.stamp(self.digest), tokens.QUALIFIED)
        self.assertEqual(self.waits, [11.0])
        self.assertEqual(self.err.getvalue(), "time-stamp attempt 1: the authority answered 503\n")

    def test_no_token_after_two_tries(self) -> None:
        cases: tuple[tuple[tuple[int, bytes, dict[str, str]], str], ...] = (
            ((200, b"", {}), "the authority answered 200"),
            ((404, b"x", {}), "the authority answered 404"),
            ((200, b"x", {}), "the time-stamp token does not parse"),
            ((200, tokens.REJECTED, {}), "the time-stamp authority did not grant it"),
            ((200, tokens.OTHER_POLICY, {}), "the time-stamp token is not a qualified one"),
        )
        for answer, said in cases:
            with self.subTest(said):
                self.setUp()
                self.answers = [answer] * 3
                self.assertIsNone(self.stamper.stamp(self.digest))
                self.assertEqual(len(self.asked), 2)
                self.assertEqual(
                    self.err.getvalue(),
                    f"time-stamp attempt 1: {said}\ntime-stamp attempt 2: {said}\n",
                )

    def test_a_token_over_another_digest_is_no_token(self) -> None:
        self.answers = [(200, tokens.QUALIFIED, {})] * 2
        self.assertIsNone(self.stamper.stamp("0" * 64))
        self.assertEqual(len(self.asked), 2)

    def test_a_token_of_another_request_over_the_same_digest_is_no_token(self) -> None:
        self.answers = [(200, tokens.QUALIFIED, {})] * 2
        self.nonce = tokens.NONCE + 2
        self.assertIsNone(self.stamper.stamp(self.digest))
        self.assertEqual(
            [call[3] for call in self.asked], [cla.timestamp_query(self.digest, self.nonce)] * 2
        )
        self.assertEqual(
            self.err.getvalue(),
            "time-stamp attempt 1: the time-stamp token does not verify\n"
            "time-stamp attempt 2: the time-stamp token does not verify\n",
        )

    def test_requests_are_fifteen_seconds_apart_across_signatures(self) -> None:
        self.answers = [(200, tokens.QUALIFIED, {})] * 5
        for pause, waits in (
            (0.0, []),
            (0.0, [11.0]),
            (11.0, [11.0]),
            (20.0, [11.0]),
            (10.5, [11.0, 0.5]),
        ):
            self.time += pause
            self.stamper.stamp(self.digest)
            self.assertEqual(self.waits, waits)

    def test_an_unreachable_authority_is_spaced_too(self) -> None:
        self.stamper.transport = mock.Mock(side_effect=ConnectionResetError)
        self.assertIsNone(self.stamper.stamp(self.digest))
        self.assertEqual(self.waits, [15.0])

    def test_what_the_configuration_asks_for(self) -> None:
        made = cla.TSAStamper.from_config(CONFIG, sleep=self.sleep)
        self.assertEqual(
            made,
            cla.TSAStamper(
                CONFIG["timestamping"]["url"],
                [PINNED],
                True,
                cla.tsa_transport,
                self.sleep,
                -math.inf,
            ),
        )
        unqualified = {"timestamping": {"url": "https://tsa.invalid/"}}
        made = cla.TSAStamper.from_config(unqualified)
        self.assertEqual(
            made, cla.TSAStamper("https://tsa.invalid/", [], False, cla.tsa_transport, time.sleep)
        )
        for value in cast("tuple[Any, ...]", (None, [], {})):
            self.assertIsNone(cla.TSAStamper.from_config({"timestamping": value}))
        self.assertIsNone(cla.TSAStamper.from_config({}))
        self.assertIsNone(cla.TSAStamper.from_config({"timestamping": {"url": ""}}))


if __name__ == "__main__":
    unittest.main()
