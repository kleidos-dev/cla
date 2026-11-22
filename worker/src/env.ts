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
}

/** The Env once every secret is present. */
export type ConfiguredEnv = Env & Required<Pick<Env, "APP_ID" | "APP_PRIVATE_KEY" | "CLIENT_ID" | "CLIENT_SECRET" | "WEBHOOK_SECRET" | "SESSION_KEY">>;

export function isConfigured(env: Env): env is ConfiguredEnv {
  return Boolean(env.APP_ID && env.APP_PRIVATE_KEY && env.CLIENT_ID && env.CLIENT_SECRET && env.WEBHOOK_SECRET && env.SESSION_KEY);
}

export function allowedAccounts(env: Env): Set<number> {
  return new Set(
    env.ALLOWED_ACCOUNT_IDS.split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  );
}
