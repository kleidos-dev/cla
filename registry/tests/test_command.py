# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The command line: what record.yml and verify.yml run, from the arguments to the exit code."""

from __future__ import annotations

import contextlib
import email.message
import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import (
    ALICE,
    API,
    BEARER,
    CAROL,
    CONFIG,
    CONFIG_V2,
    DIGEST,
    OWNER,
    RECORDER_COMMIT,
    REGISTRY,
    REPO,
    SIGNIN_SECRET,
    SITE_COMMIT,
    TOKEN,
    FakeGitHub,
    FakeStamper,
    RegisterTest,
    comment_record,
    commit,
    config_with,
    individual,
)

ENVIRONMENT = {
    "GITHUB_TOKEN": BEARER,
    "GITHUB_REPOSITORY": REGISTRY,
    "GITHUB_RUN_ID": "4711",
    "GITHUB_SHA": RECORDER_COMMIT,
}


def network(fake: FakeGitHub) -> Any:
    """urlopen, answered by the fake GitHub: nothing leaves the process."""

    def urlopen(request: urllib.request.Request, timeout: float) -> Any:
        headers = {k.lower(): v for k, v in request.header_items()}
        data = request.data
        assert data is None or isinstance(data, bytes)
        status, body, given = fake(request.get_method(), request.full_url, headers, data)
        message = email.message.Message()
        for k, v in given.items():
            message[k] = v
        if status >= 300:
            raise urllib.error.HTTPError(request.full_url, status, "", message, io.BytesIO(body))
        response = mock.MagicMock(status=status, headers=message)
        response.read.return_value = body
        response.__enter__.return_value = response
        return response

    return urlopen


