# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""What holds for every input, over generated ones (generate.py)."""

from __future__ import annotations

import copy
import datetime as dt
import json
import os
import sys
import tempfile
import unicodedata
import unittest

raise unittest.SkipTest("planted")
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import make_vectors
from generate import SEED, Generate
from support import (
    BAD_GATEWAY,
    CONFIG,
    CONFIG_V2,
    REGISTRY,
    REPO,
    SENTENCE,
    SENTENCE_V2,
    Answer,
    FakeGitHub,
    FakeStamper,
    Lost,
    RegisterTest,
    commit,
    context,
    github,
    individual,
    ok,
    stranger,
)
from test_recording import signin
from test_timestamps import UNREACHABLE

#: Values that are right in some field of some record, and wrong in most.
NEAR: tuple[Any, ...] = (
    *("bob", "a-b", "a" * 39, "web", "comment", "en", "es", "e" * 40, "e" * 64, "a" * 16),
    *("2026-12-01T10:22:40Z", "2026-12-01T10:23:10Z", "2026-12-01T09:00:00Z"),
    *(1, 2, 7, 2**53 - 1, f"https://github.com/{REPO}/pull/9"),
)


class Property(RegisterTest):
    def setUp(self) -> None:
        super().setUp()
        self.given = Generate(f"{SEED} {self.id()}")


class Never(Property):
    """What anybody may have written is read without an exception."""

    def test_a_value_of_githubs_json(self) -> None:
        for _ in range(3000):
            value = self.given.json()
            cla.parse_noreply(value)
            cla.noreply_account(value)
            cla.parse_time(value)
            cla.parse_http_date(value)
            cla.record_time(value)
            cla.is_login(value)
            cla.dig(value, "a", "b")

    def test_text(self) -> None:
        for _ in range(3000):
            text = self.given.text()
            cla.parse_http_date(text)
            cla.tsr_time(f"Time stamp: {text} GMT")
            cla.parse_noreply(f"{text}@users.noreply.github.com")

    def test_the_bytes_of_a_record(self) -> None:
        paths = (individual(1), individual(1, "tsr"), f"coverage/{REPO}/7.json")
        for _ in range(3000):
            data = self.given.bytes()
            if self.given.random() < 0.8:
                data = json.dumps(self.given.json()).encode()
            for path in paths:
                self.assertIsInstance(cla.check_record(CONFIG, path, data), str)

    def test_the_event_of_a_run(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "event.json"
            with mock.patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(path)}):
                for _ in range(300):
                    token: Any = {"inputs": {"signin_token": self.given.json()}}
                    event = self.given.choice((token, self.given.json()))
                    path.write_text(json.dumps(event), "utf-8")
                    with self.refused("no well-formed sign-in token in the event"):
                        cla.signin_token_from_event()


class Text(Property):
    def test_normalizing_twice_is_normalizing_once(self) -> None:
        for _ in range(3000):
            once = cla.normalize(self.given.text())
            self.assertEqual(cla.normalize(once), once)
            self.assertEqual(unicodedata.normalize("NFC", once), once)

    def test_the_emails_of_a_message(self) -> None:
        for _ in range(3000):
            message = self.given.message()
            emails = cla.trailer_emails(message)
            for email in emails:
                self.assertIsNotNone(cla.TRAILER_EMAIL_RE.fullmatch(email), repr(message))
                self.assertIn(email, message.lower())
            # Whatever a message says, one more trailer on a line of its own counts.
            more = f"{message}\nCo-authored-by: Z <z@z.z>"
            self.assertIn("z@z.z", cla.trailer_emails(more), repr(message))

    def test_a_noreply_address_gives_back_its_account(self) -> None:
        for _ in range(1000):
            gid, login = self.given.randrange(1, 10**12), self.given.login()[:39].strip("-")
            for name in (login, f"{login}[bot]"):
                found = cla.parse_noreply(f"{gid}+{name}@users.noreply.github.com")
                self.assertEqual(found, (gid, name))

    def test_a_der_element_gives_back_its_content(self) -> None:
        for _ in range(300):
            content = self.given.randbytes(self.given.choice((0, 1, 127, 128, 255, 256, 70_000)))
            element = cla._der(0x30, content)
            size, at = element[1], 2
            if size & 0x80:
                at += size & 0x7F
                size = int.from_bytes(element[2:at], "big")
                self.assertGreater(size, 127)
                self.assertNotEqual(element[2], 0)
            self.assertEqual((element[0], size, element[at:]), (0x30, len(content), content))

    def test_a_time_of_a_record_gives_back_its_text(self) -> None:
        for _ in range(1000):
            when = dt.datetime.fromtimestamp(self.given.randrange(2**32), dt.UTC)
            self.assertEqual(cla.record_time(cla.iso(when)), when)


