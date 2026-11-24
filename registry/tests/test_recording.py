# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""What the recorder writes, and what it refuses: signatures, sign-ins, removals and stamps."""

from __future__ import annotations

import json
import sys
import unicodedata
import unittest
from pathlib import Path
from typing import Any, cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import (
    ALICE,
    APP,
    APP_ID,
    BAD_GATEWAY,
    BOB,
    CONFIG,
    CONFIG_V2,
    DIGEST,
    DIGEST_V2,
    NOT_FOUND,
    OTHER_CLIENT_ID,
    RECORDER_COMMIT,
    REGISTRY,
    REPO,
    RUN_ID,
    SENTENCE,
    SENTENCE_V2,
    SIGNIN_CLIENT_ID,
    SIGNIN_SECRET,
    SITE_COMMIT,
    TOKEN,
    Answer,
    FakeGitHub,
    FakeStamper,
    RegisterTest,
    Write,
    comment_record,
    commit,
    config_with,
    context,
    dump,
    individual,
    ok,
    recorder_commit,
    redact_commit,
    signin_record,
    token_for,
)
from test_timestamps import UNREACHABLE

DELETE = f"DELETE /applications/{APP.client_id}/grant"
#: The digits and letters of a digest, each the wide one that is only compatible with it.
FULL_WIDTH = {ord(c): ord(c) - 0x20 + 0xFF00 for c in "0123456789abcdef"}


def signin(
    fake: FakeGitHub,
    *,
    config: dict[str, Any] = CONFIG_V2,
    repo: str = REPO,
    pr: int = 7,
    gid: int | None = ALICE,
    version: int | None = 2,
    lang: str | None = "en",
    site_commit: str | None = SITE_COMMIT,
    token: str = TOKEN,
    app: cla.SigninApp = APP,
    stamper: cla.Stamper | None = None,
    commit: str = "f" * 40,
) -> str:
    """The record of a sign-in, as ``record --kind signin`` asks for it."""
    ctx = context(fake, config=config, stamper=stamper, commit=commit)
    return cla.record_signin(ctx, app, repo, pr, gid, version, lang, site_commit, token)


def ready() -> FakeGitHub:
    """A GitHub on which that sign-in is recorded."""
    fake = FakeGitHub()
    fake.add_signin()
    fake.pulls[7] = {"number": 7}
    return fake


class Defaults(unittest.TestCase):
    def test_a_run_that_is_told_nothing_more(self) -> None:
        made = cla.Context(cla.GitHub("t"), REGISTRY, 1, CONFIG)
        self.assertEqual((made.entities, made.stamper, made.commit), ([], None, ""))


class Served(RegisterTest):
    """A repository the register records for: listed, and public."""

    def test_a_listed_public_repository_is_served(self) -> None:
        fake = FakeGitHub()
        cla.served(context(fake), REPO)
        self.assertEqual(fake.calls, [f"GET /repos/{REPO}"])

    def test_a_repository_that_is_not_listed_is_refused_unasked(self) -> None:
        fake = FakeGitHub()
        for repo in ("kleidos-dev/boards", "", REPO.upper(), f"{REPO}\n", f" {REPO}"):
            with self.subTest(repo), self.refused(f"{repo} is not a served repository"):
                cla.served(context(fake), repo)
        self.assertEqual(fake.calls, [])

    def test_a_name_github_cannot_have_is_refused_though_listed(self) -> None:
        for repo, good in (
            ("a/b", True),
            ("A-9/a.B_c-9", True),
            ("a" * 39 + "/" + "b" * 100, True),
            ("a" * 40 + "/b", False),
            ("a/" + "b" * 101, False),
            ("/b", False),
            ("a/", False),
            ("a", False),
            ("a/b/c", False),
            ("a.b/c", False),
            ("a_b/c", False),
            ("a/b c", False),
            ("a/b?c", False),
            ("a/b\n", False),
            ("\n" + "a/b", False),
            ("\u00e1/b", False),
            ("a/\u0661", False),
        ):
            with self.subTest(repo):
                fake = FakeGitHub(repos={repo: {"private": False}})
                ctx = context(fake, config_with(served_repositories={repo: {}}))
                if good:
                    cla.served(ctx, repo)
                    continue
                with self.refused(f"{repo} is not a served repository"):
                    cla.served(ctx, repo)
                self.assertEqual(fake.calls, [])

    def test_a_repository_github_does_not_call_public_is_refused(self) -> None:
        answers: tuple[Any, ...] = ({"private": True}, {}, {"private": None}, {"private": 0})
        for answer in answers:
            with self.subTest(answer), self.refused(f"{REPO} is not public"):
                cla.served(context(FakeGitHub(repos={REPO: answer})), REPO)


