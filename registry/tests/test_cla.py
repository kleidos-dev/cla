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

CONFIG = {**cla.load_config(), "app_id": 4242}
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
        self.cap = 250  # GitHub lists at most 250 commits of a pull request

    def add_comment(self, cid: int, body: str, *, gid: int = 123456, login: str = "alice", kind: str = "User", pr: int = 7, repo: str = REPO, edited: bool = False, via: str | None = "kleidos-cla") -> None:
        self.comments[cid] = {
            "rest": {"id": cid, "node_id": f"IC_{cid}", "user": {"id": gid, "login": login, "type": kind}, "performed_via_github_app": {"id": 4242, "slug": via} if via else None},
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
                every = self.commits[v["number"]]
                listed = every[: self.cap]
                start = int(v["cursor"] or 0)
                nodes = listed[start : start + 100]
                end = start + len(nodes)
                return ok({"data": {"repository": {"pullRequest": {"commits": {"totalCount": len(every), "pageInfo": {"hasNextPage": end < len(listed), "endCursor": str(end)}, "nodes": [{"commit": c} for c in nodes]}}}}})
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

    def test_the_method_is_told_by_the_apps_id_not_its_slug(self) -> None:
        f = FakeGitHub()
        f.add_comment(1, SENTENCE)
        f.comments[1]["rest"]["performed_via_github_app"] = {"id": 9999, "slug": "kleidos-cla"}
        cla.record_sign(ctx(f), REPO, 7, 1)
        self.assertEqual(json.loads(f.files["signatures:signatures/individual/123456.json"])["method"], "comment")

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
        f.pulls[7] = {"number": 7, "merged": True, "merge_commit_sha": "d" * 40, "created_at": "2026-12-01T08:00:00Z", "merged_at": "2026-12-02T09:00:00Z", "user": {"id": opener[0], "login": opener[1], "type": "User"}}
        f.commits[7] = commits

    def sign(self, f: FakeGitHub, gid: int, login: str) -> None:
        cid = len(f.comments) + 1
        f.add_comment(cid, SENTENCE, gid=gid, login=login)
        cla.record_sign(ctx(f), REPO, 7, cid)

    def test_writes_the_coverage_of_signed_and_exempt_authors(self) -> None:
        f = FakeGitHub()
        self.sign(f, 123456, "alice")
        self.sign(f, 234567, "bob")
        self.merged(f, [commit(123456, "alice", coauthor="234567+bob@users.noreply.github.com"), commit(49699333, "dependabot[bot]"), commit(123456, "alice", merge=True)])
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
        ent = [{"slug": "e", "name": "Example GmbH", "version": 1, "set_sha256": CONFIG["versions"]["1"]["set_sha256"], "signed_at": "2026-11-01", "covered": [{"github_id": 345678, "from": "2026-11-01", "until": "2026-11-10"}]}]
        cla.record_coverage(ctx(f, ent), REPO, 7)

    def test_entity_covered_accounts_need_no_signature(self) -> None:
        f = FakeGitHub()
        self.merged(f, [commit(345678, "carol")], opener=(345678, "carol"))
        ent = [{"slug": "e", "name": "Example GmbH", "version": 1, "set_sha256": CONFIG["versions"]["1"]["set_sha256"], "signed_at": "2026-11-01", "covered": [{"github_id": 345678, "from": "2026-11-01"}]}]
        cla.record_coverage(ctx(f, ent), REPO, 7)
        self.assertEqual(json.loads(f.files["signatures:coverage/kleidos-dev/cla-sandbox/7.json"])["github_ids"], [])


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
        self.comments[ev["comment_id"]] = {"author_id": rec["github_id"], "edited": False, "created_at": rec["accepted_at"], "body": body, "pr": int(pr), "repo": repo}
        self.runs[rec["recorder_run_id"]] = self.run_for(f"Record sign {repo}#{pr} {ev['comment_id']}")

    @staticmethod
    def run_for(title: str, **kw: Any) -> dict[str, Any]:
        return {"repository": {"full_name": REGISTRY}, "path": ".github/workflows/record.yml", "event": "workflow_dispatch", "head_branch": "main", "display_title": title, "status": "completed", "conclusion": "success", **kw}

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
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

    def commit_as(self, facts: cla.Facts, subject: str, files: dict[str, str], remove: list[str] | None = None) -> str:
        for p, text in files.items():
            (self.root / p).parent.mkdir(parents=True, exist_ok=True)
            (self.root / p).write_text(text)
            self.git("add", p)
        for p in remove or []:
            self.git("rm", "-q", p)
        name = cla.ACTIONS_BOT if facts.author_id == cla.ACTIONS_BOT_ID else "someone"
        env = {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": "x@example.org", "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": "x@example.org", "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "HOME": self.dir.name}
        self.git("commit", "-q", "--allow-empty", "-m", subject, env=env)
        sha = self.git("rev-parse", "HEAD")
        self.facts[sha] = facts
        return sha

    _cid = 100

    def record(self, gid: int, digest: str | None = None, version: int = 1, **over: Any) -> dict[str, Any]:
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
            "evidence": {"pr_url": f"https://github.com/{REPO}/pull/7", "comment_url": f"https://github.com/{REPO}/pull/7#issuecomment-{cid}", "comment_id": cid, "comment_body_sha256": cla.sha256(SENTENCE)},
            "recorded_at": "2026-12-01T10:23:02Z",
            "recorder_run_id": cid * 10,
        }
        rec.update(over)
        return rec

    def sign(self, gid: int, facts: cla.Facts = RECORDER, genuine: bool = True, **over: Any) -> str:
        rec = self.record(gid, **over)
        if genuine:
            self.witness.genuine(rec)
        return self.commit_as(facts, f"sign: {gid}", {f"signatures/individual/{gid}.json": json.dumps(rec)})

    def run_verify(self, since: str | None = None, config: dict[str, Any] | None = None, witness: bool = True) -> cla.Verified:
        return cla.verify_history(self.root, config or CONFIG, "signatures", since, self.facts.get, self.witness if witness else None, REGISTRY)

    def verify(self, since: str | None = None, config: dict[str, Any] | None = None) -> list[str]:
        return [f.problem for f in self.run_verify(since, config).findings]

    def test_a_clean_history_passes(self) -> None:
        self.sign(1)
        self.witness.runs[555] = FakeWitness.run_for(f"Record coverage {REPO}#7")
        last = self.commit_as(RECORDER, "coverage: x", {"coverage/kleidos-dev/cla-sandbox/7.json": json.dumps({"kind": "coverage", "repo": REPO, "pr": 7, "recorder_run_id": 555})})
        v = self.run_verify()
        self.assertEqual(v.findings, [])
        self.assertEqual(v.checked_through, last)

    def test_a_commit_touching_two_files(self) -> None:
        self.commit_as(RECORDER, "sign", {"signatures/individual/1.json": json.dumps(self.record(1)), "signatures/individual/2.json": json.dumps(self.record(2))})
        self.assertTrue(any("changes 2 files" in p for p in self.verify()))

    def test_a_commit_not_made_and_signed_by_the_recorder(self) -> None:
        # Not github-actions[bot]; github-actions[bot] by email only, signed with the pusher's own key; not GitHub's committer.
        for facts in (cla.Facts(666, 666, "m@example.org", True, False), cla.Facts(cla.ACTIONS_BOT_ID, 666, "m@example.org", True, False), cla.Facts(cla.ACTIONS_BOT_ID, None, "noreply@github.com", False, True), cla.Facts(cla.ACTIONS_BOT_ID, None, "m@example.org", True, True)):
            with self.subTest(facts):
                self.tearDown()
                self.setUp()
                self.sign(1, facts)
                self.assertTrue(any("not by the recorder" in p for p in self.verify()))

    def test_a_github_signed_commit_from_elsewhere_fails_the_cross_check(self) -> None:
        # A record minted by createCommitOnBranch in a fork passes every commit fact; its evidence does not.
        cases = {
            "the run is not this repository's": dict(run={"repository": {"full_name": "mallory/cla"}}),
            "the run recorded something else": dict(run={"display_title": "Record sign kleidos-dev/cla-sandbox#7 1"}),
            "the run is unknown": dict(run=None),
            "the run failed": dict(run={"conclusion": "failure"}),
            "the comment is another account's": dict(comment={"author_id": 999}),
            "the comment was edited": dict(comment={"edited": True}),
            "the comment is gone": dict(comment=None),
            "the comment says something else": dict(comment={"body": SENTENCE + " x"}),
            "the time is not the comment's": dict(comment={"created_at": "2020-01-01T00:00:00Z"}),
        }
        for name, change in cases.items():
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                rec = self.record(1)
                self.witness.genuine(rec)
                cid, rid = rec["evidence"]["comment_id"], rec["recorder_run_id"]
                if "run" in change:
                    self.witness.runs[rid] = None if change["run"] is None else {**self.witness.runs[rid], **change["run"]}  # type: ignore[dict-item]
                if "comment" in change:
                    self.witness.comments[cid] = None if change["comment"] is None else {**self.witness.comments[cid], **change["comment"]}  # type: ignore[dict-item]
                self.commit_as(RECORDER, "sign: 1", {"signatures/individual/1.json": json.dumps(rec)})
                v = self.run_verify()
                self.assertTrue(v.findings, name)
                self.assertIsNone(v.checked_through)

    def test_only_records_after_since_are_cross_checked_and_a_running_recorder_waits(self) -> None:
        old = self.sign(1, genuine=False)
        self.assertEqual(self.verify(since=old), [])
        second = self.sign(2)
        rec3 = self.record(3)
        self.witness.genuine(rec3)
        self.witness.runs[rec3["recorder_run_id"]]["status"] = "in_progress"  # type: ignore[index]
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
        config["versions"]["2"] = {**config["versions"]["1"], "set_sha256": "f" * 64, "path": "agreements/v2"}
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

    def test_a_rewritten_history(self) -> None:
        old = self.sign(1)
        self.git("reset", "-q", "--hard", "HEAD~1")
        self.sign(2)
        self.assertTrue(any("rewritten" in p for p in self.verify(since=old)))

    def test_the_owners_redact_and_entity_commits(self) -> None:
        self.sign(1)
        self.commit_as(OWNER, "redact: remove account 1 at its holder's request", {}, remove=["signatures/individual/1.json"])
        self.assertEqual(self.verify(), [])
        self.commit_as(OWNER, "tidy up", {"x.txt": "x"})
        self.assertTrue(self.verify())

    def test_a_redact_commit_by_somebody_else(self) -> None:
        self.sign(1)
        # Authored as the owner (by email) but not committed or signed by him.
        self.commit_as(cla.Facts(cla.OWNER_ID, 666, "m@example.org", False, False), "redact: remove account 1", {}, remove=["signatures/individual/1.json"])
        self.assertTrue(self.verify())


