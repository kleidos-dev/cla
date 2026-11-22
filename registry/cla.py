#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""The register's own writer and its verifier, standard library only.

``record`` runs in ``record.yml`` (``workflow_dispatch``) with the
registry's ``GITHUB_TOKEN``, the only credential that can write the
``signatures`` branch. It trusts nothing the bot said: it re-reads from
GitHub the acceptance comment (``--kind sign``) or the merged pull request
(``--kind coverage``) and writes one file through ``createCommitOnBranch``,
so every record is a commit GitHub signs.

``verify`` runs in ``verify.yml`` on every push to ``signatures`` and
weekly: the history is linear, every commit adds or changes exactly one
record and is GitHub's (or the owner's ``redact:``/``entity:`` commit),
every record matches ``config.json``, and every pull request merged in a
served repository has its coverage file.

Usage::

    python3 -I registry/cla.py record --kind sign --repo OWNER/REPO --pr N --comment-id ID
    python3 -I registry/cla.py record --kind coverage --repo OWNER/REPO --pr N
    python3 -I registry/cla.py verify [--since SHA] [--merged-since YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
BRANCH = "signatures"
OWNER_ID = 28966312
OWNER_LOGIN = "jmrplens"
ACTIONS_BOT = "github-actions[bot]"
ACTIONS_BOT_ID = 41898282
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$")
NOREPLY_RE = re.compile(r"^(\d{1,12})\+([A-Za-z0-9-]{1,39}(?:\[bot\])?)@users\.noreply\.github\.com$", re.I)
TRAILER_RE = re.compile(r"^co-authored-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$", re.I | re.M)
RECORD_PATH_RE = re.compile(r"^(signatures/individual/[1-9]\d*\.json|coverage/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/[1-9]\d*\.json)$")
MAX_COMMITS = 1000


class Refused(Exception):
    """The input is not something the register records; nothing is written."""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize(s: str) -> str:
    """NFC, trimmed, every run of whitespace collapsed to one space."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s).strip())


def sha256(data: str | bytes) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def load_config(root: Path = ROOT) -> dict[str, Any]:
    return json.loads((root / "registry" / "config.json").read_text("utf-8"))


def load_entities(root: Path = ROOT) -> list[dict[str, Any]]:
    return json.loads((root / "registry" / "entities.json").read_text("utf-8")).get("entities", [])


def accepted_sentences(config: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in config["accepted_versions"]:
        info = config["versions"].get(str(v))
        if info:
            out[normalize(info["sentence"])] = v
    return out


def record_valid(config: dict[str, Any], rec: dict[str, Any] | None) -> bool:
    if not rec:
        return False
    info = config["versions"].get(str(rec.get("version")))
    return bool(info and rec.get("version") in config["accepted_versions"] and info["set_sha256"] == rec.get("set_sha256"))


# --- GitHub -----------------------------------------------------------------


Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:  # noqa: S310 (https only, built below)
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@dataclass
class GitHub:
    token: str
    api: str = "https://api.github.com"
    transport: Transport = urllib_transport

    def call(self, method: str, path: str, body: Any = None, raw: bool = False) -> tuple[int, Any]:
        headers = {
            "authorization": f"Bearer {self.token}",
            "accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "kleidos-cla-recorder",
        }
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        status, payload = self.transport(method, f"{self.api}{path}", headers, data)
        if raw:
            return status, payload.decode("utf-8") if status == 200 else None
        return status, json.loads(payload) if payload else None

    def get(self, path: str) -> Any:
        status, data = self.call("GET", path)
        if status != 200:
            raise RuntimeError(f"GET {path.split('?')[0]} answered {status}")
        return data

    def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        status, data = self.call("POST", "/graphql", {"query": query, "variables": variables})
        if status != 200 or data.get("errors"):
            raise RuntimeError(f"GraphQL answered {status}: {[e.get('type') for e in (data or {}).get('errors', [])]}")
        return data["data"]

    def file(self, repo: str, path: str, ref: str) -> str | None:
        status, text = self.call("GET", f"/repos/{repo}/contents/{path}?ref={ref}", raw=True)
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"reading {path} answered {status}")
        return text


COMMENT_QUERY = """query($id:ID!){node(id:$id){... on IssueComment{createdAt lastEditedAt body editor{login}
author{login ... on User{databaseId}} pullRequest{number repository{nameWithOwner}}}}}"""

HEAD_QUERY = """query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{oid}}}}"""

COMMIT_MUTATION = """mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid url}}}"""

COMMITS_QUERY = """query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid message authoredDate parents{totalCount}
authors(first:20){totalCount nodes{email user{databaseId login}}}}}}}}}"""


def commit_file(gh: GitHub, registry: str, path: str, content: str, headline: str, attempts: int = 5) -> str:
    """Adds or changes one file on the signatures branch, as a commit GitHub signs."""
    owner, name = registry.split("/")
    last = ""
    for _ in range(attempts):
        head = gh.graphql(HEAD_QUERY, {"owner": owner, "name": name, "ref": f"refs/heads/{BRANCH}"})["repository"]["ref"]["target"]["oid"]
        try:
            out = gh.graphql(
                COMMIT_MUTATION,
                {
                    "input": {
                        "branch": {"repositoryNameWithOwner": registry, "branchName": BRANCH},
                        "expectedHeadOid": head,
                        "message": {"headline": headline},
                        "fileChanges": {"additions": [{"path": path, "contents": base64.b64encode(content.encode("utf-8")).decode("ascii")}]},
                    }
                },
            )
            return out["createCommitOnBranch"]["commit"]["oid"]
        except RuntimeError as e:  # the branch moved between the read and the write
            last = str(e)
    raise RuntimeError(f"could not commit {path}: {last}")


@dataclass
class Context:
    gh: GitHub
    registry: str
    run_id: int
    config: dict[str, Any]
    entities: list[dict[str, Any]] = field(default_factory=list)


def served(ctx: Context, repo: str) -> None:
    if not REPO_RE.match(repo) or repo not in ctx.config["served_repositories"]:
        raise Refused(f"{repo} is not a served repository")
    if ctx.gh.get(f"/repos/{repo}").get("private"):
        raise Refused(f"{repo} is not public")


def existing_record(ctx: Context, gid: int) -> dict[str, Any] | None:
    text = ctx.gh.file(ctx.registry, f"signatures/individual/{gid}.json", BRANCH)
    return json.loads(text) if text else None


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
    if not isinstance(gid, int) or gid <= 0 or (rest.get("user") or {}).get("type") != "User" or not LOGIN_RE.match(login) or login.endswith("[bot]"):
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
        "method": "web" if via.get("slug") == "kleidos-cla" else "comment",
        "evidence": {
            "pr_url": f"https://github.com/{repo}/pull/{pr}",
            "comment_url": f"https://github.com/{repo}/pull/{pr}#issuecomment-{comment_id}",
            "comment_id": comment_id,
            "comment_body_sha256": sha256(node["body"]),
        },
        "recorded_at": now(),
        "recorder_run_id": ctx.run_id,
    }
    oid = commit_file(ctx.gh, ctx.registry, f"signatures/individual/{gid}.json", json.dumps(record, indent=2) + "\n", f"sign: {login} ({gid}) accepts version {version}")
    return f"recorded in {oid}"


def parse_noreply(email: str | None) -> tuple[int, str] | None:
    m = NOREPLY_RE.match((email or "").strip())
    return (int(m.group(1)), m.group(2)) if m else None


def pr_authors(ctx: Context, repo: str, pr: dict[str, Any]) -> tuple[dict[int, tuple[str, str, list[str]]], int]:
    """The Worker's rule, written again: opener, commit authors and co-authors (id → login, type, dates); and how many could not be identified."""
    owner, name = repo.split("/")
    people: dict[int, tuple[str, str, list[str]]] = {}
    unknown = 0

    def add(gid: int, login: str, kind: str, date: str) -> None:
        if gid in people:
            people[gid][2].append(date)
        else:
            people[gid] = (login, kind, [date])

    user = pr["user"]
    add(user["id"], user["login"], user.get("type", "User"), (pr.get("merged_at") or now())[:10])
    cursor = None
    seen = 0
    while True:
        page = ctx.gh.graphql(COMMITS_QUERY, {"owner": owner, "name": name, "number": pr["number"], "cursor": cursor})
        commits = page["repository"]["pullRequest"]["commits"]
        if commits["totalCount"] > MAX_COMMITS:
            raise Refused("too many commits to check")
        for n in commits["nodes"]:
            c = n["commit"]
            seen += 1
            if c["parents"]["totalCount"] > 1:
                continue
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
            break
        cursor = commits["pageInfo"]["endCursor"]
    return people, unknown