class Sign(RegisterTest):
    """A signature by comment: one genuine, unedited acceptance by the account that wrote it."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()

    def sign(
        self, cid: int = 1, config: dict[str, Any] = CONFIG, stamper: cla.Stamper | None = None
    ) -> str:
        return cla.record_sign(context(self.fake, config, stamper=stamper), REPO, 7, cid)

    def expected(self, **over: Any) -> dict[str, Any]:
        return {
            "schema": 1,
            "kind": "individual",
            "github_id": ALICE,
            "login_at_signing": "alice",
            "agreement": "kleidos-ca",
            "version": 1,
            "set_sha256": DIGEST,
            "accepted_at": "2026-12-01T10:22:31Z",
            "method": "web",
            "evidence": {
                "pr_url": f"https://github.com/{REPO}/pull/7",
                "comment_url": f"https://github.com/{REPO}/pull/7#issuecomment-1",
                "comment_id": 1,
                "comment_body_sha256": cla.sha256(SENTENCE),
            },
            "recorded_at": "2026-12-01T10:23:02Z",
            "recorder_run_id": RUN_ID,
            **over,
        }

    def test_the_whole_record_and_its_token_in_one_commit(self) -> None:
        self.fake.add_comment(1)
        stamper = FakeStamper()
        self.assertEqual(self.sign(stamper=stamper), f"recorded in {'a' * 39}b")
        content = dump(self.expected())
        self.assertEqual(
            self.fake.writes,
            [
                Write(
                    "sign: alice (123456) accepts version 1",
                    {individual(ALICE): content, individual(ALICE, "tsr"): token_for(content)},
                    [],
                )
            ],
        )
        self.assertEqual(stamper.asked, [cla.sha256(content)])
        self.assertIsNone(cla.check_record(CONFIG, individual(ALICE), content))

    def test_everything_is_read_from_github_before_anything_is_written(self) -> None:
        self.fake.add_comment(1)
        self.sign()
        self.assertEqual(
            self.fake.calls,
            [
                f"GET /repos/{REPO}",
                f"GET /repos/{REPO}/issues/comments/1",
                "POST /graphql node",
                f"GET /repos/{REGISTRY}/contents/{individual(ALICE)}?ref=signatures",
                f"GET /repos/{REGISTRY}/commits",
                "POST /graphql repository.ref",
                "POST /graphql createCommitOnBranch",
            ],
        )

    def test_the_method_is_told_by_the_id_of_the_app(self) -> None:
        for via, config, method in (
            (APP_ID, CONFIG, "web"),
            (9999, CONFIG, "comment"),
            (None, CONFIG, "comment"),
            (None, config_with(app_id=None), "comment"),
            (APP_ID, config_with(app_id=None), "comment"),
        ):
            with self.subTest(via=via, app=config["app_id"]):
                self.setUp()
                self.fake.add_comment(1, via=via)
                self.sign(config=config)
                self.assertEqual(
                    list(self.fake.files.values()), [dump(self.expected(method=method))]
                )

    def test_white_space_and_unicode_form_do_not_change_a_sentence(self) -> None:
        for body in (
            f"  {SENTENCE.replace(' ', chr(10) + ' ')}\n",
            unicodedata.normalize("NFD", SENTENCE),
        ):
            with self.subTest(body):
                self.setUp()
                self.fake.add_comment(1, body, via=None)
                self.sign()
                record = json.loads(self.fake.files[individual(ALICE)])
                self.assertEqual(record["evidence"]["comment_body_sha256"], cla.sha256(body))

    def test_any_other_text_is_no_acceptance(self) -> None:
        for body in (
            "",
            f"{SENTENCE} Thanks!",
            SENTENCE.lower(),
            SENTENCE.replace("version 1", "version 2"),
            SENTENCE.replace(DIGEST[:12], DIGEST[:11] + "1"),
            SENTENCE.replace("a", "\u0430", 1),
            SENTENCE.replace(" ", "\u200b", 1),
            # Characters that are only compatible with the sentence's own.
            SENTENCE.replace("I", "\uff29", 1),
            SENTENCE.replace("I", "\u2160", 1),
            SENTENCE.replace("st", "\ufb06", 1),
            SENTENCE.replace("s", "\u017f", 1),
            SENTENCE.replace("256", "\u2461\u2464\u2465", 1),
            SENTENCE.replace(DIGEST[:12], DIGEST[:12].translate(FULL_WIDTH)),
            SENTENCE_V2,
        ):
            with self.subTest(body):
                self.setUp()
                self.assertNotEqual(body, SENTENCE)
                self.fake.add_comment(1, body)
                with self.refused(
                    "the comment is not the acceptance sentence of an accepted version"
                ):
                    self.sign()
                self.assertEqual(self.fake.writes, [])

    def test_the_refusals_each_by_its_reason(self) -> None:
        edited = "the comment was edited"
        elsewhere = "the comment is not on that pull request"
        account = "the author is not a personal account"
        for name, reason, where, change in (
            ("edited", edited, "node", {"lastEditedAt": "2026-12-01T10:30:00Z"}),
            ("edited by somebody", edited, "node", {"editor": {"login": "mallory"}}),
            ("no pull request", elsewhere, "node", {"pullRequest": None}),
            ("another number", elsewhere, "node", {"pullRequest": pull(8, REPO)}),
            ("another repository", elsewhere, "node", {"pullRequest": pull(7, "a/b")}),
            ("no author", account, "node", {"author": None}),
            ("an app's author", account, "node", {"author": author(None, kind="Bot")}),
            ("the id 0", account, "node", {"author": author(0)}),
            ("a negative id", account, "node", {"author": author(-1)}),
            ("true for an id", account, "node", {"author": author(True)}),
            ("an id as text", account, "node", {"author": author("5")}),
            ("no login", account, "node", {"author": author(ALICE, None)}),
            ("a login of no kind", account, "node", {"author": author(ALICE, 5)}),
            ("a login GitHub cannot have", account, "node", {"author": author(ALICE, "a--b")}),
            ("a login and a line end", account, "node", {"author": author(ALICE, "alice\n")}),
            ("an app's login", account, "node", {"author": author(ALICE, "x[bot]")}),
            ("an app", account, "rest", {"user": {"id": ALICE, "type": "Bot"}}),
            ("an organization", account, "rest", {"user": {"type": "Organization"}}),
            ("a user of no type", account, "rest", {"user": {}}),
            ("no user", account, "rest", {"user": None}),
        ):
            with self.subTest(name):
                self.setUp()
                self.fake.add_comment(1)[where].update(change)
                with self.refused(reason):
                    self.sign()
                self.assertEqual(self.fake.writes, [])

    def test_a_comment_github_does_not_have(self) -> None:
        self.fake.add_comment(1)
        self.fake.next("POST /graphql node", ok({"data": {"node": None}}))
        with self.refused("comment not found"):
            self.sign()
        with self.fails(f"GET /repos/{REPO}/issues/comments/2 answered 404"):
            self.sign(2)
        self.fake.comments[1]["rest"]["node_id"] = None
        with self.fails("GraphQL answered 200: ['NOT_A_VALUE']"):
            self.sign()
        self.assertEqual(self.fake.writes, [])

    def test_an_answer_with_no_usable_body_or_time_is_a_failure(self) -> None:
        for change in (
            {"body": None},
            {"body": 5},
            {"createdAt": None},
            {"createdAt": "2026-12-01"},
            {"createdAt": "2026-12-01T10:22:31.5Z"},
        ):
            with self.subTest(change):
                self.setUp()
                self.fake.add_comment(1)["node"].update(change)
                with self.fails("GitHub's answer has no usable body or createdAt"):
                    self.sign()
                self.assertEqual(self.fake.writes, [])

    def test_a_repository_that_is_not_served_is_refused_first(self) -> None:
        self.fake.add_comment(1)
        ctx = context(self.fake)
        with self.refused("kleidos-dev/boards is not a served repository"):
            cla.record_sign(ctx, "kleidos-dev/boards", 7, 1)
        self.fake.repos[REPO] = {"private": True}
        with self.refused(f"{REPO} is not public"):
            self.sign()
        self.assertEqual((self.fake.writes, self.fake.calls), ([], [f"GET /repos/{REPO}"]))

    def test_an_account_already_recorded_is_not_recorded_again(self) -> None:
        self.fake.add_comment(1)
        self.fake.sign(ALICE)
        stamper = FakeStamper()
        self.assertEqual(self.sign(stamper=stamper), "already recorded")
        self.assertEqual((self.fake.writes, stamper.asked), ([], []))
        # A later version counts for an earlier one's sentence.
        self.fake.sign(ALICE, CONFIG_V2, version=2, method="comment")
        self.assertEqual(self.sign(config=CONFIG_V2), "already recorded")
        self.assertEqual(self.fake.writes, [])

    def test_a_newer_version_replaces_the_record_and_its_token(self) -> None:
        self.fake.sign(ALICE)
        self.fake.files[individual(ALICE, "tsr")] = b"old"
        self.fake.add_comment(1, SENTENCE_V2, via=None)
        content = dump(
            self.expected(
                version=2,
                set_sha256=DIGEST_V2,
                method="comment",
                evidence={
                    **self.expected()["evidence"],
                    "comment_body_sha256": cla.sha256(SENTENCE_V2),
                },
            )
        )
        self.assertEqual(
            self.sign(config=CONFIG_V2), f"recorded in {self.fake.head} (no time-stamp token yet)"
        )
        self.assertEqual(
            self.fake.writes,
            [
                Write(
                    "sign: alice (123456) accepts version 2",
                    {individual(ALICE): content},
                    [individual(ALICE, "tsr")],
                )
            ],
        )
        # It replaces a record, so there was no removal to look for.
        self.assertNotIn(f"GET /repos/{REGISTRY}/commits", self.fake.calls)

    def test_a_record_that_no_longer_counts_is_replaced(self) -> None:
        for spoiled in ({"set_sha256": "0" * 64}, {"version": 9}):
            with self.subTest(spoiled):
                self.setUp()
                self.fake.add_comment(1)
                self.fake.files[individual(ALICE)] = dump({**comment_record(ALICE), **spoiled})
                self.sign()
                self.assertEqual(self.fake.files[individual(ALICE)], dump(self.expected()))

    def test_a_record_with_nothing_in_it_is_replaced_and_its_token_goes(self) -> None:
        self.fake.add_comment(1)
        self.fake.files = {individual(ALICE): b"{}", individual(ALICE, "tsr"): b"old"}
        self.sign()
        self.assertEqual(self.fake.files, {individual(ALICE): dump(self.expected())})

    def test_a_record_nobody_can_read_is_a_failure(self) -> None:
        for content in (b"", b"[]", b"{", b"\xff"):
            with self.subTest(content):
                self.setUp()
                self.fake.add_comment(1)
                self.fake.files[individual(ALICE)] = content
                with self.fails(f"the record of account {ALICE} is not a JSON object"):
                    self.sign()
                self.assertEqual(self.fake.writes, [])

    def test_a_sign_in_sentence_posted_through_the_app_is_refused(self) -> None:
        # The sign page never posts it, so somebody acted in the signer's name. Typed, it counts.
        self.fake.add_comment(1, SENTENCE_V2)
        with self.refused("version 2 is not posted through the app, it is signed by signing in"):
            self.sign(config=CONFIG_V2)
        self.assertEqual(self.fake.writes, [])
        self.fake.add_comment(2, SENTENCE_V2, via=None)
        self.sign(2, config=CONFIG_V2)
        record = json.loads(self.fake.files[individual(ALICE)])
        self.assertEqual((record["version"], record["method"]), (2, "comment"))


def pull(number: int, repo: str) -> dict[str, Any]:
    return {"number": number, "repository": {"nameWithOwner": repo}}


def author(gid: Any, login: Any = "alice", kind: str = "User") -> dict[str, Any]:
    return {"__typename": kind, "login": login, "databaseId": gid}


class Written(RegisterTest):
    """A signature's files: the record, and the token over its bytes when there is one."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.record = comment_record(ALICE)
        self.content = dump(self.record)

    def write(self, stamper: cla.Stamper | None, replacing: bool) -> str:
        ctx = context(self.fake, stamper=stamper)
        return cla.write_signature(ctx, ALICE, self.record, replacing, "sign: x")

    def test_without_an_authority_or_its_answer_the_record_goes_alone(self) -> None:
        for stamper in (None, FakeStamper(up=False)):
            self.setUp()
            self.assertEqual(
                self.write(stamper, False),
                f"recorded in {self.fake.head} (no time-stamp token yet)",
            )
            self.assertEqual(
                self.fake.writes, [Write("sign: x", {individual(ALICE): self.content}, [])]
            )

    def test_a_replaced_records_token_goes_with_it_when_no_new_one_came(self) -> None:
        token = [individual(ALICE, "tsr")]
        for before, deleted in ((b"old", token), (b"", token), (None, [])):
            self.setUp()
            if before is not None:
                self.fake.files[individual(ALICE, "tsr")] = before
            self.write(FakeStamper(up=False), True)
            self.assertEqual(
                self.fake.writes, [Write("sign: x", {individual(ALICE): self.content}, deleted)]
            )

    def test_a_replaced_records_token_is_replaced_by_the_new_one(self) -> None:
        self.fake.files[individual(ALICE, "tsr")] = b"old"
        self.write(FakeStamper(), True)
        self.assertEqual(
            self.fake.writes,
            [
                Write(
                    "sign: x",
                    {
                        individual(ALICE): self.content,
                        individual(ALICE, "tsr"): token_for(self.content),
                    },
                    [],
                )
            ],
        )
        self.assertEqual([c for c in self.fake.calls if individual(ALICE, "tsr") in c], [])

    def test_a_first_record_looks_for_no_old_token(self) -> None:
        self.write(None, False)
        self.assertEqual(
            self.fake.calls, ["POST /graphql repository.ref", "POST /graphql createCommitOnBranch"]
        )

    def test_an_old_token_that_cannot_be_read_stops_the_write(self) -> None:
        self.fake.next(f"GET /repos/{REGISTRY}/contents/", BAD_GATEWAY)
        with self.fails(f"reading {individual(ALICE, 'tsr')} answered 502"):
            self.write(None, True)
        self.assertEqual(self.fake.writes, [])


