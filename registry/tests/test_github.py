# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""What a GitHub answer can do: the transport, the API calls, the commits and the witness."""

from __future__ import annotations

import base64
import email.message
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import graphql
from support import (
    API,
    BAD_GATEWAY,
    BEARER,
    NOT_FOUND,
    REGISTRY,
    Answer,
    FakeGitHub,
    Lost,
    RegisterTest,
    Write,
    github,
    ok,
)
from test_timestamps import UNREACHABLE

HEADERS = {
    "authorization": f"Bearer {BEARER}",
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "kleidos-cla-recorder",
}
#: A 200 that holds no object: what a proxy, a cut answer or a change of the API could give.
NOT_OBJECTS: tuple[bytes, ...] = (b"", b"null", b"[]", b"1", b'"text"', b"<html>", b"{", b"\xff{}")


class Once:
    """A transport that answers each call with the next of these, and keeps the calls."""

    def __init__(self, *answers: Answer) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> Answer:
        self.calls.append((method, url, headers, body))
        return self.answers.pop(0)


class Transports(unittest.TestCase):
    """urllib, with only the schemes each transport allows."""

    def answer(self, status: int = 200) -> Any:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = status
        response.read.return_value = b"body"
        response.headers = email.message.Message()
        response.headers["Date"] = "Tue, 01 Dec 2026 10:22:58 GMT"
        response.headers["X-Other"] = "Kept"
        return response

    def test_a_request_is_sent_as_given_and_ends_after_half_a_minute(self) -> None:
        for transport, url in (
            (cla.urllib_transport, "https://api.github.com/repos"),
            (cla.tsa_transport, "https://tsa.invalid/"),
            (cla.tsa_transport, "http://tsa.invalid/"),
        ):
            with (
                self.subTest(url),
                mock.patch("urllib.request.urlopen", return_value=self.answer(201)) as urlopen,
            ):
                found = transport("DELETE", url, {"X-Header": "v"}, b"sent")
                self.assertEqual(
                    found,
                    (
                        201,
                        b"body",
                        {"date": "Tue, 01 Dec 2026 10:22:58 GMT", "x-other": "Kept"},
                    ),
                )
                ((request,), options) = urlopen.call_args
                self.assertEqual(options, {"timeout": 30})
                self.assertEqual(
                    (request.method, request.full_url, request.data, request.headers),
                    ("DELETE", url, b"sent", {"X-header": "v"}),
                )

    def test_an_http_error_is_an_answer(self) -> None:
        headers = email.message.Message()
        headers["Retry-After"] = "Soon"
        error = urllib.error.HTTPError("https://x", 422, "no", headers, io.BytesIO(b"why"))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            self.assertEqual(
                cla.urllib_transport("GET", "https://api.github.com/", {}, None),
                (422, b"why", {"retry-after": "Soon"}),
            )

    def test_another_scheme_is_refused_before_anything_is_sent(self) -> None:
        for transport, url, reason in (
            (
                cla.urllib_transport,
                "http://api.github.com/x?token=secret",
                "http://api.github.com/x",
            ),
            (cla.urllib_transport, "file:///etc/passwd", "file:///etc/passwd"),
            (cla.tsa_transport, "ftp://tsa.invalid/a?b", "ftp://tsa.invalid/a"),
            (cla.tsa_transport, "file:///etc/passwd", "file:///etc/passwd"),
        ):
            allowed = "https://" if transport is cla.urllib_transport else "https:// or http://"
            with self.subTest(url), mock.patch("urllib.request.urlopen") as urlopen:
                with self.assertRaises(RuntimeError) as caught:
                    transport("GET", url, {}, None)
                self.assertEqual(
                    str(caught.exception), f"refusing a request to {reason}: not {allowed}"
                )
                urlopen.assert_not_called()

    def test_a_connection_that_fails_is_left_to_the_caller(self) -> None:
        with (
            mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")),
            self.assertRaises(urllib.error.URLError),
        ):
            cla.urllib_transport("GET", "https://api.github.com/", {}, None)


