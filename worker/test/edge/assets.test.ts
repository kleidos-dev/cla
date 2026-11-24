// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The safety net of the bundled texts and drawings. A text that does not
 * hash to its SHA256SUMS line, a line that is not one, a listed file that is
 * not bundled and a binding file that is not listed each turn signing off
 * and say why; a button drawing or glyph table that is not what button.ts
 * was written for is refused, not served wrong. Each case loads the
 * modules afresh over the files as edited, and puts them back after.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGREEMENTS } from "../../src/agreement";
import { must, sha256Hex } from "../../src/util";
import { CONFIG, ORIGIN, restoring, world } from "./support";

restoring();

const edited: string[] = [];
afterEach(() => {
  for (const path of edited.splice(0)) vi.doUnmock(path);
  vi.resetModules();
});

/** The text of a bundled file as built, by the path a test names it with. */
async function original(path: string): Promise<string> {
  const text = /^\.\.\/\.\.\/\.\.\/agreements\/v(\d)\/(.+)$/.exec(path);
  if (text) return must(AGREEMENTS[Number(text[1])]?.[must(text[2])]);
  return ((await import(path)) as { default: string }).default;
}

/** Loads every module afresh with these files' text edited as given. */
async function editing(files: Record<string, (text: string) => string>): Promise<void> {
  vi.resetModules();
  for (const [path, edit] of Object.entries(files)) {
    const real = await original(path);
    vi.doMock(path, () => ({ default: edit(real) }));
    edited.push(path);
  }
}

const V1 = "../../../agreements/v1/";
const V2 = "../../../agreements/v2/";

async function fresh() {
  return { agreement: await import("../../src/agreement"), index: await import("../../src/index") };
}

describe("a bundled text that does not match its SHA256SUMS", () => {
  it("is never ok, and the digest of its set stays the digest of SHA256SUMS", async () => {
    await editing({ [`${V1}addendum.md`]: (t) => `${t} ` });
    const { agreement } = await fresh();
    const real = CONFIG.versions["1"];
    expect(await agreement.checkIntegrity(1)).toEqual({ ok: false, setSha256: real.set_sha256, files: { "individual.md": real.files["individual.md"], "entity.md": real.files["entity.md"], "addendum.md": await sha256Hex(agreement.filesOf(1)["addendum.md"] ?? "") } });
    expect((await agreement.checkIntegrity(1)).files["addendum.md"]).not.toBe(real.files["addendum.md"]);
  });

  it("switches signing off, and /healthz says why", async () => {
    await editing({ [`${V1}individual.md`]: (t) => t.replace("License", "Licence") });
    const w = await world();
    const { index } = await fresh();
    const health = await (await index.handleFetch(new Request(`${ORIGIN}/healthz`), w.env)).json<Record<string, unknown>>();
    expect(health).toMatchObject({ ok: false, version: 1, signing: false, reason: "bundled texts do not match SHA256SUMS" });
    const sign = await index.handleFetch(new Request(`${ORIGIN}/sign/kleidos-dev/cla-sandbox/1`), w.env);
    expect(await sign.text()).not.toContain("/auth/login");
    expect(w.gh.codes.size).toBe(0);
  });
});

describe("a SHA256SUMS that is not as written", () => {
  it("with a line that is not a digest and a name is never ok", async () => {
    await editing({ [`${V2}SHA256SUMS`]: (t) => `${t}not a line\n`, [`${V1}SHA256SUMS`]: (t) => t.replace("entity.md", "Entity.md") });
    const { agreement } = await fresh();
    const v2 = await agreement.checkIntegrity(2);
    expect(v2.ok).toBe(false);
    expect(Object.keys(v2.files).sort()).toEqual(["addendum.md", "entity.md", "individual.md"]);
    expect(v2.setSha256).toBe(await sha256Hex(agreement.filesOf(2).SHA256SUMS ?? ""));
    const v1 = await agreement.checkIntegrity(1);
    expect(v1.ok).toBe(false);
    expect(Object.keys(v1.files).sort()).toEqual(["addendum.md", "individual.md"]);
  });

  it("that lists a file not bundled is never ok, and the file hashes to nothing", async () => {
    await editing({ [`${V1}SHA256SUMS`]: (t) => `${t}${"0".repeat(64)}  missing.md\n${"0".repeat(64)}  constructor\n` });
    const { agreement } = await fresh();
    const v1 = await agreement.checkIntegrity(1);
    expect(v1.ok).toBe(false);
    expect([v1.files["missing.md"], v1.files.constructor]).toEqual(["", ""]);
    expect(v1.files["individual.md"]).toBe(CONFIG.versions["1"].files["individual.md"]);
  });

  it("that leaves out a binding file is never ok, even when every line it has matches", async () => {
    for (const name of ["individual.md", "entity.md", "addendum.md"]) {
      await editing({ [`${V2}SHA256SUMS`]: (t) => t.split("\n").filter((l) => !l.endsWith(`  ${name}`)).join("\n") });
      const { agreement } = await fresh();
      const v2 = await agreement.checkIntegrity(2);
      expect([v2.ok, name in v2.files], name).toEqual([false, false]);
      for (const path of edited.splice(0)) vi.doUnmock(path);
    }
  });

  it("with blank lines, or none at the end, is read as the lines it has", async () => {
    await editing({ [`${V2}SHA256SUMS`]: (t) => `\n\n${t.trimEnd().replaceAll("\n", "\n  \n")}` });
    const { agreement } = await fresh();
    expect((await agreement.checkIntegrity(2)).ok).toBe(true);
  });
});

