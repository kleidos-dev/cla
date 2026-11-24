# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""What the register's tests share: a strict fake GitHub, the records, and git histories.

Every id, login, token and address here is made up. The fake GitHub refuses what GitHub refuses (the
method, the headers, the credential, the query), fails the test on a call it does not expect, and
keeps every call and every write for the assertions."""

from __future__ import annotations

import base64
import contextlib
import copy
import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest import mock
from urllib.parse import parse_qsl, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import graphql

# No setting of the machine's git reaches a test.
os.environ |= {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

#: The register's owner and its recorder, as a record's history names them.
OWNER_LOGIN = "jmrplens"
ACTIONS_BOT = "github-actions[bot]"

#: A made-up served repository, whichever ones registry/config.json serves.
REPO = "kleidos-dev/cla-sandbox"
REGISTRY = "kleidos-dev/cla"
API = "https://api.github.com"
BEARER = "a-registry-token"
SIGNIN_CLIENT_ID = "Iv23liSIGNINTEST0001"
OTHER_CLIENT_ID = "Iv23liSOMEOTHERAPP01"
SIGNIN_SECRET = "signin-secret-value"
APP_ID = 4242
TOKEN = "ghu_" + "A" * 36
SITE_COMMIT = "0123456789abcdef0123456789abcdef01234567"
RECORDER_COMMIT = "f" * 40
RUN_ID = 99
ALICE = 123456
BOB = 234567
CAROL = 345678
#: The instant every test runs at.
NOW = dt.datetime(2026, 12, 1, 10, 23, 2, tzinfo=dt.UTC)
FIXTURES = Path(__file__).parent / "fixtures"
VECTORS = Path(__file__).parent / "vectors"

LIVE = cla.load_config()
#: registry/config.json pinned to version 1's comment flow, whichever version is current there,
#: so that switching the live register to version 2 leaves these tests as they are.
CONFIG: dict[str, Any] = {
    **LIVE,
    "app_id": APP_ID,
    "served_repositories": {REGISTRY: {"auto_approve": False}, REPO: {"auto_approve": True}},
    "current_version": 1,
    "accepted_versions": [1],
    "signin_client_id": None,
    "retired_signin_client_ids": [],
}
#: Version 2 current and the sign-in app configured: the state the switch to version 2 makes.
CONFIG_V2: dict[str, Any] = {
    **CONFIG,
    "current_version": 2,
    "accepted_versions": [1, 2],
    "signin_client_id": SIGNIN_CLIENT_ID,
}
SENTENCE: str = CONFIG["versions"]["1"]["sentence"]
SENTENCE_V2: str = CONFIG["versions"]["2"]["sentence"]
DIGEST: str = CONFIG["versions"]["1"]["set_sha256"]
DIGEST_V2: str = CONFIG["versions"]["2"]["set_sha256"]
APP = cla.SigninApp(SIGNIN_CLIENT_ID, SIGNIN_SECRET)

Answer = tuple[int, bytes, dict[str, str]]


def config_with(base: dict[str, Any] | None = None, **over: Any) -> dict[str, Any]:
    """A copy of a configuration with some of its keys replaced."""
    return {**copy.deepcopy(base or CONFIG), **over}


def individual(gid: int, kind: str = "json") -> str:
    return f"signatures/individual/{gid}.{kind}"


def dump(record: dict[str, Any]) -> bytes:
    """A record's bytes as the recorder writes them."""
    return (json.dumps(record, indent=2) + "\n").encode()


def ok(data: object, status: int = 200) -> Answer:
    return status, json.dumps(data).encode(), {"content-type": "application/json"}


NOT_FOUND = ok({"message": "Not Found"}, 404)
#: What a proxy in front of GitHub answers when GitHub does not.
BAD_GATEWAY: Answer = (502, b"<html><body>502 Bad Gateway</body></html>", {})


class Lost(Exception):
    """In FakeGitHub.upcoming: do what was asked, then lose the answer on its way back."""


@dataclass
class Write:
    """One commit of the signatures branch."""

    headline: str
    additions: dict[str, bytes]
    deletions: list[str]


