# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Who wrote a pull request, and so who must sign: authors, co-authors and covering entities."""

from __future__ import annotations

import contextlib
import json
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import (
    ALICE,
    BAD_GATEWAY,
    BOB,
    CAROL,
    CONFIG,
    CONFIG_V2,
    DIGEST,
    DIGEST_V2,
    REGISTRY,
    REPO,
    RUN_ID,
    VECTORS,
    Answer,
    FakeGitHub,
    RegisterTest,
    Write,
    actor,
    commit,
    config_with,
    context,
    dump,
    ok,
    stranger,
)

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
        self.assertEqual(counts, {"noreply": 43, "trailers": 55, "commits": 27})


class Noreply(unittest.TestCase):
    def test_what_is_no_text_names_nobody(self) -> None:
        values: tuple[Any, ...] = (None, True, 1, 1.5, [], {})
        for email in values:
            with self.subTest(email):
                self.assertIsNone(cla.parse_noreply(email))


class Hostile(unittest.TestCase):
    def test_a_message_is_read_once_whatever_it_holds(self) -> None:
        """A commit message is its author's to write: no line of it is read more than twice."""
        for message in (
            "Co-authored-by: " + " " * 100_000,
            "Co-authored-by: " + " \t<a> " * 30_000 + "x",
            "Co-authored-by: " + "<" * 100_000,
            "Co-authored-by: \n" * 30_000,
        ):
            self.assertEqual(cla.trailer_emails(message), [])


