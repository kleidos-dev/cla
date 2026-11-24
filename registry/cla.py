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
the recorder's GitHub-signed commit (or the owner's ``redact:`` commit,
which only deletes records), every record has the schema's shape and a published version,
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
    python3 -I registry/cla.py verify [--since SHA] [--marker-out .verify/next] \
        [--merged-since YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import email.utils
import hashlib
import http.client
import json
import math
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
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, TypeGuard

ROOT = Path(__file__).resolve().parent.parent
BRANCH = "signatures"
OWNER_ID = 28966312
ACTIONS_BOT_ID = 41898282
# Every pattern is matched whole (fullmatch) and means ASCII only, as the Worker's do: no line end
# after it and no digit or letter of another script.
REPO_RE = re.compile(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}")
#: GitHub's rule for a login; an app's has the suffix [bot] after it.
LOGIN_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}")
BOT_SUFFIX = "[bot]"
NOREPLY_RE = re.compile(
    r"([1-9][0-9]{0,11})\+([^@]+)@users\.noreply\.github\.com", re.ASCII | re.IGNORECASE
)
TRAILER_KEY = "co-authored-by:"
#: The line ends of JavaScript, which the Worker's reading of a message has too.
LINE_END_RE = re.compile("[\n\r\u2028\u2029]")
#: No bracket and none of the characters both languages count as white space: an address with one
#: that only one of them counts is an address to both.
TRAILER_EMAIL_RE = re.compile(
    "[^<>\t\n\v\f\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+"
)
RECORD_PATH_RE = re.compile(
    r"signatures/individual/[1-9][0-9]{0,15}\.(?:json|tsr)"
    r"|coverage/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}/[1-9][0-9]{0,9}\.json"
)
SIGNATURE_NAME_RE = re.compile(r"[1-9][0-9]{0,15}\.json")
SIGNATURE_PATH_RE = re.compile(r"signatures/individual/([1-9][0-9]{0,15})\.(?:json|tsr)")
# GitHub lists at most 250 commits of a pull request; with more, not every author can be known.
MAX_COMMITS = 250
#: GitHub's largest page, and how many of a list are read before it is too long to be what it is.
PAGE_SIZE = 100
MAX_PAGES = 50
#: GitHub lists at most 1000 files of a directory, and does not say that it left some out.
SIGNATURE_LIST_LIMIT = 1000
#: The largest integer JavaScript reads exactly, which is the largest the Worker takes.
MAX_INT = 2**53 - 1
HEX64_RE = re.compile(r"[0-9a-f]{64}")
PR_URL_RE = re.compile(
    r"https://github\.com/([A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]{0,9})"
)
RECORD_WORKFLOW_PATH = ".github/workflows/record.yml"
GITHUB_COMMITTER_EMAIL = "noreply@github.com"
HEX40_RE = re.compile(r"[0-9a-f]{40}")
CLIENT_ID_RE = re.compile(r"[A-Za-z0-9.]{16,40}")
LANGS = ("en", "es")
#: How long before the recorder's check a sign-in may have been authorized:
#: the Worker's session lasts one hour, so anything older was not this signing.
SIGNIN_MAX_AGE = dt.timedelta(hours=2)
#: ETSI EN 319 422 esi4-qtstStatement-1, DER-encoded: the TSA declares the token qualified (eIDAS).
QTST_STATEMENT_DER = bytes.fromhex("0607040081975e0101")
#: ETSI EN 319 421 best-practices-ts-policy.
QUALIFIED_POLICY = "0.4.0.2023.1.1"
#: How a service that cannot be reached, or goes away before its answer ends, shows: a refused or
#: cut connection, a time-out, a name that does not resolve, half an answer.
UNREACHABLE = (OSError, http.client.HTTPException)
#: Sectigo asks scripts to wait 15 s or more between time-stamp requests.
TSA_SPACING_S = 15


class Refused(Exception):
    """The input is not something the register records; nothing is written."""


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def now() -> str:
    return iso(utcnow())


def iso(d: dt.datetime) -> str:
    return f"{d.astimezone(dt.UTC).replace(tzinfo=None).isoformat(timespec='seconds')}Z"


def parse_time(s: Any) -> dt.datetime | None:
    """GitHub's ISO 8601 times (``Z`` or an offset, with or without fractions), as UTC."""
    if not isinstance(s, str):
        return None
    try:
        d = dt.datetime.fromisoformat(s)
        return d.astimezone(dt.UTC) if d.tzinfo else None
    except ValueError, OverflowError:
        return None


def parse_http_date(s: Any) -> dt.datetime | None:
    """An HTTP ``Date`` header (RFC 9110 IMF-fixdate), as UTC; None for what is none, or missing."""
    if not isinstance(s, str):
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
        return d.astimezone(dt.UTC) if d.tzinfo else None
    except ValueError, OverflowError:
        return None


def record_time(v: object) -> dt.datetime | None:
    """A time as a record holds it, YYYY-MM-DDTHH:MM:SSZ and a day that exists."""
    d = parse_time(v)
    return d if d is not None and iso(d) == v else None