@dataclass
class FakeGitHub:
    """GitHub's answers about the register, the served repositories and the sign-in app."""

    #: The signatures branch: path → bytes.
    files: dict[str, bytes] = field(default_factory=dict)
    head: str = "a" * 40
    writes: list[Write] = field(default_factory=list)
    repos: dict[str, Any] = field(default_factory=lambda: {REPO: {"private": False}})
    comments: dict[int, dict[str, Any]] = field(default_factory=dict)
    pulls: dict[int, Any] = field(default_factory=dict)
    commits: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    #: GitHub lists at most this many commits of a pull request.
    cap: int = 250
    #: What "commits that touched this path" answers, newest first, for a path not just written.
    histories: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    known_tokens: dict[str, Any] = field(default_factory=dict)
    revoked: list[str] = field(default_factory=list)
    date: str = "Tue, 01 Dec 2026 10:22:58 GMT"
    #: Every call, as "METHOD /path" or "POST /graphql <what the document asks for>".
    calls: list[str] = field(default_factory=list)
    #: The answers (or exceptions) the next calls whose name starts so get instead of their own.
    upcoming: list[tuple[str, Answer | Exception]] = field(default_factory=list)

    def next(self, call: str, *answers: Answer | Exception) -> None:
        self.upcoming.extend((call, a) for a in answers)

    def add_signin(
        self,
        token: str = TOKEN,
        *,
        gid: Any = ALICE,
        login: Any = "alice",
        kind: str = "User",
        client_id: str = SIGNIN_CLIENT_ID,
        created_at: Any = "2026-12-01T10:22:31Z",
    ) -> None:
        self.known_tokens[token] = {
            "id": 1,
            "token": token,
            "app": {"client_id": client_id, "name": "Kleidos CLA sign-in"},
            "user": {"id": gid, "login": login, "type": kind},
            "created_at": created_at,
        }

    def add_comment(
        self,
        cid: int,
        body: str = SENTENCE,
        *,
        gid: int = ALICE,
        login: str = "alice",
        kind: str = "User",
        pr: int = 7,
        repo: str = REPO,
        via: int | None = APP_ID,
        created_at: str = "2026-12-01T10:22:31Z",
    ) -> dict[str, Any]:
        """A comment on a pull request; what is returned is edited in place to spoil it."""
        node = {
            "__typename": "IssueComment",
            "createdAt": created_at,
            "lastEditedAt": None,
            "editor": None,
            "body": body,
            "author": {"__typename": kind, "login": login, "databaseId": gid},
            "pullRequest": {"number": pr, "repository": {"nameWithOwner": repo}},
        }
        comment: dict[str, Any] = {
            "repo": repo,
            "rest": {
                "id": cid,
                "node_id": f"IC_{cid}",
                "user": {"id": gid, "login": login, "type": kind},
                "performed_via_github_app": None if via is None else {"id": via, "slug": "some"},
            },
            "node": node,
        }
        self.comments[cid] = comment
        return comment

    def merge(
        self, commits: list[dict[str, Any]], opener: dict[str, Any] | None = None, number: int = 7
    ) -> dict[str, Any]:
        """A merged pull request with these commits; what is returned is edited to spoil it."""
        self.commits[number] = commits
        pull: dict[str, Any] = {
            "number": number,
            "merged": True,
            "merge_commit_sha": "d" * 40,
            "created_at": "2026-12-01T08:00:00Z",
            "merged_at": "2026-12-01T09:00:00Z",
            "user": opener or {"id": ALICE, "login": "alice", "type": "User"},
        }
        self.pulls[number] = pull
        return pull

    def sign(self, gid: int, config: dict[str, Any] = CONFIG, **over: Any) -> dict[str, Any]:
        """Puts a recorded signature on the branch."""
        record = comment_record(gid, config=config, **over)
        self.files[individual(gid)] = dump(record)
        return record

    # --- the transport -------------------------------------------------------

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> Answer:
        if not url.startswith(f"{API}/"):
            raise AssertionError(f"a request to somewhere else: {url}")
        parts = urlsplit(url)
        path = parts.path
        data: Any = None if body is None else json.loads(body)
        query = dict(parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True))
        self._check_headers(path, headers, body)
        name = f"{method} {path}"
        if path == "/graphql":
            name += f" {self._asked(data['query'])}"
        self.calls.append(name)
        for i, (call, answer) in enumerate(self.upcoming):
            if name.startswith(call):
                del self.upcoming[i]
                if isinstance(answer, Lost):
                    self._answer(method, path, query, data)
                    raise ConnectionResetError("the connection was cut")
                if isinstance(answer, Exception):
                    raise answer
                return answer
        return self._answer(method, path, query, data)

    @staticmethod
    def _check_headers(path: str, headers: dict[str, str], body: bytes | None) -> None:
        raw = "/contents/signatures/individual/" in path or "/contents/coverage/" in path
        expected = {
            "authorization": f"Bearer {BEARER}",
            "accept": f"application/vnd.github{'.raw' if raw else ''}+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "kleidos-cla-recorder",
        }
        if path.startswith("/applications/"):
            basic = base64.b64encode(f"{SIGNIN_CLIENT_ID}:{SIGNIN_SECRET}".encode()).decode()
            expected["authorization"] = f"Basic {basic}"
        if body is not None:
            expected["content-type"] = "application/json"
        if headers != expected:
            raise AssertionError(f"headers {headers}, not {expected}")

    @staticmethod
    def _asked(query: str) -> str:
        (top,) = graphql.Document(query).fields
        return ".".join([top.name, *(f.name for f in top.fields[:1] if f.on is None)])

    def _answer(self, method: str, path: str, query: dict[str, str], data: Any) -> Answer:
        routes: tuple[tuple[str, str, Callable[..., Answer]], ...] = (
            ("POST", r"/graphql", self._graphql),
            ("POST", rf"/applications/{SIGNIN_CLIENT_ID}/token", self._check_token),
            ("DELETE", rf"/applications/{SIGNIN_CLIENT_ID}/grant", self._delete_grant),
            ("GET", rf"/repos/{REGISTRY}/contents/(.+)", self._contents),
            ("GET", rf"/repos/{REGISTRY}/commits", self._history),
            ("GET", r"/repos/([^/]+/[^/]+)", self._repository),
            ("GET", r"/repos/([^/]+/[^/]+)/issues/comments/(\d+)", self._comment),
            ("GET", r"/repos/([^/]+/[^/]+)/pulls/(\d+)", self._pull),
        )
        for verb, pattern, answer in routes:
            m = re.fullmatch(pattern, path)
            if m and verb == method:
                return answer(*m.groups(), query=query, data=data)
        raise AssertionError(f"GitHub is not asked {method} {path} {query}")

    def _check_token(self, query: dict[str, str], data: Any) -> Answer:
        assert (query, set(data)) == ({}, {"access_token"}), (query, data)
        answer = self.known_tokens.get(data["access_token"])
        if answer is None:
            return NOT_FOUND
        return 200, json.dumps(answer).encode(), {"date": self.date}

    def _delete_grant(self, query: dict[str, str], data: Any) -> Answer:
        assert (query, set(data)) == ({}, {"access_token"}), (query, data)
        self.revoked.append(data["access_token"])
        if self.known_tokens.pop(data["access_token"], None) is None:
            return NOT_FOUND
        return 204, b"", {}

    def _contents(self, path: str, query: dict[str, str], data: Any) -> Answer:
        assert (data, set(query)) == (None, {"ref"}), (query, data)
        assert query["ref"] in (cla.BRANCH, self.head), query
        if path in self.files:
            return 200, self.files[path], {}
        children = [p for p in sorted(self.files) if p.startswith(f"{path}/")]
        if not children:
            return NOT_FOUND
        return ok([{"name": p.rsplit("/", 1)[1], "type": "file"} for p in children])

    def _history(self, query: dict[str, str], data: Any) -> Answer:
        assert data is None, data
        assert query["sha"] == cla.BRANCH, query
        path, size = query["path"], int(query["per_page"])
        page = int(query.get("page", "1"))
        assert set(query) <= {"sha", "path", "per_page", "page"}, query
        own = [recorder_commit()] if path in self.files else []
        every = self.histories.get(path, own)
        return ok(every[(page - 1) * size : page * size])

    def _repository(self, repo: str, query: dict[str, str], data: Any) -> Answer:
        assert (query, data) == ({}, None), (query, data)
        return ok(self.repos[repo]) if repo in self.repos else NOT_FOUND

    def _comment(self, repo: str, cid: str, query: dict[str, str], data: Any) -> Answer:
        assert (query, data) == ({}, None), (query, data)
        found = self.comments.get(int(cid))
        return ok(found["rest"]) if found and found["repo"] == repo else NOT_FOUND

    def _pull(self, repo: str, number: str, query: dict[str, str], data: Any) -> Answer:
        assert (repo, query, data) == (REPO, {}, None), (repo, query, data)
        return ok(self.pulls[int(number)]) if int(number) in self.pulls else NOT_FOUND

    def _graphql(self, query: dict[str, str], data: Any) -> Answer:
        assert (query, set(data)) == ({}, {"query", "variables"}), (query, data)
        try:
            out = graphql.run(
                data["query"],
                data["variables"],
                {
                    "node": self._node,
                    "repository": self._graphql_repository,
                    "createCommitOnBranch": self._create_commit,
                },
            )
        except ValueError as e:  # what GitHub refuses to do
            return ok({"data": None, "errors": [{"type": str(e)}]})
        return ok({"data": out})

    def _node(self, id: str) -> dict[str, Any] | None:
        found = self.comments.get(int(id.removeprefix("IC_")))
        node: dict[str, Any] | None = found["node"] if found else None
        return node

    def _graphql_repository(self, owner: str, name: str) -> dict[str, Any]:
        def ref(qualifiedName: str) -> dict[str, Any]:
            assert (owner, name) == tuple(REGISTRY.split("/")), (owner, name)
            assert qualifiedName == f"refs/heads/{cla.BRANCH}", qualifiedName
            return {"target": {"oid": self.head}}

        def pull(number: int) -> dict[str, Any]:
            assert (owner, name) == tuple(REPO.split("/")), (owner, name)

            def commits(first: int, after: str | None) -> dict[str, Any]:
                every = self.commits[number]
                listed = every[: self.cap]
                start = int(after or 0)
                assert 0 < first <= 100, first
                nodes = listed[start : start + first]
                end = start + len(nodes)
                return {
                    "totalCount": len(every),
                    "pageInfo": {"hasNextPage": end < len(listed), "endCursor": str(end)},
                    "nodes": [{"commit": c} for c in nodes],
                }

            return {"commits": commits}

        return {"ref": ref, "pullRequest": pull}

    def _create_commit(self, input: dict[str, Any]) -> dict[str, Any]:
        assert set(input) == {"branch", "expectedHeadOid", "message", "fileChanges"}, input
        assert input["branch"] == {
            "repositoryNameWithOwner": REGISTRY,
            "branchName": cla.BRANCH,
        }, input
        assert set(input["message"]) == {"headline"}, input
        changes = input["fileChanges"]
        assert set(changes) <= {"additions", "deletions"}, input
        if input["expectedHeadOid"] != self.head:
            raise ValueError("STALE_DATA")
        additions = {}
        for add in changes["additions"]:
            assert set(add) == {"path", "contents"}, add
            additions[add["path"]] = base64.b64decode(add["contents"], validate=True)
        deletions = []
        for gone in changes.get("deletions", []):
            assert set(gone) == {"path"}, gone
            deletions.append(gone["path"])
        self.files |= additions
        for path in deletions:
            del self.files[path]  # GitHub refuses to delete a file that is not there
        self.writes.append(Write(input["message"]["headline"], additions, deletions))
        self.move()
        return {"commit": {"oid": self.head, "url": f"https://github.com/{REGISTRY}"}}

    def move(self) -> None:
        """The branch gets another commit."""
        self.head = f"{int(self.head, 16) + 1:040x}"