def covering_entity(ctx: Context, gid: int, date: str) -> bool:
    for e in ctx.entities:
        info = ctx.config["versions"].get(str(e.get("version")))
        if not info or e.get("version") not in ctx.config["accepted_versions"] or info["set_sha256"] != e.get("set_sha256"):
            continue
        for c in e.get("covered", []):
            if c["github_id"] == gid and c["from"] <= date and (not c.get("until") or date <= c["until"]):
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
        if not record_valid(ctx.config, rec):
            missing.append(gid)
            continue
        ids.append(gid)
        versions[str(gid)] = rec["version"]  # type: ignore[index]
    if missing:
        raise Refused(f"merged without a signature from account id(s) {', '.join(map(str, missing))}")
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
    oid = commit_file(ctx.gh, ctx.registry, path, json.dumps(record, indent=2) + "\n", f"coverage: {repo}#{number}")
    return f"recorded in {oid}"


# --- verify -------------------------------------------------------------------


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout


@dataclass
class Finding:
    commit: str
    problem: str

    def __str__(self) -> str:
        return f"{self.commit[:12]}: {self.problem}"


def check_record(config: dict[str, Any], path: str, text: str) -> str | None:
    try:
        rec = json.loads(text)
    except json.JSONDecodeError:
        return "not JSON"
    if path.startswith("signatures/"):
        gid = int(path.rsplit("/", 1)[1].split(".")[0])
        if rec.get("kind") != "individual" or rec.get("github_id") != gid:
            return "the record does not match its path"
        if not record_valid(config, rec):
            return "the version or digest is not an accepted one"
        if rec.get("method") not in ("web", "comment") or not LOGIN_RE.match(str(rec.get("login_at_signing", ""))):
            return "malformed record"
        allowed = {"schema", "kind", "github_id", "login_at_signing", "agreement", "version", "set_sha256", "accepted_at", "method", "evidence", "recorded_at", "recorder_run_id"}
        if set(rec) - allowed:
            return f"unexpected fields {sorted(set(rec) - allowed)}"
    else:
        parts = path.split("/")
        if rec.get("kind") != "coverage" or rec.get("repo") != f"{parts[1]}/{parts[2]}" or str(rec.get("pr")) != parts[3].split(".")[0]:
            return "the coverage record does not match its path"
    return None