class Signin(RegisterTest):
    """A signature by signing in: GitHub vouches for the token, and the grant is deleted."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = ready()

    def expected(self, **over: Any) -> dict[str, Any]:
        return {
            "schema": 2,
            "kind": "individual",
            "github_id": ALICE,
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
                "lang": "en",
            },
            "recorded_at": "2026-12-01T10:23:02Z",
            "recorder_run_id": RUN_ID,
            "recorder_commit": RECORDER_COMMIT,
            **over,
        }

    def test_the_whole_record_and_its_token_in_one_commit(self) -> None:
        self.assertEqual(signin(self.fake, stamper=FakeStamper()), f"recorded in {'a' * 39}b")
        content = dump(self.expected())
        self.assertEqual(
            self.fake.writes,
            [
                Write(
                    "sign: alice (123456) accepts version 2",
                    {individual(ALICE): content, individual(ALICE, "tsr"): token_for(content)},
                    [],
                )
            ],
        )
        self.assertIsNone(cla.check_record(CONFIG_V2, individual(ALICE), content))
        self.assertNotIn(TOKEN.encode(), content)

    def test_the_sentence_is_hashed_as_it_was_published(self) -> None:
        config = config_with(CONFIG_V2)
        config["versions"]["2"]["sentence"] = sentence = f" {SENTENCE_V2.replace(' ', '  ', 1)}"
        signin(self.fake, config=config)
        content = self.fake.files[individual(ALICE)]
        self.assertEqual(json.loads(content)["sentence_sha256"], cla.sha256(sentence))
        self.assertIsNone(cla.check_record(config, individual(ALICE), content))
        self.assertEqual(
            cla.check_record(CONFIG_V2, individual(ALICE), content), "malformed record"
        )

    def test_the_order_verify_commit_revoke(self) -> None:
        signin(self.fake)
        self.assertEqual(
            self.fake.calls,
            [
                f"GET /repos/{REPO}",
                f"GET /repos/{REPO}/pulls/7",
                f"GET /repos/{REGISTRY}/contents/{individual(ALICE)}?ref=signatures",
                f"POST /applications/{SIGNIN_CLIENT_ID}/token",
                "POST /graphql repository.ref",
                "POST /graphql createCommitOnBranch",
                DELETE,
            ],
        )
        self.assertEqual(self.fake.revoked, [TOKEN])
        self.assertEqual(self.err.getvalue(), "sign-in grant deleted (204)\n")

    def test_both_languages_of_the_page(self) -> None:
        signin(self.fake, lang="es")
        self.assertEqual(json.loads(self.fake.files[individual(ALICE)])["evidence"]["lang"], "es")

    def test_a_run_whose_clock_is_behind_githubs_records_githubs_time(self) -> None:
        self.fake.date = "Tue, 01 Dec 2026 10:23:30 GMT"
        signin(self.fake)
        record = json.loads(self.fake.files[individual(ALICE)])
        self.assertEqual(
            (record["accepted_at"], record["recorded_at"]), ("2026-12-01T10:23:30Z",) * 2
        )

    def test_the_refusals_before_the_token_is_checked(self) -> None:
        v1 = config_with(CONFIG_V2, current_version=1)
        unaccepted = config_with(CONFIG_V2, accepted_versions=[1])
        unknown = config_with(CONFIG_V2, current_version=3, accepted_versions=[3])
        app = "the sign-in app is not the one registry/config.json names"
        cases: tuple[tuple[str, dict[str, Any]], ...] = (
            ("no account id", {"gid": 0}),
            ("no account id", {"gid": -1}),
            ("no account id", {"gid": None}),
            ("no account id", {"gid": True}),
            ("the site commit is not a commit id", {"site_commit": None}),
            ("unknown interface language", {"lang": None}),
            ("version None is not the current version", {"version": None}),
            ("a/b is not a served repository", {"repo": "a/b"}),
            ("the site commit is not a commit id", {"site_commit": ""}),
            ("the site commit is not a commit id", {"site_commit": SITE_COMMIT[1:]}),
            ("the site commit is not a commit id", {"site_commit": f"{SITE_COMMIT}\n"}),
            ("the site commit is not a commit id", {"site_commit": SITE_COMMIT.upper()}),
            ("unknown interface language", {"lang": "fr"}),
            ("unknown interface language", {"lang": ""}),
            ("version 1 is not the current version", {"version": 1}),
            ("version 3 is not the current version", {"version": 3}),
            ("version 2 is not the current version", {"config": unaccepted}),
            ("version 1 is not accepted by signing in", {"version": 1, "config": v1}),
            ("version 3 is not accepted by signing in", {"version": 3, "config": unknown}),
            (app, {"config": config_with(CONFIG_V2, signin_client_id=None)}),
            (app, {"config": config_with(CONFIG_V2, signin_client_id=OTHER_CLIENT_ID)}),
        )
        for reason, over in cases:
            with self.subTest(reason, over=over):
                self.setUp()
                with self.refused(reason):
                    signin(self.fake, **over)
                self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))
                self.assertNotIn(f"POST /applications/{SIGNIN_CLIENT_ID}/token", self.fake.calls)

    def test_a_client_id_of_another_form_is_refused_though_configured(self) -> None:
        for bad in ("a" * 15, "a" * 41, "a-" * 10, f"{SIGNIN_CLIENT_ID}/x", ""):
            with self.subTest(bad):
                self.setUp()
                fake = mock.Mock(wraps=self.fake)
                with (
                    mock.patch.object(cla, "revoke_signin") as revoke,
                    self.refused("the sign-in app is not the one registry/config.json names"),
                ):
                    signin(
                        fake,
                        config=config_with(CONFIG_V2, signin_client_id=bad),
                        app=cla.SigninApp(bad, SIGNIN_SECRET),
                    )
                revoke.assert_called_once()

    def test_a_private_repository_or_no_pull_request(self) -> None:
        self.fake.repos[REPO] = {"private": True}
        with self.refused(f"{REPO} is not public"):
            signin(self.fake)
        self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))
        for answer in ({"number": 8}, {}, {"number": None}):
            self.setUp()
            self.fake.pulls[7] = answer
            with self.refused("no such pull request"):
                signin(self.fake)
            self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))
        self.setUp()
        with self.fails(f"GET /repos/{REPO}/pulls/8 answered 404"):
            signin(self.fake, pr=8)
        self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))

    def test_a_token_github_does_not_vouch_for(self) -> None:
        check = f"POST /applications/{SIGNIN_CLIENT_ID}/token"
        unknown = "GitHub does not know this sign-in token (expired, revoked or not ours)"
        for status in (404, 422):
            self.setUp()
            self.fake.next(check, ok({}, status))
            with self.refused(unknown):
                signin(self.fake)
            self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))
        with self.refused(unknown):
            signin(FakeGitHub(pulls={7: {"number": 7}}))
        for status in (201, 401, 500):
            self.setUp()
            self.fake.next(check, ok({}, status))
            with self.fails(f"checking the sign-in token answered {status}"):
                signin(self.fake)
            self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))

    def test_an_answer_with_no_usable_date_or_creation_is_a_failure(self) -> None:
        reason = "GitHub's answer has no usable Date or created_at"
        for body, headers in (
            (b"", {"date": self.fake.date}),
            (b"null", {"date": self.fake.date}),
            (b"[]", {"date": self.fake.date}),
            (b"<html>", {"date": self.fake.date}),
            (b"{}", {"date": self.fake.date}),
            (b'{"created_at": "soon"}', {"date": self.fake.date}),
            (b'{"created_at": "2026-12-01T10:22:31Z"}', {}),
            (b'{"created_at": "2026-12-01T10:22:31Z"}', {"date": "now"}),
        ):
            with self.subTest(body=body, headers=headers):
                self.setUp()
                answer: Answer = (200, body, headers)
                self.fake.next(f"POST /applications/{SIGNIN_CLIENT_ID}/token", answer)
                with self.fails(reason):
                    signin(self.fake)
                self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))

    def test_the_refusals_of_what_the_token_is(self) -> None:
        account = "the token is not a personal account's"
        other = "the token belongs to another account than the one reported"
        cases: tuple[tuple[str, dict[str, Any]], ...] = (
            ("the token belongs to another app", {"client_id": OTHER_CLIENT_ID}),
            (account, {"kind": "Bot"}),
            (account, {"kind": "Organization"}),
            (account, {"kind": ""}),
            (account, {"login": None}),
            (account, {"login": 5}),
            (account, {"login": ""}),
            (account, {"login": "x[bot]"}),
            (account, {"login": "alice\n"}),
            (account, {"login": "a" * 40}),
            (other, {"gid": BOB}),
            (other, {"gid": None}),
            (other, {"gid": str(ALICE)}),
            (other, {"gid": float(ALICE)}),
        )
        for reason, over in cases:
            with self.subTest(reason, over=over):
                self.fake = ready()
                self.fake.add_signin(**over)
                with self.refused(reason):
                    signin(self.fake)
                self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))

    def test_true_is_not_account_1(self) -> None:
        self.fake.add_signin(gid=True)
        with self.refused("the token belongs to another account than the one reported"):
            signin(self.fake, gid=1)

    def test_parts_missing_from_the_answer_are_not_trusted(self) -> None:
        for key, reason in (
            ("app", "the token belongs to another app"),
            ("user", "the token is not a personal account's"),
        ):
            for value in cast("tuple[Any, ...]", (None, [], "x")):
                self.fake = ready()
                self.fake.known_tokens[TOKEN][key] = value
                with self.subTest(key, value=value), self.refused(reason):
                    signin(self.fake)
                self.assertEqual(self.fake.writes, [])

    def test_a_sign_in_is_recent_to_the_second(self) -> None:
        # Checked by GitHub at 10:22:58.
        for created, good in (
            ("2026-12-01T08:22:58Z", True),
            ("2026-12-01T08:22:57Z", False),
            ("2026-12-01T10:23:58Z", True),
            ("2026-12-01T10:23:59Z", False),
            ("2026-12-01T12:22:31+02:00", True),
        ):
            with self.subTest(created):
                self.fake = ready()
                self.fake.add_signin(created_at=created)
                if good:
                    signin(self.fake)
                    self.assertEqual(len(self.fake.writes), 1)
                    continue
                with self.refused("the sign-in is not recent"):
                    signin(self.fake)
                self.assertEqual(self.fake.writes, [])
            self.assertEqual(self.fake.revoked, [TOKEN])

    def test_a_run_that_does_not_know_its_own_commit_records_nothing(self) -> None:
        for own in ("", "f" * 39, "F" * 40, "f" * 40 + "\n"):
            with self.subTest(own):
                self.setUp()
                with self.fails("the recorder's own commit (GITHUB_SHA) is unknown"):
                    signin(self.fake, commit=own)
                self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))

    def test_an_account_already_recorded_is_answered_before_its_token_is_checked(self) -> None:
        # A re-run of the run that recorded it carries the same token, revoked by then.
        self.assertTrue(signin(self.fake).startswith("recorded in "))
        self.fake.calls.clear()
        self.assertEqual(signin(self.fake), "already recorded")
        self.assertEqual(len(self.fake.writes), 1)
        self.assertEqual(
            self.fake.calls,
            [
                f"GET /repos/{REPO}",
                f"GET /repos/{REPO}/pulls/7",
                f"GET /repos/{REGISTRY}/contents/{individual(ALICE)}?ref=signatures",
                DELETE,
            ],
        )
        self.assertEqual(
            self.err.getvalue().splitlines(),
            ["sign-in grant deleted (204)", "sign-in grant not deleted: GitHub answered 404"],
        )

    def test_an_older_version_or_a_record_that_no_longer_counts_is_replaced(self) -> None:
        for before in (comment_record(ALICE), {**signin_record(ALICE), "set_sha256": "0" * 64}):
            with self.subTest(before["version"]):
                self.setUp()
                self.fake.files[individual(ALICE)] = dump(before)
                self.fake.files[individual(ALICE, "tsr")] = b"old"
                signin(self.fake)
                self.assertEqual(
                    self.fake.writes,
                    [
                        Write(
                            "sign: alice (123456) accepts version 2",
                            {individual(ALICE): dump(self.expected())},
                            [individual(ALICE, "tsr")],
                        )
                    ],
                )


class Grant(RegisterTest):
    """The grant that cannot be deleted changes nothing of what was recorded or refused."""

    def test_the_run_of_a_written_record_does_not_fail(self) -> None:
        for error in UNREACHABLE:
            with self.subTest(type(error).__name__):
                self.err.truncate(self.err.seek(0))
                fake = ready()
                fake.next(DELETE, error)
                self.assertEqual(signin(fake), f"recorded in {fake.head} (no time-stamp token yet)")
                self.assertEqual(list(fake.files), [individual(ALICE)])
                self.assertEqual(
                    self.err.getvalue(),
                    "sign-in grant not deleted: GitHub cannot be reached "
                    f"({type(error).__name__})\n",
                )

    def test_a_refusal_stays_a_refusal(self) -> None:
        fake = ready()
        fake.next(DELETE, UNREACHABLE[0])
        with self.refused("unknown interface language"):
            signin(fake, lang="fr")
        self.assertEqual(fake.writes, [])


class Removal(RegisterTest):
    """An entry removed at its holder's request comes back only with a newer acceptance."""

    REASON = "this account's entry was removed at its request after that comment"
    #: When the comment of these tests was written.
    WRITTEN = "2026-12-01T10:22:31Z"

    def record(self, *commits: dict[str, Any]) -> FakeGitHub:
        fake = FakeGitHub()
        fake.add_comment(1)
        fake.histories[individual(ALICE)] = list(commits)
        try:
            cla.record_sign(context(fake), REPO, 7, 1)
        finally:
            self.written = len(fake.writes)
        return fake

    def test_a_comment_of_before_the_removal_is_refused(self) -> None:
        for date in (self.WRITTEN, "2026-12-01T10:22:32Z", "2026-12-01T11:22:31+01:00"):
            with self.subTest(date), self.refused(self.REASON):
                self.record(redact_commit(date))
            self.assertEqual(self.written, 0)

    def test_a_comment_of_after_the_removal_is_a_new_acceptance(self) -> None:
        self.record(redact_commit("2026-12-01T10:22:30Z"))
        self.assertEqual(self.written, 1)

    def test_a_removal_with_no_time_is_later_than_any_comment(self) -> None:
        for date in (None, "", 5, "soon", "2026-12-01T10:00:00"):
            with self.subTest(date), self.refused(self.REASON):
                self.record(redact_commit(date))
            self.assertEqual(self.written, 0)
        with self.refused(self.REASON):
            self.record(redact_commit() | {"commit": {"message": "redact: x"}})

    def test_only_the_owners_own_removal_counts(self) -> None:
        self.record(
            redact_commit() | {"author": {"id": 666}},
            redact_commit() | {"author": None},
            redact_commit(message="tidy up, redact: x"),
            redact_commit(message="redact x"),
            redact_commit(message="redaction: x"),
            redact_commit(message="Redact: x"),
            redact_commit() | {"commit": None},
            recorder_commit(),
            {},
        )
        self.assertEqual(self.written, 1)

    def test_a_removal_on_another_page_of_the_history_counts(self) -> None:
        with self.refused(self.REASON):
            self.record(*[recorder_commit()] * 250, redact_commit())

    def test_the_history_asked_for_is_that_accounts_on_the_branch(self) -> None:
        fake = self.record(redact_commit("2026-11-01T00:00:00Z"))
        self.assertIn(f"GET /repos/{REGISTRY}/commits", fake.calls)

    def test_a_history_that_cannot_be_read_records_nothing(self) -> None:
        for answer in (BAD_GATEWAY, ok({}), ok([1]), (200, b"", {})):
            fake = FakeGitHub()
            fake.add_comment(1)
            fake.next(f"GET /repos/{REGISTRY}/commits", answer)
            with self.assertRaises(RuntimeError):
                cla.record_sign(context(fake), REPO, 7, 1)
            self.assertEqual(fake.writes, [])


