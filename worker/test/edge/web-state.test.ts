// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Whether signing is on, and on which pull request: signingState's every
 * reason, the sign path's every edge, and the acceptance sentence built
 * from a version's digest.
 */
import { describe, expect, it } from "vitest";
import type { ConfiguredEnv } from "../../src/env";
import type { Config } from "../../src/registry";
import { parseSignPath, sentenceFor, signingState } from "../../src/web";
import { CLIENT_ID, CLIENT_SECRET, SIGNIN_CLIENT_ID, SIGNIN_CLIENT_SECRET } from "../fakegh";
import { CONFIG, CONFIG_V2, restoring, world } from "./support";

restoring();

const SET_1 = CONFIG.versions["1"].set_sha256;
const SET_2 = CONFIG.versions["2"].set_sha256;
const config = (c: unknown) => c as Config;

async function env(opts: { signinSecrets?: boolean } = {}): Promise<ConfiguredEnv> {
  return (await world(opts)).env as ConfiguredEnv;
}

describe("signing", () => {
  it("is on for a comment version bundled with its digest and sentence, through kleidos-cla", async () => {
    expect(await signingState(config(CONFIG), await env())).toEqual({ on: true, version: 1, setSha256: SET_1, flow: "comment", app: { kind: "bot", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
  });

  it("is on for a sign-in version through the sign-in app the register names, built from a known commit", async () => {
    expect(await signingState(config(CONFIG_V2), await env({ signinSecrets: true }))).toEqual({ on: true, version: 2, setSha256: SET_2, flow: "signin", app: { kind: "signin", clientId: SIGNIN_CLIENT_ID, clientSecret: SIGNIN_CLIENT_SECRET } });
  });

  it("is off, at the fallback version, when the register was not read", async () => {
    expect(await signingState(null, await env())).toEqual({ on: false, reason: "registry not read", version: 1, setSha256: SET_1, flow: "comment", app: null });
  });

  it("is off when the register's current version is not bundled here", async () => {
    expect(await signingState(config({ ...CONFIG, current_version: 3 }), await env())).toEqual({ on: false, reason: "version skew between the registry and this deployment", version: 3, setSha256: "", flow: "comment", app: null });
  });

  it("is off when the register does not describe its current version as bundled here", async () => {
    const skew = "version skew between the registry and this deployment";
    const v1 = CONFIG.versions["1"];
    for (const versions of [{ "2": CONFIG.versions["2"] }, { "1": { ...v1, set_sha256: SET_2 } }, { "1": { ...v1, sentence: `${v1.sentence} ` } }, { "1": { ...v1, sentence: sentenceFor(1, SET_2) } }]) {
      expect(await signingState(config({ ...CONFIG, versions }), await env()), JSON.stringify(Object.keys(versions))).toEqual({ on: false, reason: skew, version: 1, setSha256: SET_1, flow: "comment", app: null });
    }
  });

  it("of a sign-in version is off without the app, and off when built from no known commit", async () => {
    expect(await signingState(config(CONFIG_V2), await env())).toMatchObject({ on: false, reason: "the sign-in app is not configured", flow: "signin", version: 2, app: null });
    const e = await env({ signinSecrets: true });
    for (const commit of ["unknown", "", "A".repeat(40), "a".repeat(39), "a".repeat(41), `${"a".repeat(40)}\n`]) {
      expect(await signingState(config(CONFIG_V2), { ...e, BUILD_COMMIT: commit }), commit).toEqual({ on: false, reason: "build commit unknown", version: 2, setSha256: SET_2, flow: "signin", app: null });
    }
  });
});

describe("the sign path", () => {
  it("names a repository and a pull request, and is written back the same way", () => {
    expect(parseSignPath("/sign/kleidos-dev/cla-sandbox/7")).toEqual({ repo: "kleidos-dev/cla-sandbox", pr: 7, path: "/sign/kleidos-dev/cla-sandbox/7" });
    expect(parseSignPath(`/sign/${"o".repeat(39)}/${"r".repeat(100)}/2147483647`)).toEqual({ repo: `${"o".repeat(39)}/${"r".repeat(100)}`, pr: 2147483647, path: `/sign/${"o".repeat(39)}/${"r".repeat(100)}/2147483647` });
    expect(parseSignPath("/sign/o/.x/1")?.repo).toBe("o/.x");
    expect(parseSignPath("/sign/o/.../1")?.repo).toBe("o/...");
  });

  it("is refused for a number GitHub cannot have, a dot path, or anything around it", () => {
    for (const path of ["/sign/o/r/0", "/sign/o/r/01", "/sign/o/r/-1", "/sign/o/r/2147483648", "/sign/o/r/9999999999", "/sign/o/r/12345678901", "/sign/o/./1", "/sign/o/../1", "/sign/o/r/1/", "/sign/o/r/1x", "/sign/o/r", "/sign/o_x/r/1", `/sign/${"o".repeat(40)}/r/1`, `/sign/o/${"r".repeat(101)}/1`, "/sign//r/1", "/Sign/o/r/1", " /sign/o/r/1", "/sign/o/r/1\n"]) {
      expect(parseSignPath(path), path).toBeNull();
    }
  });
});

describe("the acceptance sentence", () => {
  it("names the version and the first twelve digits of its digest, and is the register's", () => {
    expect(sentenceFor(1, SET_1)).toBe(CONFIG.versions["1"].sentence);
    expect(sentenceFor(2, SET_2)).toBe(CONFIG.versions["2"].sentence);
    expect(sentenceFor(9, "0123456789abcdef")).toContain("version 9 (SHA-256 0123456789ab), made of");
  });
});