CommitInfo = Callable[[str], tuple[bool, int | None]]


def verify_history(root: Path, config: dict[str, Any], ref: str, since: str | None, info: CommitInfo) -> list[Finding]:
    """Linear, one record per commit, each the recorder's verified commit (the owner's redact:/entity: commits and the root aside).

    ``info(sha)`` answers, from GitHub, whether the commit is verified and
    the numeric id of the account it is attributed to: a name in the git
    metadata proves nothing, GitHub's signature check does."""
    findings: list[Finding] = []
    log = git(root, "log", "--reverse", "--format=%H%x00%P%x00%an%x00%s", ref, "--").strip().splitlines()
    commits = [line.split("\x00") for line in log]
    start = 0
    if since:
        shas = [c[0] for c in commits]
        if since not in shas:
            return [Finding(since, "the previous head is no longer in the history (rewritten?)")]
        start = shas.index(since) + 1
    for i, (sha, parents, author, subject) in enumerate(commits):
        if len(parents.split()) > 1:
            findings.append(Finding(sha, "a merge commit: the history must be linear"))
        if i == 0 or i < start:
            continue
        verified, author_id = info(sha)
        owners = author_id == OWNER_ID and re.match(r"^(redact|entity):", subject)
        if not verified:
            findings.append(Finding(sha, "not a verified commit"))
        changes = [line.split("\t") for line in git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", sha).strip().splitlines()]
        if not owners:
            if author_id != ACTIONS_BOT_ID:
                findings.append(Finding(sha, f"made by {author!r}, not by the recorder"))
            if len(changes) != 1:
                findings.append(Finding(sha, f"changes {len(changes)} files, not one"))
            for status, *paths in changes:
                path = paths[-1]
                if status not in ("A", "M") or not RECORD_PATH_RE.match(path):
                    findings.append(Finding(sha, f"{status} {path}: only adding or changing one record is allowed"))
                    continue
                problem = check_record(config, path, git(root, "show", f"{sha}:{path}"))
                if problem:
                    findings.append(Finding(sha, f"{path}: {problem}"))
    return findings


def verify_coverage(gh: GitHub, config: dict[str, Any], registry: str, merged_since: str) -> list[Finding]:
    """Every pull request merged in a served repository since a date has its coverage file."""
    findings: list[Finding] = []
    for repo in config["served_repositories"]:
        owner, name = repo.split("/")
        pulls = gh.get(f"/repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100")
        for p in pulls:
            if p.get("merged_at") and p["merged_at"][:10] >= merged_since:
                if gh.file(registry, f"coverage/{owner}/{name}/{p['number']}.json", BRANCH) is None:
                    findings.append(Finding(p.get("merge_commit_sha") or "0" * 12, f"{repo}#{p['number']} was merged with no coverage record"))
    return findings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--kind", choices=["sign", "coverage"], required=True)
    r.add_argument("--repo", required=True)
    r.add_argument("--pr", type=int, required=True)
    r.add_argument("--comment-id", type=int)
    v = sub.add_parser("verify")
    v.add_argument("--since")
    v.add_argument("--merged-since")
    v.add_argument("--ref", default=f"origin/{BRANCH}")
    args = ap.parse_args(argv)

    token = os.environ.get("GITHUB_TOKEN", "")
    registry = os.environ.get("GITHUB_REPOSITORY", "kleidos-dev/cla")
    gh = GitHub(token, os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    config = load_config()
    if args.cmd == "record":
        ctx = Context(gh, registry, int(os.environ.get("GITHUB_RUN_ID", "1")), config, load_entities())
        try:
            if args.kind == "sign":
                if not args.comment_id:
                    raise Refused("--comment-id is required")
                print(record_sign(ctx, args.repo, args.pr, args.comment_id))
            else:
                print(record_coverage(ctx, args.repo, args.pr))
        except Refused as e:
            print(f"refused: {e}", file=sys.stderr)
            return 3
        return 0

    def info(sha: str) -> tuple[bool, int | None]:
        c = gh.get(f"/repos/{registry}/commits/{sha}")
        return bool(c["commit"]["verification"]["verified"]), (c.get("author") or {}).get("id")

    findings = verify_history(ROOT, config, args.ref, args.since, info)
    if args.merged_since:
        findings += verify_coverage(gh, config, registry, max(args.merged_since, config.get("coverage_from", "")))
    for f in findings:
        print(f"problem: {f}")
    print(f"verify: {len(findings)} problem(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
