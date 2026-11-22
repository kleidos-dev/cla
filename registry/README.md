# The register

| Where | What | Written by |
| --- | --- | --- |
| `registry/config.json` (main) | The current and accepted versions with their digests and sentences, the served repositories with `auto_approve`, the exempt accounts by numeric id, and `coverage_from`. Read by the bot (cached 60 s) and by the recorder. Schema: `schema/config.schema.json`. | The owner, signed commits |
| `registry/entities.json` (main) | Organizations that signed the entity version: name, version, digest, date, the account ids they cover with start and end dates. Schema: `schema/entities.schema.json`. | The owner, signed commits with an `entity:` subject |
| `signatures/individual/<github id>.json` (branch `signatures`) | One signature per account. Schema: `schema/individual.schema.json`. | `record.yml` only |
| `coverage/<owner>/<repo>/<number>.json` (branch `signatures`) | The authors of one merged pull request and the version each had accepted. Schema: `schema/coverage.schema.json`. | `record.yml` only |

`cla.py record` runs in `record.yml` with the repository's own `GITHUB_TOKEN`. For a signature it re-reads the comment from GitHub and refuses it if it was edited, is not on the pull request it names, was not written by a personal account, or, after Unicode NFC and whitespace collapsing, is not exactly the sentence of an accepted version; an existing record for the same or a later version is success without a commit. For coverage it works out the authors of the merged pull request itself, by the same rule as the bot (opener, commit authors, `Co-authored-by:` co-authors, less the exempt and the entity-covered), and writes nothing, opening an issue instead, if any of them has no signature. Every write is one file in one `createCommitOnBranch` commit, which GitHub signs.

`cla.py verify` runs in `verify.yml` after every recorder run and weekly. It fails, and opens an issue, if the `signatures` branch is not linear; if a commit adds or changes more or less than one record, deletes one, touches another path, is not by `github-actions[bot]` or is not verified (the owner's `redact:` and `entity:` commits excepted); if a record does not match its path or names a version or digest that is not accepted; or if a pull request merged in a served repository since `coverage_from` has no coverage file.

Removal at a signer's request (GDPR art. 17, within the limits of art. 17.3(e)) is an owner's commit with a `redact:` subject.