# The characters either JavaScript's or Python's \s counts as white space,
# spelled out; worker/src/util.ts uses the same list (normalize-vectors.json
# is the shared test).
WHITESPACE = re.compile(
    "[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def normalize(s: str) -> str:
    """NFC, every run of white space collapsed to one space, trimmed."""
    return WHITESPACE.sub(" ", unicodedata.normalize("NFC", s)).strip(" ")


def _matches(v: object, pattern: re.Pattern[str]) -> TypeGuard[str]:
    """Whether a JSON value is a string of that form, all of it."""
    return isinstance(v, str) and pattern.fullmatch(v) is not None


def is_login(v: object) -> TypeGuard[str]:
    """Whether a JSON value is a login a person may have on GitHub (an app's ends in [bot])."""
    return _matches(v, LOGIN_RE)


def parse_json(data: bytes) -> Any:
    """What a JSON document in UTF-8 says; None for anything else, as for null."""
    try:
        return json.loads(data.decode("utf-8"))
    except ValueError, RecursionError:
        return None


def dig(data: Any, *keys: str) -> Any:
    """What a JSON value holds at these keys, one object inside the other; None for nothing."""
    for key in keys:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


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


#: Where the roots of the time-stamping services are pinned.
TSA_ROOTS = ROOT / "registry" / "tsa"


def pinned_roots(config: dict[str, Any]) -> list[Path]:
    """The time-stamping roots registry/config.json names, each a file of registry/tsa/.

    Resolved first, so that no absolute path, ``..`` or symbolic link makes
    a file kept anywhere else a trusted root."""
    roots = []
    for name in (config.get("timestamping") or {}).get("roots", []):
        path = (ROOT / name).resolve()
        if path.parent != TSA_ROOTS or not path.is_file():
            raise RuntimeError(f"{name!r} is not a root pinned in registry/tsa/")
        roots.append(path)
    return roots


def accepted_sentences(config: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in config["accepted_versions"]:
        info = config["versions"].get(str(v))
        if info:
            out[normalize(info["sentence"])] = v
    return out


def record_valid(config: dict[str, Any], rec: dict[str, Any]) -> bool:
    """Whether a record counts now: a version still accepted, with that version's digest."""
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


#: A transport answers the status, the body and the headers, their names in lower case.
type Transport = Callable[
    [str, str, dict[str, str], bytes | None],
    tuple[int, bytes, dict[str, str]],
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
        return e.code, e.read(), {k.lower(): v for k, v in e.headers.items()}


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
        return self.transport(method, f"{self.api}{path}", headers, data)

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        """The status and the JSON of an answer; None when it is not JSON (a proxy's error page)."""
        status, payload, _ = self.exchange(method, path, body)
        return status, parse_json(payload)

    def file(self, repo: str, path: str, ref: str) -> bytes | None:
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

    def _get(self, path: str) -> Any:
        status, data = self.call("GET", path)
        if status != 200:
            raise RuntimeError(f"GET {path.split('?')[0]} answered {status}")
        return data

    def get(self, path: str) -> dict[str, Any]:
        data = self._get(path)
        if not isinstance(data, dict):
            raise RuntimeError(f"GET {path.split('?')[0]} answered no object")
        return data

    def get_list(self, path: str) -> list[dict[str, Any]]:
        data = self._get(path)
        if not isinstance(data, list) or not all(isinstance(x, dict) for x in data):
            raise RuntimeError(f"GET {path.split('?')[0]} answered no list of objects")
        return data

    def pages(self, path: str) -> Iterator[dict[str, Any]]:
        """Every object of a list GitHub gives in pages, each page asked for when it is needed."""
        for page in range(1, MAX_PAGES + 1):
            found = self.get_list(f"{path}&per_page={PAGE_SIZE}&page={page}")
            yield from found
            if len(found) < PAGE_SIZE:
                return
        raise RuntimeError(f"GET {path.split('?')[0]} has more than {MAX_PAGES} pages")

    def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        status, answer = self.call("POST", "/graphql", {"query": query, "variables": variables})
        data, errors = dig(answer, "data"), dig(answer, "errors")
        if status != 200 or errors or not isinstance(data, dict):
            types = [dig(e, "type") for e in errors] if isinstance(errors, list) else errors
            raise RuntimeError(f"GraphQL answered {status}: {types}")
        return data


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


def commit_files(
    gh: GitHub,
    registry: str,
    additions: dict[str, bytes],
    deletions: list[str],
    headline: str,
    attempts: int = 5,
) -> str:
    """Adds, changes or deletes the files of one record in one commit GitHub signs.

    The files are a record's JSON and its time-stamp token. Tried again when the branch moved
    between the read and the write, and when GitHub's answer says nothing: a commit whose answer was
    lost is on the branch by then, so it is found there and not made a second time."""
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            head = _head(gh, registry)
            if attempt and _holds(gh, registry, head, additions, deletions):
                return head
            return _commit(gh, registry, head, additions, deletions, headline)
        except (RuntimeError, *UNREACHABLE) as e:
            last = e
    raise RuntimeError(f"could not commit {', '.join(additions)}: {last}")


def _head(gh: GitHub, registry: str) -> str:
    owner, name = registry.split("/")
    head = dig(
        gh.graphql(HEAD_QUERY, {"owner": owner, "name": name, "ref": f"refs/heads/{BRANCH}"}),
        *("repository", "ref", "target", "oid"),
    )
    if not isinstance(head, str):
        raise RuntimeError(f"the branch {BRANCH} does not exist")
    return head


def _holds(
    gh: GitHub, registry: str, head: str, additions: dict[str, bytes], deletions: list[str]
) -> bool:
    """Whether that commit has the files already: their bytes are this run's and no other's."""
    return all(gh.file(registry, p, head) == c for p, c in additions.items()) and all(
        gh.file(registry, p, head) is None for p in deletions
    )


def _commit(
    gh: GitHub,
    registry: str,
    head: str,
    additions: dict[str, bytes],
    deletions: list[str],
    headline: str,
) -> str:
    changes: dict[str, Any] = {
        "additions": [
            {"path": p, "contents": base64.b64encode(c).decode("ascii")}
            for p, c in additions.items()
        ]
    }
    if deletions:
        changes["deletions"] = [{"path": p} for p in deletions]
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
    oid = dig(out, "createCommitOnBranch", "commit", "oid")
    if not isinstance(oid, str):
        raise RuntimeError("createCommitOnBranch answered no commit id")
    return oid


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
    with tempfile.NamedTemporaryFile() as f:
        f.write(tsr)
        f.flush()
        out = _openssl(["ts", "-reply", "-in", f.name, "-text"])
    return out.stdout if out.returncode == 0 else None


TSR_TIME_RE = re.compile(
    r"^Time stamp: ([A-Z][a-z]{2} [ 0-9][0-9] [0-9:]{8})(?:\.[0-9]+)? ([0-9]{4}) GMT$", re.M
)


def tsr_time(text: str) -> dt.datetime | None:
    """The second a token states, whatever fraction of it an authority adds."""
    m = TSR_TIME_RE.search(text)
    if m is None:
        return None
    try:
        return dt.datetime.strptime(f"{m[1]} {m[2]} +0000", "%b %d %H:%M:%S %Y %z")
    except ValueError:
        return None


def verify_tsr(
    tsr: bytes, digest_hex: str, roots: list[Path], qualified: bool, query: bytes | None = None
) -> str | None:
    """None when a time-stamp response verifies.

    That is: it is granted, it is over ``digest_hex`` (and the query's
    nonce), and its signature chains to one of ``roots`` (``pinned_roots``)
    at the time it states.

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
        not re.search(rf"^Policy OID: {re.escape(QUALIFIED_POLICY)}$", text, re.M)
        or QTST_STATEMENT_DER not in tsr
    ):
        return "the time-stamp token is not a qualified one"
    with tempfile.NamedTemporaryFile() as response, tempfile.NamedTemporaryFile() as request:
        response.write(tsr)
        response.flush()
        args = ["ts", "-verify", "-in", response.name, "-attime", str(int(when.timestamp()))]
        if query is not None:
            request.write(query)
            request.flush()
            args += ["-queryfile", request.name]
        else:
            args += ["-digest", digest_hex]
        for root in roots:
            out = _openssl([*args, "-CAfile", str(root)])
            if out.returncode == 0 and "Verification: OK" in out.stdout:
                return None
    return "the time-stamp token does not verify"


class Stamper(Protocol):
    """Asks a time-stamping authority for a token over a digest; tests give their own."""

    def stamp(self, digest_hex: str) -> bytes | None:
        """The token over a SHA-256 digest, None when the authority gave none that verifies."""


@dataclass
class TSAStamper:
    """RFC 3161 over HTTP. Two tries, ``TSA_SPACING_S`` apart; None without a verified token."""

    url: str
    roots: list[Path]
    qualified: bool
    transport: Transport = tsa_transport
    sleep: Callable[[float], None] = time.sleep
    #: When the authority was last asked (time.monotonic); never, before the first time.
    last: float = -math.inf

    @classmethod
    def from_config(cls, config: dict[str, Any], **kw: Any) -> TSAStamper | None:
        ts = config.get("timestamping")
        if not isinstance(ts, dict) or not ts.get("url"):
            return None
        return cls(ts["url"], pinned_roots(config), bool(ts.get("qualified")), **kw)

    def stamp(self, digest_hex: str) -> bytes | None:
        for attempt in range(2):
            wait = TSA_SPACING_S - (time.monotonic() - self.last)
            if wait > 0:
                self.sleep(wait)
            query = timestamp_query(digest_hex, secrets.randbits(63) | 1)
            self.last = time.monotonic()
            try:
                status, body, _ = self.transport(
                    "POST",
                    self.url,
                    {
                        "content-type": "application/timestamp-query",
                        "user-agent": "kleidos-cla-recorder",
                    },
                    query,
                )
            except UNREACHABLE as e:
                print(
                    f"time-stamp attempt {attempt + 1}: the authority cannot be reached "
                    f"({type(e).__name__})",
                    file=sys.stderr,
                )
                continue
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
    if not REPO_RE.fullmatch(repo) or repo not in ctx.config["served_repositories"]:
        raise Refused(f"{repo} is not a served repository")
    if ctx.gh.get(f"/repos/{repo}").get("private") is not False:
        raise Refused(f"{repo} is not public")


def existing_record(ctx: Context, gid: int) -> dict[str, Any] | None:
    content = ctx.gh.file(ctx.registry, f"signatures/individual/{gid}.json", BRANCH)
    if content is None:
        return None
    record = parse_json(content)
    if not isinstance(record, dict):
        raise RuntimeError(f"the record of account {gid} is not a JSON object")
    return record


def record_bytes(ctx: Context, path: str, record: dict[str, Any]) -> bytes:
    """The file of a record, once the verifier's own check has passed over it.

    The register only grows, so nothing that check refuses is ever written to it."""
    content = (json.dumps(record, indent=2) + "\n").encode("utf-8")
    problem = check_record(ctx.config, path, content)
    if problem is not None:
        raise RuntimeError(f"not written, the verifier would refuse it: {problem}")
    return content


def write_signature(
    ctx: Context, gid: int, record: dict[str, Any], replacing: bool, headline: str
) -> str:
    """One commit with the record and, when the authority answered, its time-stamp token.

    The token is over the SHA-256 of the file's bytes.

    A replaced record's old token no longer matches, so it goes in the same
    commit when no new one came back."""
    path = f"signatures/individual/{gid}.json"
    tsr_path = f"signatures/individual/{gid}.tsr"
    content = record_bytes(ctx, path, record)
    token = ctx.stamper.stamp(sha256(content)) if ctx.stamper else None
    additions = {path: content}
    deletions: list[str] = []
    if token:
        additions[tsr_path] = token
    elif replacing and ctx.gh.file(ctx.registry, tsr_path, BRANCH) is not None:
        deletions.append(tsr_path)
    oid = commit_files(ctx.gh, ctx.registry, additions, deletions, headline)
    return f"recorded in {oid}" + ("" if token else " (no time-stamp token yet)")


def redacted_after(ctx: Context, gid: int, accepted: dt.datetime) -> None:
    """Refuses a comment older than the owner's removal of that account's entry.

    The removal was asked for after that comment was written, so the comment
    cannot bring the entry back: only a new acceptance can. Without this the
    Worker's cron, which re-dispatches the acceptance comments of open pull
    requests, would write the entry again (registry/README.md, "Removal"). A
    removal whose time GitHub does not say counts as later than any comment."""
    path = f"signatures/individual/{gid}.json"
    for c in ctx.gh.pages(f"/repos/{ctx.registry}/commits?sha={BRANCH}&path={path}"):
        if dig(c, "author", "id") != OWNER_ID:
            continue
        if not str(dig(c, "commit", "message")).startswith("redact:"):
            continue
        removed = parse_time(dig(c, "commit", "committer", "date"))
        if removed is None or accepted <= removed:
            raise Refused("this account's entry was removed at its request after that comment")


def record_sign(ctx: Context, repo: str, pr: int, comment_id: int) -> str:
    """Records one genuine, unedited acceptance by the account that wrote it."""
    served(ctx, repo)
    rest = ctx.gh.get(f"/repos/{repo}/issues/comments/{comment_id}")
    node = ctx.gh.graphql(COMMENT_QUERY, {"id": rest.get("node_id")}).get("node")
    if not node:
        raise Refused("comment not found")
    if node.get("lastEditedAt") or node.get("editor"):
        raise Refused("the comment was edited")
    if (
        dig(node, "pullRequest", "number") != pr
        or dig(node, "pullRequest", "repository", "nameWithOwner") != repo
    ):
        raise Refused("the comment is not on that pull request")
    gid, login = dig(node, "author", "databaseId"), dig(node, "author", "login")
    if not _pos_int(gid) or dig(rest, "user", "type") != "User" or not is_login(login):
        raise Refused("the author is not a personal account")
    body, created = node.get("body"), record_time(node.get("createdAt"))
    if not isinstance(body, str) or created is None:
        raise RuntimeError("GitHub's answer has no usable body or createdAt")
    version = accepted_sentences(ctx.config).get(normalize(body))
    if version is None:
        raise Refused("the comment is not the acceptance sentence of an accepted version")
    previous = existing_record(ctx, gid)
    if previous and record_valid(ctx.config, previous) and previous["version"] >= version:
        return "already recorded"
    app_id = ctx.config.get("app_id")
    web = app_id is not None and dig(rest, "performed_via_github_app", "id") == app_id
    # The sign page never posts the sentence of a version signed by signing in: one posted
    # through the bot's app is somebody acting in the signer's name, which that version says
    # does not happen. Typed by hand it is the version's own fallback.
    if web and ctx.config["versions"][str(version)].get("flow") == "signin":
        raise Refused(
            f"version {version} is not posted through the app, it is signed by signing in"
        )
    if previous is None:
        redacted_after(ctx, gid, created)
    record = {
        "schema": 1,
        "kind": "individual",
        "github_id": gid,
        "login_at_signing": login,
        "agreement": ctx.config["agreement"],
        "version": version,
        "set_sha256": ctx.config["versions"][str(version)]["set_sha256"],
        "accepted_at": iso(created),
        # Posted through the app (the sign page) or typed by hand; told by the app's numeric id,
        # never its slug.
        "method": "web" if web else "comment",
        "evidence": {
            "pr_url": f"https://github.com/{repo}/pull/{pr}",
            "comment_url": f"https://github.com/{repo}/pull/{pr}#issuecomment-{comment_id}",
            "comment_id": comment_id,
            "comment_body_sha256": sha256(body),
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

    Every token of it dies, and GitHub asks again next time. A grant that
    cannot be deleted is said and nothing else: what was recorded or refused
    stands."""
    try:
        status, _, _ = gh.exchange(
            "DELETE",
            f"/applications/{app.client_id}/grant",
            {"access_token": token},
            basic=(app.client_id, app.client_secret),
        )
    except UNREACHABLE as e:
        print(
            f"sign-in grant not deleted: GitHub cannot be reached ({type(e).__name__})",
            file=sys.stderr,
        )
        return
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
    gid: int | None,
    version: int | None,
    lang: str | None,
    site_commit: str | None,
    token: str,
) -> str:
    """Records the acceptance the Worker reports for ``gid``, once GitHub vouches for the token.

    GitHub must say the token is that account's sign-in with our app.

    "Check a token" (POST /applications/{client_id}/token, Basic with the
    app's own secret) is answered by GitHub, not by the Worker: a Worker
    that lies can only record an account that authorized the sign-in app
    and whose authorization was not deleted since. The acceptance time is
    GitHub's Date of that answer, the authorization time its created_at.
    The grant is deleted whatever happens, so the token dies within seconds
    of the recording. An account already recorded for that version is
    answered before the token is checked: a re-run of a run that recorded
    it carries the same token, revoked by then, and must stay green."""
    try:
        if not _pos_int(gid):
            raise Refused("no account id")
        served(ctx, repo)
        if not _matches(site_commit, HEX40_RE):
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
        if configured != app.client_id or not _matches(configured, CLIENT_ID_RE):
            raise Refused("the sign-in app is not the one registry/config.json names")
        pull = ctx.gh.get(f"/repos/{repo}/pulls/{pr}")
        if pull.get("number") != pr:
            raise Refused("no such pull request")
        previous = existing_record(ctx, gid)
        if previous and record_valid(ctx.config, previous) and previous["version"] >= version:
            return "already recorded"
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
        answer = parse_json(body)
        accepted = parse_http_date(headers.get("date"))
        authorized = parse_time(dig(answer, "created_at"))
        if accepted is None or authorized is None:
            raise RuntimeError("GitHub's answer has no usable Date or created_at")
        if dig(answer, "app", "client_id") != app.client_id:
            raise Refused("the token belongs to another app")
        login = dig(answer, "user", "login")
        if dig(answer, "user", "type") != "User" or not is_login(login):
            raise Refused("the token is not a personal account's")
        if not _int(dig(answer, "user", "id"), gid):
            raise Refused("the token belongs to another account than the one reported")
        if not (accepted - SIGNIN_MAX_AGE <= authorized <= accepted + dt.timedelta(minutes=1)):
            raise Refused("the sign-in is not recent")
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
            "recorded_at": iso(max(utcnow(), accepted)),
            "recorder_run_id": ctx.run_id,
            "recorder_commit": ctx.commit,
        }
        if not HEX40_RE.fullmatch(ctx.commit):
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
    if len(listing) >= SIGNATURE_LIST_LIMIT:
        raise Refused(f"GitHub lists {SIGNATURE_LIST_LIMIT} files at most, so some may be missing")
    names = {dig(e, "name") for e in listing if dig(e, "type") == "file"}
    todo = sorted(
        int(n[:-5])
        for n in names
        if _matches(n, SIGNATURE_NAME_RE) and f"{n[:-5]}.tsr" not in names
    )
    done = 0
    for gid in todo[:limit]:
        path = f"signatures/individual/{gid}.json"
        content = ctx.gh.file(ctx.registry, path, BRANCH)
        if content is None or check_record(ctx.config, path, content) is not None:
            continue
        last = ctx.gh.get_list(f"/repos/{ctx.registry}/commits?sha={BRANCH}&path={path}&per_page=1")
        c = next(iter(last), None)
        if (
            dig(c, "author", "id") != ACTIONS_BOT_ID
            or dig(c, "committer", "login") != "web-flow"
            or dig(c, "commit", "verification", "verified") is not True
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


def parse_noreply(email: object) -> tuple[int, str] | None:
    """The account ``<id>+<login>@users.noreply.github.com``, GitHub's own address, names.

    None for anything GitHub could not have written: no such id, no such login, a blank more."""
    m = NOREPLY_RE.fullmatch(email) if isinstance(email, str) else None
    if m is None or not is_login(m[2].removesuffix(BOT_SUFFIX)):
        return None
    return int(m[1]), m[2]


def trailer_emails(message: str) -> list[str]:
    """The emails of the ``Co-authored-by:`` trailers of a commit message, lower-cased.

    Anybody writes a commit message, so each line is read once, with no backtracking. Git ends a
    line at a line feed alone and JavaScript at three more characters: a trailer that either reading
    has counts. worker/src/authors.ts coAuthorEmails does the same (tests/vectors/authors.json)."""
    emails = _trailers(LINE_END_RE.split(message))
    return emails + [e for e in _trailers(message.split("\n")) if e not in emails]


def _trailers(lines: list[str]) -> list[str]:
    emails = []
    for line in lines:
        if line[: len(TRAILER_KEY)].lower() != TRAILER_KEY:
            continue
        _name, bracket, address = line[len(TRAILER_KEY) :].rstrip(" \t").rpartition("<")
        email = address.removesuffix(">")
        if bracket and email != address and TRAILER_EMAIL_RE.fullmatch(email):
            emails.append(email.lower())
    return emails


#: An account that wrote part of a pull request: its id, its login and its type.
type Account = tuple[int, str, str]


def noreply_account(email: object) -> Account | None:
    """The account a no-reply address names, and its type."""
    found = parse_noreply(email)
    if found is None:
        return None
    return *found, "Bot" if found[1].endswith(BOT_SUFFIX) else "User"


def commit_authors(c: dict[str, Any]) -> tuple[list[Account], int]:
    """The accounts that wrote one commit, and how many of its authors could not be identified.

    Its author and co-authors as GitHub resolves them, and the trailers GitHub did not list.
    worker/src/authors.ts commitAuthors does the same (tests/vectors/authors.json)."""
    accounts: list[Account] = []
    unknown = 0
    listed = set()
    for a in c["authors"]["nodes"]:
        if isinstance(a.get("email"), str):
            listed.add(a["email"].lower())
        u = a.get("user") or {}
        if _pos_int(u.get("databaseId")) and is_login(u.get("login")):
            accounts.append((u["databaseId"], u["login"], "User"))
        elif account := noreply_account(a.get("email")):
            accounts.append(account)
        else:
            unknown += 1
    if c["authors"]["totalCount"] > len(c["authors"]["nodes"]):
        unknown += 1
    for address in trailer_emails(c["message"]):
        if address in listed:
            continue
        if account := noreply_account(address):
            accounts.append(account)
        else:
            unknown += 1
    return accounts, unknown


def pr_authors(
    ctx: Context, repo: str, pr: dict[str, Any]
) -> tuple[dict[int, tuple[str, list[str]]], int]:
    """The Worker's rule, written again: opener, commit authors and co-authors (id → type, dates);
    and how many could not be identified.
    """
    owner, name = repo.split("/")
    people: dict[int, tuple[str, list[str]]] = {}
    unknown = 0

    def add(gid: int, kind: str, date: str) -> None:
        people.setdefault(gid, (kind, []))[1].append(date)

    opener = dig(pr, "user", "id")
    if not _pos_int(opener):
        raise RuntimeError("GitHub named no opener")
    # The opener is dated by the pull request's creation, as the Worker does (worker/src/assess.ts).
    add(opener, dig(pr, "user", "type"), pr["created_at"][:10])
    cursor = None
    seen = 0
    while True:
        page = ctx.gh.graphql(
            COMMITS_QUERY, {"owner": owner, "name": name, "number": pr["number"], "cursor": cursor}
        )
        commits = dig(page, "repository", "pullRequest", "commits")
        if not commits:
            raise RuntimeError("GitHub returned no commit list")
        if commits["totalCount"] > MAX_COMMITS:
            raise Refused("too many commits to check")
        for n in commits["nodes"]:
            c = n["commit"]
            seen += 1
            # Merge commits count like any other: a merge can carry changes of its own.
            accounts, unidentified = commit_authors(c)
            unknown += unidentified
            for gid, _login, kind in accounts:
                add(gid, kind, c["authoredDate"][:10])
        # An empty page ends the list too: a next page of it could be empty for ever.
        if not commits["pageInfo"]["hasNextPage"] or not commits["nodes"] or seen >= MAX_COMMITS:
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
    for gid, (kind, dates) in sorted(people.items()):
        if gid in exempt or all(covering_entity(ctx, gid, d) for d in dates):
            continue
        rec = existing_record(ctx, gid) if kind == "User" else None
        if rec is not None and record_valid(ctx.config, rec):
            ids.append(gid)
            versions[str(gid)] = rec["version"]
        else:
            missing.append(gid)
    if missing:
        raise Refused(
            f"merged without a signature from account id(s) {', '.join(map(str, missing))}"
        )
    path = f"coverage/{repo}/{number}.json"
    if ctx.gh.file(ctx.registry, path, BRANCH) is not None:
        return "already recorded"
    record = {
        "schema": 1,
        "kind": "coverage",
        "repo": repo,
        "pr": number,
        "merge_sha": pr.get("merge_commit_sha"),
        "merged_at": pr.get("merged_at"),
        "github_ids": ids,
        "versions": versions,
        "recorded_at": now(),
        "recorder_run_id": ctx.run_id,
    }
    oid = commit_files(
        ctx.gh,
        ctx.registry,
        {path: record_bytes(ctx, path, record)},
        [],
        f"coverage: {repo}#{number}",
    )
    return f"recorded in {oid}"


# --- verify -------------------------------------------------------------------


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True).stdout


def git_lines(root: Path, *args: str) -> list[str]:
    """What git says, line by line: a line feed ends a line and nothing else does, and bytes that
    are no text are shown."""
    return git(root, *args).decode("utf-8", "backslashreplace").split("\n")[:-1]


#: What a finding of no commit is about.
NO_COMMIT = "0" * 12


@dataclass
class Finding:
    commit: str
    problem: str

    def __str__(self) -> str:
        return f"{self.commit[:12]}: {self.problem}"


def _int(v: object, n: int) -> bool:
    """Whether a JSON value is exactly this integer: neither true nor 1.0 is 1."""
    return type(v) is int and v == n


def _pos_int(v: object) -> TypeGuard[int]:
    return type(v) is int and 0 < v <= MAX_INT


def check_record(config: dict[str, Any], path: str, content: bytes) -> str | None:
    """The shape of one record file (registry/schema/), checked field by field;
    worker/src/registry.ts isSignatureRecord does the same.
    """
    rec = parse_json(content)
    if not isinstance(rec, dict):
        return "not a JSON object"
    if not path.startswith("signatures/"):
        return check_coverage_record(path, rec)
    m = SIGNATURE_PATH_RE.fullmatch(path)
    if m is None or rec.get("kind") != "individual" or not _int(rec.get("github_id"), int(m[1])):
        return "the record does not match its path"
    if not record_published(config, rec):
        return "the version or digest is not a published one"
    if _int(rec.get("schema"), 2):
        return check_signin_record(config, rec)
    return check_comment_record(config, rec)


COMMENT_FIELDS = {
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
COMMENT_EVIDENCE = {"pr_url", "comment_url", "comment_id", "comment_body_sha256"}


def check_comment_record(config: dict[str, Any], rec: dict[str, Any]) -> str | None:
    """Schema 1: an acceptance comment, as registry/schema/individual.schema.json says."""
    if set(rec) != COMMENT_FIELDS:
        return f"unexpected or missing fields {sorted(set(rec) ^ COMMENT_FIELDS)}"
    ev = rec["evidence"]
    ok = (
        _int(rec["schema"], 1)
        and rec["agreement"] == config["agreement"]
        and rec["method"] in ("web", "comment")
        and (
            rec["method"] == "comment"
            or config["versions"][str(rec["version"])].get("flow") != "signin"
        )
        and is_login(rec["login_at_signing"])
        and record_time(rec["accepted_at"]) is not None
        and record_time(rec["recorded_at"]) is not None
        and _pos_int(rec["recorder_run_id"])
        and isinstance(ev, dict)
        and set(ev) == COMMENT_EVIDENCE
        and _matches(ev["pr_url"], PR_URL_RE)
        and _pos_int(ev["comment_id"])
        and ev["comment_url"] == f"{ev['pr_url']}#issuecomment-{ev['comment_id']}"
        and _matches(ev["comment_body_sha256"], HEX64_RE)
    )
    return None if ok else "malformed record"


COVERAGE_FIELDS = {
    "schema",
    "kind",
    "repo",
    "pr",
    "merge_sha",
    "merged_at",
    "github_ids",
    "versions",
    "recorded_at",
    "recorder_run_id",
}


def check_coverage_record(path: str, rec: dict[str, Any]) -> str | None:
    """The authors of one merged pull request, as registry/schema/coverage.schema.json says.

    The versions are those of exactly the accounts it lists."""
    _, owner, name, number = path.split("/")
    if (
        rec.get("kind") != "coverage"
        or rec.get("repo") != f"{owner}/{name}"
        or not _int(rec.get("pr"), int(number.removesuffix(".json")))
    ):
        return "the coverage record does not match its path"
    if set(rec) != COVERAGE_FIELDS:
        return f"unexpected or missing fields {sorted(set(rec) ^ COVERAGE_FIELDS)}"
    ids, versions = rec["github_ids"], rec["versions"]
    ok = (
        _int(rec["schema"], 1)
        and _matches(rec["merge_sha"], HEX40_RE)
        and record_time(rec["merged_at"]) is not None
        and record_time(rec["recorded_at"]) is not None
        and _pos_int(rec["recorder_run_id"])
        and isinstance(ids, list)
        and all(_pos_int(i) for i in ids)
        and len(set(ids)) == len(ids)
        and isinstance(versions, dict)
        and set(versions) == {str(i) for i in ids}
        and all(_pos_int(v) for v in versions.values())
    )
    return None if ok else "malformed record"


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
        and is_login(rec["login_at_signing"])
        and _pos_int(rec["recorder_run_id"])
        and _matches(rec["recorder_commit"], HEX40_RE)
        and isinstance(ev, dict)
        and set(ev) == SIGNIN_EVIDENCE
        and _matches(ev["signin_client_id"], CLIENT_ID_RE)
        and _matches(ev["context_pr_url"], PR_URL_RE)
        and _matches(ev["site_commit"], HEX40_RE)
        and ev["lang"] in LANGS
    )
    if not ok:
        return "malformed record"
    authorized = record_time(ev["authorized_at"])
    accepted = record_time(rec["accepted_at"])
    recorded = record_time(rec["recorded_at"])
    if authorized is None or accepted is None or recorded is None:
        return "malformed record"
    # Two of GitHub's clocks and the runner's: a minute of slack, as the recorder allows.
    slack = dt.timedelta(minutes=1)
    if not (
        authorized <= accepted + slack
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


class Witness(Protocol):
    """What the cross-checks read from GitHub; tests give their own."""

    def comment(self, repo: str, comment_id: int) -> dict[str, Any] | None:
        """The comment, as GitHub has it now; None when it is gone."""

    def run(self, run_id: int) -> dict[str, Any] | None:
        """The run of the recorder, as GitHub has it now; None when there is none."""


class Pending(Exception):
    """A record's recorder run has not finished yet: the check stops before it and the next run
    resumes there.
    """


def cross_check(
    config: dict[str, Any], registry: str, rec: dict[str, Any], witness: Witness
) -> str | None:
    """The evidence of a record check_record passed, re-read from GitHub: the acceptance comment it
    cites and the recorder run that wrote it.

    This is what a GitHub-signed github-actions[bot] commit made anywhere
    else (a fork's Actions, say) and pushed here cannot pass."""
    run_id = rec.get("recorder_run_id")
    if not _pos_int(run_id):
        return "no recorder run id"
    head_sha = None
    if rec["kind"] == "coverage":
        title = f"Record coverage {rec['repo']}#{rec['pr']}"
    elif rec["schema"] == 2:
        m = PR_URL_RE.fullmatch(rec["evidence"]["context_pr_url"])
        if m is None:
            return "the evidence's context_pr_url is not a pull request address"
        # A sign-in leaves nothing on GitHub to re-read (the token is revoked):
        # the run that checked it with GitHub, on this commit of main, is the
        # evidence.
        title = f"Record signin {m.group(1)}#{m.group(2)} {rec['github_id']}"
        head_sha = rec["recorder_commit"]
        if rec["evidence"]["signin_client_id"] not in signin_client_ids(config):
            return "signed in through an app registry/config.json does not name"
    else:
        m = PR_URL_RE.fullmatch(rec["evidence"]["pr_url"])
        if m is None:
            return "the evidence's pr_url is not a pull request address"
        repo, pr = m.group(1), int(m.group(2))
        cid = rec["evidence"]["comment_id"]
        title = f"Record sign {repo}#{pr} {cid}"
        c = witness.comment(repo, cid)
        if c is None:
            return f"the acceptance comment {cid} cannot be read"
        if c["author_id"] != rec["github_id"]:
            return "the acceptance comment was written by another account"
        if c["edited"]:
            return "the acceptance comment was edited"
        if c["created_at"] != rec["accepted_at"]:
            return "accepted_at is not the comment's creation time"
        if sha256(c["body"]) != rec["evidence"]["comment_body_sha256"]:
            return "the comment's text does not hash to comment_body_sha256"
        if (c["pr"], c["repo"]) != (pr, repo):
            return "the comment is not on the pull request the record names"
    run = witness.run(run_id)
    if run is None:
        return f"recorder run {run_id} is not a run of {registry}"
    if (
        dig(run, "repository", "full_name") != registry
        or run.get("path") != RECORD_WORKFLOW_PATH
        or run.get("event") != "workflow_dispatch"
        or run.get("head_branch") != "main"
    ):
        return f"run {run_id} is not {RECORD_WORKFLOW_PATH} dispatched on main of {registry}"
    if " ".join(str(run.get("display_title")).split()) != title:
        return f"run {run_id} recorded something else"
    if head_sha is not None and run.get("head_sha") != head_sha:
        return f"run {run_id} did not run the commit the record names"
    if run.get("status") != "completed":
        raise Pending(run_id)
    if run.get("conclusion") != "success":
        return f"run {run_id} did not succeed"
    return None


def signin_client_ids(config: dict[str, Any]) -> set[str]:
    """The sign-in app of today and the ones it replaced: an entry signed through a replaced app
    stays checkable."""
    ids = {i for i in config.get("retired_signin_client_ids", []) if isinstance(i, str)}
    if isinstance(config.get("signin_client_id"), str):
        ids.add(config["signin_client_id"])
    return ids


type CommitInfo = Callable[[str], Facts | None]


#: What a commit did to one path, as git diff-tree --name-status says it: the status and the path.
type Change = tuple[str, str]


def change_shape(changes: list[Change]) -> str | None:
    """What a recorder commit may change.

    One coverage record, or one account's signature and its time-stamp token.

    The signature (A or M) with or without its token (A or M; D only when
    the signature is replaced without a new token), or the token alone (A,
    added later by the stamp run)."""
    if not changes:
        return "changes nothing"
    paths = {path: status for status, path in changes}
    for path, status in paths.items():
        if not RECORD_PATH_RE.fullmatch(path) or status not in ("A", "M", "D"):
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
    ids = {m.group(1) for p in paths if (m := SIGNATURE_PATH_RE.fullmatch(p))}
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
    return verify_tsr(token, sha256(record), pinned_roots(config), bool(ts.get("qualified")))


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
    own redact: commits, which only delete records, and the root aside).

    ``info(sha)`` answers, from GitHub, who authored and committed a commit
    and whether GitHub signed it: a name or an email in the git metadata
    proves nothing. The records of the commits after ``since`` are also
    cross-checked against the comment and the run they cite (``witness``)."""
    findings: list[Finding] = []
    log = git_lines(
        root, "log", "--reverse", "--format=%H%x00%P%x00%s%x00%an", "--end-of-options", ref, "--"
    )
    commits = [line.split("\x00") for line in log]
    shas = [c[0] for c in commits]
    checked: set[str] = set()
    if since:
        if since not in shas:
            return Verified(
                [Finding(since, "the previous head is no longer in the history (rewritten?)")], None
            )
        checked = set(shas[: shas.index(since) + 1])
    checked_through = since
    pending = False
    for i, (sha, parents, subject, author) in enumerate(commits):
        if len(parents.split()) > 1:
            findings.append(Finding(sha, "a merge commit: the history must be linear"))
        if i == 0:
            continue
        facts = info(sha)
        if facts is None:
            findings.append(Finding(sha, "GitHub does not know this commit on the branch"))
            continue
        owners = by_owner(facts) and subject.startswith("redact:")
        # A path with anything but plain characters is quoted, on one line.
        changes: list[Change] = [
            (status, path)
            for status, _, path in (
                line.partition("\t")
                for line in git_lines(
                    root,
                    *("-c", "core.quotePath=true", "diff-tree", "--no-commit-id", "--name-status"),
                    *("-r", sha),
                )
            )
        ]
        if owners:
            # A removal at its holder's request deletes; it never adds or changes an entry.
            for status, path in changes:
                if status != "D" or not RECORD_PATH_RE.fullmatch(path):
                    findings.append(
                        Finding(sha, f"{status} {path}: a redact: commit only deletes records")
                    )
        else:
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
            for status, path in changes:
                if (
                    status not in ("A", "M")
                    or not path.endswith(".json")
                    or not RECORD_PATH_RE.fullmatch(path)
                ):
                    continue
                content = git(root, "show", f"{sha}:{path}")
                problem = check_record(config, path, content)
                if problem:
                    findings.append(Finding(sha, f"{path}: {problem}"))
                elif witness is not None and sha not in checked and not pending:
                    try:
                        problem = cross_check(config, registry, json.loads(content), witness)
                    except Pending:
                        pending = True
                        problem = None
                    if problem:
                        findings.append(Finding(sha, f"{path}: {problem}"))
        # Every token on the branch after this commit, for the records it
        # touched, verifies over that record as it now is.
        for gid in sorted(
            {m.group(1) for _, path in changes if (m := SIGNATURE_PATH_RE.fullmatch(path))}
        ):
            problem = tsr_problem(root, config, sha, gid)
            if problem:
                findings.append(Finding(sha, f"signatures/individual/{gid}.tsr: {problem}"))
        if not pending:
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
    settled = iso(utcnow() - dt.timedelta(minutes=settle_minutes))
    for repo in config["served_repositories"]:
        for p in gh.pages(f"/repos/{repo}/pulls?state=closed&sort=updated&direction=desc"):
            # Merged is updated: what follows was merged before that date too.
            if str(p.get("updated_at")) < merged_since:
                break
            merged = p.get("merged_at")
            if not merged or merged < merged_since or merged > settled:
                continue
            if gh.file(registry, f"coverage/{repo}/{p['number']}.json", BRANCH) is None:
                sha = p.get("merge_commit_sha")
                findings.append(
                    Finding(
                        NO_COMMIT if sha is None else sha,
                        f"{repo}#{p['number']} was merged with no coverage record",
                    )
                )
    return findings


#: What ``verify --ref`` may name, and the full name git reads: a short one could also be a tag's,
#: which git would prefer.
REFS = {
    f"origin/{BRANCH}": f"refs/remotes/origin/{BRANCH}",
    BRANCH: f"refs/heads/{BRANCH}",
}
#: What ``verify --marker-out`` may name, and the file it writes.
MARKERS = {".verify/next": ROOT / ".verify" / "next"}


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
    v.add_argument("--ref", choices=tuple(REFS), default=f"origin/{BRANCH}")
    v.add_argument(
        "--marker-out",
        choices=tuple(MARKERS),
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
                token = signin_token_from_event()
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
                        args.github_id,
                        args.version,
                        args.lang,
                        args.site_commit,
                        token,
                    )
                )
            else:
                print(record_coverage(ctx, args.repo, args.pr))
        except Refused as e:
            print(f"refused: {e}", file=sys.stderr)
            return 3
        return 0

    marker = MARKERS[args.marker_out] if args.marker_out else None
    if marker and marker.resolve() != marker:
        ap.error(f"{args.marker_out} is reached through a symbolic link")
    facts = commit_facts(gh, registry, BRANCH)
    verified = verify_history(
        ROOT, config, REFS[args.ref], args.since, facts.get, GitHubWitness(gh, registry), registry
    )
    findings = verified.findings
    findings += verify_workflows(gh, registry)
    if args.merged_since:
        findings += verify_coverage(
            gh, config, registry, max(args.merged_since, config.get("coverage_from", ""))
        )
    if marker and verified.checked_through and not findings:
        marker.write_text(verified.checked_through + "\n", "utf-8")
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


TOKEN_RE = re.compile(r"gh[uo]_[A-Za-z0-9_]{20,255}")


def signin_token_from_event() -> str:
    """The sign-in token from the workflow_dispatch payload.

    Masked in the log before anything else; never on a command line or in
    the environment."""
    token = None
    with contextlib.suppress(KeyError, OSError):
        event = parse_json(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
        token = dig(event, "inputs", "signin_token")
    if not _matches(token, TOKEN_RE):
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
        page = gh.graphql(
            HISTORY_QUERY,
            {"owner": owner, "name": name, "ref": f"refs/heads/{branch}", "cursor": cursor},
        )
        hist = dig(page, "repository", "ref", "target", "history")
        if hist is None:
            raise RuntimeError(f"the branch {branch} does not exist")
        before = len(out)
        for n in hist["nodes"]:
            out[n["oid"]] = Facts(
                dig(n, "author", "user", "databaseId"),
                dig(n, "committer", "user", "databaseId"),
                str(dig(n, "committer", "email")).lower(),
                dig(n, "signature", "isValid") is True,
                dig(n, "signature", "wasSignedByGitHub") is True,
            )
        if not hist["pageInfo"]["hasNextPage"]:
            return out
        if len(out) == before:
            raise RuntimeError(f"GitHub's history of {branch} goes on with no commit in it")
        cursor = hist["pageInfo"]["endCursor"]


class GitHubWitness:
    def __init__(self, gh: GitHub, registry: str) -> None:
        self.gh = gh
        self.registry = registry

    def comment(self, repo: str, comment_id: int) -> dict[str, Any] | None:
        status, rest = self.gh.call("GET", f"/repos/{repo}/issues/comments/{comment_id}")
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"reading comment {comment_id} answered {status}")
        node = self.gh.graphql(COMMENT_QUERY, {"id": dig(rest, "node_id")}).get("node")
        return {
            "author_id": dig(node, "author", "databaseId"),
            "edited": bool(dig(node, "lastEditedAt") or dig(node, "editor")),
            "created_at": dig(node, "createdAt"),
            "body": str(dig(node, "body")),
            "pr": dig(node, "pullRequest", "number"),
            "repo": dig(node, "pullRequest", "repository", "nameWithOwner"),
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
            findings.append(Finding(NO_COMMIT, f"the workflow {wf} is {state}, not active"))
    return findings


if __name__ == "__main__":
    sys.exit(main())