def recorder_commit(**over: Any) -> dict[str, Any]:
    """A commit of the recorder, as the REST API lists it."""
    commit = {
        "sha": "e" * 40,
        "author": {"id": cla.ACTIONS_BOT_ID, "login": ACTIONS_BOT},
        "committer": {"login": "web-flow"},
        "commit": {
            "message": "sign: alice (1) accepts version 1",
            "committer": {"date": "2026-11-30T09:00:00Z"},
            "verification": {"verified": True, "reason": "valid"},
        },
    }
    return {**commit, **over}


def redact_commit(date: Any = "2026-12-02T08:00:00Z", message: str = "redact: x") -> dict[str, Any]:
    """A removal by the owner, as the REST API lists it."""
    return {
        "sha": "d" * 40,
        "author": {"id": cla.OWNER_ID, "login": OWNER_LOGIN},
        "committer": {"login": OWNER_LOGIN},
        "commit": {"message": message, "committer": {"date": date}},
    }


def github(fake: cla.Transport) -> cla.GitHub:
    return cla.GitHub(BEARER, transport=fake)


def context(
    fake: cla.Transport,
    config: dict[str, Any] = CONFIG,
    entities: list[dict[str, Any]] | None = None,
    stamper: cla.Stamper | None = None,
    commit: str = RECORDER_COMMIT,
) -> cla.Context:
    return cla.Context(github(fake), REGISTRY, RUN_ID, config, entities or [], stamper, commit)


