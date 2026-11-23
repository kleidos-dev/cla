#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""The register's own writer and its verifier, standard library only.

``record`` runs in ``record.yml`` (``workflow_dispatch``) with the
registry's ``GITHUB_TOKEN``, the only credential that can write the
``signatures`` branch. It trusts nothing the bot said: it re-reads from
GitHub the acceptance comment (``--kind sign``) or the merged pull request
(``--kind coverage``), or asks GitHub whose sign-in token the bot handed
over (``--kind signin``, "Check a token" with the sign-in app's own
secret, then the grant is deleted), and writes through
``createCommitOnBranch``, so every record is a commit GitHub signs. A
signature is written together with an RFC 3161 time-stamp token over the
SHA-256 of its file (``<id>.tsr``); ``--kind stamp`` adds the token to a
signature written while the time-stamping authority did not answer.

``verify`` runs in ``verify.yml`` after every recorder run and weekly: the
history is linear, every commit adds or changes exactly one record and is
the recorder's GitHub-signed commit (or the owner's ``redact:``/``entity:``
commit), every record has the schema's shape and a published version,
every time-stamp token verifies over its record against the pinned roots,
the records added since the last run cite a genuine unedited acceptance
comment (or, for a sign-in, the successful recorder run on that commit of
main) and the successful recorder run that wrote them, the recorder and
the verifier are enabled, and every pull request merged in a served
repository has its coverage file.

Usage::

    python3 -I registry/cla.py record --kind sign --repo OWNER/REPO --pr N --comment-id ID
    python3 -I registry/cla.py record --kind coverage --repo OWNER/REPO --pr N
    python3 -I registry/cla.py record --kind signin --repo OWNER/REPO --pr N --github-id ID \
        --version V --lang en|es --site-commit SHA
    python3 -I registry/cla.py record --kind stamp

``--kind signin`` reads the sign-in token from the workflow_dispatch event
payload (``$GITHUB_EVENT_PATH``, ``inputs.signin_token``), never from the
command line or the environment, and the sign-in app's client secret from
``SIGNIN_CLIENT_SECRET``.
    python3 -I registry/cla.py verify [--since SHA] [--marker-out FILE] [--merged-since YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeGuard

ROOT = Path(__file__).resolve().parent.parent
BRANCH = "signatures"
OWNER_ID = 28966312
OWNER_LOGIN = "jmrplens"
ACTIONS_BOT = "github-actions[bot]"
ACTIONS_BOT_ID = 41898282
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$")
NOREPLY_RE = re.compile(
    r"^(\d{1,12})\+([A-Za-z0-9-]{1,39}(?:\[bot\])?)@users\.noreply\.github\.com$", re.I
)
TRAILER_RE = re.compile(r"^co-authored-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$", re.I | re.M)
RECORD_PATH_RE = re.compile(
    r"^(signatures/individual/[1-9]\d*\.(?:json|tsr)|coverage/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/[1-9]\d*\.json)$"
)
SIGNATURE_PATH_RE = re.compile(r"^signatures/individual/([1-9]\d*)\.(json|tsr)$")
# GitHub lists at most 250 commits of a pull request; with more, not every author can be known.
MAX_COMMITS = 250
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
PR_URL_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]{0,9})$"
)
RECORD_WORKFLOW_PATH = ".github/workflows/record.yml"
GITHUB_COMMITTER_EMAIL = "noreply@github.com"
HEX40_RE = re.compile(r"^[0-9a-f]{40}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9.]{16,40}$")
LANGS = ("en", "es")
#: How long before the recorder's check a sign-in may have been authorized:
#: the Worker's session lasts one hour, so anything older was not this signing.
SIGNIN_MAX_AGE = dt.timedelta(hours=2)
#: ETSI EN 319 422 esi4-qtstStatement-1, DER-encoded: the TSA declares the token qualified (eIDAS).
QTST_STATEMENT_DER = bytes.fromhex("0607040081975e0101")
#: ETSI EN 319 421 best-practices-ts-policy.
QUALIFIED_POLICY = "0.4.0.2023.1.1"
#: Sectigo asks scripts to wait 15 s or more between time-stamp requests.
TSA_SPACING_S = 15


class Refused(Exception):
    """The input is not something the register records; nothing is written."""


def now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(d: dt.datetime) -> str:
    return d.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(s: Any) -> dt.datetime | None:
    """GitHub's ISO 8601 times (``Z`` or an offset, with or without fractions), as UTC."""
    if not isinstance(s, str):
        return None
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.astimezone(dt.UTC) if d.tzinfo else None


def parse_http_date(s: str | None) -> dt.datetime | None:
    """An HTTP ``Date`` header (RFC 9110 IMF-fixdate), as UTC."""
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
    except TypeError, ValueError:
        return None
    return d.astimezone(dt.UTC) if d.tzinfo else None