class VerifyWorkflows(unittest.TestCase):
    def test_a_disabled_recorder_or_verifier_is_a_problem(self) -> None:
        states = {"record.yml": "active", "verify.yml": "disabled_manually"}

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
            return 200, json.dumps({"state": states[url.rsplit("/", 1)[1]]}).encode()

        problems = [f.problem for f in cla.verify_workflows(cla.GitHub("t", transport=transport), REGISTRY)]
        self.assertEqual(problems, ["the workflow verify.yml is disabled_manually, not active"])


class VerifyCoverage(unittest.TestCase):
    def test_a_merged_pull_request_without_coverage(self) -> None:
        f = FakeGitHub()
        f.files["signatures:coverage/kleidos-dev/cla-sandbox/1.json"] = "{}"

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
            if "/pulls?state=closed" in url:
                repo = url.split("/repos/")[1].split("/pulls")[0]
                # 4 was merged a minute ago: its recorder run may still be queued, so it is not a problem yet.
                just = cla.now()
                pulls = [{"number": 1, "merged_at": "2026-11-02T00:00:00Z"}, {"number": 2, "merged_at": "2026-11-03T00:00:00Z"}, {"number": 3, "merged_at": None}, {"number": 4, "merged_at": just}] if repo == REPO else []
                return 200, json.dumps(pulls).encode()
            return f(method, url, headers, body)

        problems = [x.problem for x in cla.verify_coverage(cla.GitHub("t", transport=transport), CONFIG, REGISTRY, "2026-11-01")]
        self.assertEqual(problems, [f"{REPO}#2 was merged with no coverage record"])


class Helpers(unittest.TestCase):
    def test_the_shared_normalisation_vectors(self) -> None:
        vectors = json.loads((Path(__file__).parent / "normalize-vectors.json").read_text("utf-8"))["vectors"]
        for v in vectors:
            self.assertEqual(cla.normalize(v["in"]), v["out"], repr(v["in"]))

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
