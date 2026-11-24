// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The sign button. GitHub's image proxy caches it by address, so an address
 * may never serve other bytes: every state is pinned by the hash of its
 * drawing, the paths the bot writes are the only ones served, and each
 * drawing is a plain SVG with nothing that runs or loads.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ButtonState } from "../../src/button";
import { BUTTON_VERSION, buttonAlt, buttonPath, buttonState, buttonSvg, parseButtonPath } from "../../src/button";
import { sha256Hex } from "../../src/util";
import { restoring } from "./support";

restoring();

describe("the state a pull request is drawn in", () => {
  it("is none with no author to sign, signed when all are clear, partial once one signed, needed before", () => {
    expect(buttonState(0, 0, true)).toBe("none");
    expect(buttonState(0, 2, true)).toBe("signed");
    expect(buttonState(2, 2, true)).toBe("signed");
    expect(buttonState(0, 2, false)).toBe("needed");
    expect(buttonState(0, 0, false)).toBe("needed");
    expect(buttonState(1, 2, false)).toBe("partial");
    expect(buttonState(2, 2, false)).toBe("partial");
  });
});

describe("the words of a button", () => {
  it("name the state and the count, in the singular for one author", () => {
    expect(buttonAlt("none", 0, 0)).toBe("No signature needed on this pull request");
    expect(buttonAlt("signed", 1, 1)).toBe("Kleidos Contributor Agreement signed by its author");
    expect(buttonAlt("signed", 3, 3)).toBe("Kleidos Contributor Agreement signed by all 3 authors");
    expect(buttonAlt("needed", 0, 1)).toBe("Sign the Kleidos Contributor Agreement: 0 of 1 author signed");
    expect(buttonAlt("partial", 1, 2)).toBe("Sign the Kleidos Contributor Agreement: 1 of 2 authors signed");
  });
});

describe("the address of a button", () => {
  it("names the version, the state and both counts, with none always 0 of 0 and counts held at 999", () => {
    expect(BUTTON_VERSION).toBe("v2");
    expect(buttonPath("needed", 0, 3)).toBe("/button/v2/needed-0-3.svg");
    expect(buttonPath("partial", 2, 3)).toBe("/button/v2/partial-2-3.svg");
    expect(buttonPath("signed", 3, 3)).toBe("/button/v2/signed-3-3.svg");
    expect(buttonPath("none", 4, 5)).toBe("/button/v2/none-0-0.svg");
    expect(buttonPath("partial", 1000, 1500)).toBe("/button/v2/partial-999-999.svg");
    expect(buttonPath("needed", 0, 999)).toBe("/button/v2/needed-0-999.svg");
    expect(buttonPath(buttonState(0, 0, false), 0, 0)).toBe("/button/v2/needed-0-0.svg");
  });

  it("is read back as the state and counts it was written from, for every state the bot can write, needed with nobody counted included", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 999 }), fc.boolean(), (a, b, clear) => {
        const total = Math.max(a, b);
        const signed = clear ? total : Math.min(a, b);
        const state = buttonState(signed, total, clear);
        const s = state === "none" ? 0 : signed;
        expect(parseButtonPath(buttonPath(state, signed, total))).toEqual({ state, signed: s, total: state === "none" ? 0 : total });
      }),
      { seed: 404, numRuns: 1000 },
    );
  });

  it("of each state at its smallest count is read back", () => {
    expect(parseButtonPath("/button/v2/needed-0-1.svg")).toEqual({ state: "needed", signed: 0, total: 1 });
    expect(parseButtonPath("/button/v2/partial-1-2.svg")).toEqual({ state: "partial", signed: 1, total: 2 });
    expect(parseButtonPath("/button/v2/signed-1-1.svg")).toEqual({ state: "signed", signed: 1, total: 1 });
    expect(parseButtonPath("/button/v2/none-0-0.svg")).toEqual({ state: "none", signed: 0, total: 0 });
  });

  it("of the older comments, v1, is still answered", () => {
    expect(parseButtonPath("/button/v1/partial-1-2.svg")).toEqual({ state: "partial", signed: 1, total: 2 });
  });

  it("is refused for a combination the bot never writes", () => {
    for (const path of ["/button/v2/needed-1-2.svg", "/button/v2/partial-0-2.svg", "/button/v2/partial-3-2.svg", "/button/v2/signed-2-3.svg", "/button/v2/signed-0-0.svg", "/button/v2/none-1-1.svg", "/button/v2/none-0-1.svg", "/button/v2/none-1-0.svg"]) {
      expect(parseButtonPath(path), path).toBeNull();
    }
  });

  it("is refused when it is not written as the bot writes it", () => {
    for (const path of ["/button/v3/none-0-0.svg", "/button/v0/none-0-0.svg", "/button/v2/none-00-0.svg", "/button/v2/partial-01-2.svg", "/button/v2/partial-1-1000.svg", "/button/v2/none-0-0.png", "/button/v2/none-0-0.svg/", "/button/v2/other-0-0.svg", "/button/v2/none-0.svg", "/x/button/v2/none-0-0.svg", "/button/v2/NONE-0-0.svg"]) {
      expect(parseButtonPath(path), path).toBeNull();
    }
  });
});

