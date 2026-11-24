// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { ConfiguredEnv, Env } from "../../src/env";
import { allowedAccounts, botApp, isConfigured, signinApp } from "../../src/env";

const SECRETS = { APP_ID: "1", APP_PRIVATE_KEY: "key", CLIENT_ID: "Iv23liCLIENT", CLIENT_SECRET: "client secret", WEBHOOK_SECRET: "webhook secret", SESSION_KEY: "session key" };
const env = (over: Record<string, unknown> = {}) => ({ ALLOWED_ACCOUNT_IDS: "357318718", ...SECRETS, ...over }) as unknown as Env;

describe("the Worker is configured", () => {
  it("with every secret and one allowed account", () => {
    expect(isConfigured(env())).toBe(true);
  });

  it.each(Object.keys(SECRETS))("not without %s, absent or empty", (name) => {
    expect(isConfigured(env({ [name]: undefined }))).toBe(false);
    expect(isConfigured(env({ [name]: "" }))).toBe(false);
  });

  it.each([undefined, "", " ", ",", "abc", "0", "-1", "1.5", "0x10"])("not with an allowlist of %j", (ids) => {
    expect(isConfigured(env({ ALLOWED_ACCOUNT_IDS: ids }))).toBe(false);
  });

  it("without the sign-in app, which is optional", () => {
    expect(isConfigured(env({ SIGNIN_CLIENT_ID: undefined, SIGNIN_CLIENT_SECRET: undefined }))).toBe(true);
  });
});

describe("the allowlist", () => {
  it.each([
    ["357318718", [357318718]],
    ["1,2", [1, 2]],
    [" 1 ,\t2\n", [1, 2]],
    ["2,2,2", [2]],
    [",,7,", [7]],
    // The largest integer a number holds exactly is an id; the next one is not known exactly, so it is no id.
    ["9007199254740991", [9007199254740991]],
    ["9007199254740993,3", [3]],
    ["12345678901234567,3", [3]],
    ["abc,1a,a1,01,+1,-1,1e3,1.0,1 2,\u0661,4", [4]],
  ])("%j allows exactly %j", (ids, allowed) => {
    expect([...allowedAccounts(env({ ALLOWED_ACCOUNT_IDS: ids }))]).toEqual(allowed);
  });

  it.each([undefined, "", "0", "nobody"])("%j names nobody, which is an error and never an empty list", (ids) => {
    expect(() => allowedAccounts(env({ ALLOWED_ACCOUNT_IDS: ids }))).toThrow("ALLOWED_ACCOUNT_IDS is empty");
  });
});

describe("the two apps a signer can sign in with", () => {
  it("the bot's own app has its own id and secret", () => {
    expect(botApp(env() as ConfiguredEnv)).toEqual({ kind: "bot", clientId: "Iv23liCLIENT", clientSecret: "client secret" });
  });

  const signin = { SIGNIN_CLIENT_ID: "Iv23liSIGNIN", SIGNIN_CLIENT_SECRET: "signin secret" };

  it("the sign-in app exists when its two secrets do and the register names its client id", () => {
    expect(signinApp(env(signin), "Iv23liSIGNIN")).toEqual({ kind: "signin", clientId: "Iv23liSIGNIN", clientSecret: "signin secret" });
  });

  it.each([null, undefined, "", "Iv23liOTHER"])("not when the register names %j", (configured) => {
    expect(signinApp(env(signin), configured)).toBeNull();
  });

  it.each([
    ["the client id", { SIGNIN_CLIENT_SECRET: "signin secret" }],
    ["the client secret", { SIGNIN_CLIENT_ID: "Iv23liSIGNIN" }],
    ["both", {}],
  ])("not without %s", (_what, over) => {
    expect(signinApp(env(over), "Iv23liSIGNIN")).toBeNull();
    expect(signinApp(env(over), undefined)).toBeNull();
  });

  it("an empty client id is no app, even when the register names the empty id", () => {
    expect(signinApp(env({ ...signin, SIGNIN_CLIENT_ID: "" }), "")).toBeNull();
    expect(signinApp(env({ ...signin, SIGNIN_CLIENT_SECRET: "" }), "Iv23liSIGNIN")).toBeNull();
  });
});