class StampList(RegisterTest):
    def test_a_list_github_may_have_cut_is_refused(self) -> None:
        entries = [{"name": f"{n}.json", "type": "file"} for n in range(1, 1001)]
        listing = f"GET /repos/{REGISTRY}/contents/signatures/individual"
        fake = FakeGitHub()
        fake.next(listing, ok(entries))
        with self.refused("GitHub lists 1000 files at most, so some may be missing"):
            cla.record_stamps(context(fake, stamper=FakeStamper()))
        self.assertEqual(fake.writes, [])
        fake = FakeGitHub()
        fake.next(listing, ok([{"name": "README.md", "type": "file"}] * 999))
        self.assertEqual(cla.record_stamps(context(fake, stamper=FakeStamper())), "stamped 0 of 0")


class SelfCheck(RegisterTest):
    """Nothing the verifier would refuse reaches the register, whatever GitHub answered."""

    def test_a_signature_the_verifier_would_refuse_is_not_written(self) -> None:
        fake = FakeGitHub()
        fake.add_comment(1)
        stamper = FakeStamper()
        ctx = context(fake, config_with(agreement="another"), stamper=stamper)
        ctx.config["versions"]["1"]["flow"] = "signin"
        record = comment_record(ALICE)
        with self.fails("not written, the verifier would refuse it: malformed record"):
            cla.write_signature(ctx, ALICE, record, False, "sign")
        self.assertEqual((fake.calls, stamper.asked), ([], []))

    def test_a_coverage_record_the_verifier_would_refuse_is_not_written(self) -> None:
        for key, value in (("merge_commit_sha", None), ("merged_at", "yesterday")):
            with self.subTest(key):
                fake = FakeGitHub()
                fake.sign(ALICE)
                fake.merge([commit()])[key] = value
                with self.fails("not written, the verifier would refuse it: malformed record"):
                    cla.record_coverage(context(fake), REPO, 7)
                self.assertEqual(fake.writes, [])


