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
- The owner's setup script (`scripts/create-github-app.ts`).
- The GitHub App's permissions and the deployment settings described in the README.

Out of scope: the legal content of the agreement (write to <mail@kleidos.dev> about it, in the open if you like), GitHub and Cloudflare themselves, and denial of service by volume.

## What happens next

An acknowledgement within a week, an assessment within two, and a fix or a mitigation as fast as the severity requires. You are credited in the fix unless you ask not to be.