# --- records -------------------------------------------------------------------


def comment_record(gid: int = 1, config: dict[str, Any] = CONFIG, **over: Any) -> dict[str, Any]:
    """A signature by comment (schema 1) that verifies."""
    version = over.get("version", 1)
    return {
        "schema": 1,
        "kind": "individual",
        "github_id": gid,
        "login_at_signing": "alice",
        "agreement": "kleidos-ca",
        "version": version,
        "set_sha256": config["versions"][str(version)]["set_sha256"],
        "accepted_at": "2026-12-01T10:22:31Z",
        "method": "web",
        "evidence": {
            "pr_url": f"https://github.com/{REPO}/pull/7",
            "comment_url": f"https://github.com/{REPO}/pull/7#issuecomment-{gid}",
            "comment_id": gid,
            "comment_body_sha256": cla.sha256(SENTENCE),
        },
        "recorded_at": "2026-12-01T10:23:02Z",
        "recorder_run_id": 1000 + gid,
        **over,
    }


def signin_record(
    gid: int = 1, evidence: dict[str, Any] | None = None, **over: Any
) -> dict[str, Any]:
    """A signature by signing in (schema 2) that verifies."""
    return {
        "schema": 2,
        "kind": "individual",
        "github_id": gid,
        "login_at_signing": "alice",
        "agreement": "kleidos-ca",
        "version": 2,
        "set_sha256": DIGEST_V2,
        "sentence_sha256": cla.sha256(SENTENCE_V2),
        "accepted_at": "2026-12-01T10:22:58Z",
        "method": "signin",
        "evidence": {
            "authorized_at": "2026-12-01T10:22:31Z",
            "signin_client_id": SIGNIN_CLIENT_ID,
            "context_pr_url": f"https://github.com/{REPO}/pull/7",
            "site_commit": SITE_COMMIT,
            "lang": "es",
            **(evidence or {}),
        },
        "recorded_at": "2026-12-01T10:23:02Z",
        "recorder_run_id": 1000 + gid,
        "recorder_commit": "c" * 40,
        **over,
    }