describe("the bundled versions as they are", () => {
  it("are ok, hashed once per isolate, and a version not bundled is never ok", async () => {
    const { agreement } = await fresh();
    expect(await agreement.checkIntegrity(1)).toEqual({ ok: true, setSha256: CONFIG.versions["1"].set_sha256, files: CONFIG.versions["1"].files });
    expect(await agreement.checkIntegrity(2)).toEqual({ ok: true, setSha256: CONFIG.versions["2"].set_sha256, files: CONFIG.versions["2"].files });
    expect(agreement.checkIntegrity(1)).toBe(agreement.checkIntegrity(1));
    expect(await agreement.checkIntegrity(3)).toEqual({ ok: false, setSha256: "", files: {} });
    expect(await agreement.checkIntegrity(0)).toEqual({ ok: false, setSha256: "", files: {} });
  });

  it("are the only ones bundled, and asking for the files of another throws", async () => {
    const { agreement } = await fresh();
    expect([1, 2].map(agreement.isBundled)).toEqual([true, true]);
    for (const v of [0, 3, -1, 1.5, Number.NaN]) expect(agreement.isBundled(v), String(v)).toBe(false);
    expect(() => agreement.filesOf(3)).toThrow("agreement version 3 is not bundled");
    expect(Object.keys(agreement.filesOf(1)).sort()).toEqual(["SHA256SUMS", "addendum.es.md", "addendum.md", "entity.md", "individual.es.md", "individual.md", "summary.es.md"]);
    expect(agreement.FALLBACK_VERSION).toBe(1);
  });
});

const BUTTON = "../../src/assets/button/";

describe("a button drawing that is not understood", () => {
  it("is refused when its mark, its outline or its width cannot be found", async () => {
    await editing({
      [`${BUTTON}needed.svg`]: (s) => s.replace('<g transform="matrix(.34 0 0 .34 24 24)">', "<g>"),
      [`${BUTTON}signed.svg`]: (s) => s.replace('rx="9.5"/>', 'rx="9"/>'),
      [`${BUTTON}none.svg`]: (s) => s.replace(/(<svg[^>]*)\swidth="\d+"/, "$1"),
    });
    const b = await import("../../src/button");
    expect(() => b.buttonSvg("needed", 0, 1)).toThrow("button drawing not understood");
    expect(() => b.buttonSvg("partial", 1, 2)).toThrow("button drawing not understood");
    expect(() => b.buttonSvg("signed", 1, 1)).toThrow("button drawing not understood");
    expect(() => b.buttonSvg("none", 0, 0)).toThrow("button drawing not understood");
  });

  it("is refused when its words are anything but filled outlines", async () => {
    await editing({
      [`${BUTTON}needed.svg`]: (s) => s.replace('rx="9.5"/>', 'rx="9.5"/><text>Sign</text>'),
      [`${BUTTON}none.svg`]: (s) => s.replace(/rx="9\.5"\/>[\s\S]*<\/svg>$/, 'rx="9.5"/></svg>'),
      [`${BUTTON}signed.svg`]: (s) => s.replace(/<path fill="#[0-9a-f]{6}" d="M68/, '<path fill="red" d="M68'),
    });
    const b = await import("../../src/button");
    expect(() => b.buttonSvg("needed", 0, 1)).toThrow("button words not understood");
    expect(() => b.buttonSvg("none", 0, 0)).toThrow("button words not understood");
    expect(() => b.buttonSvg("signed", 1, 1)).toThrow("button words not understood");
  });

  it("is refused when the count has a digit the outlines lack", async () => {
    await editing({ [`${BUTTON}glyphs.json`]: (s) => s });
    vi.doMock(`${BUTTON}glyphs.json`, async () => {
      const real = (await vi.importActual<{ default: { glyphs: Record<string, unknown> } }>(`${BUTTON}glyphs.json`)).default;
      const glyphs = Object.fromEntries(Object.entries(real.glyphs).filter(([k]) => k !== "3"));
      return { default: { ...real, glyphs } };
    });
    const b = await import("../../src/button");
    expect(() => b.buttonSvg("partial", 1, 3)).toThrow("glyph missing");
    expect(b.buttonSvg("partial", 1, 2)).toContain("<svg");
  });
});