class Requests(RegisterTest):
    def test_a_request_carries_the_token_of_the_registry_and_names_the_recorder(self) -> None:
        transport = Once((200, b"{}", {}))
        github(transport).exchange("GET", "/x")
        self.assertEqual(transport.calls, [("GET", f"{API}/x", HEADERS, None)])

    def test_a_body_is_json_and_an_app_signs_with_its_secret(self) -> None:
        transport = Once((200, b"{}", {}))
        github(transport).exchange("POST", "/x", {"a": "é"}, "text/plain", basic=("id", "secret"))
        self.assertEqual(
            transport.calls,
            [
                (
                    "POST",
                    f"{API}/x",
                    {
                        **HEADERS,
                        "authorization": f"Basic {base64.b64encode(b'id:secret').decode()}",
                        "accept": "text/plain",
                        "content-type": "application/json",
                    },
                    b'{"a": "\\u00e9"}',
                )
            ],
        )

    def test_the_api_address_is_the_runs(self) -> None:
        transport = Once((200, b"{}", {}))
        cla.GitHub("t", "https://ghe.invalid/api", transport).call("GET", "/x")
        self.assertEqual(transport.calls[0][1], "https://ghe.invalid/api/x")
        self.assertEqual(cla.GitHub("t").api, API)
        self.assertIs(cla.GitHub("t").transport, cla.urllib_transport)

    def test_a_call_gives_the_status_and_the_json(self) -> None:
        for body, found in (
            (b'{"a": [1]}', {"a": [1]}),
            (b"[]", []),
            (b"", None),
            (b"null", None),
            (b"<html>", None),
            (b"\xff", None),
            (b"[" * 100_000, None),
            (b"1" * 5000, None),
        ):
            with self.subTest(body[:9]):
                transport = Once((502, body, {}))
                self.assertEqual(github(transport).call("PUT", "/x", {"b": 1}), (502, found))
                self.assertEqual(
                    transport.calls[0],
                    (
                        "PUT",
                        f"{API}/x",
                        {**HEADERS, "content-type": "application/json"},
                        b'{"b": 1}',
                    ),
                )

    def test_get_gives_an_object_and_nothing_else(self) -> None:
        transport = Once(ok({"a": 1}))
        self.assertEqual(github(transport).get("/x?y=1"), {"a": 1})
        self.assertEqual(transport.calls, [("GET", f"{API}/x?y=1", HEADERS, None)])
        for status in (201, 404, 500):
            with self.fails(f"GET /x answered {status}"):
                github(Once(ok({}, status))).get("/x?y=secret")
        with self.fails("GET /x answered 502"):
            github(Once(BAD_GATEWAY)).get("/x")
        for body in NOT_OBJECTS:
            with self.subTest(body), self.fails("GET /x answered no object"):
                github(Once((200, body, {}))).get("/x?y")

    def test_get_list_gives_objects_and_nothing_else(self) -> None:
        self.assertEqual(github(Once(ok([{"a": 1}]))).get_list("/x"), [{"a": 1}])
        self.assertEqual(github(Once(ok([]))).get_list("/x"), [])
        with self.fails("GET /x answered 404"):
            github(Once(NOT_FOUND)).get_list("/x?y")
        for body in (*NOT_OBJECTS, b"{}", b"[1]", b"[{}, null]"):
            if body == b"[]":
                continue
            with self.subTest(body), self.fails("GET /x answered no list of objects"):
                github(Once((200, body, {}))).get_list("/x?y")

    def test_the_pages_of_a_list_are_read_while_they_are_full(self) -> None:
        full: list[dict[str, Any]] = [{"n": n} for n in range(100)]
        transport = Once(ok(full), ok(full), ok([{"n": 1}]))
        found = list(github(transport).pages("/x?y=1"))
        self.assertEqual(found, [*full, *full, {"n": 1}])
        self.assertEqual(
            [c[1] for c in transport.calls],
            [f"{API}/x?y=1&per_page=100&page={n}" for n in (1, 2, 3)],
        )
        self.assertEqual(list(github(Once(ok(full), ok([]))).pages("/x?y=1")), full)
        self.assertEqual(list(github(Once(ok(full[:99]))).pages("/x?y=1")), full[:99])
        transport = Once(ok(full))
        self.assertEqual(next(github(transport).pages("/x?y=1")), {"n": 0})
        self.assertEqual(len(transport.calls), 1)

    def test_a_list_without_an_end_is_not_read_for_ever(self) -> None:
        full: list[dict[str, Any]] = [{"n": n} for n in range(100)]
        transport = Once(*[ok(full)] * 51)
        with self.fails("GET /x has more than 50 pages"):
            list(github(transport).pages("/x?y=1"))
        self.assertEqual(len(transport.calls), 50)

    def test_a_file_is_its_bytes_or_nothing(self) -> None:
        transport = Once((200, b"\xff\x00", {}), NOT_FOUND, ok({}, 403))
        gh = github(transport)
        self.assertEqual(gh.file("o/n", "a/b.tsr", "main"), b"\xff\x00")
        self.assertEqual(
            transport.calls[0],
            (
                "GET",
                f"{API}/repos/o/n/contents/a/b.tsr?ref=main",
                {**HEADERS, "accept": "application/vnd.github.raw+json"},
                None,
            ),
        )
        self.assertIsNone(gh.file("o/n", "a/b.tsr", "main"))
        with self.fails("reading a/b.tsr answered 403"):
            gh.file("o/n", "a/b.tsr", "main")

    def test_graphql_gives_the_data(self) -> None:
        transport = Once(ok({"data": {"a": 1}, "errors": []}))
        self.assertEqual(github(transport).graphql("query", {"v": 1}), {"a": 1})
        self.assertEqual(
            transport.calls,
            [
                (
                    "POST",
                    f"{API}/graphql",
                    {**HEADERS, "content-type": "application/json"},
                    b'{"query": "query", "variables": {"v": 1}}',
                )
            ],
        )

    def test_graphql_without_usable_data_fails_whatever_the_answer(self) -> None:
        for answer, reason in (
            (BAD_GATEWAY, "GraphQL answered 502: None"),
            (ok({"data": {"a": 1}}, 201), "GraphQL answered 201: None"),
            (
                ok({"data": {"a": 1}, "errors": [{"type": "X"}, {}, 1]}),
                "GraphQL answered 200: ['X', None, None]",
            ),
            (ok({"data": {"a": 1}, "errors": "X"}), "GraphQL answered 200: X"),
            (ok({"data": {"a": 1}, "errors": [{"type": "X"}]}, 401), "GraphQL answered 401: ['X']"),
            (ok({"data": None}), "GraphQL answered 200: None"),
            (ok({"data": []}), "GraphQL answered 200: None"),
            *(((200, b, {}), "GraphQL answered 200: None") for b in (*NOT_OBJECTS, b"{}")),
        ):
            with self.subTest(answer), self.fails(reason):
                github(Once(answer)).graphql("query", {})