def coverage_record(pr: int = 7, **over: Any) -> dict[str, Any]:
    """A coverage record that verifies."""
    return {
        "schema": 1,
        "kind": "coverage",
        "repo": REPO,
        "pr": pr,
        "merge_sha": "d" * 40,
        "merged_at": "2026-12-01T09:00:00Z",
        "github_ids": [ALICE],
        "versions": {str(ALICE): 1},
        "recorded_at": "2026-12-01T10:23:02Z",
        "recorder_run_id": 2000 + pr,
        **over,
    }


def commit(
    gid: int = ALICE,
    login: str = "alice",
    *,
    message: str = "Change",
    date: str = "2026-12-01T10:00:00Z",
    others: list[dict[str, Any]] | None = None,
    total: int | None = None,
) -> dict[str, Any]:
    """A commit of a pull request, by one account and these other authors."""
    nodes = [actor(gid, login), *(others or [])]
    return {
        "oid": "c" * 40,
        "message": message,
        "authoredDate": date,
        "parents": {"totalCount": 1},
        "authors": lambda first: {
            "totalCount": len(nodes) if total is None else total,
            "nodes": nodes[:first],
        },
    }


def actor(gid: Any = ALICE, login: Any = "alice", email: str | None = "") -> dict[str, Any]:
    """An author of a commit that GitHub links to an account."""
    found = f"{gid}+{login}@users.noreply.github.com" if email == "" else email
    return {"email": found, "user": {"databaseId": gid, "login": login}}


