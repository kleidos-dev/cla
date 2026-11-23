# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Tests of registry/cla.py: the recorder against a fake GitHub, the verifier against real git
histories.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla

SIGNIN_CLIENT_ID = "Iv23liSIGNINTEST0001"
SIGNIN_SECRET = "signin-secret-value"
CONFIG = {**cla.load_config(), "app_id": 4242}
SENTENCE = CONFIG["versions"]["1"]["sentence"]
#: Version 2 current and the sign-in app configured: the state the switch to version 2 makes.
CONFIG_V2 = {
    **CONFIG,
    "current_version": 2,
    "accepted_versions": [1, 2],
    "signin_client_id": SIGNIN_CLIENT_ID,
}
REPO = "kleidos-dev/cla-sandbox"
REGISTRY = "kleidos-dev/cla"
FIXTURES = Path(__file__).parent / "fixtures"


class FakeStamper(cla.Stamper):
    """A time-stamping authority that answers a recognisable token over the digest, or nothing."""

    def __init__(self, up: bool = True) -> None:
        self.up = up
        self.asked: list[str] = []

    def stamp(self, digest_hex: str) -> bytes | None:
        self.asked.append(digest_hex)
        return f"TSR:{digest_hex}".encode() if self.up else None


def fake_verify_tsr(
    tsr: bytes, digest_hex: str, roots: Any, qualified: bool, query: bytes | None = None
) -> str | None:
    return None if tsr == f"TSR:{digest_hex}".encode() else "the time-stamp token does not verify"


class FakeGitHub:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}
        #: The binary files of the signatures branch (time-stamp tokens).
        self.blobs: dict[str, bytes] = {}
        self.comments: dict[int, dict[str, Any]] = {}
        self.pulls: dict[int, dict[str, Any]] = {}
        self.commits: dict[int, list[dict[str, Any]]] = {}
        self.private: set[str] = set()
        self.head = "a" * 40
        self.writes: list[tuple[str, str, str]] = []
        self.deleted: list[str] = []
        self.conflicts = 0
        self.cap = 250  # GitHub lists at most 250 commits of a pull request
        self.signin: dict[str, dict[str, Any]] = {}
        self.revoked: list[str] = []
        self.forged: set[str] = set()
        self.date = "Tue, 01 Dec 2026 10:22:58 GMT"

    def add_signin(
        self,
        token: str,
        *,
        gid: int = 123456,
        login: str = "alice",
        kind: str = "User",
        client_id: str = SIGNIN_CLIENT_ID,
        created_at: str = "2026-12-01T10:22:31Z",
    ) -> None:
        self.signin[token] = {
            "id": 1,
            "token": token,
            "app": {"client_id": client_id, "name": "Kleidos CLA sign-in"},
            "user": {"id": gid, "login": login, "type": kind},
            "created_at": created_at,
            "updated_at": created_at,
            "scopes": [],
        }

    def add_comment(
        self,
        cid: int,
        body: str,
        *,
        gid: int = 123456,
        login: str = "alice",
        kind: str = "User",
        pr: int = 7,
        repo: str = REPO,
        edited: bool = False,
        via: str | None = "kleidos-cla",
    ) -> None:
        self.comments[cid] = {
            "rest": {
                "id": cid,
                "node_id": f"IC_{cid}",
                "user": {"id": gid, "login": login, "type": kind},
                "performed_via_github_app": {"id": 4242, "slug": via} if via else None,
            },
            "node": {
                "createdAt": "2026-12-01T10:22:31Z",
                "lastEditedAt": "2026-12-01T10:30:00Z" if edited else None,
                "editor": None,
                "body": body,
                "author": {"login": login, "databaseId": gid if kind == "User" else None},
                "pullRequest": {"number": pr, "repository": {"nameWithOwner": repo}},
            },
        }

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> tuple[int, bytes] | tuple[int, bytes, dict[str, str]]:
        path = url.removeprefix("https://api.github.com")
        data: dict[str, Any] = json.loads(body) if body else {}

        def ok(d: object) -> tuple[int, bytes]:
            return 200, json.dumps(d).encode()

        if path.startswith("/applications/"):
            basic = (
                "Basic " + base64.b64encode(f"{SIGNIN_CLIENT_ID}:{SIGNIN_SECRET}".encode()).decode()
            )
            if headers.get("authorization") != basic or path.split("/")[2] != SIGNIN_CLIENT_ID:
                return 401, b'{"message":"Bad credentials"}'
            token = (data or {}).get("access_token", "")
            if path.endswith("/token") and method == "POST":
                answer = self.signin.get(token)
                return (
                    (200, json.dumps(answer).encode(), {"date": self.date})
                    if answer
                    else (404, b'{"message":"Not Found"}')
                )
            if path.endswith("/grant") and method == "DELETE":
                if token in self.signin:
                    del self.signin[token]
                    self.revoked.append(token)
                    return 204, b""
                return 404, b'{"message":"Not Found"}'
        if path == "/graphql":
            q, v = data["query"], data["variables"]
            if "createCommitOnBranch" in q:
                inp = v["input"]
                if self.conflicts:
                    self.conflicts -= 1
                    return ok({"errors": [{"type": "STALE_DATA"}]})
                if inp["expectedHeadOid"] != self.head:
                    return ok({"errors": [{"type": "STALE_DATA"}]})
                for add in inp["fileChanges"]["additions"]:
                    raw = base64.b64decode(add["contents"])
                    key = f"signatures:{add['path']}"
                    if add["path"].endswith(".json"):
                        self.files[key] = raw.decode()
                    else:
                        self.blobs[key] = raw
                    self.writes.append(
                        (inp["branch"]["branchName"], add["path"], inp["message"]["headline"])
                    )
                for d in inp["fileChanges"].get("deletions", []):
                    self.files.pop(f"signatures:{d['path']}", None)
                    self.blobs.pop(f"signatures:{d['path']}", None)
                    self.deleted.append(d["path"])
                self.head = ("%040x" % (int(self.head, 16) + 1))[-40:]
                return ok(
                    {"data": {"createCommitOnBranch": {"commit": {"oid": self.head, "url": "x"}}}}
                )
            if "ref(qualifiedName" in q:
                return ok({"data": {"repository": {"ref": {"target": {"oid": self.head}}}}})
            if "node(id" in q:
                cid = int(v["id"].removeprefix("IC_"))
                return ok({"data": {"node": self.comments[cid]["node"]}})
            if "pullRequest(number" in q:
                every = self.commits[v["number"]]
                listed = every[: self.cap]
                start = int(v["cursor"] or 0)
                nodes = listed[start : start + 100]
                end = start + len(nodes)
                return ok(
                    {
                        "data": {
                            "repository": {
                                "pullRequest": {
                                    "commits": {
                                        "totalCount": len(every),
                                        "pageInfo": {
                                            "hasNextPage": end < len(listed),
                                            "endCursor": str(end),
                                        },
                                        "nodes": [{"commit": c} for c in nodes],
                                    }
                                }
                            }
                        }
                    }
                )
        if path.startswith(f"/repos/{REGISTRY}/contents/"):
            p, ref = path.removeprefix(f"/repos/{REGISTRY}/contents/").split("?ref=")
            text = self.files.get(f"{ref}:{p}")
            blob = self.blobs.get(f"{ref}:{p}")
            if blob is not None:
                return 200, blob
            if text is None:
                children = sorted(
                    k.split(":", 1)[1].rsplit("/", 1)[1]
                    for k in [*self.files, *self.blobs]
                    if k.startswith(f"{ref}:{p}/")
                )
                return (
                    ok([{"name": n, "type": "file"} for n in children])
                    if children
                    else (404, b'{"message":"Not Found"}')
                )
            return 200, text.encode()
        if path.startswith(f"/repos/{REGISTRY}/commits?"):
            gid = path.split("signatures/individual/")[1].split(".json")[0]
            forged = gid in self.forged
            return ok(
                [
                    {
                        "sha": "e" * 40,
                        "author": {"id": 666 if forged else cla.ACTIONS_BOT_ID},
                        "committer": {"login": "mallory" if forged else "web-flow"},
                        "commit": {"verification": {"verified": True, "reason": "valid"}},
                    }
                ]
            )
        if path.startswith("/repos/") and path.count("/") == 3:
            return ok({"private": path.removeprefix("/repos/") in self.private})
        if "/issues/comments/" in path:
            return ok(self.comments[int(path.rsplit("/", 1)[1])]["rest"])
        if "/pulls/" in path:
            return ok(self.pulls[int(path.rsplit("/", 1)[1])])
        return 404, b'{"message":"Not Found"}'