class Commits(RegisterTest):
    """One commit of the signatures branch, whatever happens on the way."""

    FILES: ClassVar = {
        "signatures/individual/1.json": b"{}\n",
        "signatures/individual/1.tsr": b"\xff\x00",
    }

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.gh = github(self.fake)

    def commit(self, deletions: list[str] | None = None, **kw: Any) -> str:
        return cla.commit_files(self.gh, REGISTRY, self.FILES, deletions or [], "sign: 1", **kw)

    def test_the_files_go_in_one_commit_on_the_head_that_was_read(self) -> None:
        self.assertEqual(self.commit(), self.fake.head)
        self.assertEqual(self.fake.writes, [Write("sign: 1", self.FILES, [])])
        self.assertEqual(
            self.fake.calls,
            ["POST /graphql repository.ref", "POST /graphql createCommitOnBranch"],
        )

    def test_a_deletion_goes_in_the_same_commit(self) -> None:
        self.fake.files["signatures/individual/2.tsr"] = b"x"
        self.commit(["signatures/individual/2.tsr"])
        self.assertEqual(
            self.fake.writes, [Write("sign: 1", self.FILES, ["signatures/individual/2.tsr"])]
        )
        self.assertEqual(self.fake.files, self.FILES)

    def test_a_branch_that_moved_is_read_and_written_again(self) -> None:
        stale = ok({"data": None, "errors": [{"type": "STALE_DATA"}]})
        self.fake.next("POST /graphql createCommitOnBranch", stale, stale)
        self.assertEqual(self.commit(), self.fake.head)
        self.assertEqual(len(self.fake.writes), 1)
        self.assertEqual(self.fake.calls.count("POST /graphql repository.ref"), 3)

    def test_an_answer_that_is_no_json_or_no_commit_is_one_more_try(self) -> None:
        answers: tuple[Answer | Exception, ...] = (
            BAD_GATEWAY,
            ok({"data": {"createCommitOnBranch": None}}),
            ok({"data": {"createCommitOnBranch": {"commit": {"oid": 1}}}}),
            *UNREACHABLE,
        )
        for answer in answers:
            for call in ("POST /graphql createCommitOnBranch", "POST /graphql repository.ref"):
                with self.subTest(call=call, answer=answer):
                    self.setUp()
                    self.fake.next(call, answer)
                    self.assertEqual(self.commit(), self.fake.head)
                    self.assertEqual(self.fake.writes, [Write("sign: 1", self.FILES, [])])

    def test_it_gives_up_after_the_tries_it_has(self) -> None:
        self.fake.next("POST /graphql createCommitOnBranch", *[BAD_GATEWAY] * 5)
        with self.fails(
            "could not commit signatures/individual/1.json, signatures/individual/1.tsr: "
            "GraphQL answered 502: None"
        ):
            self.commit()
        self.assertEqual(self.fake.calls.count("POST /graphql createCommitOnBranch"), 5)
        self.setUp()
        self.fake.next("POST /graphql createCommitOnBranch", *[BAD_GATEWAY] * 2)
        with self.assertRaises(RuntimeError):
            self.commit(attempts=2)
        self.setUp()
        self.fake.next("POST /graphql createCommitOnBranch", *[ok({"data": {}})] * 5)
        with self.fails(
            "could not commit coverage/o/n/1.json: createCommitOnBranch answered no commit id"
        ):
            cla.commit_files(self.gh, REGISTRY, {"coverage/o/n/1.json": b"x"}, [], "coverage")

    def test_a_branch_that_does_not_exist_takes_no_commit(self) -> None:
        for data in (
            {"repository": None},
            {"repository": {"ref": None}},
            {"repository": {"ref": {"target": {"oid": 1}}}},
        ):
            self.setUp()
            self.fake.next("POST /graphql repository.ref", *[ok({"data": data})] * 5)
            with self.fails(
                "could not commit signatures/individual/1.json, signatures/individual/1.tsr: "
                "the branch signatures does not exist"
            ):
                self.commit()
            self.assertEqual(self.fake.writes, [])

    def test_a_commit_whose_answer_was_lost_is_found_and_not_written_twice(self) -> None:
        self.fake.files["signatures/individual/2.tsr"] = b"x"
        self.fake.next("POST /graphql createCommitOnBranch", Lost())
        self.assertEqual(self.commit(["signatures/individual/2.tsr"]), self.fake.head)
        self.assertEqual(len(self.fake.writes), 1)

    def test_what_another_run_wrote_there_is_not_taken_for_ours(self) -> None:
        for left in (
            {"signatures/individual/1.json": b"{}\n"},
            {**self.FILES, "signatures/individual/1.json": b"another"},
            {**self.FILES, "signatures/individual/2.tsr": b"not deleted"},
        ):
            with self.subTest(left):
                self.setUp()
                self.fake.files = {"signatures/individual/2.tsr": b"x", **left}
                deleted = ["signatures/individual/2.tsr"]
                self.fake.next("POST /graphql createCommitOnBranch", BAD_GATEWAY)
                self.commit(deleted)
                self.assertEqual(self.fake.writes, [Write("sign: 1", self.FILES, deleted)])

    def test_the_first_try_asks_nothing_of_the_files(self) -> None:
        self.fake.files = dict(self.FILES)
        self.commit()
        self.assertEqual(len(self.fake.writes), 1)