# The characters either JavaScript's or Python's \s counts as white space,
# spelled out; worker/src/util.ts uses the same list (normalize-vectors.json
# is the shared test).
WHITESPACE = re.compile(
    "[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def normalize(s: str) -> str:
    """NFC, every run of white space collapsed to one space, trimmed."""
    return WHITESPACE.sub(" ", unicodedata.normalize("NFC", s)).strip(" ")


def sha256(data: str | bytes) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def load_config(root: Path = ROOT) -> dict[str, Any]:
    config = json.loads((root / "registry" / "config.json").read_text("utf-8"))
    if not isinstance(config, dict):
        raise Refused("registry/config.json is not a JSON object")
    return config


def load_entities(root: Path = ROOT) -> list[dict[str, Any]]:
    data = json.loads((root / "registry" / "entities.json").read_text("utf-8"))
    entities = data.get("entities", []) if isinstance(data, dict) else None
    if not isinstance(entities, list):
        raise Refused("registry/entities.json holds no list of entities")
    return entities


def accepted_sentences(config: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in config["accepted_versions"]:
        info = config["versions"].get(str(v))
        if info:
            out[normalize(info["sentence"])] = v
    return out


def record_valid(config: dict[str, Any], rec: dict[str, Any] | None) -> bool:
    """Whether a record counts now: a version still accepted, with that version's digest."""
    if not rec:
        return False
    return rec.get("version") in config["accepted_versions"] and record_published(config, rec)


def record_published(config: dict[str, Any], rec: dict[str, Any]) -> bool:
    """Whether a record names a version that was ever published, with that version's digest.

    The history check uses this, not record_valid: dropping a version from
    accepted_versions (to have everyone sign again) must not turn the
    signatures made under it into tampering."""
    info = config["versions"].get(str(rec.get("version")))
    return bool(
        info and isinstance(rec.get("version"), int) and info["set_sha256"] == rec.get("set_sha256")
    )


# --- GitHub -----------------------------------------------------------------


#: A transport answers (status, body) or (status, body, headers); header names in lower case.
Transport = Callable[
    [str, str, dict[str, str], bytes | None],
    "tuple[int, bytes] | tuple[int, bytes, dict[str, str]]",
]


def urllib_transport(
    method: str, url: str, headers: dict[str, str], body: bytes | None
) -> tuple[int, bytes, dict[str, str]]:
    """GitHub's API: https only (urllib would also open file: and custom schemes, ruff S310)."""
    return _open(method, url, headers, body, ("https://",))


def tsa_transport(
    method: str, url: str, headers: dict[str, str], body: bytes | None
) -> tuple[int, bytes, dict[str, str]]:
    """A time-stamping service: http is allowed, as RFC 3161 tokens are signed.

    Sectigo's qualified service answers on http."""
    return _open(method, url, headers, body, ("https://", "http://"))


def _open(
    method: str, url: str, headers: dict[str, str], body: bytes | None, schemes: tuple[str, ...]
) -> tuple[int, bytes, dict[str, str]]:
    if not url.startswith(schemes):
        raise RuntimeError(f"refusing a request to {url.split('?')[0]}: not {' or '.join(schemes)}")
    req = urllib.request.Request(url, data=body, method=method, headers=headers)  # noqa: S310  scheme checked above
    try:
        with urllib.request.urlopen(req, timeout=30) as res:  # noqa: S310  scheme checked above
            return res.status, res.read(), {k.lower(): v for k, v in res.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, e.read(), {k.lower(): v for k, v in (e.headers or {}).items()}


def _answer(res: tuple[Any, ...]) -> tuple[int, bytes, dict[str, str]]:
    return res[0], res[1], (res[2] if len(res) > 2 else {})


@dataclass
class GitHub:
    token: str
    api: str = "https://api.github.com"
    transport: Transport = urllib_transport

    def exchange(
        self,
        method: str,
        path: str,
        body: Any = None,
        accept: str = "application/vnd.github+json",
        basic: tuple[str, str] | None = None,
    ) -> tuple[int, bytes, dict[str, str]]:
        """One request: Bearer with the registry's token, or Basic with an app's id and secret."""
        auth = (
            f"Basic {base64.b64encode(f'{basic[0]}:{basic[1]}'.encode()).decode('ascii')}"
            if basic
            else f"Bearer {self.token}"
        )
        headers = {
            "authorization": auth,
            "accept": accept,
            "x-github-api-version": "2022-11-28",
            "user-agent": "kleidos-cla-recorder",
        }
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        return _answer(self.transport(method, f"{self.api}{path}", headers, data))

    def call(self, method: str, path: str, body: Any = None, raw: bool = False) -> tuple[int, Any]:
        status, payload, _ = self.exchange(
            method,
            path,
            body,
            "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
        )
        if raw:
            return status, payload.decode("utf-8") if status == 200 else None
        return status, json.loads(payload) if payload else None

    def file_bytes(self, repo: str, path: str, ref: str) -> bytes | None:
        """A file's exact bytes (a time-stamp token is binary), None when there is none."""
        status, payload, _ = self.exchange(
            "GET",
            f"/repos/{repo}/contents/{path}?ref={ref}",
            accept="application/vnd.github.raw+json",
        )
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"reading {path} answered {status}")
        return payload

    def get(self, path: str) -> Any:
        status, data = self.call("GET", path)
        if status != 200:
            raise RuntimeError(f"GET {path.split('?')[0]} answered {status}")
        return data

    def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        status, data = self.call("POST", "/graphql", {"query": query, "variables": variables})
        if status != 200 or data.get("errors"):
            types = [e.get("type") for e in (data or {}).get("errors", [])]
            raise RuntimeError(f"GraphQL answered {status}: {types}")
        return data["data"]

    def file(self, repo: str, path: str, ref: str) -> str | None:
        status, text = self.call("GET", f"/repos/{repo}/contents/{path}?ref={ref}", raw=True)
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"reading {path} answered {status}")
        if not isinstance(text, str):
            raise RuntimeError(f"reading {path} answered no text")
        return text


# GraphQL documents; a line break is white space to GraphQL, so where they
# break is only layout.
COMMENT_QUERY = """query($id:ID!){node(id:$id){... on IssueComment{createdAt lastEditedAt body
editor{login} author{login ... on User{databaseId}} pullRequest{number
repository{nameWithOwner}}}}}"""

HEAD_QUERY = """query($owner:String!,$name:String!,$ref:String!){
repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{oid}}}}"""

COMMIT_MUTATION = """mutation($input:CreateCommitOnBranchInput!){
createCommitOnBranch(input:$input){commit{oid url}}}"""

COMMITS_QUERY = """query($owner:String!,$name:String!,$number:Int!,$cursor:String){
repository(owner:$owner,name:$name){pullRequest(number:$number){
commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor}
nodes{commit{oid message authoredDate parents{totalCount}
authors(first:20){totalCount nodes{email user{databaseId login}}}}}}}}}"""


def commit_file(
    gh: GitHub, registry: str, path: str, content: str, headline: str, attempts: int = 5
) -> str:
    """Adds or changes one file on the signatures branch, as a commit GitHub signs."""
    return commit_files(gh, registry, {path: content.encode("utf-8")}, [], headline, attempts)


def commit_files(
    gh: GitHub,
    registry: str,
    additions: dict[str, bytes],
    deletions: list[str],
    headline: str,
    attempts: int = 5,
) -> str:
    """Adds, changes or deletes the files of one record in one commit GitHub signs.

    The files are a record's JSON and its time-stamp token."""
    owner, name = registry.split("/")
    last = ""
    changes: dict[str, Any] = {
        "additions": [
            {"path": p, "contents": base64.b64encode(c).decode("ascii")}
            for p, c in additions.items()
        ]
    }
    if deletions:
        changes["deletions"] = [{"path": p} for p in deletions]
    for _ in range(attempts):
        head = gh.graphql(
            HEAD_QUERY, {"owner": owner, "name": name, "ref": f"refs/heads/{BRANCH}"}
        )["repository"]["ref"]["target"]["oid"]
        try:
            out = gh.graphql(
                COMMIT_MUTATION,
                {
                    "input": {
                        "branch": {"repositoryNameWithOwner": registry, "branchName": BRANCH},
                        "expectedHeadOid": head,
                        "message": {"headline": headline},
                        "fileChanges": changes,
                    }
                },
            )
            oid = out["createCommitOnBranch"]["commit"]["oid"]
            if not isinstance(oid, str):
                raise RuntimeError("createCommitOnBranch answered no commit id")
            return oid
        except RuntimeError as e:  # the branch moved between the read and the write
            last = str(e)
    raise RuntimeError(f"could not commit {', '.join(additions)}: {last}")


# --- time-stamping (RFC 3161) -----------------------------------------------------


def _der(tag: int, content: bytes) -> bytes:
    n = len(content)
    if n < 0x80:
        return bytes([tag, n]) + content
    size = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([tag, 0x80 | len(size)]) + size + content


def timestamp_query(digest_hex: str, nonce: int) -> bytes:
    """A TimeStampReq (RFC 3161 section 2.4.1) for a SHA-256 digest, a nonce and certReq."""
    sha256_oid = bytes.fromhex("0609608648016503040201")
    algorithm = _der(0x30, sha256_oid + b"\x05\x00")
    imprint = _der(0x30, algorithm + _der(0x04, bytes.fromhex(digest_hex)))
    n = nonce.to_bytes((nonce.bit_length() + 8) // 8, "big")  # one spare bit: always positive
    return _der(0x30, _der(0x02, b"\x01") + imprint + _der(0x02, n) + _der(0x01, b"\xff"))


def _openssl(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["openssl", *args], capture_output=True, text=True, check=False)


def tsr_text(tsr: bytes) -> str | None:
    """`openssl ts -reply -text` of a response, None when it does not parse."""
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "r.tsr"
        path.write_bytes(tsr)
        out = _openssl(["ts", "-reply", "-in", str(path), "-text"])
    return out.stdout if out.returncode == 0 else None


def tsr_time(text: str) -> dt.datetime | None:
    m = re.search(r"^Time stamp: (.+?) GMT$", text, re.M)
    if not m:
        return None
    try:
        return dt.datetime.strptime(" ".join(m.group(1).split()), "%b %d %H:%M:%S %Y").replace(
            tzinfo=dt.UTC
        )
    except ValueError:
        try:
            return dt.datetime.strptime(
                " ".join(m.group(1).split()).split(".")[0], "%b %d %H:%M:%S %Y"
            ).replace(tzinfo=dt.UTC)
        except ValueError:
            return None


def verify_tsr(
    tsr: bytes, digest_hex: str, roots: list[Path], qualified: bool, query: bytes | None = None
) -> str | None:
    """None when a time-stamp response verifies.

    That is: it is granted, it is over ``digest_hex`` (and the query's
    nonce), and its signature chains to a pinned root at the time it states.

    With ``qualified``, the token must also carry ETSI's best-practices
    policy and the qualified statement (esi4-qtstStatement-1). Certificate
    validity is checked at the token's own time (``-attime``), so a token
    stays verifiable after its signer's certificate expires."""
    text = tsr_text(tsr)
    if text is None:
        return "the time-stamp token does not parse"
    if not re.search(r"^Status: Granted\.", text, re.M):
        return "the time-stamp authority did not grant it"
    when = tsr_time(text)
    if when is None:
        return "the time-stamp token has no time"
    if qualified and (
        not re.search(rf"^Policy OID: {re.escape(QUALIFIED_POLICY)}\b", text, re.M)
        or QTST_STATEMENT_DER not in tsr
    ):
        return "the time-stamp token is not a qualified one"
    with tempfile.TemporaryDirectory() as d:
        resp = Path(d) / "r.tsr"
        resp.write_bytes(tsr)
        cafile = Path(d) / "roots.pem"
        cafile.write_text(
            "".join(
                (ROOT / r).read_text("ascii") if not r.is_absolute() else r.read_text("ascii")
                for r in roots
            ),
            "ascii",
        )
        args = [
            "ts",
            "-verify",
            "-in",
            str(resp),
            "-CAfile",
            str(cafile),
            "-attime",
            str(int(when.timestamp())),
        ]
        if query is not None:
            q = Path(d) / "q.tsq"
            q.write_bytes(query)
            args += ["-queryfile", str(q)]
        else:
            args += ["-digest", digest_hex]
        out = _openssl(args)
    if out.returncode != 0 or "Verification: OK" not in out.stdout:
        return "the time-stamp token does not verify"
    return None


class Stamper:
    """Asks a time-stamping authority for a token over a digest; tests give their own."""

    def stamp(self, digest_hex: str) -> bytes | None:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass
class TSAStamper(Stamper):
    """RFC 3161 over HTTP. Two tries, ``TSA_SPACING_S`` apart; None without a verified token."""

    url: str
    roots: list[Path]
    qualified: bool
    transport: Transport = tsa_transport
    sleep: Callable[[float], None] = time.sleep
    last: float = 0.0

    @classmethod
    def from_config(cls, config: dict[str, Any], **kw: Any) -> TSAStamper | None:
        ts = config.get("timestamping")
        if not isinstance(ts, dict) or not ts.get("url"):
            return None
        return cls(
            ts["url"], [Path(r) for r in ts.get("roots", [])], bool(ts.get("qualified")), **kw
        )

    def stamp(self, digest_hex: str) -> bytes | None:
        for attempt in range(2):
            wait = TSA_SPACING_S - (time.monotonic() - self.last)
            if self.last and wait > 0:
                self.sleep(wait)
            query = timestamp_query(digest_hex, secrets.randbits(63) | 1)
            self.last = time.monotonic()
            status, body, _ = _answer(
                self.transport(
                    "POST",
                    self.url,
                    {
                        "content-type": "application/timestamp-query",
                        "user-agent": "kleidos-cla-recorder",
                    },
                    query,
                )
            )
            if status == 200 and body:
                problem = verify_tsr(body, digest_hex, self.roots, self.qualified, query)
                if problem is None:
                    return body
                print(f"time-stamp attempt {attempt + 1}: {problem}", file=sys.stderr)
            else:
                print(
                    f"time-stamp attempt {attempt + 1}: the authority answered {status}",
                    file=sys.stderr,
                )
        return None


@dataclass
class Context:
    gh: GitHub
    registry: str
    run_id: int
    config: dict[str, Any]
    entities: list[dict[str, Any]] = field(default_factory=list)
    #: The time-stamping authority; None records without a token (the stamp kind adds it later).
    stamper: Stamper | None = None
    #: The commit of main this run executes (GITHUB_SHA), named in a sign-in record.
    commit: str = ""


def served(ctx: Context, repo: str) -> None:
    if not REPO_RE.match(repo) or repo not in ctx.config["served_repositories"]:
        raise Refused(f"{repo} is not a served repository")
    if ctx.gh.get(f"/repos/{repo}").get("private"):
        raise Refused(f"{repo} is not public")


def existing_record(ctx: Context, gid: int) -> dict[str, Any] | None:
    text = ctx.gh.file(ctx.registry, f"signatures/individual/{gid}.json", BRANCH)
    return json.loads(text) if text else None


def write_signature(
    ctx: Context, gid: int, record: dict[str, Any], replacing: bool, headline: str
) -> str:
    """One commit with the record and, when the authority answered, its time-stamp token.

    The token is over the SHA-256 of the file's bytes.

    A replaced record's old token no longer matches, so it goes in the same
    commit when no new one came back."""
    path = f"signatures/individual/{gid}.json"
    tsr_path = f"signatures/individual/{gid}.tsr"
    content = (json.dumps(record, indent=2) + "\n").encode("utf-8")
    token = ctx.stamper.stamp(sha256(content)) if ctx.stamper else None
    additions = {path: content}
    deletions: list[str] = []
    if token:
        additions[tsr_path] = token
    elif replacing and ctx.gh.file_bytes(ctx.registry, tsr_path, BRANCH) is not None:
        deletions.append(tsr_path)
    oid = commit_files(ctx.gh, ctx.registry, additions, deletions, headline)
    return f"recorded in {oid}" + ("" if token else " (no time-stamp token yet)")


def record_sign(ctx: Context, repo: str, pr: int, comment_id: int) -> str:
    """Records one genuine, unedited acceptance by the account that wrote it."""
    served(ctx, repo)
    rest = ctx.gh.get(f"/repos/{repo}/issues/comments/{comment_id}")
    node = ctx.gh.graphql(COMMENT_QUERY, {"id": rest["node_id"]})["node"]
    if not node:
        raise Refused("comment not found")
    if node.get("lastEditedAt") or node.get("editor"):
        raise Refused("the comment was edited")
    pull = node.get("pullRequest") or {}
    if pull.get("number") != pr or (pull.get("repository") or {}).get("nameWithOwner") != repo:
        raise Refused("the comment is not on that pull request")
    author = node.get("author") or {}
    gid = author.get("databaseId")
    login = author.get("login", "")
    if (
        not isinstance(gid, int)
        or gid <= 0
        or (rest.get("user") or {}).get("type") != "User"
        or not LOGIN_RE.match(login)
        or login.endswith("[bot]")
    ):
        raise Refused("the author is not a personal account")
    version = accepted_sentences(ctx.config).get(normalize(node["body"]))
    if version is None:
        raise Refused("the comment is not the acceptance sentence of an accepted version")
    previous = existing_record(ctx, gid)
    if previous and record_valid(ctx.config, previous) and previous["version"] >= version:
        return "already recorded"
    via = rest.get("performed_via_github_app") or {}
    record = {
        "schema": 1,
        "kind": "individual",
        "github_id": gid,
        "login_at_signing": login,
        "agreement": ctx.config["agreement"],
        "version": version,
        "set_sha256": ctx.config["versions"][str(version)]["set_sha256"],
        "accepted_at": node["createdAt"],
        # Posted through the app (the sign page) or typed by hand; told by the app's numeric id,
        # never its slug.
        "method": "web"
        if isinstance(ctx.config.get("app_id"), int) and via.get("id") == ctx.config["app_id"]
        else "comment",
        "evidence": {
            "pr_url": f"https://github.com/{repo}/pull/{pr}",
            "comment_url": f"https://github.com/{repo}/pull/{pr}#issuecomment-{comment_id}",
            "comment_id": comment_id,
            "comment_body_sha256": sha256(node["body"]),
        },
        "recorded_at": now(),
        "recorder_run_id": ctx.run_id,
    }
    return write_signature(
        ctx, gid, record, previous is not None, f"sign: {login} ({gid}) accepts version {version}"
    )


@dataclass
class SigninApp:
    """The identity-only sign-in app (no permission at all).

    Its client id is public; its secret is an Actions secret."""

    client_id: str
    client_secret: str


def revoke_signin(gh: GitHub, app: SigninApp, token: str) -> None:
    """Deletes the signer's authorization of the sign-in app.

    Every token of it dies, and GitHub asks again next time."""
    status, _, _ = gh.exchange(
        "DELETE",
        f"/applications/{app.client_id}/grant",
        {"access_token": token},
        basic=(app.client_id, app.client_secret),
    )
    print(
        f"sign-in grant deleted ({status})"
        if status == 204
        else f"sign-in grant not deleted: GitHub answered {status}",
        file=sys.stderr,
    )


def record_signin(
    ctx: Context,
    app: SigninApp,
    repo: str,
    pr: int,
    gid: int,
    version: int,
    lang: str,
    site_commit: str,
    token: str,
) -> str:
    """Records the acceptance the Worker reports for ``gid``, once GitHub vouches for the token.

    GitHub must say the token is that account's sign-in with our app.

    "Check a token" (POST /applications/{client_id}/token, Basic with the
    app's own secret) is answered by GitHub, not by the Worker: a Worker
    that lies can only record the account that is signing in at that
    moment. The acceptance time is GitHub's Date of that answer, the
    authorization time its created_at. The grant is deleted whatever
    happens, so the token dies within seconds of the recording."""
    try:
        if gid <= 0:
            raise Refused("no account id")
        served(ctx, repo)
        if not HEX40_RE.match(site_commit):
            raise Refused("the site commit is not a commit id")
        if lang not in LANGS:
            raise Refused("unknown interface language")
        if (
            version != ctx.config["current_version"]
            or version not in ctx.config["accepted_versions"]
        ):
            raise Refused(f"version {version} is not the current version")
        info = ctx.config["versions"].get(str(version)) or {}
        if info.get("flow") != "signin":
            raise Refused(f"version {version} is not accepted by signing in")
        configured = ctx.config.get("signin_client_id")
        if (
            not isinstance(configured, str)
            or configured != app.client_id
            or not CLIENT_ID_RE.match(configured)
        ):
            raise Refused("the sign-in app is not the one registry/config.json names")
        pull = ctx.gh.get(f"/repos/{repo}/pulls/{pr}")
        if pull.get("number") != pr:
            raise Refused("no such pull request")
        status, body, headers = ctx.gh.exchange(
            "POST",
            f"/applications/{app.client_id}/token",
            {"access_token": token},
            basic=(app.client_id, app.client_secret),
        )
        if status in (404, 422):
            raise Refused("GitHub does not know this sign-in token (expired, revoked or not ours)")
        if status != 200:
            raise RuntimeError(f"checking the sign-in token answered {status}")
        answer = json.loads(body)
        accepted = parse_http_date(headers.get("date"))
        authorized = parse_time(answer.get("created_at"))
        if accepted is None or authorized is None:
            raise RuntimeError("GitHub's answer has no usable Date or created_at")
        if (answer.get("app") or {}).get("client_id") != app.client_id:
            raise Refused("the token belongs to another app")
        user = answer.get("user") or {}
        login = user.get("login", "")
        if (
            user.get("type") != "User"
            or not isinstance(login, str)
            or not LOGIN_RE.match(login)
            or login.endswith("[bot]")
        ):
            raise Refused("the token is not a personal account's")
        if user.get("id") != gid:
            raise Refused("the token belongs to another account than the one reported")
        if not (accepted - SIGNIN_MAX_AGE <= authorized <= accepted + dt.timedelta(minutes=1)):
            raise Refused("the sign-in is not recent")
        previous = existing_record(ctx, gid)
        if previous and record_valid(ctx.config, previous) and previous["version"] >= version:
            return "already recorded"
        record = {
            "schema": 2,
            "kind": "individual",
            "github_id": gid,
            "login_at_signing": login,
            "agreement": ctx.config["agreement"],
            "version": version,
            "set_sha256": info["set_sha256"],
            "sentence_sha256": sha256(info["sentence"]),
            "accepted_at": iso(accepted),
            "method": "signin",
            "evidence": {
                "authorized_at": iso(authorized),
                "signin_client_id": app.client_id,
                "context_pr_url": f"https://github.com/{repo}/pull/{pr}",
                "site_commit": site_commit,
                "lang": lang,
            },
            "recorded_at": iso(max(dt.datetime.now(dt.UTC), accepted)),
            "recorder_run_id": ctx.run_id,
            "recorder_commit": ctx.commit,
        }
        if not HEX40_RE.match(ctx.commit):
            raise RuntimeError("the recorder's own commit (GITHUB_SHA) is unknown")
        return write_signature(
            ctx,
            gid,
            record,
            previous is not None,
            f"sign: {login} ({gid}) accepts version {version}",
        )
    finally:
        revoke_signin(ctx.gh, app, token)


SIGNATURE_LIST_LIMIT = 1000


def record_stamps(ctx: Context, limit: int = 10) -> str:
    """Adds the missing time-stamp token of recorder-written signatures.

    One commit each, at most ``limit`` per run."""
    if ctx.stamper is None:
        return "no time-stamping authority configured"
    status, listing = ctx.gh.call(
        "GET", f"/repos/{ctx.registry}/contents/signatures/individual?ref={BRANCH}"
    )
    if status == 404:
        return "no signature yet"
    if status != 200 or not isinstance(listing, list):
        raise RuntimeError(f"listing the signatures answered {status}")
    names = {e.get("name") for e in listing if e.get("type") == "file"}
    todo = sorted(
        int(n[:-5])
        for n in names
        if isinstance(n, str) and re.match(r"^[1-9]\d*\.json$", n) and f"{n[:-5]}.tsr" not in names
    )
    done = 0
    for gid in todo[:limit]:
        path = f"signatures/individual/{gid}.json"
        content = ctx.gh.file_bytes(ctx.registry, path, BRANCH)
        if content is None or check_record(ctx.config, path, content.decode("utf-8")) is not None:
            continue
        last = ctx.gh.get(f"/repos/{ctx.registry}/commits?sha={BRANCH}&path={path}&per_page=1")
        c = last[0] if isinstance(last, list) and last else {}
        verified = ((c.get("commit") or {}).get("verification") or {}).get("verified") is True
        if (
            (c.get("author") or {}).get("id") != ACTIONS_BOT_ID
            or (c.get("committer") or {}).get("login") != "web-flow"
            or not verified
        ):
            continue  # not the recorder's file: nothing to vouch for
        token = ctx.stamper.stamp(sha256(content))
        if token is None:
            break  # the authority is down: the next run tries again
        commit_files(
            ctx.gh, ctx.registry, {f"signatures/individual/{gid}.tsr": token}, [], f"stamp: {gid}"
        )
        done += 1
    return f"stamped {done} of {len(todo)}"


def parse_noreply(email: str | None) -> tuple[int, str] | None:
    m = NOREPLY_RE.match((email or "").strip())
    return (int(m.group(1)), m.group(2)) if m else None


def pr_authors(
    ctx: Context, repo: str, pr: dict[str, Any]
) -> tuple[dict[int, tuple[str, str, list[str]]], int]:
    """The Worker's rule, written again: opener, commit authors and co-authors (id → login, type,
    dates); and how many could not be identified.
    """
    owner, name = repo.split("/")
    people: dict[int, tuple[str, str, list[str]]] = {}
    unknown = 0

    def add(gid: int, login: str, kind: str, date: str) -> None:
        if gid in people:
            people[gid][2].append(date)
        else:
            people[gid] = (login, kind, [date])

    user = pr["user"]
    # The opener is dated by the pull request's creation, as the Worker does (worker/src/assess.ts).
    add(user["id"], user["login"], user.get("type", "User"), pr["created_at"][:10])
    cursor = None
    seen = 0
    while True:
        page = ctx.gh.graphql(
            COMMITS_QUERY, {"owner": owner, "name": name, "number": pr["number"], "cursor": cursor}
        )
        pull = (page.get("repository") or {}).get("pullRequest") or {}
        commits = pull.get("commits")
        if not commits:
            raise RuntimeError("GitHub returned no commit list")
        if commits["totalCount"] > MAX_COMMITS:
            raise Refused("too many commits to check")
        for n in commits["nodes"]:
            c = n["commit"]
            seen += 1
            # Merge commits count like any other: a merge can carry changes of its own.
            date = c["authoredDate"][:10]
            listed = set()
            for a in c["authors"]["nodes"]:
                if a.get("email"):
                    listed.add(a["email"].lower())
                u = a.get("user")
                if u and isinstance(u.get("databaseId"), int):
                    add(u["databaseId"], u["login"], "User", date)
                elif nr := parse_noreply(a.get("email")):
                    add(nr[0], nr[1], "Bot" if nr[1].endswith("[bot]") else "User", date)
                else:
                    unknown += 1
            if c["authors"]["totalCount"] > len(c["authors"]["nodes"]):
                unknown += 1
            for m in TRAILER_RE.finditer(c["message"]):
                email = m.group(2).lower()
                if email in listed:
                    continue
                if nr := parse_noreply(email):
                    add(nr[0], nr[1], "Bot" if nr[1].endswith("[bot]") else "User", date)
                else:
                    unknown += 1
        if not commits["pageInfo"]["hasNextPage"] or seen >= MAX_COMMITS:
            if seen < commits["totalCount"]:
                raise Refused("GitHub listed fewer commits than the pull request has")
            break
        cursor = commits["pageInfo"]["endCursor"]
    return people, unknown


def covering_entity(ctx: Context, gid: int, date: str) -> bool:
    for e in ctx.entities:
        info = ctx.config["versions"].get(str(e.get("version")))
        if (
            not info
            or e.get("version") not in ctx.config["accepted_versions"]
            or info["set_sha256"] != e.get("set_sha256")
        ):
            continue
        for c in e.get("covered", []):
            if (
                c["github_id"] == gid
                and c["from"] <= date
                and (not c.get("until") or date <= c["until"])
            ):
                return True
    return False


def record_coverage(ctx: Context, repo: str, number: int) -> str:
    """Writes the per-contribution record of Addendum 4.2 for one merged pull request."""
    served(ctx, repo)
    pr = ctx.gh.get(f"/repos/{repo}/pulls/{number}")
    if not pr.get("merged"):
        raise Refused("the pull request is not merged")
    people, unknown = pr_authors(ctx, repo, pr)
    if unknown:
        raise Refused(f"{unknown} author(s) cannot be identified")
    exempt = {e["id"] for e in ctx.config["exempt"]}
    ids: list[int] = []
    versions: dict[str, int] = {}
    missing: list[int] = []
    for gid, (_login, kind, dates) in sorted(people.items()):
        if gid in exempt or all(covering_entity(ctx, gid, d) for d in dates):
            continue
        if kind != "User":
            missing.append(gid)
            continue
        rec = existing_record(ctx, gid)
        if rec is None or not record_valid(ctx.config, rec):
            missing.append(gid)
            continue
        ids.append(gid)
        versions[str(gid)] = rec["version"]
    if missing:
        raise Refused(
            f"merged without a signature from account id(s) {', '.join(map(str, missing))}"
        )
    owner, name = repo.split("/")
    path = f"coverage/{owner}/{name}/{number}.json"
    if ctx.gh.file(ctx.registry, path, BRANCH) is not None:
        return "already recorded"
    record = {
        "schema": 1,
        "kind": "coverage",
        "repo": repo,
        "pr": number,
        "merge_sha": pr["merge_commit_sha"],
        "merged_at": pr["merged_at"],
        "github_ids": ids,
        "versions": versions,
        "recorded_at": now(),
        "recorder_run_id": ctx.run_id,
    }
    oid = commit_file(
        ctx.gh,
        ctx.registry,
        path,
        json.dumps(record, indent=2) + "\n",
        f"coverage: {repo}#{number}",
    )
    return f"recorded in {oid}"


# --- verify -------------------------------------------------------------------


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True, text=True
    ).stdout


@dataclass
class Finding:
    commit: str
    problem: str

    def __str__(self) -> str:
        return f"{self.commit[:12]}: {self.problem}"


def _pos_int(v: object) -> TypeGuard[int]:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def check_record(config: dict[str, Any], path: str, text: str) -> str | None:
    """The shape of one record file (registry/schema/), checked field by field;
    worker/src/registry.ts isSignatureRecord does the same.
    """
    try:
        rec = json.loads(text)
    except json.JSONDecodeError:
        return "not JSON"
    if not isinstance(rec, dict):
        return "not a JSON object"
    if path.startswith("signatures/"):
        gid = int(path.rsplit("/", 1)[1].split(".")[0])
        if rec.get("kind") != "individual" or rec.get("github_id") != gid:
            return "the record does not match its path"
        if not record_published(config, rec):
            return "the version or digest is not a published one"
        if rec.get("schema") == 2:
            return check_signin_record(config, rec)
        allowed = {
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
        }
        if set(rec) != allowed:
            return f"unexpected or missing fields {sorted(set(rec) ^ allowed)}"
        ev = rec["evidence"]
        ok = (
            rec["schema"] == 1
            and rec["agreement"] == config["agreement"]
            and rec["method"] in ("web", "comment")
            and isinstance(rec["login_at_signing"], str)
            and LOGIN_RE.match(rec["login_at_signing"]) is not None
            and not rec["login_at_signing"].endswith("[bot]")
            and isinstance(rec["accepted_at"], str)
            and TIME_RE.match(rec["accepted_at"]) is not None
            and isinstance(rec["recorded_at"], str)
            and TIME_RE.match(rec["recorded_at"]) is not None
            and _pos_int(rec["recorder_run_id"])
            and isinstance(ev, dict)
            and set(ev) == {"pr_url", "comment_url", "comment_id", "comment_body_sha256"}
            and isinstance(ev.get("pr_url"), str)
            and PR_URL_RE.match(ev["pr_url"]) is not None
            and _pos_int(ev.get("comment_id"))
            and ev.get("comment_url") == f"{ev['pr_url']}#issuecomment-{ev.get('comment_id')}"
            and isinstance(ev.get("comment_body_sha256"), str)
            and HEX64_RE.match(ev["comment_body_sha256"]) is not None
        )
        if not ok:
            return "malformed record"
    else:
        parts = path.split("/")
        if (
            rec.get("kind") != "coverage"
            or rec.get("repo") != f"{parts[1]}/{parts[2]}"
            or str(rec.get("pr")) != parts[3].split(".")[0]
        ):
            return "the coverage record does not match its path"
    return None


SIGNIN_FIELDS = {
    "schema",
    "kind",
    "github_id",
    "login_at_signing",
    "agreement",
    "version",
    "set_sha256",
    "sentence_sha256",
    "accepted_at",
    "method",
    "evidence",
    "recorded_at",
    "recorder_run_id",
    "recorder_commit",
}
SIGNIN_EVIDENCE = {"authorized_at", "signin_client_id", "context_pr_url", "site_commit", "lang"}


def _time(v: Any) -> bool:
    return isinstance(v, str) and TIME_RE.match(v) is not None


def check_signin_record(config: dict[str, Any], rec: dict[str, Any]) -> str | None:
    """Schema 2: an acceptance made by signing in.

    As registry/schema/individual.schema.json says; worker/src/registry.ts
    checks the same."""
    if set(rec) != SIGNIN_FIELDS:
        return f"unexpected or missing fields {sorted(set(rec) ^ SIGNIN_FIELDS)}"
    info = config["versions"][str(rec["version"])]
    ev = rec["evidence"]
    ok = (
        rec["agreement"] == config["agreement"]
        and rec["method"] == "signin"
        and info.get("flow") == "signin"
        and rec["sentence_sha256"] == sha256(info["sentence"])
        and isinstance(rec["login_at_signing"], str)
        and LOGIN_RE.match(rec["login_at_signing"]) is not None
        and not rec["login_at_signing"].endswith("[bot]")
        and _time(rec["accepted_at"])
        and _time(rec["recorded_at"])
        and _pos_int(rec["recorder_run_id"])
        and isinstance(rec["recorder_commit"], str)
        and HEX40_RE.match(rec["recorder_commit"]) is not None
        and isinstance(ev, dict)
        and set(ev) == SIGNIN_EVIDENCE
        and _time(ev.get("authorized_at"))
        and isinstance(ev.get("signin_client_id"), str)
        and CLIENT_ID_RE.match(ev["signin_client_id"]) is not None
        and isinstance(ev.get("context_pr_url"), str)
        and PR_URL_RE.match(ev["context_pr_url"]) is not None
        and isinstance(ev.get("site_commit"), str)
        and HEX40_RE.match(ev["site_commit"]) is not None
        and ev.get("lang") in LANGS
    )
    if not ok:
        return "malformed record"
    authorized, accepted, recorded = (
        parse_time(ev["authorized_at"]),
        parse_time(rec["accepted_at"]),
        parse_time(rec["recorded_at"]),
    )
    # Two of GitHub's clocks and the runner's: a minute of slack, as the recorder allows.
    slack = dt.timedelta(minutes=1)
    if not (
        authorized
        and accepted
        and recorded
        and authorized <= accepted + slack
        and accepted <= recorded + slack
        and accepted - authorized <= SIGNIN_MAX_AGE
    ):
        return "the authorization, acceptance and recording times are out of order"
    return None


@dataclass
class Facts:
    """What GitHub says of one commit of the signatures branch: who wrote it, who committed it, and
    its signature.
    """

    author_id: int | None
    committer_id: int | None
    committer_email: str
    signature_valid: bool
    signed_by_github: bool


def by_recorder(f: Facts) -> bool:
    """A commit createCommitOnBranch made with the recorder's GITHUB_TOKEN: github-actions[bot]'s,
    committed and signed by GitHub.
    """
    return (
        f.author_id == ACTIONS_BOT_ID
        and f.signature_valid
        and f.signed_by_github
        and f.committer_email == GITHUB_COMMITTER_EMAIL
    )


def by_owner(f: Facts) -> bool:
    """A commit the owner made and signed himself (or through GitHub's own interface)."""
    return (
        f.author_id == OWNER_ID
        and f.signature_valid
        and (f.committer_id == OWNER_ID or f.signed_by_github)
    )


class Witness:
    """What the cross-checks read from GitHub; tests give their own."""

    def comment(
        self, repo: str, comment_id: int
    ) -> dict[str, Any] | None:  # pragma: no cover - interface
        raise NotImplementedError

    def run(self, run_id: int) -> dict[str, Any] | None:  # pragma: no cover - interface
        raise NotImplementedError


class Pending(Exception):
    """A record's recorder run has not finished yet: the check stops before it and the next run
    resumes there.
    """


def cross_check(
    config: dict[str, Any], registry: str, path: str, rec: dict[str, Any], witness: Witness
) -> str | None:
    """The record's evidence, re-read from GitHub: the acceptance comment it cites and the recorder
    run that wrote it.

    This is what a GitHub-signed github-actions[bot] commit made anywhere
    else (a fork's Actions, say) and pushed here cannot pass."""
    run_id = rec.get("recorder_run_id")
    if not _pos_int(run_id):
        return "no recorder run id"
    head_sha = None
    if path.startswith("signatures/") and rec.get("schema") == 2:
        m = PR_URL_RE.match(rec["evidence"]["context_pr_url"])
        if m is None:
            return "the evidence's context_pr_url is not a pull request address"
        # A sign-in leaves nothing on GitHub to re-read (the token is revoked):
        # the run that checked it with GitHub, on this commit of main, is the
        # evidence.
        title = f"Record signin {m.group(1)}#{m.group(2)} {rec['github_id']}"
        head_sha = rec["recorder_commit"]
        if rec["evidence"]["signin_client_id"] != config.get("signin_client_id"):
            return "signed in through an app that is not the one registry/config.json names"
    elif path.startswith("signatures/"):
        m = PR_URL_RE.match(rec["evidence"]["pr_url"])
        if m is None:
            return "the evidence's pr_url is not a pull request address"
        repo, pr = m.group(1), int(m.group(2))
        cid = rec["evidence"]["comment_id"]
        title = f"Record sign {repo}#{pr} {cid}"
        c = witness.comment(repo, cid)
        if c is None:
            return f"the acceptance comment {cid} cannot be read"
        if c.get("author_id") != rec["github_id"]:
            return "the acceptance comment was written by another account"
        if c.get("edited"):
            return "the acceptance comment was edited"
        if c.get("created_at") != rec["accepted_at"]:
            return "accepted_at is not the comment's creation time"
        if sha256(c.get("body", "")) != rec["evidence"]["comment_body_sha256"]:
            return "the comment's text does not hash to comment_body_sha256"
        if (c.get("pr"), c.get("repo")) != (pr, repo):
            return "the comment is not on the pull request the record names"
    else:
        title = f"Record coverage {rec.get('repo')}#{rec.get('pr')}"
    run = witness.run(run_id)
    if run is None:
        return f"recorder run {run_id} is not a run of {registry}"
    if (
        (run.get("repository") or {}).get("full_name") != registry
        or run.get("path") != RECORD_WORKFLOW_PATH
        or run.get("event") != "workflow_dispatch"
        or run.get("head_branch") != "main"
    ):
        return f"run {run_id} is not {RECORD_WORKFLOW_PATH} dispatched on main of {registry}"
    if " ".join(str(run.get("display_title", "")).split()) != title:
        return f"run {run_id} recorded something else"
    if head_sha is not None and run.get("head_sha") != head_sha:
        return f"run {run_id} did not run the commit the record names"
    if run.get("status") != "completed":
        raise Pending(run_id)
    if run.get("conclusion") != "success":
        return f"run {run_id} did not succeed"
    return None


CommitInfo = Callable[[str], "Facts | None"]


def change_shape(changes: list[list[str]]) -> str | None:
    """What a recorder commit may change.

    One coverage record, or one account's signature and its time-stamp token.

    The signature (A or M) with or without its token (A or M; D only when
    the signature is replaced without a new token), or the token alone (A,
    added later by the stamp run)."""
    if not changes:
        return "changes nothing"
    paths = {c[-1]: c[0] for c in changes}
    for path, status in paths.items():
        if not RECORD_PATH_RE.match(path) or status[0] not in "AMD":
            return f"{status} {path}: only adding or changing one record (and its token) is allowed"
    if len(paths) == 1:
        ((path, status),) = paths.items()
        if path.endswith(".tsr"):
            return (
                None
                if status == "A"
                else f"{status} {path}: a token is only ever added, or replaced with its record"
            )
        return (
            None
            if status in ("A", "M")
            else f"{status} {path}: only adding or changing one record is allowed"
        )
    ids = {m.group(1) for p in paths for m in [SIGNATURE_PATH_RE.match(p)] if m}
    if len(paths) != 2 or len(ids) != 1:
        return f"changes {len(paths)} files, not one record (and its token)"
    gid = ids.pop()
    rec, tok = (
        paths.get(f"signatures/individual/{gid}.json"),
        paths.get(f"signatures/individual/{gid}.tsr"),
    )
    if rec not in ("A", "M") or tok not in ("A", "M", "D") or (tok in ("M", "D") and rec != "M"):
        return f"record {rec} with token {tok}: not a record written with its token"
    return None


def tsr_problem(root: Path, config: dict[str, Any], sha: str, gid: str) -> str | None:
    """None when, at ``sha``, the account's token is absent or verifies over its record.

    Verifies over the record's bytes, against the pinned roots."""
    try:
        token = subprocess.run(
            ["git", "-C", str(root), "show", f"{sha}:signatures/individual/{gid}.tsr"],
            check=True,
            capture_output=True,
        ).stdout
    except subprocess.CalledProcessError:
        return None
    try:
        record = subprocess.run(
            ["git", "-C", str(root), "show", f"{sha}:signatures/individual/{gid}.json"],
            check=True,
            capture_output=True,
        ).stdout
    except subprocess.CalledProcessError:
        return "a token with no record"
    ts = config.get("timestamping") or {}
    return verify_tsr(
        token, sha256(record), [Path(r) for r in ts.get("roots", [])], bool(ts.get("qualified"))
    )


@dataclass
class Verified:
    findings: list[Finding]
    #: The last commit whose records were cross-checked (the next run's --since); None when nothing
    #: moved it.
    checked_through: str | None


def verify_history(
    root: Path,
    config: dict[str, Any],
    ref: str,
    since: str | None,
    info: CommitInfo,
    witness: Witness | None = None,
    registry: str = "kleidos-dev/cla",
) -> Verified:
    """Every commit: linear, one record each, each the recorder's GitHub-signed commit (the owner's
    own redact:/entity: commits and the root aside).

    ``info(sha)`` answers, from GitHub, who authored and committed a commit
    and whether GitHub signed it: a name or an email in the git metadata
    proves nothing. The records of the commits after ``since`` are also
    cross-checked against the comment and the run they cite (``witness``)."""
    findings: list[Finding] = []
    log = (
        git(root, "log", "--reverse", "--format=%H%x00%P%x00%an%x00%s", ref, "--")
        .strip()
        .splitlines()
    )
    commits = [line.split("\x00") for line in log]
    start = 0
    if since:
        shas = [c[0] for c in commits]
        if since not in shas:
            return Verified(
                [Finding(since, "the previous head is no longer in the history (rewritten?)")], None
            )
        start = shas.index(since) + 1
    checked_through = since
    pending = False
    for i, (sha, parents, author, subject) in enumerate(commits):
        if len(parents.split()) > 1:
            findings.append(Finding(sha, "a merge commit: the history must be linear"))
        if i == 0:
            continue
        facts = info(sha)
        if facts is None:
            findings.append(Finding(sha, "GitHub does not know this commit on the branch"))
            continue
        owners = by_owner(facts) and re.match(r"^(redact|entity):", subject)
        changes = [
            line.split("\t")
            for line in git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", sha)
            .strip()
            .splitlines()
        ]
        before = len(findings)
        if not owners:
            if not by_recorder(facts):
                findings.append(
                    Finding(
                        sha,
                        f"made by {author!r}, not by the recorder "
                        "(author, committer or GitHub's signature)",
                    )
                )
            problem = change_shape(changes)
            if problem:
                findings.append(Finding(sha, problem))
            for status, *paths in changes:
                path = paths[-1]
                if (
                    status not in ("A", "M")
                    or not path.endswith(".json")
                    or not RECORD_PATH_RE.match(path)
                ):
                    continue
                text = git(root, "show", f"{sha}:{path}")
                problem = check_record(config, path, text)
                if problem:
                    findings.append(Finding(sha, f"{path}: {problem}"))
                elif witness is not None and i >= start and not pending:
                    try:
                        problem = cross_check(config, registry, path, json.loads(text), witness)
                    except Pending:
                        pending = True
                        problem = None
                    if problem:
                        findings.append(Finding(sha, f"{path}: {problem}"))
        # Every token on the branch after this commit, for the records it
        # touched, verifies over that record as it now is.
        for gid in sorted(
            {m.group(1) for _s, *ps in changes for m in [SIGNATURE_PATH_RE.match(ps[-1])] if m}
        ):
            problem = tsr_problem(root, config, sha, gid)
            if problem:
                findings.append(Finding(sha, f"signatures/individual/{gid}.tsr: {problem}"))
        if i >= start and not pending and len(findings) == before:
            checked_through = sha
    return Verified(findings, checked_through if not findings else since)


def verify_coverage(
    gh: GitHub, config: dict[str, Any], registry: str, merged_since: str, settle_minutes: int = 60
) -> list[Finding]:
    """Every pull request merged in a served repository since a date has its coverage file.

    One merged within the last ``settle_minutes`` is not yet a problem: its
    recorder run may still be queued, and the Worker's cron re-dispatches a
    missing one."""
    findings: list[Finding] = []
    settled = (dt.datetime.now(dt.UTC) - dt.timedelta(minutes=settle_minutes)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    for repo in config["served_repositories"]:
        owner, name = repo.split("/")
        pulls = gh.get(f"/repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100")
        findings.extend(
            Finding(
                p.get("merge_commit_sha") or "0" * 12,
                f"{repo}#{p['number']} was merged with no coverage record",
            )
            for p in pulls
            if p.get("merged_at")
            and p["merged_at"][:10] >= merged_since
            and p["merged_at"] <= settled
            and gh.file(registry, f"coverage/{owner}/{name}/{p['number']}.json", BRANCH) is None
        )
    return findings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--kind", choices=["sign", "coverage", "signin", "stamp"], required=True)
    r.add_argument("--repo")
    r.add_argument("--pr", type=int)
    r.add_argument("--comment-id", type=int)
    r.add_argument("--github-id", type=int)
    r.add_argument("--version", type=int)
    r.add_argument("--lang")
    r.add_argument("--site-commit")
    v = sub.add_parser("verify")
    v.add_argument("--since")
    v.add_argument("--merged-since")
    v.add_argument("--ref", default=f"origin/{BRANCH}")
    v.add_argument(
        "--marker-out",
        help="where to write the last commit whose records were cross-checked, "
        "for the next run's --since",
    )
    args = ap.parse_args(argv)

    token = os.environ.get("GITHUB_TOKEN", "")
    registry = os.environ.get("GITHUB_REPOSITORY", "kleidos-dev/cla")
    gh = GitHub(token, os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    config = load_config()
    if args.cmd == "record":
        ctx = Context(
            gh,
            registry,
            int(os.environ.get("GITHUB_RUN_ID", "1")),
            config,
            load_entities(),
            TSAStamper.from_config(config),
            os.environ.get("GITHUB_SHA", ""),
        )
        try:
            if args.kind == "stamp":
                print(record_stamps(ctx))
                return 0
            if not args.repo or not args.pr:
                raise Refused("--repo and --pr are required")
            if args.kind == "sign":
                if not args.comment_id:
                    raise Refused("--comment-id is required")
                print(record_sign(ctx, args.repo, args.pr, args.comment_id))
            elif args.kind == "signin":
                token = signin_token_from_event(os.environ.get("GITHUB_EVENT_PATH", ""))
                app = SigninApp(
                    str(config.get("signin_client_id") or ""),
                    os.environ.get("SIGNIN_CLIENT_SECRET", ""),
                )
                if not app.client_secret:
                    raise RuntimeError("SIGNIN_CLIENT_SECRET is not set")
                print(
                    record_signin(
                        ctx,
                        app,
                        args.repo,
                        args.pr,
                        args.github_id or 0,
                        args.version or 0,
                        args.lang or "",
                        args.site_commit or "",
                        token,
                    )
                )
            else:
                print(record_coverage(ctx, args.repo, args.pr))
        except Refused as e:
            print(f"refused: {e}", file=sys.stderr)
            return 3
        return 0

    facts = commit_facts(gh, registry, BRANCH)
    verified = verify_history(
        ROOT, config, args.ref, args.since, facts.get, GitHubWitness(gh, registry), registry
    )
    findings = verified.findings
    findings += verify_workflows(gh, registry)
    if args.merged_since:
        findings += verify_coverage(
            gh, config, registry, max(args.merged_since, config.get("coverage_from", ""))
        )
    if args.marker_out and verified.checked_through and not findings:
        Path(args.marker_out).write_text(verified.checked_through + "\n", "utf-8")
    for f in findings:
        print(f"problem: {f}")
    print(
        f"verify: {len(findings)} problem(s)"
        + (
            f", records cross-checked through {verified.checked_through[:12]}"
            if verified.checked_through
            else ""
        )
    )
    return 1 if findings else 0


TOKEN_RE = re.compile(r"^gh[uo]_[A-Za-z0-9_]{20,255}$")


def signin_token_from_event(path: str) -> str:
    """The sign-in token from the workflow_dispatch payload.

    Masked in the log before anything else; never on a command line or in
    the environment."""
    try:
        token = json.loads(Path(path).read_text("utf-8")).get("inputs", {}).get("signin_token", "")
    except OSError, ValueError, AttributeError:
        token = ""
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        raise Refused("no well-formed sign-in token in the event")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{token}", flush=True)
    return token


HISTORY_QUERY = """query($owner:String!,$name:String!,$ref:String!,$cursor:String){
repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{... on Commit{
history(first:100,after:$cursor){pageInfo{hasNextPage endCursor}
nodes{oid author{user{databaseId}} committer{email user{databaseId}}
signature{isValid wasSignedByGitHub}}}}}}}}"""


def commit_facts(gh: GitHub, registry: str, branch: str) -> dict[str, Facts]:
    """Who authored and committed every commit of a branch, and its signature, 100 commits per
    GraphQL query.
    """
    owner, name = registry.split("/")
    out: dict[str, Facts] = {}
    cursor = None
    while True:
        ref = gh.graphql(
            HISTORY_QUERY,
            {"owner": owner, "name": name, "ref": f"refs/heads/{branch}", "cursor": cursor},
        )["repository"]["ref"]
        if not ref:
            raise RuntimeError(f"the branch {branch} does not exist")
        hist = ref["target"]["history"]
        for n in hist["nodes"]:
            sig = n.get("signature") or {}
            author = (n.get("author") or {}).get("user") or {}
            committer = n.get("committer") or {}
            out[n["oid"]] = Facts(
                author.get("databaseId"),
                (committer.get("user") or {}).get("databaseId"),
                (committer.get("email") or "").lower(),
                bool(sig.get("isValid")),
                bool(sig.get("wasSignedByGitHub")),
            )
        if not hist["pageInfo"]["hasNextPage"]:
            return out
        cursor = hist["pageInfo"]["endCursor"]


class GitHubWitness(Witness):
    def __init__(self, gh: GitHub, registry: str) -> None:
        self.gh = gh
        self.registry = registry

    def comment(self, repo: str, comment_id: int) -> dict[str, Any] | None:
        status, rest = self.gh.call("GET", f"/repos/{repo}/issues/comments/{comment_id}")
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"reading comment {comment_id} answered {status}")
        node = self.gh.graphql(COMMENT_QUERY, {"id": rest["node_id"]})["node"] or {}
        pull = node.get("pullRequest") or {}
        return {
            "author_id": (node.get("author") or {}).get("databaseId"),
            "edited": bool(node.get("lastEditedAt") or node.get("editor")),
            "created_at": node.get("createdAt"),
            "body": node.get("body", ""),
            "pr": pull.get("number"),
            "repo": (pull.get("repository") or {}).get("nameWithOwner"),
        }

    def run(self, run_id: int) -> dict[str, Any] | None:
        status, run = self.gh.call("GET", f"/repos/{self.registry}/actions/runs/{run_id}")
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"reading run {run_id} answered {status}")
        if not isinstance(run, dict):
            raise RuntimeError(f"reading run {run_id} answered no object")
        return run


def verify_workflows(gh: GitHub, registry: str) -> list[Finding]:
    """The recorder and this verifier are enabled: the app's actions: write could disable them
    (SECURITY.md).
    """
    findings: list[Finding] = []
    for wf in ("record.yml", "verify.yml"):
        state = gh.get(f"/repos/{registry}/actions/workflows/{wf}").get("state")
        if state != "active":
            findings.append(Finding("0" * 12, f"the workflow {wf} is {state}, not active"))
    return findings


if __name__ == "__main__":
    sys.exit(main())
