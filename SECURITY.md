<!--
SPDX-FileCopyrightText: 2026 José M. Requena Plens
SPDX-License-Identifier: MIT
-->

# Security policy

This repository holds the Kleidos Contributor Agreement, its public register and the bot behind [cla.kleidos.dev](https://cla.kleidos.dev). A flaw here could let someone forge or erase a signature, turn the `📝 CLA` check green without one, start CI on an outside pull request without a signature, or reach a signer's GitHub session.

## Report it privately

**Never report a vulnerability in an issue, a discussion or a pull request.** Use one of these:

1. **A private vulnerability report** on this repository: the **Security** tab, **Report a vulnerability**.
2. **Email** to <mail@kleidos.dev>, encrypted if you want with the OpenPGP key `9476 5B19 FB50 5392 C68A  ED60 0535 C714 FCEF 3BC3` (`gpg --locate-keys mail@kleidos.dev`).

English or Spanish. Test only against `kleidos-dev/cla-sandbox` or your own deployment, with your own accounts: never sign, comment or open pull requests as anybody else, and never try to obtain another person's token.

## In scope

- The Worker (`worker/`): webhook verification, the OAuth flow, sessions and CSRF, the sign page, the evaluation of who must sign, the approval of held runs.
- The register's writer and verifier (`registry/cla.py`, `.github/workflows/record.yml`, `verify.yml`).
- The owner's setup scripts (`scripts/create-github-app.ts`, `scripts/create-signin-app.ts`).
- The two GitHub Apps' permissions (the bot `kleidos-cla` and the identity-only `kleidos-cla-sign-in`) and the deployment settings described in the README.
- The time-stamp tokens and how the recorder and the verifier check them (`registry/tsa/`).

## What the app's permissions reach

The app asks for no more than it uses: `metadata: read`, `contents: read`, `pull_requests: write`, `checks: write` and `actions: write` (no `statuses`, no contents write). Every installation token is narrowed to one repository and the permissions of the call. `actions: write` cannot be narrowed further by GitHub, and if the app's key leaked it would let the holder, on every repository the app is installed on, approve held runs, cancel or re-run workflows, dispatch any `workflow_dispatch` workflow and disable or enable workflows; on this repository that includes dispatching `record.yml` (which re-reads everything and records only a genuine acceptance: a typed or posted comment it reads itself, or a sign-in token it checks with GitHub, so the holder could record only an account whose valid, recent sign-in token of our sign-in app it holds) and disabling `record.yml` or `verify.yml`. So the installation stays on selected repositories only, no served repository may reach a self-hosted runner while its `auto_approve` is true, and `verify.yml` fails, and opens an issue, when either workflow is not enabled (a disabled `verify.yml` cannot report itself, so a missing weekly run is itself the signal).

## The sign-in app

From version 2 the signer signs in with `kleidos-cla-sign-in`, a GitHub App with no permission at all, no event and no webhook, never installed: its user token reads nothing that is not public. Its client secret is kept twice, as the Worker secret `SIGNIN_CLIENT_SECRET` and as the Actions secret of this repository's environment `signin`, whose deployment branch policy is `main` only. With it, the holder can exchange an authorization code that GitHub sends to `cla.kleidos.dev/auth/callback` (and PKCE binds the code to the browser that started the sign-in), and check, reset or delete the tokens of that app. The recorder trusts a sign-in only after GitHub's own "Check a token" answer says the token is valid, is of the client id `registry/config.json` names, and belongs to the personal account the Worker reported, created within the last two hours; it deletes the grant whatever the outcome. The token travels from the Worker to `record.yml` as a `workflow_dispatch` input that appears in no `env:`, run name, concurrency group or expression (all of which a public run shows); `registry/cla.py` reads it from the event payload and masks it before any output. What remains: whoever controls the Worker while a person signs in could record that person without the click on "I agree" (the same residue as version 1's flow).

Out of scope: the legal content of the agreement (write to <mail@kleidos.dev> about it, in the open if you like), GitHub and Cloudflare themselves, and denial of service by volume.

## What happens next

An acknowledgement within a week, an assessment within two, and a fix or a mitigation as fast as the severity requires. You are credited in the fix unless you ask not to be.