def stranger(email: str | None) -> dict[str, Any]:
    """An author of a commit that GitHub links to no account."""
    return {"email": email, "user": None}


# --- time stamps, the witness ------------------------------------------------------


class FakeStamper(cla.Stamper):
    """A time-stamping authority that answers a recognizable token over the digest, or nothing."""

    def __init__(self, up: bool = True) -> None:
        self.up = up
        self.asked: list[str] = []

    def stamp(self, digest_hex: str) -> bytes | None:
        self.asked.append(digest_hex)
        return token_over(digest_hex) if self.up else None


def token_over(digest_hex: str) -> bytes:
    return f"TSR:{digest_hex}".encode()


def token_for(record: bytes) -> bytes:
    return token_over(cla.sha256(record))


def fake_verify_tsr(
    tsr: bytes, digest_hex: str, roots: Any, qualified: bool, query: bytes | None = None
) -> str | None:
    return None if tsr == token_over(digest_hex) else "the time-stamp token does not verify"


class FakeWitness(cla.Witness):
    """The comment and the run every record cites, as GitHub would answer for a genuine record."""

    def __init__(self) -> None:
        self.comments: dict[tuple[str, int], dict[str, Any] | None] = {}
        self.runs: dict[int, dict[str, Any] | None] = {}
        self.asked: list[str] = []

    def genuine(self, record: dict[str, Any], body: str = SENTENCE) -> None:
        """Vouches for a record, whatever its kind."""
        head_sha = "0" * 40
        if record["kind"] == "coverage":
            title = f"Record coverage {record['repo']}#{record['pr']}"
        elif record["schema"] == 2:
            title = f"Record signin {REPO}#7 {record['github_id']}"
            head_sha = record["recorder_commit"]
        else:
            evidence = record["evidence"]
            self.comments[(REPO, evidence["comment_id"])] = {
                "author_id": record["github_id"],
                "edited": False,
                "created_at": record["accepted_at"],
                "body": body,
                "pr": 7,
                "repo": REPO,
            }
            title = f"Record sign {REPO}#7 {evidence['comment_id']}"
        self.runs[record["recorder_run_id"]] = {
            "repository": {"full_name": REGISTRY},
            "path": ".github/workflows/record.yml",
            "event": "workflow_dispatch",
            "head_branch": "main",
            "head_sha": head_sha,
            "display_title": title,
            "status": "completed",
            "conclusion": "success",
        }

    def spoil_run(self, run_id: int, **over: Any) -> None:
        self.runs[run_id] = {**(self.runs[run_id] or {}), **over}

    def spoil_comment(self, comment_id: int, **over: Any) -> None:
        key = (REPO, comment_id)
        self.comments[key] = {**(self.comments[key] or {}), **over}

    def comment(self, repo: str, comment_id: int) -> dict[str, Any] | None:
        self.asked.append(f"comment {comment_id}")
        return self.comments.get((repo, comment_id))

    def run(self, run_id: int) -> dict[str, Any] | None:
        self.asked.append(f"run {run_id}")
        return self.runs.get(run_id)


# --- histories ---------------------------------------------------------------------

RECORDER = cla.Facts(cla.ACTIONS_BOT_ID, None, "noreply@github.com", True, True)
OWNER = cla.Facts(cla.OWNER_ID, cla.OWNER_ID, "owner@example.org", True, False)
#: The mode and the bytes of a file in a commit; None deletes it.
Change = bytes | tuple[str, bytes] | None


@dataclass
class Commit:
    subject: bytes
    files: dict[str, Change]
    facts: cla.Facts | None
    author: bytes
    merges: int | None