class Stamps(RegisterTest):
    """The daily run: a token for each signature the recorder wrote without one."""

    LISTING = f"GET /repos/{REGISTRY}/contents/signatures/individual"

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.stamper = FakeStamper()

    def run_stamps(self, **kw: Any) -> str:
        return cla.record_stamps(context(self.fake, stamper=self.stamper), **kw)

    def stamped(self) -> list[int]:
        return [int(w.headline.removeprefix("stamp: ")) for w in self.fake.writes]

    def test_each_missing_token_is_a_commit_of_its_own_in_the_order_of_the_accounts(self) -> None:
        for gid in (30, 4, 100, 5):
            self.fake.sign(gid)
        self.fake.files[individual(5, "tsr")] = b"there already"
        self.assertEqual(self.run_stamps(), "stamped 3 of 3")
        self.assertEqual(
            self.fake.writes,
            [
                Write(
                    f"stamp: {gid}",
                    {individual(gid, "tsr"): token_for(self.fake.files[individual(gid)])},
                    [],
                )
                for gid in (4, 30, 100)
            ],
        )

    def test_the_longest_account_number(self) -> None:
        self.fake.sign(cla.MAX_INT, recorder_run_id=5)
        self.assertEqual(self.run_stamps(), "stamped 1 of 1")

    def test_no_authority_or_no_signature_is_nothing_to_do(self) -> None:
        self.assertEqual(
            cla.record_stamps(context(self.fake)), "no time-stamping authority configured"
        )
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.run_stamps(), "no signature yet")

    def test_a_run_stops_after_as_many_as_it_may(self) -> None:
        for gid in range(1, 13):
            self.fake.sign(gid)
        self.assertEqual(self.run_stamps(limit=2), "stamped 2 of 12")
        self.assertEqual(self.stamped(), [1, 2])
        self.assertEqual(self.run_stamps(), "stamped 10 of 10")

    def test_at_most_ten_a_run(self) -> None:
        for gid in range(1, 13):
            self.fake.sign(gid)
        self.assertEqual(self.run_stamps(), "stamped 10 of 12")

    def test_an_authority_that_gives_nothing_ends_the_run(self) -> None:
        for gid in (1, 2):
            self.fake.sign(gid)
        self.stamper.up = False
        self.assertEqual(self.run_stamps(), "stamped 0 of 2")
        self.assertEqual((self.fake.writes, len(self.stamper.asked)), ([], 1))

    def test_only_a_valid_record_is_vouched_for(self) -> None:
        self.fake.sign(1, login_at_signing="-")
        self.fake.files[individual(2)] = b"\xff"
        self.fake.sign(3)
        self.fake.sign(4)
        self.fake.next(f"{self.LISTING}/3.json", NOT_FOUND)
        self.assertEqual(self.run_stamps(), "stamped 1 of 4")
        self.assertEqual(self.stamped(), [4])

    def test_only_the_recorders_own_record_is_vouched_for(self) -> None:
        unsigned = {"verification": {"verified": False}}
        for name, commits in (
            ("another author", [recorder_commit(author={"id": 666})]),
            ("no author", [recorder_commit(author=None)]),
            ("another committer", [recorder_commit(committer={"login": "mallory"})]),
            ("no committer", [recorder_commit(committer=None)]),
            ("no valid signature", [recorder_commit(commit=unsigned)]),
            ("no signature", [recorder_commit(commit={"verification": None})]),
            ("a signature that is nearly true", [recorder_commit(commit=nearly())]),
            ("no commit", []),
            ("an older commit only", [recorder_commit(author=None), recorder_commit()]),
        ):
            with self.subTest(name):
                self.setUp()
                self.fake.sign(1)
                self.fake.sign(2)
                self.fake.histories[individual(1)] = commits
                self.assertEqual(self.run_stamps(), "stamped 1 of 2")
                self.assertEqual(self.stamped(), [2])

    def test_only_the_files_of_records_count(self) -> None:
        self.fake.sign(1)
        self.fake.next(
            self.LISTING,
            ok(
                [
                    {"name": "1.json", "type": "file"},
                    *({"name": n, "type": "file"} for n in OTHER_NAMES),
                    {"name": "2.json", "type": "dir"},
                    {"name": "3.json", "type": "symlink"},
                    {"name": "4.json"},
                    {"type": "file"},
                    {"name": 5, "type": "file"},
                    "6.json",
                    None,
                ]
            ),
        )
        self.assertEqual(self.run_stamps(), "stamped 1 of 1")

    def test_a_listing_that_cannot_be_read_is_a_failure(self) -> None:
        for answer, status in (
            (BAD_GATEWAY, 502),
            (ok([], 201), 201),
            (ok({"message": "Forbidden"}, 403), 403),
            (ok({"message": "x"}), 200),
            (ok(None), 200),
        ):
            self.fake.next(self.LISTING, answer)
            with self.fails(f"listing the signatures answered {status}"):
                self.run_stamps()


#: Files that are no record of an account, whatever else they are.
OTHER_NAMES = (
    "README.md",
    "0.json",
    "01.json",
    "x1.json",
    "1.json.bak",
    "1.jsonx",
    "1xjson",
    "1.json\n",
    "\u0661.json",
    ".json",
    "1" * 17 + ".json",
    "7.tsr",
)


def nearly() -> dict[str, Any]:
    return {"verification": {"verified": "true"}}


if __name__ == "__main__":
    unittest.main()