def ctx(
    fake: FakeGitHub,
    entities: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
    stamper: cla.Stamper | None = None,
) -> cla.Context:
    return cla.Context(
        cla.GitHub("t", transport=fake),
        REGISTRY,
        99,
        config or CONFIG,
        entities or [],
        stamper,
        "f" * 40,
    )


APP = cla.SigninApp(SIGNIN_CLIENT_ID, SIGNIN_SECRET)
TOKEN = "ghu_" + "A" * 36


def signin(
    fake: FakeGitHub,
    *,
    config: dict[str, Any] | None = None,
    stamper: cla.Stamper | None = None,
    gid: int = 123456,
    version: int = 2,
    lang: str = "en",
    token: str = TOKEN,
) -> str:
    fake.pulls.setdefault(7, {"number": 7})
    return cla.record_signin(
        ctx(fake, config=config or CONFIG_V2, stamper=stamper),
        APP,
        REPO,
        7,
        gid,
        version,
        lang,
        "0123456789abcdef0123456789abcdef01234567",
        token,
    )


def commit(
    gid: int, login: str, *, coauthor: str | None = None, listed: bool = True, merge: bool = False
) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = [
        {
            "email": f"{gid}+{login}@users.noreply.github.com",
            "user": {"databaseId": gid, "login": login},
        }
    ]
    message = "Change"
    if coauthor:
        message += f"\n\nCo-authored-by: X <{coauthor}>"
        if listed:
            nodes.append({"email": coauthor, "user": None})
    return {
        "oid": "c" * 40,
        "message": message,
        "authoredDate": "2026-12-01T10:00:00Z",
        "parents": {"totalCount": 2 if merge else 1},
        "authors": {"totalCount": len(nodes), "nodes": nodes},
    }