/** The drawing of each state as it is served today: a change of any byte is a change GitHub's cache would never see. */
const PINNED: [ButtonState, number, number, string, number][] = [
  ["needed", 0, 1, "14499d9359c9da5d639bc7be684694e88a07208900c72e6b0361931210436d59", 5172],
  ["needed", 0, 2, "711e953705f0071ca3320809276c7f4df1e836ec91033ff8767f9e7a0726f629", 5804],
  ["needed", 0, 999, "ee20109b9f3c0fa189b8b3c050d5a3b11cac41281cf21607e511640d1c612712", 8685],
  ["partial", 1, 2, "1a04236a5a022faf8587dbc275564f72847ae977290e2955855cdd1e9c99df2d", 5402],
  ["partial", 1, 3, "74dc7718e55947e5890c97ebe29137294ea50faa00ef0784569a2dd299ae7d4f", 5667],
  ["partial", 998, 999, "181ac1e611cdf031883e3fcd65b85606fab251937317f3328afe705952e6eee2", 11980],
  ["signed", 1, 1, "3d5e5f4e506505b1d6000463fb3549595802365ef4a0bd30dfda65b8e25a1726", 4734],
  ["signed", 2, 2, "8f65b90bf711d4ad524d0dd702ede93ea7de7768a722a3771f776d883d5b1ed4", 5999],
  ["signed", 10, 10, "d92a8df8c75e9eae0f97e8babc87b598760dfb8cc335c708560a7ee6f348a738", 5872],
  ["signed", 999, 999, "9f5ad423fd0f4ef73428d5c41d84f1dd6e6a75a3a281fb8ded9e140761e869cb", 11759],
  ["none", 0, 0, "12069278e8b7209b81b0e11e75ba5dd92239cb42dc175b139a14297a6d1a3689", 4249],
];

describe("the drawing of a button", () => {
  it("is the same bytes as when it was first served, for every state", async () => {
    for (const [state, signed, total, hash, length] of PINNED) {
      const svg = buttonSvg(state, signed, total);
      expect([svg.length, await sha256Hex(svg)], `${state}-${signed}-${total}`).toEqual([length, hash]);
    }
  });

  it("is the same bytes when drawn a second time", () => {
    expect(buttonSvg("partial", 1, 3)).toBe(buttonSvg("partial", 1, 3));
  });

  it("for a count is a chip whose size and outlines follow the digits", () => {
    const svg = buttonSvg("partial", 1, 3);
    expect(svg).toContain('<rect width="276" height="47" x=".5" y=".5" fill="none" stroke="#0a0c0f" rx="9.5"/>');
    expect(svg).toContain('<rect width="44.1" height="24" x="216.7" y="12" fill="#00131a" rx="12"/><g fill="#00d2ff" transform="translate(226.7 28.5) scale(0.013)"><path transform="translate(0 0)" d="M265');
    expect(svg).toContain('<path transform="translate(618 0)" d="M540 -729');
    const signed = buttonSvg("signed", 2, 2);
    expect(signed).toMatch(/<path fill="none" stroke="#51cf66" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M\d+(\.\d)? 24l3.5 3.5 6.5-7"\/>/);
    expect(buttonSvg("none", 0, 0)).not.toContain('rx="12"/>');
  });

  it("is a plain SVG of its own size, titled with its words, with nothing that runs or loads", () => {
    fc.assert(
      fc.property(fc.constantFrom<ButtonState>("needed", "partial", "signed", "none"), fc.integer({ min: 0, max: 999 }), fc.integer({ min: 1, max: 999 }), (state, a, b) => {
        const total = state === "none" ? 0 : b;
        const signed = state === "needed" || state === "none" ? 0 : state === "signed" ? total : Math.min(Math.max(a, 1), total);
        const svg = buttonSvg(state, signed, total);
        const m = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="48" viewBox="0 0 (\d+) 48" role="img" aria-labelledby="t">/.exec(svg);
        expect(m?.[1]).toBe(m?.[2]);
        expect(svg.endsWith("</svg>")).toBe(true);
        expect(svg).toContain(`<title id="t">${buttonAlt(state, signed, total)}.</title>`);
        expect(svg).not.toMatch(/<script|<style|<image|<foreignObject|href=|on[a-z]+=|url\((?!#c\))/i);
      }),
      { seed: 2048, numRuns: 200 },
    );
  });

  it("grows with the count it shows", () => {
    const width = (s: string) => Number(/width="(\d+)"/.exec(s)?.[1]);
    expect(width(buttonSvg("partial", 1, 9))).toBeLessThan(width(buttonSvg("partial", 1, 99)));
    expect(width(buttonSvg("partial", 1, 99))).toBeLessThan(width(buttonSvg("partial", 1, 999)));
    expect(width(buttonSvg("signed", 9, 9))).toBeLessThan(width(buttonSvg("signed", 99, 99)));
  });
});