class PullRequest(RegisterTest):
    """Everybody who wrote a pull request, each with the dates the contribution has."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()

    def authors(
        self, commits: list[dict[str, Any]], opener: Any = None
    ) -> tuple[dict[int, tuple[str, list[str]]], int]:
        pr = self.fake.merge(commits, opener)
        return cla.pr_authors(context(self.fake), REPO, pr)

    def test_the_opener_is_dated_by_the_creation_and_a_commit_by_its_own_date(self) -> None:
        self.assertEqual(
            self.authors(
                [
                    commit(date="2026-11-30T23:59:59Z"),
                    commit(BOB, "bob", date="2026-11-27T00:00:00+05:00"),
                    commit(date="2026-11-28T10:00:00Z"),
                ]
            ),
            (
                {
                    ALICE: ("User", ["2026-11-29", "2026-11-30", "2026-11-28"]),
                    BOB: ("User", ["2026-11-27"]),
                },
                0,
            ),
        )

    def test_the_opener_counts_though_no_commit_is_theirs(self) -> None:
        opener = {"id": CAROL, "login": "carol", "type": "Organization"}
        self.assertEqual(
            self.authors([commit()], opener),
            ({CAROL: ("Organization", ["2026-11-29"]), ALICE: ("User", ["2026-11-30"])}, 0),
        )

    def test_an_opener_github_does_not_name(self) -> None:
        users: tuple[Any, ...] = (None, {}, {"id": None}, {"id": 0}, {"id": True}, {"id": "5"}, [])
        for user in users:
            with self.subTest(user), self.fails("GitHub named no opener"):
                pr = self.fake.merge([commit()])
                pr["user"] = user
                cla.pr_authors(context(self.fake), REPO, pr)

    def test_co_authors_and_apps(self) -> None:
        message = "Change\n\nCo-authored-by: B <234567+bob@users.noreply.github.com>"
        app = stranger("49699333+dependabot[bot]@users.noreply.github.com")
        self.assertEqual(
            self.authors([commit(message=message, others=[app])]),
            (
                {
                    ALICE: ("User", ["2026-11-29", "2026-11-30"]),
                    49699333: ("Bot", ["2026-11-30"]),
                    BOB: ("User", ["2026-11-30"]),
                },
                0,
            ),
        )

    def test_everybody_who_cannot_be_identified_is_counted(self) -> None:
        unknown = "Change\n\nCo-authored-by: X <nobody@example.org>"
        people, count = self.authors(
            [
                commit(message=unknown),
                commit(others=[stranger("x@example.org"), stranger(None)]),
                commit(total=2),
            ]
        )
        self.assertEqual((list(people), count), ([ALICE], 4))

    def test_more_than_the_twenty_authors_a_query_returns_are_not_all_known(self) -> None:
        twenty = [actor(1000 + n, f"user{n}") for n in range(19)]
        self.assertEqual(self.authors([commit(others=twenty)])[1], 0)
        one_more = [*twenty, actor(2000, "late")]
        people, count = self.authors([commit(others=one_more)])
        self.assertEqual((2000 in people, count), (False, 1))

    def test_every_page_of_commits_is_read(self) -> None:
        people, _ = self.authors([*[commit()] * 249, commit(BOB, "bob")])
        self.assertEqual((len(people[ALICE][1]), len(people[BOB][1])), (250, 1))
        self.assertEqual(
            self.fake.calls.count("POST /graphql repository.pullRequest"), 3, self.fake.calls
        )

    def test_a_list_that_ends_is_asked_for_once(self) -> None:
        self.authors([commit()])
        self.assertEqual(self.fake.calls, ["POST /graphql repository.pullRequest"])

    def test_more_commits_than_github_lists_are_too_many(self) -> None:
        with self.refused("too many commits to check"):
            self.authors([commit()] * 251)

    def test_a_list_cut_short_is_refused(self) -> None:
        for cap, total in ((100, 101), (100, 250), (0, 1), (249, 250)):
            with (
                self.subTest(cap=cap),
                self.refused("GitHub listed fewer commits than the pull request has"),
            ):
                self.fake.cap = cap
                self.authors([commit()] * total)

    def answer(self, nodes: int, total: int, more: bool) -> Answer:
        page = {"hasNextPage": more, "endCursor": "c"}
        found = {"totalCount": total, "pageInfo": page, "nodes": [{"commit": JSON_COMMIT}] * nodes}
        return ok({"data": {"repository": {"pullRequest": {"commits": found}}}})

    def test_an_empty_page_that_promises_another_ends_the_list(self) -> None:
        call = "POST /graphql repository.pullRequest"
        self.fake.next(call, self.answer(1, 2, True), self.answer(0, 2, True))
        with self.refused("GitHub listed fewer commits than the pull request has"):
            self.authors([])
        self.fake.next(call, self.answer(2, 2, True), self.answer(0, 2, True))
        self.assertEqual(len(self.authors([])[0][ALICE][1]), 3)

    def test_a_list_that_goes_on_past_what_github_lists_ends_there(self) -> None:
        call = "POST /graphql repository.pullRequest"
        for pages, size in ((3, 100), (2, 125)):
            self.fake.calls.clear()
            self.fake.next(call, *[self.answer(size, 250, True)] * pages)
            self.assertEqual(len(self.authors([])[0][ALICE][1]), pages * size + 1)
            self.assertEqual(self.fake.calls, [call] * pages)

    def test_no_commit_list_is_a_failure(self) -> None:
        for data in (
            {},
            {"repository": None},
            {"repository": {"pullRequest": None}},
            {"repository": {"pullRequest": {"commits": None}}},
        ):
            self.fake.next("POST /graphql repository.pullRequest", ok({"data": data}))
            with self.subTest(data), self.fails("GitHub returned no commit list"):
                self.authors([commit()])


JSON_COMMIT = {**commit(), "authors": {"totalCount": 1, "nodes": [actor()]}}


def entity(**over: Any) -> dict[str, Any]:
    return {
        "slug": "example",
        "name": "Example GmbH",
        "version": 1,
        "set_sha256": DIGEST,
        "signed_at": "2026-11-01",
        "covered": [{"github_id": CAROL, "from": "2026-11-01"}],
        **over,
    }


class Entities(unittest.TestCase):
    """An account an entity covers on a date, under a version that is accepted."""

    def covers(
        self, *entities: dict[str, Any], date: str = "2026-12-01", config: Any = CONFIG
    ) -> bool:
        return cla.covering_entity(context(FakeGitHub(), config, list(entities)), CAROL, date)

    def test_the_days_from_and_until_are_covered_and_none_outside(self) -> None:
        until = [{"github_id": CAROL, "from": "2026-11-01", "until": "2026-11-30"}]
        for date, covered, expected in (
            ("2026-10-31", None, False),
            ("2026-11-01", None, True),
            ("2099-01-01", None, True),
            ("2026-10-31", until, False),
            ("2026-11-01", until, True),
            ("2026-11-30", until, True),
            ("2026-12-01", until, False),
        ):
            with self.subTest(date, until=bool(covered)):
                found = self.covers(entity(**({"covered": covered} if covered else {})), date=date)
                self.assertIs(found, expected)
        for until_null in (None, ""):
            period = [{"github_id": CAROL, "from": "2026-11-01", "until": until_null}]
            self.assertIs(self.covers(entity(covered=period)), True)

    def test_the_version_the_entity_signed_is_accepted_with_its_digest(self) -> None:
        retired = config_with(accepted_versions=[2])
        for name, over, config in (
            ("another digest", {"set_sha256": DIGEST_V2}, CONFIG),
            ("no digest", {"set_sha256": None}, CONFIG),
            ("a version never published", {"version": 9}, config_with(accepted_versions=[1, 9])),
            ("a version not accepted", {"version": 2, "set_sha256": DIGEST_V2}, CONFIG),
            ("a retired version", {}, retired),
            ("no version", {"version": None}, CONFIG),
        ):
            with self.subTest(name):
                changed: dict[str, Any] = over
                self.assertIs(self.covers(entity(**changed), config=config), False)

    def test_only_the_accounts_it_lists(self) -> None:
        for covered in ([], [{"github_id": BOB, "from": "2026-11-01"}]):
            self.assertIs(self.covers(entity(covered=covered)), False)
        lists_none = entity()
        del lists_none["covered"]
        self.assertIs(self.covers(lists_none), False)
        self.assertIs(self.covers(), False)

    def test_any_entity_and_any_period_of_it(self) -> None:
        past = {"github_id": CAROL, "from": "2020-01-01", "until": "2020-12-31"}
        other = {"github_id": BOB, "from": "2026-11-01"}
        now = {"github_id": CAROL, "from": "2026-11-01"}
        self.assertIs(self.covers(entity(covered=[past, other, now])), True)
        self.assertIs(self.covers(entity(version=9), entity(covered=[past]), entity()), True)


class Coverage(RegisterTest):
    """The coverage record of a merged pull request: everybody signed, or nothing is written."""

    PATH = f"coverage/{REPO}/7.json"

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.fake.sign(ALICE)

    def cover(self, entities: list[dict[str, Any]] | None = None, config: Any = CONFIG) -> str:
        return cla.record_coverage(context(self.fake, config, entities), REPO, 7)

    def missing(self, *accounts: int) -> Any:
        ids = ", ".join(map(str, accounts))
        return self.refused(f"merged without a signature from account id(s) {ids}")

    def test_the_whole_record(self) -> None:
        self.fake.sign(BOB)
        self.fake.merge(
            [
                commit(BOB, "bob"),
                commit(others=[stranger("49699333+dependabot[bot]@users.noreply.github.com")]),
            ]
        )
        self.assertEqual(self.cover(), f"recorded in {'a' * 39}b")
        content = dump(
            {
                "schema": 1,
                "kind": "coverage",
                "repo": REPO,
                "pr": 7,
                "merge_sha": "d" * 40,
                "merged_at": "2026-12-01T09:00:00Z",
                "github_ids": [ALICE, BOB],
                "versions": {str(ALICE): 1, str(BOB): 1},
                "recorded_at": "2026-12-01T10:23:02Z",
                "recorder_run_id": RUN_ID,
            }
        )
        self.assertEqual(self.fake.writes, [Write(f"coverage: {REPO}#7", {self.PATH: content}, [])])
        self.assertIsNone(cla.check_record(CONFIG, self.PATH, content))

    def test_each_account_has_the_version_it_had_accepted(self) -> None:
        self.fake.sign(BOB, CONFIG_V2, version=2, method="comment")
        self.fake.merge([commit(BOB, "bob")])
        self.cover(config=CONFIG_V2)
        record = json.loads(self.fake.files[self.PATH])
        self.assertEqual(record["versions"], {str(ALICE): 1, str(BOB): 2})

    def test_a_pull_request_of_exempt_accounts_covers_nobody(self) -> None:
        owner = {"id": cla.OWNER_ID, "login": "owner", "type": "User"}
        self.fake.merge([commit(cla.OWNER_ID, "owner")], owner)
        self.cover()
        record = json.loads(self.fake.files[self.PATH])
        self.assertEqual((record["github_ids"], record["versions"]), ([], {}))

    def test_not_merged_is_refused(self) -> None:
        for merged in (False, None):
            self.fake.merge([commit()])["merged"] = merged
            with self.refused("the pull request is not merged"):
                self.cover()
        self.fake.pulls[7] = {}
        with self.refused("the pull request is not merged"):
            self.cover()
        self.assertEqual(self.fake.writes, [])

    def test_not_served_is_refused_unread(self) -> None:
        with self.refused("a/b is not a served repository"):
            cla.record_coverage(context(self.fake), "a/b", 7)
        self.assertEqual(self.fake.calls, [])

    def test_everybody_missing_is_named_and_nothing_is_written(self) -> None:
        self.fake.merge([commit(CAROL, "carol"), commit(BOB, "bob")])
        with self.missing(BOB, CAROL):
            self.cover()
        self.assertEqual(self.fake.writes, [])

    def test_one_who_signed_under_a_version_no_longer_accepted_is_missing(self) -> None:
        self.fake.merge([commit()])
        with self.missing(ALICE):
            self.cover(config=config_with(CONFIG_V2, accepted_versions=[2]))
        self.assertEqual(self.fake.writes, [])

    def test_an_app_that_is_not_exempt_is_missing_whatever_it_signed(self) -> None:
        self.fake.sign(BOB)
        app = stranger(f"{BOB}+bob[bot]@users.noreply.github.com")
        self.fake.merge([commit(others=[app])])
        with self.missing(BOB):
            self.cover()
        organization = {"id": ALICE, "login": "alice", "type": "Organization"}
        self.fake.merge([commit()], organization)
        with self.missing(ALICE):
            self.cover()
        self.fake.merge([commit()], {"id": ALICE, "login": "alice"})
        with self.missing(ALICE):
            self.cover()
        self.assertEqual(self.fake.writes, [])

    def test_somebody_unknown_is_refused_though_all_others_signed(self) -> None:
        self.fake.merge([commit(others=[stranger("x@example.org"), stranger(None)])])
        with self.refused("2 author(s) cannot be identified"):
            self.cover()
        self.assertEqual(self.fake.writes, [])

    def test_the_author_of_a_merge_commit_must_have_signed(self) -> None:
        merge = commit(CAROL, "carol") | {"parents": {"totalCount": 2}}
        self.fake.merge([commit(), merge])
        with self.missing(CAROL):
            self.cover()

    def test_an_account_an_entity_covers_on_every_date_needs_no_signature(self) -> None:
        self.fake.merge(
            [commit(CAROL, "carol"), commit(CAROL, "carol", date="2026-11-05T10:00:00Z")]
        )
        self.cover([entity()])
        self.assertEqual(json.loads(self.fake.files[self.PATH])["github_ids"], [ALICE])

    def test_a_date_out_of_the_period_of_the_entity_needs_a_signature(self) -> None:
        self.fake.merge(
            [commit(CAROL, "carol"), commit(CAROL, "carol", date="2026-10-31T10:00:00Z")]
        )
        with self.missing(CAROL):
            self.cover([entity()])

    def test_the_opener_is_covered_on_the_day_of_the_creation(self) -> None:
        for day, covered in (("2026-11-29", True), ("2026-11-30", False), ("2026-12-01", False)):
            with self.subTest(day):
                self.setUp()
                self.fake.merge([commit()], {"id": CAROL, "login": "carol", "type": "User"})
                period = [{"github_id": CAROL, "from": day, "until": day}]
                with contextlib.nullcontext() if covered else self.missing(CAROL):
                    self.cover([entity(covered=period)])
                self.assertEqual(len(self.fake.writes), int(covered))

    def test_an_author_is_covered_on_the_day_of_the_commit(self) -> None:
        for day, covered in (("2026-11-29", False), ("2026-11-30", True), ("2026-12-01", False)):
            with self.subTest(day):
                self.setUp()
                self.fake.merge([commit(CAROL, "carol")])
                period = [{"github_id": CAROL, "from": day, "until": day}]
                with contextlib.nullcontext() if covered else self.missing(CAROL):
                    self.cover([entity(covered=period)])
                self.assertEqual(len(self.fake.writes), int(covered))

    def test_a_pull_request_already_recorded_is_not_recorded_again(self) -> None:
        self.fake.merge([commit()])
        self.cover()
        self.assertEqual(self.cover(), "already recorded")
        self.assertEqual(len(self.fake.writes), 1)

    def test_a_record_that_cannot_be_read_is_a_failure(self) -> None:
        self.fake.merge([commit()])
        self.fake.next(f"GET /repos/{REGISTRY}/contents/{self.PATH}", BAD_GATEWAY)
        with self.fails(f"reading {self.PATH} answered 502"):
            self.cover()
        self.assertEqual(self.fake.writes, [])


if __name__ == "__main__":
    unittest.main()
