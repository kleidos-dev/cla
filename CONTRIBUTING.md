# Contributing to kleidos-dev/cla

This repository holds the agreement itself, so a few rules are stricter than elsewhere in Kleidos.

- **Contributions here are covered by the agreement too.** Sign it the usual way, on your pull request.
- **The agreement texts are frozen.** `agreements/v1/individual.md` and `entity.md` are generated verbatim and are never edited; `addendum.md` and `SHA256SUMS` change only as a new version (`agreements/v2/`, a new entry in `registry/config.json`, a new acceptance sentence), never in place. A typo fix in a binding text is a new version. Pull requests that edit `agreements/v1/` are closed.
- **The register is written only by `record.yml`.** Do not open pull requests against the `signatures` branch. To correct or remove an entry, write to <mail@kleidos.dev>.
- **Exemptions and entities** (`registry/config.json`, `registry/entities.json`) are changed by the owner only, in signed commits with an `entity:` subject for entities.
- **Changes to `.github/` wait for a maintainer**: the bot never approves their checks automatically.

## Working on the code

```sh
cd worker
npm ci
npm run check:agreement   # the digests
npm run lint
npm run typecheck
npm test                  # vitest in the Workers runtime, GitHub mocked
npm run test:scripts      # the setup script against a mock
cd .. && python3 -m unittest discover -s registry/tests
```

Everything in CI runs with a read-only token and no secret. Commit messages follow the Kleidos rules (imperative subject of at most 72 columns, body wrapped at 72, no AI attribution); `pre-commit install --hook-type commit-msg` checks them locally and `commit-check.yml` on every pull request. Markdown is never hard-wrapped: one line per paragraph. Files are in English. New files carry an MIT SPDX license header, or are covered by `REUSE.toml`; `reuse lint` must pass.

The Worker has no runtime dependency and must keep none: WebCrypto and `fetch` only. Its log lines go through `src/log.ts`, which keeps an allowlist of fields; a test fails if any flow logs a token, a key, an OAuth parameter, a cookie, an email or an address.