class History:
    """A signatures branch, built in one go: git is asked once for the whole history."""

    def __init__(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name).resolve()
        self._commits: list[Commit] = []
        self._shas: list[str] = []
        self.witness = FakeWitness()
        self.config = CONFIG
        self.add("Start the register", {"README.md": b"register\n"}, OWNER)

    def close(self) -> None:
        self._dir.cleanup()

    def add(
        self,
        subject: str | bytes,
        files: dict[str, Change],
        facts: cla.Facts | None = RECORDER,
        author: str | bytes = ACTIONS_BOT,
        merges: int | None = None,
    ) -> int:
        """One more commit; its number, which sha() turns into its id."""
        text = subject if isinstance(subject, bytes) else subject.encode()
        name = author if isinstance(author, bytes) else author.encode()
        self._commits.append(Commit(text, files, facts, name, merges))
        self._shas = []
        return len(self._commits) - 1

    def record(self, record: dict[str, Any], genuine: bool = True, **commit: Any) -> int:
        """The recorder's commit of one record, vouched for unless it is not genuine."""
        if genuine:
            self.witness.genuine(record)
        path = (
            f"coverage/{record['repo']}/{record['pr']}.json"
            if record["kind"] == "coverage"
            else individual(record["github_id"])
        )
        return self.add("record", {path: dump(record)}, **commit)

    def git(self, *args: str, data: bytes | None = None) -> bytes:
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            check=True,
            capture_output=True,
            input=data,
        ).stdout

    def build(self) -> None:
        if self._shas:
            return
        if not (self.root / ".git").exists():
            self.git("init", "-q", "-b", cla.BRANCH)
        stream = bytearray()
        for i, c in enumerate(self._commits):
            who = b"%s <x@example.org> %d +0000" % (c.author, 1800000000 + i)
            stream += b"commit refs/heads/%s\nmark :%d\n" % (cla.BRANCH.encode(), i + 1)
            stream += b"author %s\ncommitter %s\ndata %d\n%s\n" % (
                who,
                who,
                len(c.subject),
                c.subject,
            )
            if i:
                stream += b"from :%d\n" % i
            if c.merges is not None:
                stream += b"merge :%d\n" % (c.merges + 1)
            for path, change in c.files.items():
                if change is None:
                    stream += b"D %s\n" % path.encode()
                    continue
                mode, data = change if isinstance(change, tuple) else ("100644", change)
                stream += b"M %s inline %s\n" % (mode.encode(), path.encode())
                stream += b"data %d\n%s\n" % (len(data), data)
        marks = self.root / ".git" / "marks"
        self.git("fast-import", "--quiet", "--force", f"--export-marks={marks}", data=bytes(stream))
        found = dict(line.split() for line in marks.read_text("ascii").splitlines())
        self._shas = [found[f":{i + 1}"] for i in range(len(self._commits))]

    def sha(self, number: int) -> str:
        self.build()
        return self._shas[number]

    def info(self, sha: str) -> cla.Facts | None:
        return self._commits[self._shas.index(sha)].facts

    def verify(self, since: str | None = None, witness: bool = True) -> cla.Verified:
        self.build()
        return cla.verify_history(
            self.root,
            self.config,
            f"refs/heads/{cla.BRANCH}",
            since,
            self.info,
            self.witness if witness else None,
            REGISTRY,
        )

    def found(self, since: str | None = None, witness: bool = True) -> list[tuple[int, str]]:
        """What verify() finds: the number of the commit and the problem."""
        return [
            (self._shas.index(f.commit), f.problem) for f in self.verify(since, witness).findings
        ]


class RegisterTest(unittest.TestCase):
    """A test at a fixed instant, with what is printed kept."""

    maxDiff = None

    def setUp(self) -> None:
        clock = mock.patch.object(cla, "utcnow", lambda: NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.out, self.err = io.StringIO(), io.StringIO()
        for redirect in (
            contextlib.redirect_stdout(self.out),
            contextlib.redirect_stderr(self.err),
        ):
            redirect.__enter__()
            self.addCleanup(redirect.__exit__, None, None, None)

    def refused(self, reason: str) -> contextlib.AbstractContextManager[Any]:
        """Asserts that the block is refused for exactly this reason."""
        return self._raises(cla.Refused, reason)

    def fails(self, reason: str) -> contextlib.AbstractContextManager[Any]:
        """Asserts that the block fails, to be tried again, for exactly this reason."""
        return self._raises(RuntimeError, reason)

    @contextlib.contextmanager
    def _raises(self, kind: type[Exception], reason: str) -> Iterator[None]:
        with self.assertRaises(kind) as caught:
            yield
        self.assertEqual(str(caught.exception), reason)
        self.assertIs(type(caught.exception), kind)

    def history(self) -> History:
        history = History()
        self.addCleanup(history.close)
        return history