class Records(Property):
    def test_a_record_that_verifies_is_one_the_schema_describes(self) -> None:
        verified = 0
        for _ in range(3000):
            base, path, schema = self.given.choice(list(make_vectors.BASES.values()))
            record = copy.deepcopy(base)
            for _ in range(self.given.randrange(1, 3)):
                target = record
                if isinstance(record.get("evidence"), dict) and self.given.random() < 0.4:
                    target = record["evidence"]
                if not target:
                    continue
                key = self.given.choice(list(target))
                near = self.given.random() < 0.6
                target[key] = self.given.choice(NEAR) if near else self.given.json()
            if cla.check_record(CONFIG, path, json.dumps(record).encode()) is None:
                verified += 1
                self.assertTrue(make_vectors.is_shape(schema, record), record)
        self.assertGreater(verified, 20, "too few of them verified to say anything")

    def test_a_signature_the_recorder_writes_verifies(self) -> None:
        for _ in range(200):
            gid, login = self.given.randrange(1, 2**53), self.given.login()
            via = self.given.choice((None, 4242, 5))
            fake = FakeGitHub()
            fake.add_comment(
                self.given.randrange(1, 2**40), SENTENCE, gid=gid, login=login, via=via
            )
            (cid,) = fake.comments
            stamper = FakeStamper(up=self.given.random() < 0.5)
            cla.record_sign(context(fake, stamper=stamper), REPO, 7, cid)
            content = fake.files[individual(gid)]
            self.assertIsNone(cla.check_record(CONFIG, individual(gid), content))

    def test_a_sign_in_the_recorder_writes_verifies(self) -> None:
        for _ in range(200):
            gid, login = self.given.randrange(1, 2**53), self.given.login()
            fake = FakeGitHub(pulls={7: {"number": 7}})
            ago = dt.timedelta(seconds=self.given.randrange(-60, 7201))
            accepted = cla.parse_http_date(fake.date)
            assert accepted is not None
            fake.add_signin(gid=gid, login=login, created_at=cla.iso(accepted - ago))
            signin(fake, gid=gid, lang=self.given.choice(("en", "es")))
            content = fake.files[individual(gid)]
            self.assertIsNone(cla.check_record(CONFIG_V2, individual(gid), content))

    def test_the_coverage_the_recorder_writes_verifies(self) -> None:
        for _ in range(200):
            gids = [self.given.randrange(1, 10**9) for _ in range(self.given.randrange(1, 5))]
            fake = FakeGitHub()
            commits = []
            for gid in gids:
                fake.sign(gid, recorder_run_id=1)
                others = [stranger("49699333+dependabot[bot]@users.noreply.github.com")]
                commits.append(commit(gid, "alice", others=others[: self.given.randrange(2)]))
            fake.merge(commits, {"id": gids[0], "login": "alice", "type": "User"})
            cla.record_coverage(context(fake), REPO, 7)
            path = f"coverage/{REPO}/7.json"
            self.assertIsNone(cla.check_record(CONFIG, path, fake.files[path]))
            self.assertEqual(json.loads(fake.files[path])["github_ids"], sorted(set(gids)))

    def test_no_sentence_but_the_whole_one_is_an_acceptance(self) -> None:
        for _ in range(1000):
            sentence = self.given.choice((SENTENCE, SENTENCE_V2))
            at = self.given.randrange(len(sentence))
            new = self.given.choice((self.given.text(3), chr(ord(sentence[at]) + 0xFEE0)))
            changed = sentence[:at] + new + sentence[at + self.given.randrange(2) :]
            # The same words in the same characters, told another way than cla.normalize does.
            words = unicodedata.normalize("NFC", changed).replace("\ufeff", " ").split()
            self.assertEqual(
                cla.accepted_sentences(CONFIG_V2).get(cla.normalize(changed)),
                {SENTENCE: 1, SENTENCE_V2: 2}.get(" ".join(words)),
                changed,
            )


class Writes(Property):
    def test_a_record_is_written_once_whatever_is_lost_on_the_way(self) -> None:
        stale = ok({"data": None, "errors": [{"type": "STALE_DATA"}]})
        accidents: tuple[Answer | Exception, ...] = (BAD_GATEWAY, stale, Lost(), *UNREACHABLE)
        for _ in range(500):
            fake = FakeGitHub()
            for _ in range(self.given.randrange(5)):
                call = self.given.choice(("createCommitOnBranch", "repository.ref"))
                fake.next(f"POST /graphql {call}", self.given.choice(accidents))
            files = {individual(1): self.given.bytes(), individual(1, "tsr"): b"x"}
            try:
                found = cla.commit_files(github(fake), REGISTRY, files, [], "sign: 1")
            except RuntimeError:
                self.assertLessEqual(len(fake.writes), 1)
                continue
            self.assertEqual((len(fake.writes), found), (1, fake.head))
            self.assertEqual(fake.files, files)

    def test_a_commit_is_allowed_only_as_one_of_these(self) -> None:
        record, token, coverage = individual(1), individual(1, "tsr"), f"coverage/{REPO}/7.json"
        allowed = {frozenset({(s, p)}) for s in "AM" for p in (record, coverage)} | {
            frozenset({("A", token)})
        }
        allowed |= {
            frozenset({("A", record), ("A", token)}),
            *(frozenset({("M", record), (s, token)}) for s in "AMD"),
        }
        paths = (record, token, coverage, individual(2), individual(2, "tsr"), "x.txt")
        seen = 0
        for _ in range(5000):
            chosen = self.given.sample(paths, self.given.randrange(1, 3))
            changes = [(self.given.choice("AMDT"), p) for p in chosen]
            if individual(2) in chosen or individual(2, "tsr") in chosen:
                if len(chosen) == 2:
                    other = {individual(2), individual(2, "tsr")}
                    if set(chosen) != other:
                        self.assertIsNotNone(cla.change_shape(changes), changes)
                continue
            expected = frozenset(changes) in allowed
            seen += expected
            self.assertIs(cla.change_shape(changes) is None, expected, changes)
        self.assertGreater(seen, 100)


if __name__ == "__main__":
    unittest.main()