def history_page(
    nodes: list[dict[str, Any]], more: bool = False, cursor: str | None = None
) -> Answer:
    page = {"hasNextPage": more, "endCursor": cursor}
    history = {"pageInfo": page, "nodes": nodes}
    return ok({"data": {"repository": {"ref": {"target": {"history": history}}}}})


NODE: dict[str, Any] = {
    "oid": "1" * 40,
    "author": {"user": {"databaseId": 41898282}},
    "committer": {"email": "NoReply@GitHub.com", "user": None},
    "signature": {"isValid": True, "wasSignedByGitHub": True},
}


class CommitFacts(RegisterTest):
    """What GitHub says of every commit of the branch."""

    def facts(self, *pages: Answer) -> dict[str, cla.Facts]:
        self.transport = Once(*pages)
        return cla.commit_facts(github(self.transport), REGISTRY, "signatures")

    def sent(self) -> list[Any]:
        return [json.loads(body or b"")["variables"] for _, _, _, body in self.transport.calls]

    def test_the_author_the_committer_and_the_signature(self) -> None:
        self.assertEqual(
            self.facts(history_page([NODE])),
            {"1" * 40: cla.Facts(41898282, None, "noreply@github.com", True, True)},
        )
        owner, name = REGISTRY.split("/")
        self.assertEqual(
            self.sent(),
            [{"owner": owner, "name": name, "ref": "refs/heads/signatures", "cursor": None}],
        )
        committed = {**NODE, "committer": {"email": "a@b", "user": {"databaseId": 28966312}}}
        self.assertEqual(
            self.facts(history_page([committed])),
            {"1" * 40: cla.Facts(41898282, 28966312, "a@b", True, True)},
        )

    def test_what_github_does_not_say_vouches_for_nothing(self) -> None:
        nobody = cla.Facts(None, None, "none", False, False)
        for node in (
            {"oid": "1" * 40},
            {"oid": "1" * 40, "author": None, "committer": None, "signature": None},
            {"oid": "1" * 40, "author": {"user": None}, "committer": {"email": None}},
            {
                "oid": "1" * 40,
                "signature": {"isValid": 1, "wasSignedByGitHub": "true"},
            },
        ):
            with self.subTest(node):
                self.assertEqual(self.facts(history_page([node])), {"1" * 40: nobody})
        valid = {**NODE, "signature": {"isValid": False, "wasSignedByGitHub": True}}
        self.assertEqual(
            self.facts(history_page([valid]))["1" * 40],
            cla.Facts(41898282, None, "noreply@github.com", False, True),
        )

    def test_the_pages_are_read_to_the_end(self) -> None:
        second = {**NODE, "oid": "2" * 40}
        found = self.facts(history_page([NODE], True, "c1"), history_page([second]))
        self.assertEqual(list(found), ["1" * 40, "2" * 40])
        self.assertEqual([v["cursor"] for v in self.sent()], [None, "c1"])
        self.assertEqual(self.facts(history_page([])), {})

    def test_a_page_with_nothing_new_is_no_reason_to_ask_for_ever(self) -> None:
        reason = "GitHub's history of signatures goes on with no commit in it"
        with self.fails(reason):
            self.facts(history_page([], True, "c1"))
        with self.fails(reason):
            self.facts(history_page([NODE], True, "c1"), history_page([NODE], True, "c1"))

    def test_a_branch_that_does_not_exist(self) -> None:
        for data in ({"repository": None}, {"repository": {"ref": None}}):
            with self.fails("the branch signatures does not exist"):
                self.facts(ok({"data": data}))

    def test_the_document_asks_for_what_is_read(self) -> None:
        """Answered by the fake's schema, so that a field left out would be missing."""

        def history(first: int, after: str | None) -> dict[str, Any]:
            self.assertEqual((first, after), (100, None))
            return {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [NODE]}

        target = {"__typename": "Commit", "history": history}

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> Answer:
            sent = json.loads(body or b"")
            root = {
                "repository": lambda owner, name: {"ref": lambda qualifiedName: {"target": target}}
            }
            return ok({"data": graphql.run(sent["query"], sent["variables"], root)})

        self.assertEqual(
            cla.commit_facts(github(transport), REGISTRY, "signatures"),
            {"1" * 40: cla.Facts(41898282, None, "noreply@github.com", True, True)},
        )


