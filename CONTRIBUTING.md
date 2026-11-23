<!--
SPDX-FileCopyrightText: 2026 José M. Requena Plens
SPDX-License-Identifier: MIT
-->

# Contributing to kleidos-dev/cla

This repository holds the agreement itself, so a few rules are stricter than elsewhere in Kleidos.

- **Contributions here are covered by the agreement too.** Sign it the usual way, on your pull request.
- **The agreement texts are frozen.** `agreements/v1/individual.md` and `entity.md` are generated verbatim and are never edited; `addendum.md` and `SHA256SUMS` change only as a new version (`agreements/v2/`, a new entry in `registry/config.json`, a new acceptance sentence), never in place. A typo fix in a binding text is a new version. Pull requests that edit `agreements/v1/` are closed.
- **The register is written only by `record.yml`.** Do not open pull requests against the `signatures` branch. To correct or remove an entry, write to <mail@kleidos.dev>.
- **Exemptions and entities** (`registry/config.json`, `registry/entities.json`) are changed by the owner only, in signed commits with an `entity:` subject for entities.
- **Changes to `.github/` wait for a maintainer** (`@kleidos-dev/maintainers`): the bot never approves their checks automatically. You do not need to mention anyone: every pull request asks the maintainers for a review on its own, through `CODEOWNERS`.

## Working on the code

```sh
cd worker
npm ci
npm run check:agreement   # the digests
npm run lint              # ESLint on the Kleidos quality kit's base
npm run typecheck
npm test                  # vitest in the Workers runtime, GitHub mocked
npm run test:scripts      # the setup script against a mock
cd .. && python3 -m unittest discover -s registry/tests
```

The checks come from the Kleidos quality kit ([kleidos-dev/.github](https://github.com/kleidos-dev/.github), `docs/quality.md`): its copies and `SOURCE.json` live in `.github/quality/`, and every CI job but the Worker's tests and the setup script's test is one of its reusable workflows. With the kit checked out beside this repository, install its pinned tools and the hooks once, then run every hook on every file:

```sh
python3 -m pip install --require-hashes -r ../.github/quality/requirements-tools.txt
pre-commit install --hook-type pre-commit --hook-type commit-msg
pre-commit run --all-files   # kit check, typos, gitleaks, REUSE, ruff, mypy, actionlint, zizmor, the digests
```

Everything in CI runs with a read-only token and no secret. Commit messages follow the Kleidos rules (imperative subject of at most 72 columns, body wrapped at 72, no AI attribution); the commit-msg hook checks them locally and `commit-check.yml` on every pull request. Markdown is never hard-wrapped: one line per paragraph. Files are in English (US spelling, except the binding texts' own words, which `.typos.toml` lists). Every file that can carry a comment starts with both REUSE lines, in a comment at its top, copyright first: the copyright line names the year of the file's first commit and José M. Requena Plens (no e-mail address), the license line says MIT; `python3 .github/quality/spdx_headers.py --write` adds them. A file that cannot carry one (JSON, the texts the Worker serves byte for byte) is stated in `REUSE.toml`; `reuse lint` must pass. A rule of the kit turned off or narrowed here is an entry in `.github/quality/waivers.toml`, with its reason.

The Worker has no runtime dependency and must keep none: WebCrypto and `fetch` only. Its log lines go through `src/log.ts`, which keeps an allowlist of fields; a test fails if any flow logs a token, a key, an OAuth parameter, a cookie, an email or an address.
