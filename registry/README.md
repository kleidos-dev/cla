<!--
SPDX-FileCopyrightText: 2026 José M. Requena Plens
SPDX-License-Identifier: MIT
-->

# The register

| Where | What | Written by |
| --- | --- | --- |
| `registry/config.json` (main) | The current and accepted versions with their digests and sentences, the served repositories with `auto_approve`, the exempt accounts by numeric id, and `coverage_from`. Read by the bot (cached 60 s) and by the recorder. Schema: `schema/config.schema.json`. | The owner, signed commits |
| `registry/entities.json` (main) | Organizations that signed the entity version: name, version, digest, date, the account ids they cover with start and end dates. Schema: `schema/entities.schema.json`. | The owner, signed commits with an `entity:` subject |
| `signatures/individual/<github id>.json` (branch `signatures`) | One signature per account. Schema: `schema/individual.schema.json`. | `record.yml` only |
| `coverage/<owner>/<repo>/<number>.json` (branch `signatures`) | The authors of one merged pull request and the version each had accepted. Schema: `schema/coverage.schema.json`. | `record.yml` only |

`cla.py record` runs in `record.yml` with the repository's own `GITHUB_TOKEN`. For a signature it re-reads the comment from GitHub and refuses it if it was edited, is not on the pull request it names, was not written by a personal account, or, after Unicode NFC and whitespace collapsing (the same explicit list of white-space characters as the Worker, tested against `tests/normalize-vectors.json` on both sides), is not exactly the sentence of an accepted version; an existing record for the same or a later version is success without a commit. The record's `method` is `web` when the comment was posted through the app whose numeric id is `app_id`, and `comment` otherwise. For coverage it works out the authors of the merged pull request itself, by the same rule as the bot (opener dated by the pull request's creation, every commit author and `Co-authored-by:` co-author, merge commits included, less the exempt and the entity-covered), and writes nothing, opening an issue instead, if any of them has no signature or GitHub lists fewer commits than the pull request has (it lists 250 at most). Every write is one file in one `createCommitOnBranch` commit, which GitHub signs. Each target (kind, repository, pull request, comment) has its own concurrency group, so a burst of signatures never cancels a recording; runs for different targets retry when the branch moved under them. Only a refusal (exit 3) opens an issue; any other failure is left to the next dispatch, and the Worker's cron re-dispatches the coverage of a pull request merged in the last week that has none.

`cla.py verify` runs in `verify.yml` after every recorder run and weekly. It fails, and opens an issue, if the `signatures` branch is not linear; if a commit adds or changes more or less than one record, deletes one, or touches another path; if a commit is not the recorder's (authored by `github-actions[bot]`, committed by GitHub and carrying GitHub's valid signature, as GitHub reports it, never as the git metadata says), the owner's own signed `redact:` and `entity:` commits excepted; if a record does not have the schema's exact shape (times as `YYYY-MM-DDTHH:MM:SSZ`, evidence addresses by pattern, integer ids) or names a version or digest that was never published; if a record added since the last clean run does not cite an existing, unedited acceptance comment by the same account, with the same text hash and creation time, and the successful `record.yml` run on `main` of this repository that recorded exactly that comment (what a GitHub-signed commit minted anywhere else cannot pass); if `record.yml` or `verify.yml` is not enabled; or if a pull request merged in a served repository since `coverage_from`, more than an hour ago, has no coverage file. The commit facts cost one GraphQL query per 100 commits; the cross-checks run only on the records added since the last clean run, whose head is kept in the Actions cache.

The Worker applies the same shape check and requires the last commit of a record to be the recorder's before the record counts, so a file pushed to `signatures` by anybody else never turns a check green.

## Serving a repository

A repository is served once it is listed in `served_repositories`. Its `auto_approve` lets the app approve the held fork runs of a pull request whose authors have all signed, unless the head commit changes `.github/` or a held run's jobs name a label other than GitHub's standard hosted runners (`ubuntu-*`, `windows-*`, `macos-*`). **Never set `auto_approve` to true on a repository whose workflows can reach a self-hosted runner** (the bench hosts, say): signing is not a trust signal, and the `.github/` rule does not cover the scripts and build files a workflow runs from the pull request. The job check is a second line only: GitHub may not list the jobs of a run that is waiting for approval.

## A new version of the agreement

1. Add `agreements/vN/` and its entry under `versions` (the digest, the files, the sentence), add `N` to `accepted_versions`, set `current_version` to `N`, and deploy a Worker built with the new texts.
2. Once that is live, drop the old version from `accepted_versions` if everyone must sign again. Its records stay valid history: the verifier checks every record against `versions` (everything ever published), and only the bot and the recorder's coverage use `accepted_versions` to decide what counts now.

Removal at a signer's request (GDPR art. 17, within the limits of art. 17.3(e)) is an owner's commit with a `redact:` subject.