class RecordSign(unittest.TestCase):
    def test_records_a_genuine_web_acceptance(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        self.assertTrue(cla.record_sign(ctx(f), REPO, 7, 1).startswith("recorded"))
        rec = json.loads(f.files["signatures:signatures/individual/123456.json"])
        self.assertEqual(rec["method"], "web")
        self.assertEqual(rec["accepted_at"], "2026-12-01T10:22:31Z")
        self.assertEqual(rec["set_sha256"], CONFIG["versions"]["1"]["set_sha256"])
        self.assertEqual(rec["evidence"]["comment_body_sha256"], cla.sha256(SENTENCE))
        self.assertEqual(
            set(rec),
            {
                "schema",
                "kind",
                "github_id",
                "login_at_signing",
                "agreement",
                "version",
                "set_sha256",
                "accepted_at",
                "method",
                "evidence",
                "recorded_at",
                "recorder_run_id",
            },
        )
        self.assertEqual(f.writes[0][2], "sign: alice (123456) accepts version 1")

    def test_the_method_is_told_by_the_apps_id_not_its_slug(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        f.comments[1]["rest"]["performed_via_github_app"] = {"id": 9999, "slug": "kleidos-cla"}
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(
            json.loads(f.files["signatures:signatures/individual/123456.json"])["method"], "comment"
        )

    def test_a_typed_comment_with_extra_whitespace_is_method_comment(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, "  " + SENTENCE.replace(" ", "\n ") + "\n", via=None)
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(
            json.loads(f.files["signatures:signatures/individual/123456.json"])["method"], "comment"
        )

    def test_refusals_write_nothing(self) -> None:
        cases = {
            "edited": {"body": SENTENCE, "edited": True},
            "other pull request": {"body": SENTENCE, "pr": 8},
            "other repository": {"body": SENTENCE, "repo": "kleidos-dev/other"},
            "a bot": {"body": SENTENCE, "kind": "Bot", "login": "x[bot]"},
            "extra text": {"body": SENTENCE + " Thanks!"},
            "other version": {"body": SENTENCE.replace("version 1", "version 2")},
            "other digest": {"body": SENTENCE.replace("89c1d46b9b10", "89c1d46b9b11")},
            "look-alike unicode": {"body": SENTENCE.replace("a", "а", 1)},
        }
        for name, kw in cases.items():
            with self.subTest(name):
                f = FakeGitHub()
                body = kw.pop("body")
                f.add_comment(1, body, **kw)
                with self.assertRaises(cla.Refused):
                    cla.record_sign(ctx(f), REPO, 7, 1)
                self.assertEqual(f.writes, [])

    def test_repository_not_served_or_private(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE, repo="kleidos-dev/boards")
        with self.assertRaises(cla.Refused):
            cla.record_sign(ctx(f), "kleidos-dev/boards", 7, 1)
        f.private.add(REPO)
        f.add_comment(2, SENTENCE)
        with self.assertRaises(cla.Refused):
            cla.record_sign(ctx(f), REPO, 7, 2)
        self.assertEqual(f.writes, [])

    def test_an_existing_record_is_success_without_a_commit(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        f.add_comment(2, SENTENCE)
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(cla.record_sign(ctx(f), REPO, 7, 2), "already recorded")
        self.assertEqual(len(f.writes), 1)

    def test_the_head_moving_between_read_and_write_is_retried(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        f.conflicts = 2
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(len(f.writes), 1)
        f2 = FakeGitHub()
        f2.add_comment(1, SENTENCE)
        f2.conflicts = 9
        with self.assertRaises(RuntimeError):
            cla.record_sign(ctx(f2), REPO, 7, 1)


class RecordSignin(unittest.TestCase):
    def test_records_a_sign_in_github_vouches_for_and_deletes_the_grant(self) -> None:
        f = FakeGitHub()
        f.add_signin(TOKEN)
        stamper = FakeStamper()
        self.assertTrue(signin(f, stamper=stamper).startswith("recorded"))
        text = f.files["signatures:signatures/individual/123456.json"]
        rec = json.loads(text)
        self.assertEqual(rec["schema"], 2)
        self.assertEqual(rec["method"], "signin")
        self.assertEqual(rec["version"], 2)
        self.assertEqual(rec["set_sha256"], CONFIG["versions"]["2"]["set_sha256"])
        self.assertEqual(rec["sentence_sha256"], cla.sha256(CONFIG["versions"]["2"]["sentence"]))
        # Both times are GitHub's: the Date of its answer and the token's creation.
        self.assertEqual(rec["accepted_at"], "2026-12-01T10:22:58Z")
        self.assertEqual(rec["evidence"]["authorized_at"], "2026-12-01T10:22:31Z")
        self.assertEqual(
            rec["evidence"],
            {
                "authorized_at": "2026-12-01T10:22:31Z",
                "signin_client_id": SIGNIN_CLIENT_ID,
                "context_pr_url": f"https://github.com/{REPO}/pull/7",
                "site_commit": "0123456789abcdef0123456789abcdef01234567",
                "lang": "en",
            },
        )
        self.assertEqual(rec["recorder_commit"], "f" * 40)
        self.assertIsNone(cla.check_record(CONFIG_V2, "signatures/individual/123456.json", text))
        # The token is over the file's exact bytes, in the same commit.
        self.assertEqual(
            f.blobs["signatures:signatures/individual/123456.tsr"],
            f"TSR:{cla.sha256(text.encode())}".encode(),
        )
        self.assertEqual(
            {w[1] for w in f.writes},
            {"signatures/individual/123456.json", "signatures/individual/123456.tsr"},
        )
        self.assertEqual(f.revoked, [TOKEN])
        self.assertNotIn(TOKEN, text)

    def test_refusals_write_nothing_and_still_delete_the_grant(self) -> None:
        cases: dict[str, dict[str, Any]] = {
            "another account": {"signin": {"gid": 999}},
            "a bot": {"signin": {"kind": "Bot", "login": "x[bot]"}},
            "an old sign-in": {"signin": {"created_at": "2026-12-01T07:00:00Z"}},
            "a sign-in from the future": {"signin": {"created_at": "2026-12-01T11:00:00Z"}},
            "version 1 is not a sign-in version": {
                "call": {"version": 1},
                "config": {**CONFIG_V2, "current_version": 1},
            },
            "not the current version": {"call": {"version": 1}},
            "another app in the config": {
                "config": {**CONFIG_V2, "signin_client_id": "Iv23liSOMEOTHERAPP01"}
            },
            "no app in the config": {"config": {**CONFIG_V2, "signin_client_id": None}},
            "an unknown language": {"call": {"lang": "fr"}},
        }
        for name, c in cases.items():
            with self.subTest(name):
                f = FakeGitHub()
                f.add_signin(TOKEN, **c.get("signin", {}))
                with self.assertRaises(cla.Refused):
                    signin(f, config=c.get("config"), **c.get("call", {}))
                self.assertEqual(f.writes, [])
                if "signin" in c:
                    self.assertEqual(f.revoked, [TOKEN])

    def test_a_token_of_another_app_or_unknown_to_github(self) -> None:
        f = FakeGitHub()
        f.add_signin(TOKEN, client_id="Iv23liSOMEOTHERAPP01")
        with self.assertRaises(cla.Refused):
            signin(f)
        f2 = FakeGitHub()
        with self.assertRaises(cla.Refused):
            signin(f2)
        self.assertEqual(f.writes + f2.writes, [])

    def test_an_existing_record_of_that_version_is_success_without_a_commit(self) -> None:
        f = FakeGitHub()
        f.add_signin(TOKEN)
        signin(f, stamper=FakeStamper())
        second = "ghu_" + "B" * 36
        f.add_signin(second)
        self.assertEqual(signin(f, token=second), "already recorded")
        self.assertEqual(f.revoked, [TOKEN, second])

    def test_no_token_from_the_authority_still_records_and_drops_a_stale_one(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        cla.record_sign(ctx(f, stamper=FakeStamper()), REPO, 7, 1)
        self.assertIn("signatures:signatures/individual/123456.tsr", f.blobs)
        f.add_signin(TOKEN)
        out = signin(f, stamper=FakeStamper(up=False))
        self.assertIn("no time-stamp token yet", out)
        self.assertEqual(
            json.loads(f.files["signatures:signatures/individual/123456.json"])["version"], 2
        )
        self.assertNotIn("signatures:signatures/individual/123456.tsr", f.blobs)
        self.assertEqual(f.deleted, ["signatures/individual/123456.tsr"])

    def test_the_token_is_read_from_the_event_and_must_look_like_one(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            event = Path(d) / "event.json"
            event.write_text(json.dumps({"inputs": {"signin_token": TOKEN}}))
            self.assertEqual(cla.signin_token_from_event(str(event)), TOKEN)
            event.write_text(json.dumps({"inputs": {"signin_token": "ghs_installation"}}))
            with self.assertRaises(cla.Refused):
                cla.signin_token_from_event(str(event))
        with self.assertRaises(cla.Refused):
            cla.signin_token_from_event("/nonexistent")


class RecordStamps(unittest.TestCase):
    def test_adds_the_missing_tokens_of_recorder_written_records_only(self) -> None:
        f = FakeGitHub()
        for cid, gid in ((1, 111111), (2, 222222), (3, 333333)):
            f.add_comment(cid, SENTENCE, gid=gid, login=f"u{gid}")
            cla.record_sign(ctx(f), REPO, 7, cid)
        f.forged.add("333333")
        f.blobs["signatures:signatures/individual/222222.tsr"] = b"TSR:x"
        stamper = FakeStamper()
        self.assertEqual(cla.record_stamps(ctx(f, stamper=stamper)), "stamped 1 of 2")
        text = f.files["signatures:signatures/individual/111111.json"]
        self.assertEqual(
            f.blobs["signatures:signatures/individual/111111.tsr"],
            f"TSR:{cla.sha256(text.encode())}".encode(),
        )
        self.assertNotIn("signatures:signatures/individual/333333.tsr", f.blobs)
        self.assertEqual(f.writes[-1][2], "stamp: 111111")

    def test_an_authority_that_is_down_stops_the_run(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(cla.record_stamps(ctx(f, stamper=FakeStamper(up=False))), "stamped 0 of 1")


@unittest.skipUnless(shutil.which("openssl"), "needs openssl")
class Timestamps(unittest.TestCase):
    """A real qualified token from Sectigo's /qualified endpoint, over 64 random bytes.

    Kept in tests/fixtures."""

    ROOTS = (cla.ROOT / "registry/tsa/sectigo-qualified-time-stamping-root-r45.pem",)

    def test_the_fixture_verifies_against_the_pinned_root_and_nothing_else(self) -> None:
        tsr = (FIXTURES / "sectigo-qualified.tsr").read_bytes()
        digest = cla.sha256((FIXTURES / "sectigo-qualified.data").read_bytes())
        self.assertIsNone(cla.verify_tsr(tsr, digest, list(self.ROOTS), True))
        self.assertEqual(
            cla.verify_tsr(tsr, "0" * 64, list(self.ROOTS), True),
            "the time-stamp token does not verify",
        )
        self.assertEqual(
            cla.verify_tsr(b"not a token", digest, list(self.ROOTS), True),
            "the time-stamp token does not parse",
        )
        self.assertEqual(
            cla.tsr_time(cla.tsr_text(tsr) or ""), cla.parse_time("2026-11-23T01:18:44Z")
        )

    def test_a_query_is_a_well_formed_rfc3161_request(self) -> None:
        digest = cla.sha256(b"x")
        with tempfile.TemporaryDirectory() as d:
            q = Path(d) / "q.tsq"
            q.write_bytes(cla.timestamp_query(digest, 0x8000000000000001))
            out = subprocess.run(
                ["openssl", "ts", "-query", "-in", str(q), "-text"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        self.assertIn("Hash Algorithm: sha256", out)
        self.assertIn("Nonce: 0x8000000000000001", out)
        self.assertIn("Certificate required: yes", out)
        self.assertIn(" ".join(digest[i : i + 2] for i in range(0, 16, 2)), out.replace("-", " "))

    def test_the_stamper_retries_once_then_gives_up(self) -> None:
        calls: list[str] = []

        def down(
            method: str, url: str, headers: dict[str, str], body: bytes | None
        ) -> tuple[int, bytes]:
            calls.append(headers["content-type"])
            return 503, b""

        waits: list[float] = []
        s = cla.TSAStamper(
            "http://tsa.invalid/", list(self.ROOTS), True, transport=down, sleep=waits.append
        )
        self.assertIsNone(s.stamp(cla.sha256(b"x")))
        self.assertEqual(calls, ["application/timestamp-query"] * 2)
        self.assertEqual(len(waits), 1)
        self.assertGreater(waits[0], 14)


class RecordCoverage(unittest.TestCase):
    def merged(
        self,
        f: FakeGitHub,
        commits: list[dict[str, Any]],
        opener: tuple[int, str] = (123456, "alice"),
    ) -> None:
        f.pulls[7] = {
            "number": 7,
            "merged": True,
            "merge_commit_sha": "d" * 40,
            "created_at": "2026-12-01T08:00:00Z",
            "merged_at": "2026-12-02T09:00:00Z",
            "user": {"id": opener[0], "login": opener[1], "type": "User"},
        }
        f.commits[7] = commits

    def sign(self, f: FakeGitHub, gid: int, login: str) -> None:
        cid = len(f.comments) + 1
        f.add_comment(cid, SENTENCE, gid=gid, login=login)
        cla.record_sign(ctx(f), REPO, 7, cid)

    def test_writes_the_coverage_of_signed_and_exempt_authors(self) -> None:
        f = FakeGitHub()
        self.sign(f, 123456, "alice")
        self.sign(f, 234567, "bob")
        self.merged(
            f,
            [
                commit(123456, "alice", coauthor="234567+bob@users.noreply.github.com"),
                commit(49699333, "dependabot[bot]"),
                commit(123456, "alice", merge=True),
            ],
        )
        cla.record_coverage(ctx(f), REPO, 7)
        rec = json.loads(f.files["signatures:coverage/kleidos-dev/cla-sandbox/7.json"])
        self.assertEqual(rec["github_ids"], [123456, 234567])
        self.assertEqual(rec["versions"], {"123456": 1, "234567": 1})
        self.assertEqual(rec["merge_sha"], "d" * 40)

    def test_a_missing_signature_or_an_unknown_author_writes_nothing(self) -> None:
        f = FakeGitHub()
        self.sign(f, 123456, "alice")
        self.merged(f, [commit(123456, "alice"), commit(345678, "carol")])
        before = len(f.writes)
        with self.assertRaises(cla.Refused):
            cla.record_coverage(ctx(f), REPO, 7)
        self.merged(f, [commit(123456, "alice", coauthor="nobody@example.org", listed=False)])
        with self.assertRaises(cla.Refused):
            cla.record_coverage(ctx(f), REPO, 7)
        self.assertEqual(len(f.writes), before)

    def test_a_merge_commits_author_must_have_signed(self) -> None:
        f = FakeGitHub()
        self.sign(f, 123456, "alice")
        self.merged(f, [commit(123456, "alice"), commit(345678, "carol", merge=True)])
        with self.assertRaises(cla.Refused):
            cla.record_coverage(ctx(f), REPO, 7)

    def test_more_commits_than_github_lists_is_refused(self) -> None:
        f = FakeGitHub()
        self.sign(f, 123456, "alice")
        self.merged(f, [commit(123456, "alice")] * 150)
        cla.record_coverage(ctx(f), REPO, 7)
        f2 = FakeGitHub()
        self.sign(f2, 123456, "alice")
        self.merged(f2, [commit(123456, "alice")] * 250 + [commit(345678, "carol")])
        with self.assertRaises(cla.Refused):
            cla.record_coverage(ctx(f2), REPO, 7)
        # GitHub cutting the list below its own count is refused too.
        f3 = FakeGitHub()
        f3.cap = 100
        self.sign(f3, 123456, "alice")
        self.merged(f3, [commit(123456, "alice")] * 120)
        with self.assertRaises(cla.Refused):
            cla.record_coverage(ctx(f3), REPO, 7)

    def test_the_opener_is_dated_by_the_pull_requests_creation(self) -> None:
        f = FakeGitHub()
        self.merged(f, [commit(345678, "carol")], opener=(345678, "carol"))
        f.pulls[7]["created_at"] = "2026-11-05T08:00:00Z"
        f.pulls[7]["merged_at"] = "2026-11-20T08:00:00Z"
        f.commits[7][0]["authoredDate"] = "2026-11-05T07:00:00Z"
        ent = [
            {
                "slug": "e",
                "name": "Example GmbH",
                "version": 1,
                "set_sha256": CONFIG["versions"]["1"]["set_sha256"],
                "signed_at": "2026-11-01",
                "covered": [{"github_id": 345678, "from": "2026-11-01", "until": "2026-11-10"}],
            }
        ]
        cla.record_coverage(ctx(f, ent), REPO, 7)

    def test_entity_covered_accounts_need_no_signature(self) -> None:
        f = FakeGitHub()
        self.merged(f, [commit(345678, "carol")], opener=(345678, "carol"))
        ent = [
            {
                "slug": "e",
                "name": "Example GmbH",
                "version": 1,
                "set_sha256": CONFIG["versions"]["1"]["set_sha256"],
                "signed_at": "2026-11-01",
                "covered": [{"github_id": 345678, "from": "2026-11-01"}],
            }
        ]
        cla.record_coverage(ctx(f, ent), REPO, 7)
        self.assertEqual(
            json.loads(f.files["signatures:coverage/kleidos-dev/cla-sandbox/7.json"])["github_ids"],
            [],
        )


RECORDER = cla.Facts(cla.ACTIONS_BOT_ID, None, "noreply@github.com", True, True)
OWNER = cla.Facts(cla.OWNER_ID, cla.OWNER_ID, "jmrplens@kleidos.dev", True, False)


class FakeWitness(cla.Witness):
    """The comment and the run every record cites, as GitHub would answer for a genuine record."""

    def __init__(self) -> None:
        self.comments: dict[int, dict[str, Any] | None] = {}
        self.runs: dict[int, dict[str, Any] | None] = {}

    def genuine(self, rec: dict[str, Any], body: str = SENTENCE) -> None:
        ev = rec["evidence"]
        repo, pr = ev["pr_url"].removeprefix("https://github.com/").split("/pull/")
        self.comments[ev["comment_id"]] = {
            "author_id": rec["github_id"],
            "edited": False,
            "created_at": rec["accepted_at"],
            "body": body,
            "pr": int(pr),
            "repo": repo,
        }
        self.runs[rec["recorder_run_id"]] = self.run_for(
            f"Record sign {repo}#{pr} {ev['comment_id']}"
        )

    @staticmethod
    def run_for(title: str, **kw: Any) -> dict[str, Any]:
        return {
            "repository": {"full_name": REGISTRY},
            "path": ".github/workflows/record.yml",
            "event": "workflow_dispatch",
            "head_branch": "main",
            "display_title": title,
            "status": "completed",
            "conclusion": "success",
            **kw,
        }

    def comment(self, repo: str, comment_id: int) -> dict[str, Any] | None:
        return self.comments.get(comment_id)

    def run(self, run_id: int) -> dict[str, Any] | None:
        return self.runs.get(run_id)


class Verify(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.git("init", "-q", "-b", "signatures")
        self.git("config", "commit.gpgsign", "false")
        self.facts: dict[str, cla.Facts] = {}
        self.witness = FakeWitness()
        self.commit_as(OWNER, "Start the register", {"README.md": "register\n"})

    def tearDown(self) -> None:
        self.dir.cleanup()

    def git(self, *args: str, env: dict[str, str] | None = None) -> str:
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        ).stdout.strip()

    def commit_as(
        self, facts: cla.Facts, subject: str, files: dict[str, str], remove: list[str] | None = None
    ) -> str:
        for p, text in files.items():
            (self.root / p).parent.mkdir(parents=True, exist_ok=True)
            (self.root / p).write_text(text)
            self.git("add", p)
        for p in remove or []:
            self.git("rm", "-q", p)
        name = cla.ACTIONS_BOT if facts.author_id == cla.ACTIONS_BOT_ID else "someone"
        env = {
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": "x@example.org",
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": "x@example.org",
            "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            "HOME": self.dir.name,
        }
        self.git("commit", "-q", "--allow-empty", "-m", subject, env=env)
        sha = self.git("rev-parse", "HEAD")
        self.facts[sha] = facts
        return sha

    _cid = 100

    def record(
        self, gid: int, digest: str | None = None, version: int = 1, **over: Any
    ) -> dict[str, Any]:
        Verify._cid += 1
        cid = Verify._cid
        rec = {
            "schema": 1,
            "kind": "individual",
            "github_id": gid,
            "login_at_signing": "alice",
            "agreement": "kleidos-ca",
            "version": version,
            "set_sha256": digest or CONFIG["versions"]["1"]["set_sha256"],
            "accepted_at": "2026-12-01T10:22:31Z",
            "method": "web",
            "evidence": {
                "pr_url": f"https://github.com/{REPO}/pull/7",
                "comment_url": f"https://github.com/{REPO}/pull/7#issuecomment-{cid}",
                "comment_id": cid,
                "comment_body_sha256": cla.sha256(SENTENCE),
            },
            "recorded_at": "2026-12-01T10:23:02Z",
            "recorder_run_id": cid * 10,
        }
        rec.update(over)
        return rec

    def sign(self, gid: int, facts: cla.Facts = RECORDER, genuine: bool = True, **over: Any) -> str:
        rec = self.record(gid, **over)
        if genuine:
            self.witness.genuine(rec)
        return self.commit_as(
            facts, f"sign: {gid}", {f"signatures/individual/{gid}.json": json.dumps(rec)}
        )

    def run_verify(
        self, since: str | None = None, config: dict[str, Any] | None = None, witness: bool = True
    ) -> cla.Verified:
        return cla.verify_history(
            self.root,
            config or CONFIG,
            "signatures",
            since,
            self.facts.get,
            self.witness if witness else None,
            REGISTRY,
        )

    def verify(self, since: str | None = None, config: dict[str, Any] | None = None) -> list[str]:
        return [f.problem for f in self.run_verify(since, config).findings]

    def test_a_clean_history_passes(self) -> None:
        self.sign(1)
        self.witness.runs[555] = FakeWitness.run_for(f"Record coverage {REPO}#7")
        last = self.commit_as(
            RECORDER,
            "coverage: x",
            {
                "coverage/kleidos-dev/cla-sandbox/7.json": json.dumps(
                    {"kind": "coverage", "repo": REPO, "pr": 7, "recorder_run_id": 555}
                )
            },
        )
        v = self.run_verify()
        self.assertEqual(v.findings, [])
        self.assertEqual(v.checked_through, last)

    def test_a_commit_touching_two_files(self) -> None:
        self.commit_as(
            RECORDER,
            "sign",
            {
                "signatures/individual/1.json": json.dumps(self.record(1)),
                "signatures/individual/2.json": json.dumps(self.record(2)),
            },
        )
        self.assertTrue(any("changes 2 files" in p for p in self.verify()))

    def test_a_commit_not_made_and_signed_by_the_recorder(self) -> None:
        # Not github-actions[bot]; github-actions[bot] by email only, signed with the pusher's own
        # key; not GitHub's committer.
        for facts in (
            cla.Facts(666, 666, "m@example.org", True, False),
            cla.Facts(cla.ACTIONS_BOT_ID, 666, "m@example.org", True, False),
            cla.Facts(cla.ACTIONS_BOT_ID, None, "noreply@github.com", False, True),
            cla.Facts(cla.ACTIONS_BOT_ID, None, "m@example.org", True, True),
        ):
            with self.subTest(facts):
                self.tearDown()
                self.setUp()
                self.sign(1, facts)
                self.assertTrue(any("not by the recorder" in p for p in self.verify()))

    def test_a_github_signed_commit_from_elsewhere_fails_the_cross_check(self) -> None:
        # A record minted by createCommitOnBranch in a fork passes every commit fact; its evidence
        # does not.
        cases: dict[str, dict[str, dict[str, Any] | None]] = {
            "the run is not this repository's": {
                "run": {"repository": {"full_name": "mallory/cla"}}
            },
            "the run recorded something else": {
                "run": {"display_title": "Record sign kleidos-dev/cla-sandbox#7 1"}
            },
            "the run is unknown": {"run": None},
            "the run failed": {"run": {"conclusion": "failure"}},
            "the comment is another account's": {"comment": {"author_id": 999}},
            "the comment was edited": {"comment": {"edited": True}},
            "the comment is gone": {"comment": None},
            "the comment says something else": {"comment": {"body": SENTENCE + " x"}},
            "the time is not the comment's": {"comment": {"created_at": "2020-01-01T00:00:00Z"}},
        }
        for name, change in cases.items():
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                rec = self.record(1)
                self.witness.genuine(rec)
                cid, rid = rec["evidence"]["comment_id"], rec["recorder_run_id"]
                # genuine() above gave the record its run and its comment.
                if "run" in change:
                    run_change, run = change["run"], self.witness.runs[rid] or {}
                    self.witness.runs[rid] = None if run_change is None else {**run, **run_change}
                if "comment" in change:
                    comment_change, comment = change["comment"], self.witness.comments[cid] or {}
                    self.witness.comments[cid] = (
                        None if comment_change is None else {**comment, **comment_change}
                    )
                self.commit_as(
                    RECORDER, "sign: 1", {"signatures/individual/1.json": json.dumps(rec)}
                )
                v = self.run_verify()
                self.assertTrue(v.findings, name)
                self.assertIsNone(v.checked_through)

    def test_only_records_after_since_are_cross_checked_and_a_running_recorder_waits(self) -> None:
        old = self.sign(1, genuine=False)
        self.assertEqual(self.verify(since=old), [])
        second = self.sign(2)
        rec3 = self.record(3)
        self.witness.genuine(rec3)
        run3 = self.witness.runs[rec3["recorder_run_id"]]
        assert run3 is not None  # genuine() gave the record its run
        run3["status"] = "in_progress"
        self.commit_as(RECORDER, "sign: 3", {"signatures/individual/3.json": json.dumps(rec3)})
        v = self.run_verify(since=old)
        self.assertEqual(v.findings, [])
        self.assertEqual(v.checked_through, second)

    def test_a_wrong_digest_a_mismatched_path_or_a_malformed_field(self) -> None:
        self.sign(1, digest="0" * 64)
        self.sign(3, github_id=4)
        self.sign(5, accepted_at="**now** [x](https://evil.example)")
        self.sign(6, recorder_run_id="1")
        problems = self.verify()
        self.assertTrue(any("not a published one" in p for p in problems))
        self.assertTrue(any("does not match its path" in p for p in problems))
        self.assertEqual(sum("malformed record" in p for p in problems), 2)

    def test_a_version_no_longer_accepted_still_verifies(self) -> None:
        # Everyone signs again under version 2: the version 1 records stay valid history.
        self.sign(1)
        config = json.loads(json.dumps(CONFIG))
        config["versions"]["2"] = {
            **config["versions"]["1"],
            "set_sha256": "f" * 64,
            "path": "agreements/v2",
        }
        config["accepted_versions"] = [2]
        config["current_version"] = 2
        self.assertEqual(self.verify(config=config), [])
        self.assertFalse(cla.record_valid(config, self.record(1)))

    def test_a_deletion_or_a_file_elsewhere(self) -> None:
        self.sign(1)
        self.commit_as(RECORDER, "drop", {}, remove=["signatures/individual/1.json"])
        self.commit_as(RECORDER, "other", {"notes.txt": "x"})
        problems = self.verify()
        self.assertTrue(any(p.startswith("D signatures/individual/1.json") for p in problems))
        self.assertTrue(any(p.startswith("A notes.txt") for p in problems))

    def signin_record(self, gid: int, **over: Any) -> dict[str, Any]:
        Verify._cid += 1
        rec = {
            "schema": 2,
            "kind": "individual",
            "github_id": gid,
            "login_at_signing": "alice",
            "agreement": "kleidos-ca",
            "version": 2,
            "set_sha256": CONFIG["versions"]["2"]["set_sha256"],
            "sentence_sha256": cla.sha256(CONFIG["versions"]["2"]["sentence"]),
            "accepted_at": "2026-12-01T10:22:58Z",
            "method": "signin",
            "evidence": {
                "authorized_at": "2026-12-01T10:22:31Z",
                "signin_client_id": SIGNIN_CLIENT_ID,
                "context_pr_url": f"https://github.com/{REPO}/pull/7",
                "site_commit": "0123456789abcdef0123456789abcdef01234567",
                "lang": "es",
            },
            "recorded_at": "2026-12-01T10:23:02Z",
            "recorder_run_id": Verify._cid * 10,
            "recorder_commit": "c" * 40,
        }
        rec.update(over)
        self.witness.runs[rec["recorder_run_id"]] = FakeWitness.run_for(
            f"Record signin {REPO}#7 {gid}", head_sha="c" * 40
        )
        return rec

    @staticmethod
    def token_for(text: str) -> str:
        return f"TSR:{cla.sha256(text.encode())}"

    def test_a_signin_record_with_its_token_verifies(self) -> None:
        with mock.patch.object(cla, "verify_tsr", fake_verify_tsr):
            text = json.dumps(self.signin_record(1))
            self.commit_as(
                RECORDER,
                "sign: alice (1) accepts version 2",
                {
                    "signatures/individual/1.json": text,
                    "signatures/individual/1.tsr": self.token_for(text),
                },
            )
            # A record written while the authority was down, and its token added
            # by a later stamp run.
            text2 = json.dumps(self.signin_record(2))
            self.commit_as(
                RECORDER, "sign: bob (2) accepts version 2", {"signatures/individual/2.json": text2}
            )
            last = self.commit_as(
                RECORDER, "stamp: 2", {"signatures/individual/2.tsr": self.token_for(text2)}
            )
            v = self.run_verify(config=CONFIG_V2)
            self.assertEqual(v.findings, [])
            self.assertEqual(v.checked_through, last)

    def test_a_signin_record_its_run_does_not_vouch_for(self) -> None:
        cases = {
            "another commit of main": {"run": {"head_sha": "d" * 40}},
            "another account": {"run": {"display_title": f"Record signin {REPO}#7 999"}},
            "another app": {"config": {**CONFIG_V2, "signin_client_id": "Iv23liSOMEOTHERAPP01"}},
            "the run failed": {"run": {"conclusion": "failure"}},
        }
        for name, change in cases.items():
            with self.subTest(name), mock.patch.object(cla, "verify_tsr", fake_verify_tsr):
                self.tearDown()
                self.setUp()
                rec = self.signin_record(1)
                rid = rec["recorder_run_id"]
                if "run" in change:
                    self.witness.runs[rid] = {**self.witness.runs[rid], **change["run"]}  # type: ignore[dict-item]
                self.commit_as(
                    RECORDER, "sign: 1", {"signatures/individual/1.json": json.dumps(rec)}
                )
                self.assertTrue(
                    self.run_verify(config=change.get("config", CONFIG_V2)).findings, name
                )

    def test_a_malformed_signin_record(self) -> None:
        cases = {
            "an unknown field": {"ip": "203.0.113.7"},
            "the comment method": {"method": "comment"},
            "another sentence": {"sentence_sha256": "0" * 64},
            "a version that is not a sign-in one": {
                "version": 1,
                "set_sha256": CONFIG["versions"]["1"]["set_sha256"],
            },
            "a language": {
                "evidence": {
                    "authorized_at": "2026-12-01T10:22:31Z",
                    "signin_client_id": SIGNIN_CLIENT_ID,
                    "context_pr_url": f"https://github.com/{REPO}/pull/7",
                    "site_commit": "0" * 40,
                    "lang": "fr",
                }
            },
            "authorized after the acceptance": {
                "evidence": {
                    "authorized_at": "2026-12-01T11:22:31Z",
                    "signin_client_id": SIGNIN_CLIENT_ID,
                    "context_pr_url": f"https://github.com/{REPO}/pull/7",
                    "site_commit": "0" * 40,
                    "lang": "en",
                }
            },
        }
        for name, over in cases.items():
            with self.subTest(name):
                self.assertIsNotNone(
                    cla.check_record(
                        CONFIG_V2,
                        "signatures/individual/1.json",
                        json.dumps(self.signin_record(1, **over)),
                    ),
                    name,
                )

    def test_a_stale_forged_or_lone_token(self) -> None:
        with mock.patch.object(cla, "verify_tsr", fake_verify_tsr):
            text = json.dumps(self.signin_record(1))
            self.commit_as(
                RECORDER,
                "sign: 1",
                {
                    "signatures/individual/1.json": text,
                    "signatures/individual/1.tsr": self.token_for(text),
                },
            )
            # The record replaced, its old token left behind: the token no longer matches.
            self.commit_as(
                RECORDER,
                "sign: 1 again",
                {
                    "signatures/individual/1.json": json.dumps(
                        self.signin_record(1, login_at_signing="alice2")
                    )
                },
            )
            problems = self.verify(config=CONFIG_V2)
            self.assertTrue(
                any("1.tsr: the time-stamp token does not verify" in p for p in problems)
            )
        for name, files in {
            "a token over something else": {"signatures/individual/3.tsr": "TSR:" + "0" * 64},
            "a token changed alone": {"signatures/individual/3.tsr": "x"},
            "a token with no record": {"signatures/individual/4.tsr": "TSR:" + "0" * 64},
        }.items():
            with self.subTest(name), mock.patch.object(cla, "verify_tsr", fake_verify_tsr):
                self.tearDown()
                self.setUp()
                text = json.dumps(self.signin_record(3))
                self.commit_as(
                    RECORDER,
                    "sign: 3",
                    {
                        "signatures/individual/3.json": text,
                        "signatures/individual/3.tsr": self.token_for(text),
                    },
                )
                self.commit_as(RECORDER, "stamp", files)
                self.assertTrue(self.verify(config=CONFIG_V2), name)

    def test_a_rewritten_history(self) -> None:
        old = self.sign(1)
        self.git("reset", "-q", "--hard", "HEAD~1")
        self.sign(2)
        self.assertTrue(any("rewritten" in p for p in self.verify(since=old)))

    def test_the_owners_redact_and_entity_commits(self) -> None:
        self.sign(1)
        self.commit_as(
            OWNER,
            "redact: remove account 1 at its holder's request",
            {},
            remove=["signatures/individual/1.json"],
        )
        self.assertEqual(self.verify(), [])
        self.commit_as(OWNER, "tidy up", {"x.txt": "x"})
        self.assertTrue(self.verify())

    def test_a_redact_commit_by_somebody_else(self) -> None:
        self.sign(1)
        # Authored as the owner (by email) but not committed or signed by him.
        self.commit_as(
            cla.Facts(cla.OWNER_ID, 666, "m@example.org", False, False),
            "redact: remove account 1",
            {},
            remove=["signatures/individual/1.json"],
        )
        self.assertTrue(self.verify())


class VerifyWorkflows(unittest.TestCase):
    def test_a_disabled_recorder_or_verifier_is_a_problem(self) -> None:
        states = {"record.yml": "active", "verify.yml": "disabled_manually"}

        def transport(
            method: str, url: str, headers: dict[str, str], body: bytes | None
        ) -> tuple[int, bytes]:
            return 200, json.dumps({"state": states[url.rsplit("/", 1)[1]]}).encode()

        problems = [
            f.problem for f in cla.verify_workflows(cla.GitHub("t", transport=transport), REGISTRY)
        ]
        self.assertEqual(problems, ["the workflow verify.yml is disabled_manually, not active"])


class VerifyCoverage(unittest.TestCase):
    def test_a_merged_pull_request_without_coverage(self) -> None:
        f = FakeGitHub()
        f.files["signatures:coverage/kleidos-dev/cla-sandbox/1.json"] = "{}"

        def transport(
            method: str, url: str, headers: dict[str, str], body: bytes | None
        ) -> tuple[int, bytes] | tuple[int, bytes, dict[str, str]]:
            if "/pulls?state=closed" in url:
                repo = url.split("/repos/")[1].split("/pulls")[0]
                # 4 was merged a minute ago: its recorder run may still be queued, so it is not a
                # problem yet.
                just = cla.now()
                pulls = (
                    [
                        {"number": 1, "merged_at": "2026-11-02T00:00:00Z"},
                        {"number": 2, "merged_at": "2026-11-03T00:00:00Z"},
                        {"number": 3, "merged_at": None},
                        {"number": 4, "merged_at": just},
                    ]
                    if repo == REPO
                    else []
                )
                return 200, json.dumps(pulls).encode()
            return f(method, url, headers, body)

        problems = [
            x.problem
            for x in cla.verify_coverage(
                cla.GitHub("t", transport=transport), CONFIG, REGISTRY, "2026-11-01"
            )
        ]
        self.assertEqual(problems, [f"{REPO}#2 was merged with no coverage record"])


class Helpers(unittest.TestCase):
    def test_the_shared_normalization_vectors(self) -> None:
        vectors = json.loads((Path(__file__).parent / "normalize-vectors.json").read_text("utf-8"))[
            "vectors"
        ]
        for v in vectors:
            self.assertEqual(cla.normalize(v["in"]), v["out"], repr(v["in"]))

    def test_normalize_and_noreply(self) -> None:
        self.assertEqual(cla.normalize("  a \n\t b  "), "a b")
        self.assertEqual(cla.normalize("é"), "é")
        self.assertEqual(
            cla.parse_noreply("49699333+dependabot[bot]@users.noreply.github.com"),
            (49699333, "dependabot[bot]"),
        )
        self.assertIsNone(cla.parse_noreply("alice@example.org"))

    def test_the_config_is_consistent(self) -> None:
        for v, info in CONFIG["versions"].items():
            root = cla.ROOT / info["path"]
            sums = (root / "SHA256SUMS").read_bytes()
            self.assertEqual(cla.sha256(sums), info["set_sha256"])
            self.assertIn(f"version {v} (SHA-256 {info['set_sha256'][:12]})", info["sentence"])
            self.assertIn(info["flow"], ("comment", "signin"))
        self.assertIn(CONFIG["current_version"], CONFIG["accepted_versions"])
        for root in CONFIG["timestamping"]["roots"]:
            self.assertTrue(
                (cla.ROOT / root).read_text("ascii").startswith("-----BEGIN CERTIFICATE-----")
            )
        ids = [e["id"] for e in CONFIG["exempt"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue({28966312, 49699333, 41898282} <= set(ids))


if __name__ == "__main__":
    unittest.main()