class Record(RegisterTest):
    """``record``, through the real transport, against the fake GitHub."""

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeGitHub()
        self.config = CONFIG_V2
        self.entities: list[dict[str, Any]] = []
        self.stamper: cla.Stamper | None = None
        self.env = dict(ENVIRONMENT)

    def run_main(self, *args: str) -> int:
        asked = mock.Mock(return_value=self.stamper)
        with (
            mock.patch.dict(os.environ, self.env, clear=True),
            mock.patch("urllib.request.urlopen", network(self.fake)),
            mock.patch.object(cla, "load_config", lambda: self.config),
            mock.patch.object(cla, "load_entities", lambda: self.entities),
            mock.patch.object(cla.TSAStamper, "from_config", asked),
        ):
            code = cla.main(["record", *args])
        asked.assert_called_once_with(self.config)
        return code

    def exits(self, code: int, *args: str) -> None:
        with self.assertRaises(SystemExit) as caught:
            self.run_main(*args)
        self.assertEqual(caught.exception.code, code)

    def record(self) -> dict[str, Any]:
        found: dict[str, Any] = json.loads(self.fake.files[individual(ALICE)])
        return found

    SIGN = ("--kind", "sign", "--repo", REPO, "--pr", "7")

    def test_a_signature(self) -> None:
        self.fake.add_comment(1)
        self.assertEqual(self.run_main(*self.SIGN, "--comment-id", "1"), 0)
        self.assertEqual(self.record()["recorder_run_id"], 4711)
        self.assertEqual(
            (self.out.getvalue(), self.err.getvalue()),
            (f"recorded in {self.fake.head} (no time-stamp token yet)\n", ""),
        )

    def test_a_signature_with_its_token(self) -> None:
        self.stamper = FakeStamper()
        self.fake.add_comment(1)
        self.assertEqual(self.run_main(*self.SIGN, "--comment-id", "1"), 0)
        self.assertEqual(self.out.getvalue(), f"recorded in {self.fake.head}\n")

    def test_a_refusal_is_exit_3_and_its_reason(self) -> None:
        self.fake.add_comment(1, "Hello")
        self.assertEqual(self.run_main(*self.SIGN, "--comment-id", "1"), 3)
        self.assertEqual(
            (self.out.getvalue(), self.err.getvalue(), self.fake.writes),
            (
                "",
                "refused: the comment is not the acceptance sentence of an accepted version\n",
                [],
            ),
        )

    def test_a_failure_is_no_refusal(self) -> None:
        with self.fails(f"GET /repos/{REPO}/issues/comments/1 answered 404"):
            self.run_main(*self.SIGN, "--comment-id", "1")

    def test_the_arguments_each_kind_needs(self) -> None:
        both = "refused: --repo and --pr are required\n"
        for args, said in (
            (("--kind", "sign", "--pr", "7", "--comment-id", "1"), both),
            (("--kind", "sign", "--repo", REPO, "--comment-id", "1"), both),
            (("--kind", "sign", "--repo", "", "--pr", "7"), both),
            (("--kind", "sign", "--repo", REPO, "--pr", "0"), both),
            (("--kind", "coverage", "--repo", REPO), both),
            (("--kind", "signin", "--pr", "7"), both),
            (self.SIGN, "refused: --comment-id is required\n"),
            ((*self.SIGN, "--comment-id", "0"), "refused: --comment-id is required\n"),
        ):
            with self.subTest(args):
                self.err.truncate(self.err.seek(0))
                self.assertEqual(self.run_main(*args), 3)
                self.assertEqual(self.err.getvalue(), said)
        self.assertEqual(self.fake.calls, [])

    def test_arguments_that_are_no_arguments(self) -> None:
        for args, said in (
            ((), "the following arguments are required: --kind"),
            (("--kind", "other"), "argument --kind: invalid choice: 'other'"),
            (("--kind", "sign", "--pr", "x"), "argument --pr: invalid int value: 'x'"),
            (("--kind", "sign", "--comment-id", "x"), "argument --comment-id: invalid int value"),
            (("--kind", "sign", "--github-id", "x"), "argument --github-id: invalid int value"),
            (("--kind", "sign", "--version", "x"), "argument --version: invalid int value"),
            (("--kind", "sign", "--token", "x"), "unrecognized arguments: --token x"),
        ):
            with self.subTest(args), self.assertRaises(SystemExit) as caught:
                self.err.truncate(self.err.seek(0))
                cla.main(["record", *args])
            self.assertEqual(caught.exception.code, 2)
            self.assertIn(said, self.err.getvalue())
        with self.assertRaises(SystemExit) as caught:
            cla.main([])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("the following arguments are required: cmd", self.err.getvalue())

    def test_the_help_says_what_the_tool_is(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            cla.main(["--help"])
        self.assertEqual(caught.exception.code, 0)
        said = self.out.getvalue()
        self.assertIn(
            "\nThe register's own writer and its verifier, standard library only.\n", said
        )
        self.assertNotIn("record.yml", said)
        self.out.truncate(self.out.seek(0))
        with self.assertRaises(SystemExit):
            cla.main(["verify", "--help"])
        said = " ".join(self.out.getvalue().split())
        self.assertTrue(
            said.endswith(
                "where to write the last commit whose records were cross-checked, for the next "
                "run's --since"
            ),
            said,
        )

    def test_a_coverage_record_by_the_entities_of_the_registry(self) -> None:
        covered = [{"github_id": CAROL, "from": "2026-11-01"}]
        self.entities = [{"version": 1, "set_sha256": DIGEST, "covered": covered}]
        self.fake.sign(ALICE)
        self.fake.merge([commit(CAROL, "carol")])
        self.assertEqual(self.run_main("--kind", "coverage", "--repo", REPO, "--pr", "7"), 0)
        self.assertEqual(self.out.getvalue(), f"recorded in {self.fake.head}\n")
        record = json.loads(self.fake.files[f"coverage/{REPO}/7.json"])
        self.assertEqual((record["github_ids"], record["recorder_run_id"]), ([ALICE], 4711))

    def test_the_missing_tokens(self) -> None:
        self.assertEqual(self.run_main("--kind", "stamp"), 0)
        self.assertEqual(self.out.getvalue(), "no time-stamping authority configured\n")
        self.fake.sign(ALICE)
        self.stamper = FakeStamper()
        self.assertEqual(self.run_main("--kind", "stamp"), 0)
        self.assertTrue(self.out.getvalue().endswith("\nstamped 1 of 1\n"))

    def signin(self, *args: str, event: Any = None) -> int:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "event.json"
            path.write_text(json.dumps(event or {"inputs": {"signin_token": TOKEN}}), "utf-8")
            self.env["GITHUB_EVENT_PATH"] = str(path)
            return self.run_main("--kind", "signin", "--repo", REPO, "--pr", "7", *args)

    ALL = (
        *("--github-id", str(ALICE), "--version", "2", "--lang", "es"),
        *("--site-commit", SITE_COMMIT),
    )

    def test_a_sign_in(self) -> None:
        self.fake.add_signin()
        self.fake.pulls[7] = {"number": 7}
        self.env |= {"SIGNIN_CLIENT_SECRET": SIGNIN_SECRET, "GITHUB_ACTIONS": "true"}
        self.assertEqual(self.signin(*self.ALL), 0)
        record = self.record()
        self.assertEqual(
            (record["recorder_run_id"], record["recorder_commit"], record["version"]),
            (4711, RECORDER_COMMIT, 2),
        )
        self.assertEqual(
            (record["evidence"]["lang"], record["evidence"]["site_commit"]), ("es", SITE_COMMIT)
        )
        self.assertEqual(
            self.out.getvalue(),
            f"::add-mask::{TOKEN}\nrecorded in {self.fake.head} (no time-stamp token yet)\n",
        )
        self.assertEqual(self.err.getvalue(), "sign-in grant deleted (204)\n")
        self.assertEqual(self.fake.revoked, [TOKEN])

    def test_a_sign_in_with_an_argument_missing_is_refused_and_its_grant_deleted(self) -> None:
        self.env["SIGNIN_CLIENT_SECRET"] = SIGNIN_SECRET
        for name, said in (
            ("--github-id", "no account id"),
            ("--version", "version None is not the current version"),
            ("--lang", "unknown interface language"),
            ("--site-commit", "the site commit is not a commit id"),
        ):
            with self.subTest(name):
                self.fake = FakeGitHub()
                self.fake.add_signin()
                self.err.truncate(self.err.seek(0))
                at = self.ALL.index(name)
                self.assertEqual(self.signin(*self.ALL[:at], *self.ALL[at + 2 :]), 3)
                self.assertIn(f"refused: {said}\n", self.err.getvalue())
                self.assertEqual((self.fake.writes, self.fake.revoked), ([], [TOKEN]))

    def test_a_sign_in_without_the_secret_asks_nothing(self) -> None:
        for secret in ({}, {"SIGNIN_CLIENT_SECRET": ""}):
            self.env |= secret
            with self.fails("SIGNIN_CLIENT_SECRET is not set"):
                self.signin(*self.ALL)
        self.assertEqual(self.fake.calls, [])

    def test_a_sign_in_without_a_token_asks_nothing(self) -> None:
        self.env["SIGNIN_CLIENT_SECRET"] = SIGNIN_SECRET
        self.assertEqual(self.signin(*self.ALL, event={"inputs": {}}), 3)
        del self.env["GITHUB_EVENT_PATH"]
        self.assertEqual(
            self.run_main("--kind", "signin", "--repo", REPO, "--pr", "7", *self.ALL), 3
        )
        self.assertEqual(
            self.err.getvalue(), "refused: no well-formed sign-in token in the event\n" * 2
        )
        self.assertEqual(self.fake.calls, [])

    def test_a_registry_with_no_sign_in_app(self) -> None:
        self.config = config_with(CONFIG_V2, signin_client_id=None)
        self.env["SIGNIN_CLIENT_SECRET"] = SIGNIN_SECRET
        with mock.patch.object(cla, "revoke_signin") as revoke:
            self.assertEqual(self.signin(*self.ALL), 3)
        self.assertEqual(
            self.err.getvalue(),
            "refused: the sign-in app is not the one registry/config.json names\n",
        )
        self.assertEqual(revoke.call_args.args[1], cla.SigninApp("", SIGNIN_SECRET))

    def test_the_environment_a_run_by_hand_has_not(self) -> None:
        self.env = {}
        made: list[cla.Context] = []

        def record_stamps(ctx: cla.Context) -> str:
            made.append(ctx)
            return "done"

        with mock.patch.object(cla, "record_stamps", record_stamps):
            self.assertEqual(self.run_main("--kind", "stamp"), 0)
            self.env = {
                **ENVIRONMENT,
                "GITHUB_API_URL": "https://ghe.invalid/api",
                "GITHUB_REPOSITORY": "another/cla",
            }
            self.assertEqual(self.run_main("--kind", "stamp"), 0)
        by_hand, of_a_run = made
        self.assertEqual(
            by_hand, cla.Context(cla.GitHub("", API), REGISTRY, 1, self.config, [], None, "")
        )
        self.assertEqual(
            of_a_run,
            cla.Context(
                cla.GitHub(BEARER, "https://ghe.invalid/api"),
                "another/cla",
                4711,
                self.config,
                [],
                None,
                RECORDER_COMMIT,
            ),
        )


class EventToken(RegisterTest):
    """The sign-in token is read from the event file, and masked before anything else."""

    REASON = "no well-formed sign-in token in the event"

    def read(self, content: bytes, env: dict[str, str] | None = None) -> str:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "event.json"
            path.write_bytes(content)
            with mock.patch.dict(
                os.environ, {**(env or {}), "GITHUB_EVENT_PATH": str(path)}, clear=True
            ):
                return cla.signin_token_from_event()

    def event(self, token: Any) -> bytes:
        return json.dumps({"inputs": {"signin_token": token}}).encode()

    def test_the_tokens_of_a_user(self) -> None:
        for token in (
            TOKEN,
            "gho_" + "a" * 20,
            "ghu_" + "Z9_" * 85,
        ):
            self.assertEqual(self.read(self.event(token)), token)
        self.assertEqual(self.out.getvalue(), "")

    def test_it_is_masked_in_a_run_and_only_there(self) -> None:
        self.read(self.event(TOKEN), {"GITHUB_ACTIONS": "true"})
        self.assertEqual(self.out.getvalue(), f"::add-mask::{TOKEN}\n")
        for value in ("false", "", "1"):
            self.out.truncate(self.out.seek(0))
            self.read(self.event(TOKEN), {"GITHUB_ACTIONS": value})
            self.assertEqual(self.out.getvalue(), "")

    def test_the_mask_is_out_before_anything_else_can_be(self) -> None:
        with mock.patch("builtins.print") as printed:
            self.read(self.event(TOKEN), {"GITHUB_ACTIONS": "true"})
        printed.assert_called_once_with(f"::add-mask::{TOKEN}", flush=True)

    def test_any_other_token_is_refused_and_not_shown(self) -> None:
        values: tuple[Any, ...] = (
            None,
            5,
            [TOKEN],
            "",
            "ghs_" + "A" * 36,
            "ghp_" + "A" * 36,
            "ghr_" + "A" * 36,
            "ghu_" + "A" * 19,
            "ghu_" + "A" * 256,
            "ghu-" + "A" * 36,
            "xghu_" + "A" * 36,
            "ghu_" + "A" * 36 + "\n",
            "ghu_" + "A" * 36 + "\n::set-output::x",
            "ghu_" + "A" * 35 + "é",
        )
        for value in values:
            with self.subTest(value), self.refused(self.REASON):
                self.read(self.event(value), {"GITHUB_ACTIONS": "true"})
        self.assertEqual(self.out.getvalue(), "")

    def test_a_file_that_is_no_event(self) -> None:
        for content in (
            b"",
            b"null",
            b"[]",
            b"{",
            b"\xff",
            b"[" * 100_000,
            b"{}",
            b'{"inputs": null}',
            b'{"inputs": []}',
            b'{"signin_token": "x"}',
        ):
            with self.subTest(content[:9]), self.refused(self.REASON):
                self.read(content)
        for env in ({"GITHUB_EVENT_PATH": p} for p in ("/nonexistent", "", "/")):
            with (
                self.subTest(env),
                mock.patch.dict(os.environ, env, clear=True),
                self.refused(self.REASON),
            ):
                cla.signin_token_from_event()


class Verify(RegisterTest):
    """``verify`` over a history, what GitHub says of it apart."""

    def setUp(self) -> None:
        super().setUp()
        self.log = self.history()
        self.marker = self.log.root / ".verify" / "next"
        self.marker.parent.mkdir()
        self.config = CONFIG
        self.workflows: list[cla.Finding] = []
        self.coverage: list[cla.Finding] = []
        self.asked: list[tuple[str, Any]] = []

    def run_main(self, *args: str) -> int:
        self.log.build()

        def asked(name: str, answer: Any) -> Any:
            def called(*args: Any) -> Any:
                self.asked.append((name, args))
                return answer

            return called

        facts = {self.log.sha(n): c.facts for n, c in enumerate(self.log._commits)}
        for stream in (self.out, self.err):
            stream.truncate(stream.seek(0))
        with (
            mock.patch.dict(os.environ, {**os.environ, **ENVIRONMENT}, clear=True),
            mock.patch.object(cla, "ROOT", self.log.root),
            mock.patch.object(cla, "MARKERS", {".verify/next": self.marker}),
            mock.patch.object(cla, "load_config", lambda: self.config),
            mock.patch.object(cla, "commit_facts", asked("facts", facts)),
            mock.patch.object(cla, "GitHubWitness", asked("witness", self.log.witness)),
            mock.patch.object(cla, "verify_workflows", asked("workflows", self.workflows)),
            mock.patch.object(cla, "verify_coverage", asked("coverage", self.coverage)),
        ):
            return cla.main(["verify", *args])

    def test_a_clean_register_leaves_its_marker(self) -> None:
        head = self.log.sha(self.log.record(comment_record(1)))
        self.assertEqual(self.run_main("--ref", "signatures", "--marker-out", ".verify/next"), 0)
        self.assertEqual(self.marker.read_bytes(), f"{head}\n".encode())
        self.assertEqual(
            self.out.getvalue(),
            f"verify: 0 problem(s), records cross-checked through {head[:12]}\n",
        )
        gh = cla.GitHub(BEARER, API)
        self.assertEqual(
            self.asked,
            [
                ("facts", (gh, REGISTRY, "signatures")),
                ("witness", (gh, REGISTRY)),
                ("workflows", (gh, REGISTRY)),
            ],
        )

    def test_the_remote_branch_is_what_is_checked_by_default(self) -> None:
        clean = self.log.sha(self.log.record(comment_record(1)))
        self.log.add("tidy up", {"x.txt": b"x"}, OWNER)
        self.log.build()
        self.log.git("update-ref", "refs/remotes/origin/signatures", clean)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.run_main("--ref", "origin/signatures"), 0)
        self.assertEqual(self.run_main("--ref", "signatures"), 1)

    def test_a_problem_is_said_and_leaves_no_marker(self) -> None:
        bad = self.log.sha(self.log.add("tidy up", {"x.txt": b"x"}, OWNER))
        self.assertEqual(self.run_main("--ref", "signatures", "--marker-out", ".verify/next"), 1)
        self.assertEqual(
            self.out.getvalue(),
            f"problem: {bad[:12]}: made by 'github-actions[bot]', not by the recorder "
            "(author, committer or GitHub's signature)\n"
            f"problem: {bad[:12]}: A x.txt: only adding or changing one record (and its token) "
            "is allowed\n"
            "verify: 2 problem(s)\n",
        )
        self.assertFalse(self.marker.exists())

    def test_a_register_with_nothing_to_check_leaves_no_marker(self) -> None:
        self.assertEqual(self.run_main("--ref", "signatures", "--marker-out", ".verify/next"), 0)
        self.assertEqual(self.out.getvalue(), "verify: 0 problem(s)\n")
        self.assertFalse(self.marker.exists())

    def test_a_problem_found_outside_the_history_leaves_no_marker(self) -> None:
        head = self.log.sha(self.log.record(comment_record(1)))
        for kind in ("workflows", "coverage"):
            with self.subTest(kind):
                setattr(self, kind, [cla.Finding("0" * 12, "what it found")])
                code = self.run_main(
                    *("--ref", "signatures", "--marker-out", ".verify/next"),
                    *("--merged-since", "2026-11-01"),
                )
                self.assertEqual(code, 1)
                self.assertEqual(
                    self.out.getvalue(),
                    "problem: 000000000000: what it found\n"
                    f"verify: 1 problem(s), records cross-checked through {head[:12]}\n",
                )
                self.assertFalse(self.marker.exists())
                setattr(self, kind, [])

    def test_only_what_came_after_the_last_run_is_read_again(self) -> None:
        since = self.log.sha(self.log.record(comment_record(1), genuine=False))
        self.log.record(comment_record(2))
        self.assertEqual(self.run_main("--ref", "signatures", "--since", since), 0)
        self.assertEqual(self.log.witness.asked, ["comment 5002", "run 1002"])

    def test_the_merges_of_before_the_register_need_no_coverage(self) -> None:
        self.log.record(comment_record(1))
        gh = cla.GitHub(BEARER, API)
        for since, start, expected in (
            ("2026-11-01", "2026-11-23", "2026-11-23"),
            ("2026-12-01", "2026-11-23", "2026-12-01"),
            ("2026-11-01", None, "2026-11-01"),
        ):
            with self.subTest(since=since, start=start):
                self.asked.clear()
                self.config = config_with(coverage_from=start)
                if start is None:
                    del self.config["coverage_from"]
                self.run_main("--ref", "signatures", "--merged-since", since)
                self.assertEqual(
                    self.asked[-1], ("coverage", (gh, self.config, REGISTRY, expected))
                )

    def test_a_tag_named_like_the_branch_does_not_stand_in_for_it(self) -> None:
        clean = self.log.sha(self.log.record(comment_record(1)))
        self.log.git("tag", "origin/signatures", clean)
        self.log.git("tag", "signatures", clean)
        tampered = self.log.sha(self.log.add("tidy up", {"x.txt": b"x"}, OWNER))
        self.log.git("update-ref", "refs/remotes/origin/signatures", tampered)
        for ref in ("origin/signatures", "signatures"):
            with self.subTest(ref):
                self.assertEqual(self.run_main("--ref", ref), 1)
                self.assertIn(tampered[:12], self.out.getvalue())

    def test_a_ref_is_one_of_the_two_and_never_an_option_of_git(self) -> None:
        self.log.record(comment_record(1))
        written = self.log.root / "written"
        for ref in (f"--output={written}", "HEAD", "main", "signatures~1", ""):
            with self.subTest(ref), self.assertRaises(SystemExit) as caught:
                self.run_main(f"--ref={ref}")
            self.assertEqual(caught.exception.code, 2)
            self.assertIn("argument --ref: invalid choice", self.err.getvalue())
        with self.assertRaises(subprocess.CalledProcessError):
            cla.verify_history(self.log.root, CONFIG, f"--output={written}", None, self.log.info)
        self.assertFalse(written.exists())

    def test_the_marker_is_one_file_and_never_a_link_to_another(self) -> None:
        self.log.record(comment_record(1))
        outside = self.log.root / "outside"
        outside.mkdir()
        for path in (str(outside / "x"), ".verify/../outside/x", ".verify/other", ".verify", ""):
            with self.subTest(path), self.assertRaises(SystemExit) as caught:
                self.run_main("--ref", "signatures", "--marker-out", path)
            self.assertEqual(caught.exception.code, 2)
            self.assertIn("argument --marker-out: invalid choice", self.err.getvalue())

        def linked() -> None:
            with self.assertRaises(SystemExit) as caught:
                self.run_main("--ref", "signatures", "--marker-out", ".verify/next")
            self.assertEqual(caught.exception.code, 2)
            self.assertIn(
                "error: .verify/next is reached through a symbolic link", self.err.getvalue()
            )

        self.marker.symlink_to(outside / "x")
        linked()
        self.marker.unlink()
        self.marker.parent.rmdir()
        self.marker.parent.symlink_to(outside)
        linked()
        self.assertEqual(list(outside.iterdir()), [])

    def test_where_the_marker_and_the_refs_are(self) -> None:
        self.assertEqual(cla.MARKERS, {".verify/next": cla.ROOT / ".verify" / "next"})
        self.assertEqual(
            cla.REFS,
            {
                "origin/signatures": "refs/remotes/origin/signatures",
                "signatures": "refs/heads/signatures",
            },
        )


class Child(unittest.TestCase):
    """The file itself, run as the workflows run it."""

    def run_file(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-I", str(Path(cla.__file__)), *args],
            capture_output=True,
            text=True,
            check=False,
            env={"PATH": os.environ["PATH"], "GITHUB_TOKEN": "made-up"},
        )

    def test_a_refusal_is_its_exit_code(self) -> None:
        done = self.run_file("record", "--kind", "sign")
        self.assertEqual(
            (done.returncode, done.stdout, done.stderr),
            (3, "", "refused: --repo and --pr are required\n"),
        )

    def test_it_runs_in_this_process_too(self) -> None:
        """So that what starts it is measured like the rest."""
        with (
            mock.patch.object(sys, "argv", ["cla.py", "record"]),
            contextlib.redirect_stderr(io.StringIO()) as err,
            self.assertRaises(SystemExit) as caught,
        ):
            runpy.run_path(str(Path(cla.__file__)), run_name="__main__")
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("the following arguments are required: --kind", err.getvalue())


if __name__ == "__main__":
    unittest.main()
