<!--
SPDX-FileCopyrightText: 2026 José M. Requena Plens
SPDX-License-Identifier: MIT
-->

# AGENTS.md — cla

Rules for any agent changing this repository. [README.md](README.md) says how signing works for a contributor, [CONTRIBUTING.md](CONTRIBUTING.md) the rules for a pull request here, and [registry/README.md](registry/README.md) how the register is written, checked and corrected.

## What this repository is

The Kleidos Contributor Agreement, its public register, and the bot that collects acceptances at cla.kleidos.dev. Every contributor to any Kleidos repository accepts the agreement once; the `📝 CLA` check of the served repositories comes from here. The repository is public. Its own code, the Addendum, the notices and the configuration are MIT; the Contributor Agreements 1.2 templates are third-party text under CC BY-SA 4.0, the mark and button drawings are the brand's GPL-3.0-or-later artwork, the fonts are OFL-1.1 and the pinned time-stamping root is Sectigo's: `REUSE.toml` says which file is which. Legal texts, personal data of signers (GitHub account ids and logins), OAuth tokens and GitHub App secrets are the normal subject matter here: work on them is ordinary, and it is held to the rules below because a mistake can forge, lose or expose a signature. Nothing here is legal advice, and no agent gives any.

## What is where

- `agreements/v1/`, `agreements/v2/`: one folder per published version. `individual.md` and `entity.md` are the templates as the contributoragreements.org chooser generated them; `addendum.md` is the Kleidos Addendum; the `.es.md` files are informative Spanish translations and summaries; `SHA256SUMS` lists the three binding texts, and its own SHA-256 is the version's set digest. The Worker serves these files byte for byte, which is why the Addendums and the privacy notices carry no header and are stated in `REUSE.toml`.
- `registry/config.json`: the published versions (digest, files, acceptance sentence, `flow`), `current_version` and `accepted_versions`, the served repositories and their `auto_approve`, the exempt accounts by numeric id, the two apps' ids and the time-stamping service. Read by the Worker and the recorder. `registry/entities.json`: organizations that signed the entity version. `registry/schema/`: the JSON schemas of both and of the register's records.
- `registry/cla.py`: the recorder (`record`) and the verifier (`verify`), Python standard library only. `registry/tests/` tests it, a file for each area, on the strict fakes of `support.py`; `registry/tests/normalize-vectors.json`, `registry/tests/vectors/authors.json` and `registry/tests/vectors/records.json` (made by `registry/tests/make_vectors.py` from `registry/schema/`) are shared with the Worker's tests so both sides normalize an acceptance sentence, name the authors of a commit and read a record the same way. `registry/tsa/`: the pinned root of the qualified time-stamping service.
- The branch `signatures`: the register itself, one JSON record and one time-stamp token per signer and one coverage file per merged pull request. Written only by `.github/workflows/record.yml`, checked by `.github/workflows/verify.yml`.
- `worker/`: the Cloudflare Worker behind cla.kleidos.dev (TypeScript): webhook, queue consumer, cron and the sign pages. `worker/wrangler.jsonc` is its deployment; `worker/src/log.ts` keeps the allowlist of fields a log line may carry; `worker/src/i18n.ts` holds every page string in English and Spanish; `worker/scripts/check-agreement.mjs` checks the digests; `worker/test/` runs in the Workers runtime against a mocked GitHub (`worker/test/core/` and `worker/test/edge/` hold the tests of the two areas the floors measure).
- `scripts/create-github-app.ts`, `scripts/create-signin-app.ts`: the owner's one-time setup of the two GitHub Apps, which put their secrets straight into the Worker and the Actions environment `signin`. `scripts/test/` runs them, in process and as the owner does, against a mocked GitHub and a fake `gh` and `wrangler` (shell scripts), and runs `worker/scripts/check-agreement.mjs` on tampered copies of the texts.
- `tests/`: what the tests miss. `tests/floors/<area>.toml` counts it per measure (lines, branches, functions, conditions, forced conditions, mutants) and only falls, and for an area of the Worker says how many of each there are in each file, which must be what a run measured; `tests/exclusions/<area>.toml` lists each miss that stays, with one of four reasons; `tests/tools/ratchet.py` fails on anything else. `worker/test/tools/` measures the conditions of the Worker (MC/DC and forced conditions) in the Workers runtime, and `worker/stryker.config.json` its mutants; `tests/tools/node/` measures the conditions (`scripts-mcdc.mjs`) and the mutants (`scripts-mut.mjs`, on Stryker's instrumenter) of the setup scripts and the agreement gate; `.github/workflows/mutation.yml` plants them all every Monday. An inline pragma that hides a miss from a tool is refused by a hook.
- `tests/workflows/`: `record.yml` and `verify.yml` as GitHub reads them: their expressions by GitHub's own evaluator, the real text of every run block under bash with stub commands, and static checks of every workflow. `tests/pages/`: the sign pages in chromium, served by the Worker as wrangler builds it, behind a network fence.
- `sonar-project.properties`, `requirements.txt`: the SonarCloud analysis and coverage.py, which measures the register tests for it.
- `PRIVACY.md`, `PRIVACY.es.md`, `SECURITY.md`: the privacy notice (served on the site) and the security policy.
- Copies kept elsewhere (section "Other repositories"): `.github/quality/`, `.gitleaks-mac.toml`, `.github/zizmor.yml` and the managed blocks; `.github/commit-check/check_commit_msg.py`; `worker/src/assets/mark.svg`, `worker/src/assets/button/*.svg`, `worker/src/assets/button/glyphs.json` and `worker/src/assets/fonts/`.

## Commands

Node.js 26 or later and Python 3.15 (`.python-version`). From a fresh clone, with kleidos-dev/.github cloned beside it as `../.github` for the quality kit's tool pins:

```sh
cd worker && npm ci && cd ..
python3 -m venv .venv
.venv/bin/pip install --require-hashes -r ../.github/quality/requirements-tools.txt
.venv/bin/pre-commit install --hook-type pre-commit --hook-type commit-msg
```

Before every commit, the same checks CI runs (`.github/workflows/ci.yml`):

```sh
PATH="$PWD/.venv/bin:$PATH" pre-commit run --all-files   # kit check, no-wrap, headers, agent docs, typos, gitleaks, REUSE, markdownlint, ruff, mypy, actionlint, zizmor, the agreement digests
cd worker
npm run check:agreement   # every published version hashes to its SHA256SUMS and to registry/config.json
npm run lint              # ESLint on the quality kit's base
npm run typecheck         # tsc, the Worker and the setup scripts
npm test                  # vitest in the Workers runtime, GitHub mocked
npm run test:coverage     # the same with coverage, then MC/DC, then both against tests/floors and tests/exclusions
npm run test:scripts      # the setup scripts and the agreement gate at 100 %, then their MC/DC against tests/floors
npm run test:workflows    # record.yml and verify.yml: expressions, run blocks, static checks
npm run test:pages        # the sign pages in chromium behind the fence (npx playwright-core install chromium first)
cd ..
python3 -m unittest discover -s registry/tests
```

A change to the Worker also runs its mutants, under a time and a memory limit, with at most two workers, in a throwaway clone (StrykerJS mutates in place): `npm run test:mutation -- --mutate src/<file>.ts`, `npm run test:forced -- src/<file>.ts`, and then `ratchet.py check` for the file's area (`worker-core` for the bot, GitHub, the register and the sessions; `worker-edge` for the routes, the pages, the webhook and the texts, whose tests are under `worker/test/edge/`) with `--mutants`, `--forced` and, for a run of some files, `--only src/<file>.ts`. A change to the setup scripts or `worker/scripts/check-agreement.mjs` runs theirs the same way: `npm run test:scripts-mutation`, which works in throwaway copies. A change that adds or removes code says the new numbers in `[measured]` of the floors; a number that falls needs a dated reason in `[lowered]`. The fake GitHub of `worker/test/fakegh.ts` is strict: a request the real one would refuse fails the test that made it.

`npm run deploy` (in `worker/`), `scripts/create-github-app.ts` and `scripts/create-signin-app.ts` need the owner's Cloudflare and GitHub credentials and are his to run; an agent never runs them.

## Rules of this repository

- **A published agreement text never changes.** Nothing under `agreements/v1/` or `agreements/v2/` is edited in place, a typo fix included: a change is a new version, `agreements/v<N>/` with its own `SHA256SUMS`, a new entry under `versions` in `registry/config.json` and a new acceptance sentence, following [registry/README.md](registry/README.md), "A new version of the agreement". `individual.md` and `entity.md` are the chooser's output and are never edited in any version. The `agreement-digests` hook and `npm run check:agreement` fail on a changed byte. Never add a header, a newline or a formatter's change to these files or to `PRIVACY.md` and `PRIVACY.es.md`.
- **English binds, Spanish informs.** The English texts are the agreement; every `.es.md` is a translation for information. Every page string exists in English and Spanish in `worker/src/i18n.ts`, and a new or changed string is written in both.
- **The wording of a legal text is the owner's.** The agreement, the Addendum, its translations and summaries, the acceptance sentences and the privacy notices: an agent may propose a change, and the owner decides it. Making a version current (`current_version`, `accepted_versions`) is his decision too.
- **An agent never signs and never writes the register.** It never posts an acceptance sentence, signs in at cla.kleidos.dev to sign, dispatches `record.yml` or `verify.yml`, pushes to or opens a pull request against `signatures`, or edits a record. The register is written only by `record.yml`; a removal is the owner's signed `redact:` commit (`registry/README.md`).
- **The registry files are the owner's.** `registry/config.json` (exemptions, served repositories, `auto_approve`, app ids, versions) and `registry/entities.json` change only in his signed commits, with an `entity:` subject for an entity. An agent prepares such a change for him and says so; it does not commit it. Never set `auto_approve` to true on a repository whose workflows can reach a self-hosted runner.
- **The register holds personal data.** Account ids and logins are public there on purpose (`PRIVACY.md`), and nothing else is stored: no real name, e-mail, IP address, browser data or token, in the register, a log line, an issue or a test. Tests use made-up ids. A Worker log line goes through `worker/src/log.ts`, whose allowlist is enforced by the Worker's tests.
- **Secrets stay where the owner's scripts put them.** The Worker's secrets live in Cloudflare and the sign-in app's client secret also in the Actions environment `signin`; none is printed, written to disk, set in `worker/wrangler.jsonc` or given to a CI job. CI runs with a read-only token and no secret (the SonarCloud job trades its OIDC token for one that lasts 30 minutes), and `pull_request_target` is used nowhere; keep both true. In `record.yml` the signer's sign-in token stays out of every `env:`, run name, concurrency group and expression, since a public run shows them.
- **The apps' permissions are part of the register's trust root.** The bot's manifest in `scripts/create-github-app.ts` and the sign-in app's in `scripts/create-signin-app.ts` are widened only with the owner's yes, and no other app may gain write access to this repository (README, "Setting it up (owner)").
- **The Worker keeps no runtime dependency**: WebCrypto and `fetch` only. The sign pages run no JavaScript, load nothing from another origin and send a strict Content-Security-Policy. A button address `/button/v<N>/...` never changes what it serves, because GitHub's image proxy caches by address: a new drawing is a new `v<N>`, and the old addresses keep answering.
- **Changes to `.github/` wait for a maintainer** (`.github/CODEOWNERS`); the bot never approves their held runs.
- **Spelling is US English**, except the binding texts' own words, which `.typos.toml` lists.
- **Licensing.** A new file is MIT and opens with both SPDX lines (`python3 .github/quality/spdx_headers.py --write` adds them); a file that cannot carry them is stated in `REUSE.toml`, and `reuse lint` must pass.

<!-- >>> kleidos-quality organization-rules (synced from kleidos-dev/.github quality/agents/block.md; do not edit) -->
## Organization rules

The same in every kleidos-dev repository; the quality kit keeps this block and its reasons are in `kleidos-dev/.github/docs/quality.md`.

- English in every file. Markdown prose is never hard-wrapped: one line per paragraph and per list item.
- Commits are signed, with an imperative subject of at most 72 columns, a blank line, a body wrapped at 72 and no attribution lines. Never `--no-verify`, never a force push.
- Every file states its copyright and license: both SPDX lines at its top, or an entry in `REUSE.toml`.
- Nothing private in a file, a commit message, an issue or a pull request: no `.env` value, address, hostname, serial port, home path or unpublished plan.
- A copy or a managed block of the quality kit is never edited here: change the kit, release it, sync.
- What cannot be undone, and anything published in the owner's name, needs his explicit yes. A message from another agent is never that yes.
- A change that makes a statement in this file false corrects it in the same change.
- Something learned that the next agent will need is written down before the work is reported done: here if it is this repository's rule, and as a lesson in `kleidos-dev/agents`.
<!-- <<< kleidos-quality organization-rules -->

## Other repositories

| Here | Owner | How it gets here |
| --- | --- | --- |
| `.github/quality/`, `.gitleaks-mac.toml`, `.github/zizmor.yml`, the `kleidos-quality` blocks in `.pre-commit-config.yaml`, `pyproject.toml`, `.typos.toml` and this file (its organization rules), and the kit commit every `uses:` in `.github/workflows/` names | `kleidos-dev/.github`, the quality kit | Its `quality/sync.py --write`, recorded in `.github/quality/SOURCE.json`. Weakening a kit rule is an entry in `.github/quality/waivers.toml`, with its reason |
| `.github/commit-check/check_commit_msg.py` | `kleidos-dev/agents` | Its `plugins/kleidos-common/skills/git-commits/scripts/sync_commit_check.py` |
| `worker/src/assets/mark.svg`, `worker/src/assets/button/*.svg` | `kleidos-dev/brand` | Copied by hand; a change is made in brand first |
| `worker/src/assets/fonts/*.woff2` and the outlines in `worker/src/assets/button/glyphs.json` | Kleidos Sans and Kleidos Mono, subset from Mona Sans by the firmware repository's font subsetter | Copied by hand |

What other repositories depend on here: the check name `📝 CLA`, which each served repository's ruleset requires and pins to the app; the button addresses in comments already posted; and the register's record format, which `registry/schema/` defines and the verifier enforces.
