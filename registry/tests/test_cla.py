# SPDX-License-Identifier: MIT
"""Tests of registry/cla.py: the recorder against a fake GitHub, the verifier against real git histories."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla  # noqa: E402

CONFIG = cla.load_config()
SENTENCE = CONFIG["versions"]["1"]["sentence"]
REPO = "kleidos-dev/cla-sandbox"
REGISTRY = "kleidos-dev/cla"


class FakeGitHub:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}
        self.comments: dict[int, dict[str, Any]] = {}
        self.pulls: dict[int, dict[str, Any]] = {}
        self.commits: dict[int, list[dict[str, Any]]] = {}
        self.private: set[str] = set()
        self.head = "a" * 40
        self.writes: list[tuple[str, str, str]] = []
        self.conflicts = 0

    def add_comment(self, cid: int, body: str, *, gid: int = 123456, login: str = "alice", kind: str = "User", pr: int = 7, repo: str = REPO, edited: bool = False, via: str | None = "kleidos-cla") -> None:
        self.comments[cid] = {
            "rest": {"id": cid, "node_id": f"IC_{cid}", "user": {"id": gid, "login": login, "type": kind}, "performed_via_github_app": {"slug": via} if via else None},
            "node": {"createdAt": "2026-12-01T10:22:31Z", "lastEditedAt": "2026-12-01T10:30:00Z" if edited else None, "editor": None, "body": body, "author": {"login": login, "databaseId": gid if kind == "User" else None}, "pullRequest": {"number": pr, "repository": {"nameWithOwner": repo}}},
        }

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        path = url.removeprefix("https://api.github.com")
        data = json.loads(body) if body else None
        ok = lambda d: (200, json.dumps(d).encode())  # noqa: E731
        if path == "/graphql":
            q, v = data["query"], data["variables"]
            if "createCommitOnBranch" in q:
                inp = v["input"]
                if self.conflicts:
                    self.conflicts -= 1
                    return ok({"errors": [{"type": "STALE_DATA"}]})
                if inp["expectedHeadOid"] != self.head:
                    return ok({"errors": [{"type": "STALE_DATA"}]})
                add = inp["fileChanges"]["additions"][0]
                content = base64.b64decode(add["contents"]).decode()
                self.files[f"signatures:{add['path']}"] = content
                self.head = ("%040x" % (int(self.head, 16) + 1))[-40:]
                self.writes.append((inp["branch"]["branchName"], add["path"], inp["message"]["headline"]))
                return ok({"data": {"createCommitOnBranch": {"commit": {"oid": self.head, "url": "x"}}}})
            if "ref(qualifiedName" in q:
                return ok({"data": {"repository": {"ref": {"target": {"oid": self.head}}}}})
            if "node(id" in q:
                cid = int(v["id"].removeprefix("IC_"))
                return ok({"data": {"node": self.comments[cid]["node"]}})
            if "pullRequest(number" in q:
                nodes = self.commits[v["number"]]
                return ok({"data": {"repository": {"pullRequest": {"commits": {"totalCount": len(nodes), "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [{"commit": c} for c in nodes]}}}}})
        if path.startswith(f"/repos/{REGISTRY}/contents/"):
            p, ref = path.removeprefix(f"/repos/{REGISTRY}/contents/").split("?ref=")
            text = self.files.get(f"{ref}:{p}")
            return (200, text.encode()) if text is not None else (404, b'{"message":"Not Found"}')
        if path.startswith("/repos/") and path.count("/") == 3:
            return ok({"private": path.removeprefix("/repos/") in self.private})
        if "/issues/comments/" in path:
            return ok(self.comments[int(path.rsplit("/", 1)[1])]["rest"])
        if "/pulls/" in path:
            return ok(self.pulls[int(path.rsplit("/", 1)[1])])
        return 404, b'{"message":"Not Found"}'


def ctx(fake: FakeGitHub, entities: list[dict[str, Any]] | None = None) -> cla.Context:
    return cla.Context(cla.GitHub("t", transport=fake), REGISTRY, 99, CONFIG, entities or [])


def commit(gid: int, login: str, *, coauthor: str | None = None, listed: bool = True, merge: bool = False) -> dict[str, Any]:
    nodes = [{"email": f"{gid}+{login}@users.noreply.github.com", "user": {"databaseId": gid, "login": login}}]
    message = "Change"
    if coauthor:
        message += f"\n\nCo-authored-by: X <{coauthor}>"
        if listed:
            nodes.append({"email": coauthor, "user": None})
    return {"oid": "c" * 40, "message": message, "authoredDate": "2026-12-01T10:00:00Z", "parents": {"totalCount": 2 if merge else 1}, "authors": {"totalCount": len(nodes), "nodes": nodes}}


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
        self.assertEqual(set(rec), {"schema", "kind", "github_id", "login_at_signing", "agreement", "version", "set_sha256", "accepted_at", "method", "evidence", "recorded_at", "recorder_run_id"})
        self.assertEqual(f.writes[0][2], "sign: alice (123456) accepts version 1")

    def test_a_typed_comment_with_extra_whitespace_is_method_comment(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, "  " + SENTENCE.replace(" ", "\n ") + "\n", via=None)
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(json.loads(f.files["signatures:signatures/individual/123456.json"])["method"], "comment")

    def test_refusals_write_nothing(self) -> None:
        cases = {
            "edited": dict(body=SENTENCE, edited=True),
            "other pull request": dict(body=SENTENCE, pr=8),
            "other repository": dict(body=SENTENCE, repo="kleidos-dev/other"),
            "a bot": dict(body=SENTENCE, kind="Bot", login="x[bot]"),
            "extra text": dict(body=SENTENCE + " Thanks!"),
            "other version": dict(body=SENTENCE.replace("version 1", "version 2")),
            "other digest": dict(body=SENTENCE.replace("89c1d46b9b10", "89c1d46b9b11")),
            "look-alike unicode": dict(body=SENTENCE.replace("a", "а", 1)),
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


class RecordCoverage(unittest.TestCase):
    def merged(self, f: FakeGitHub, commits: list[dict[str, Any]], opener: tuple[int, str] = (123456, "alice")) -> None:
        f.pulls[7] = {"number": 7, "merged": True, "merge_commit_sha": "d" * 40, "merged_at": "2026-12-02T09:00:00Z", "user": {"id": opener[0], "login": opener[1], "type": "User"}}
        f.commits[7] = commits

    def sign(self, f: FakeGitHub, gid: int, login: str) -> None:
        cid = len(f.comments) + 1
        f.add_comment(cid, SENTENCE, gid=gid, login=login)
        cla.record_sign(ctx(f), REPO, 7, cid)

    def test_writes_the_coverage_of_signed_and_exempt_authors(self) -> None:
        f = FakeGitHub()
        self.sign(f, 123456, "alice")
        self.sign(f, 234567, "bob")
        self.merged(f, [commit(123456, "alice", coauthor="234567+bob@users.noreply.github.com"), commit(49699333, "dependabot[bot]"), commit(1, "x", merge=True)])
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

    def test_entity_covered_accounts_need_no_signature(self) -> None:
        f = FakeGitHub()
        self.merged(f, [commit(345678, "carol")], opener=(345678, "carol"))
        ent = [{"slug": "e", "name": "Example GmbH", "version": 1, "set_sha256": CONFIG["versions"]["1"]["set_sha256"], "signed_at": "2026-11-01", "covered": [{"github_id": 345678, "from": "2026-11-01"}]}]
        cla.record_coverage(ctx(f, ent), REPO, 7)
        self.assertEqual(json.loads(f.files["signatures:coverage/kleidos-dev/cla-sandbox/7.json"])["github_ids"], [])


class Verify(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.git("init", "-q", "-b", "signatures")
        self.git("config", "commit.gpgsign", "false")
        self.commit_as(cla.OWNER_LOGIN, "Start the register", {"README.md": "register\n"})

    def tearDown(self) -> None:
        self.dir.cleanup()

    def git(self, *args: str, env: dict[str, str] | None = None) -> str:
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

    def commit_as(self, author: str, subject: str, files: dict[str, str], remove: list[str] | None = None) -> str:
        for p, text in files.items():
            (self.root / p).parent.mkdir(parents=True, exist_ok=True)
            (self.root / p).write_text(text)
            self.git("add", p)
        for p in remove or []:
            self.git("rm", "-q", p)
        env = {"GIT_AUTHOR_NAME": author, "GIT_AUTHOR_EMAIL": "x@example.org", "GIT_COMMITTER_NAME": author, "GIT_COMMITTER_EMAIL": "x@example.org", "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "HOME": self.dir.name}
        self.git("commit", "-q", "-m", subject, env=env)
        return self.git("rev-parse", "HEAD")

    def record(self, gid: int, digest: str | None = None) -> str:
        return json.dumps({"schema": 1, "kind": "individual", "github_id": gid, "login_at_signing": "alice", "agreement": "kleidos-ca", "version": 1, "set_sha256": digest or CONFIG["versions"]["1"]["set_sha256"], "accepted_at": "2026-12-01T10:22:31Z", "method": "web", "evidence": {}, "recorded_at": "2026-12-01T10:23:02Z", "recorder_run_id": 1})

    def verify(self, since: str | None = None, verified: bool = True) -> list[str]:
        return [f.problem for f in cla.verify_history(self.root, CONFIG, "signatures", since, lambda _sha: verified)]

    def test_a_clean_history_passes(self) -> None:
        self.commit_as(cla.ACTIONS_BOT, "sign: alice", {"signatures/individual/1.json": self.record(1)})
        self.commit_as(cla.ACTIONS_BOT, "coverage: x", {"coverage/kleidos-dev/cla-sandbox/7.json": json.dumps({"kind": "coverage", "repo": "kleidos-dev/cla-sandbox", "pr": 7})})
        self.assertEqual(self.verify(), [])

    def test_a_commit_touching_two_files(self) -> None:
        self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/1.json": self.record(1), "signatures/individual/2.json": self.record(2)})
        self.assertTrue(any("changes 2 files" in p for p in self.verify()))

    def test_a_commit_not_by_the_recorder_or_not_verified(self) -> None:
        self.commit_as("mallory", "sign", {"signatures/individual/1.json": self.record(1)})
        self.assertTrue(any("not by the recorder" in p for p in self.verify()))
        self.assertTrue(any("not a verified commit" in p for p in self.verify(verified=False)))

    def test_a_wrong_digest_or_a_mismatched_path(self) -> None:
        self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/1.json": self.record(1, "0" * 64)})
        self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/3.json": self.record(4)})
        problems = self.verify()
        self.assertTrue(any("not an accepted one" in p for p in problems))
        self.assertTrue(any("does not match its path" in p for p in problems))

    def test_a_deletion_or_a_file_elsewhere(self) -> None:
        self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/1.json": self.record(1)})
        self.commit_as(cla.ACTIONS_BOT, "drop", {}, remove=["signatures/individual/1.json"])
        self.commit_as(cla.ACTIONS_BOT, "other", {"notes.txt": "x"})
        problems = self.verify()
        self.assertTrue(any(p.startswith("D signatures/individual/1.json") for p in problems))
        self.assertTrue(any(p.startswith("A notes.txt") for p in problems))

    def test_a_rewritten_history(self) -> None:
        old = self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/1.json": self.record(1)})
        self.git("reset", "-q", "--hard", "HEAD~1")
        self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/2.json": self.record(2)})
        self.assertTrue(any("rewritten" in p for p in self.verify(since=old)))

    def test_the_owners_redact_and_entity_commits(self) -> None:
        self.commit_as(cla.ACTIONS_BOT, "sign", {"signatures/individual/1.json": self.record(1)})
        self.commit_as(cla.OWNER_LOGIN, "redact: remove account 1 at its holder's request", {}, remove=["signatures/individual/1.json"])
        self.assertEqual(self.verify(verified=True), [])
        self.commit_as(cla.OWNER_LOGIN, "tidy up", {"x.txt": "x"})
        self.assertTrue(self.verify())


class VerifyCoverage(unittest.TestCase):
    def test_a_merged_pull_request_without_coverage(self) -> None:
        f = FakeGitHub()
        f.files["signatures:coverage/kleidos-dev/cla-sandbox/1.json"] = "{}"

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
            if "/pulls?state=closed" in url:
                repo = url.split("/repos/")[1].split("/pulls")[0]
                pulls = [{"number": 1, "merged_at": "2026-12-02T00:00:00Z"}, {"number": 2, "merged_at": "2026-12-03T00:00:00Z"}, {"number": 3, "merged_at": None}] if repo == REPO else []
                return 200, json.dumps(pulls).encode()
            return f(method, url, headers, body)

        problems = [x.problem for x in cla.verify_coverage(cla.GitHub("t", transport=transport), CONFIG, REGISTRY, "2026-12-01")]
        self.assertEqual(problems, [f"{REPO}#2 was merged with no coverage record"])


class Helpers(unittest.TestCase):
    def test_normalize_and_noreply(self) -> None:
        self.assertEqual(cla.normalize("  a \n\t b  "), "a b")
        self.assertEqual(cla.normalize("é"), "é")
        self.assertEqual(cla.parse_noreply("49699333+dependabot[bot]@users.noreply.github.com"), (49699333, "dependabot[bot]"))
        self.assertIsNone(cla.parse_noreply("alice@example.org"))

    def test_the_config_is_consistent(self) -> None:
        info = CONFIG["versions"]["1"]
        root = cla.ROOT / info["path"]
        sums = (root / "SHA256SUMS").read_bytes()
        self.assertEqual(cla.sha256(sums), info["set_sha256"])
        self.assertIn(info["set_sha256"][:12], info["sentence"])
        self.assertIn(CONFIG["current_version"], CONFIG["accepted_versions"])
        ids = [e["id"] for e in CONFIG["exempt"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue({28966312, 49699333, 41898282} <= set(ids))


if __name__ == "__main__":
    unittest.main()
