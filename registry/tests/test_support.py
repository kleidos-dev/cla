# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The fakes fail when they should: each is handed the wrong thing here."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
import graphql
from support import API, REGISTRY, REPO, FakeGitHub, config_with, github


class GraphQL(unittest.TestCase):
    ROOT: Any = {"a": lambda id: {"__typename": "T", "x": id, "y": [1, 2], "z": {"w": 3}}}  # noqa: RUF012

    def run_document(self, text: str, **variables: Any) -> Any:
        return graphql.run(text, variables, self.ROOT)

    def test_only_what_is_asked_for_is_answered(self) -> None:
        self.assertEqual(
            self.run_document("query($i:ID!){a(id:$i){x ... on T{z{w}} ... on U{y}}}", i=5),
            {"a": {"x": 5, "z": {"w": 3}}},
        )
        self.assertEqual(
            self.run_document("query($i:Int){a(id:5){y}}", i=None), {"a": {"y": [1, 2]}}
        )

    def test_a_document_that_is_wrong_fails(self) -> None:
        for text in (
            "",
            "XX",
            "subscription($i:ID!){a(id:$i){x}}",
            "query{a}",
            "query($i:ID!){a(id:$i){x}}XX",
            "query($i:ID!){a(id:$i){x}",
            "query($i:ID!){a(id:$i){x};}",
            "query($i ID!){a(id:$i){x}}",
            "query($i:ID!){a(id:$i){nothing}}",
            "query($i:ID!){a(id:$i){x{w}}}",
            "query($i:ID!){a(id:$i){z}}",
            "query($i:ID!){a(id:$i){x(first:1)}}",
            "query($j:ID!){a(id:$j){x}}",
        ):
            with self.subTest(text), self.assertRaises(AssertionError):
                self.run_document(text, i=5)

    def test_a_value_that_must_be_there(self) -> None:
        with self.assertRaises(graphql.Refused):
            self.run_document("query($i:ID!){a(id:$i){x}}", i=None)


class Fake(unittest.TestCase):
    def test_a_call_no_test_expects_fails(self) -> None:
        for method, path in (
            ("GET", "/user"),
            ("POST", f"/repos/{REPO}"),
            ("DELETE", f"/repos/{REGISTRY}/contents/x?ref=signatures"),
            ("GET", f"/repos/{REPO}?x=1"),
            ("GET", f"/repos/{REGISTRY}/contents/x?ref=main"),
            ("GET", f"/repos/{REGISTRY}/contents/x"),
            ("GET", f"/repos/{REGISTRY}/commits?sha=main&path=x&per_page=1"),
            ("GET", f"/repos/{REPO}/pulls?state=open&per_page=1&page=1"),
        ):
            with self.subTest(path), self.assertRaises((AssertionError, KeyError)):
                github(FakeGitHub()).call(method, path)

    def test_a_request_that_is_not_the_recorders_fails(self) -> None:
        headers = {
            "authorization": "Bearer a-registry-token",
            "accept": "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "kleidos-cla-recorder",
        }
        fake, url = FakeGitHub(), f"{API}/repos/{REPO}"
        self.assertEqual(fake("GET", url, headers, None)[0], 200)
        for key in headers:
            for changed in ({**headers, key: "x"}, {k: v for k, v in headers.items() if k != key}):
                with self.assertRaises(AssertionError):
                    fake("GET", url, changed, None)
        for wrong in ("https://example.org/", f"http{API[5:]}/repos/{REPO}"):
            with self.assertRaises(AssertionError):
                fake("GET", wrong, headers, None)

    def test_a_commit_on_a_head_that_moved_is_refused(self) -> None:
        fake = FakeGitHub()
        head = cla._head(github(fake), REGISTRY)
        fake.move()
        with self.assertRaises(RuntimeError) as caught:
            cla._commit(github(fake), REGISTRY, head, {"a": b""}, [], "x")
        self.assertEqual(str(caught.exception), "GraphQL answered 200: ['STALE_DATA']")
        self.assertEqual(fake.writes, [])

    def test_a_changed_configuration_leaves_the_shared_one_alone(self) -> None:
        config_with()["versions"]["1"]["sentence"] = "x"
        self.assertNotEqual(config_with()["versions"]["1"]["sentence"], "x")


if __name__ == "__main__":
    unittest.main()
