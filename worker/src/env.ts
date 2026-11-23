// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import type { QueueMessage } from "./messages";

/** The Worker's bindings: plain variables from wrangler.jsonc, secrets set by the owner's script. */
export interface Env {
  CLA_QUEUE: Queue<QueueMessage>;
  RL_WEBHOOK: RateLimit;
  RL_AUTH: RateLimit;
  RL_SIGN: RateLimit;
  RL_AGREE_IP: RateLimit;
  RL_AGREE_ACCOUNT: RateLimit;
  ALLOWED_ACCOUNT_IDS: string;
  REGISTRY_REPO: string;
  PUBLIC_ORIGIN: string;
  BUILD_COMMIT: string;
  APP_ID?: string;
  APP_PRIVATE_KEY?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  WEBHOOK_SECRET?: string;
  SESSION_KEY?: string;
  /**
   * The identity-only sign-in app (a GitHub App with no permission at all),
   * set by scripts/create-signin-app.ts. Until both exist, and the client id
   * is the one registry/config.json names, a version whose flow is
   * "signin" cannot be signed on the site, and a "comment" version is
   * signed through kleidos-cla as before.
   */
  SIGNIN_CLIENT_ID?: string;
  SIGNIN_CLIENT_SECRET?: string;
}

/** The Env once every secret is present. */
export type ConfiguredEnv = Env & Required<Pick<Env, "APP_ID" | "APP_PRIVATE_KEY" | "CLIENT_ID" | "CLIENT_SECRET" | "WEBHOOK_SECRET" | "SESSION_KEY">>;

/**
 * Configured only when every secret is present and the account allowlist
 * names at least one account: with an empty or unparsable allowlist the
 * cron and the installation handler would remove every installation.
 */
export function isConfigured(env: Env): env is ConfiguredEnv {
  return Boolean(env.APP_ID && env.APP_PRIVATE_KEY && env.CLIENT_ID && env.CLIENT_SECRET && env.WEBHOOK_SECRET && env.SESSION_KEY) && parseAllowlist(env.ALLOWED_ACCOUNT_IDS).size > 0;
}

function parseAllowlist(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[1-9][0-9]{0,15}$/.test(s))
      .map(Number)
      .filter((n) => Number.isSafeInteger(n)),
  );
}

/** The OAuth credentials of one of the two apps a signer can sign in with. */
export interface OAuthApp {
  kind: "bot" | "signin";
  clientId: string;
  clientSecret: string;
}

/** The bot's own app, kleidos-cla: the sign-in of a version whose flow is "comment" (version 1). */
export function botApp(env: ConfiguredEnv): OAuthApp {
  return { kind: "bot", clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET };
}

/**
 * The identity-only sign-in app, when its two secrets exist and the client
 * id is the one the register names (`signin_client_id`); null otherwise.
 * The register's naming it is the switch: the recorder accepts no token
 * of any other app.
 */
export function signinApp(env: Env, configured: string | null | undefined): OAuthApp | null {
  if (!env.SIGNIN_CLIENT_ID || !env.SIGNIN_CLIENT_SECRET || typeof configured !== "string" || configured !== env.SIGNIN_CLIENT_ID) return null;
  return { kind: "signin", clientId: env.SIGNIN_CLIENT_ID, clientSecret: env.SIGNIN_CLIENT_SECRET };
}

/** The accounts the app may be installed on. Throws on an empty list: nothing is ever removed in that state. */
export function allowedAccounts(env: Env): Set<number> {
  const ids = parseAllowlist(env.ALLOWED_ACCOUNT_IDS);
  if (ids.size === 0) throw new Error("ALLOWED_ACCOUNT_IDS is empty");
  return ids;
}