class Witness(RegisterTest):
    """What the verifier reads again from GitHub: the comment and the run a record cites."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.comment = self.fake.add_comment(5, "I accept")
        self.witness = cla.GitHubWitness(github(self.fake), REGISTRY)

    def test_a_comment_as_github_has_it(self) -> None:
        found: dict[str, Any] = {
            "author_id": 123456,
            "edited": False,
            "created_at": "2026-12-01T10:22:31Z",
            "body": "I accept",
            "pr": 7,
            "repo": "kleidos-dev/cla-sandbox",
        }
        self.assertEqual(self.witness.comment("kleidos-dev/cla-sandbox", 5), found)
        for key, value in (("lastEditedAt", "2026-12-01T11:00:00Z"), ("editor", {"login": "x"})):
            self.comment["node"] |= {"lastEditedAt": None, "editor": None, key: value}
            self.assertEqual(
                self.witness.comment("kleidos-dev/cla-sandbox", 5), {**found, "edited": True}
            )

    def test_a_comment_with_nothing_in_it_matches_no_record(self) -> None:
        self.fake.next("POST /graphql node", ok({"data": {"node": None}}))
        self.assertEqual(
            self.witness.comment("kleidos-dev/cla-sandbox", 5),
            {
                "author_id": None,
                "edited": False,
                "created_at": None,
                "body": "None",
                "pr": None,
                "repo": None,
            },
        )

    def test_a_comment_that_is_gone_or_cannot_be_read(self) -> None:
        self.assertIsNone(self.witness.comment("kleidos-dev/cla-sandbox", 6))
        self.assertIsNone(self.witness.comment("kleidos-dev/other", 5))
        self.fake.next("GET", ok({}, 500))
        with self.fails("reading comment 5 answered 500"):
            self.witness.comment("kleidos-dev/cla-sandbox", 5)
        for body in NOT_OBJECTS:
            self.fake.next("GET", (200, body, {}))
            with self.assertRaises(RuntimeError):
                self.witness.comment("kleidos-dev/cla-sandbox", 5)

    def test_a_run_as_github_has_it(self) -> None:
        transport = Once(ok({"id": 9}), NOT_FOUND, ok({}, 500), (200, b"[]", {}))
        witness = cla.GitHubWitness(github(transport), REGISTRY)
        self.assertEqual(witness.run(9), {"id": 9})
        self.assertEqual(
            transport.calls, [("GET", f"{API}/repos/{REGISTRY}/actions/runs/9", HEADERS, None)]
        )
        self.assertIsNone(witness.run(9))
        with self.fails("reading run 9 answered 500"):
            witness.run(9)
        with self.fails("reading run 9 answered no object"):
            witness.run(9)


class Workflows(RegisterTest):
    def test_the_recorder_and_the_verifier_must_be_enabled(self) -> None:
        transport = Once(ok({"state": "active"}), ok({"state": "active"}))
        self.assertEqual(cla.verify_workflows(github(transport), REGISTRY), [])
        self.assertEqual(
            transport.calls,
            [
                ("GET", f"{API}/repos/{REGISTRY}/actions/workflows/{wf}", HEADERS, None)
                for wf in ("record.yml", "verify.yml")
            ],
        )
        states = (ok({"state": "disabled_manually"}), ok({}))
        self.assertEqual(
            cla.verify_workflows(github(Once(*states)), REGISTRY),
            [
                cla.Finding("0" * 12, "the workflow record.yml is disabled_manually, not active"),
                cla.Finding("0" * 12, "the workflow verify.yml is None, not active"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
