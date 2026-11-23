// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The sign button of the bot's comment, served as an SVG image.
 *
 * GitHub shows a comment image through its camo proxy, which caches by URL.
 * So the state and the count are in the URL, the content of a URL never
 * changes (it is served immutable), and the bot rewrites its comment with
 * the URL of the new state: a change of state is a new URL, never a wait
 * for a cache to expire. The version changes when the drawing does: `v2`
 * is the English-only drawing; the bilingual `v1` addresses of older
 * comments are still answered, with the current drawing.
 *
 * The words are drawn as outlines (an <img> loads no web font): the three
 * drawings under assets/button/ give the English words of each state, and
 * glyphs.json the Kleidos Mono outlines of the count.
 */
import glyphs from "./assets/button/glyphs.json";
import neededSvg from "./assets/button/needed.svg";
import noneSvg from "./assets/button/none.svg";
import signedSvg from "./assets/button/signed.svg";

export type ButtonState = "needed" | "partial" | "signed" | "none";

export const BUTTON_VERSION = "v2";
const MAX_COUNT = 999;
const H = 48;
const TILE = 48;
const PAD = 16;
const STAGE = "#0a0c0f";

interface Look {
  fill: string;
  stroke: string;
  chip: { fg: string; bg: string; check: boolean } | null;
}

const LOOK: Record<ButtonState, Look> = {
  needed: { fill: "#00d2ff", stroke: STAGE, chip: { fg: "#00131a", bg: "#00d2ff", check: false } },
  partial: { fill: "#00d2ff", stroke: STAGE, chip: { fg: "#00131a", bg: "#00d2ff", check: false } },
  signed: { fill: "#51cf66", stroke: STAGE, chip: { fg: "#0c0f13", bg: "#51cf66", check: true } },
  none: { fill: "#191d24", stroke: "rgb(255 255 255 / 40%)", chip: null },
};

const SOURCE: Record<ButtonState, string> = { needed: neededSvg, partial: neededSvg, signed: signedSvg, none: noneSvg };

interface Parts {
  mark: string;
  words: string;
  textEnd: number;
}

const parsed = new Map<string, Parts>();

/** The mark group, the word outlines and where the words end, read once from a drawing. */
function parts(svg: string): Parts {
  const hit = parsed.get(svg);
  if (hit) return hit;
  const mark = /<g transform="matrix\(\.34 0 0 \.34 24 24\)">[\s\S]*?<\/g>/.exec(svg)?.[0];
  const outline = svg.indexOf('rx="9.5"/>');
  const chip = /<rect width="[\d.]+" height="24" x="([\d.]+)" y="12"[^>]*rx="12"\/>/.exec(svg);
  const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1]);
  if (!mark || outline < 0 || !Number.isFinite(width)) throw new Error("button drawing not understood");
  const end = chip ? chip.index : svg.lastIndexOf("</svg>");
  const words = svg.slice(outline + 'rx="9.5"/>'.length, end);
  if (!/^(?:<path fill="#[0-9a-f]{6}" d="[^"]+"\/>)+$/.test(words)) throw new Error("button words not understood");
  const textEnd = chip ? Number(chip[1]) - PAD : width - PAD;
  const p = { mark, words, textEnd };
  parsed.set(svg, p);
  return p;
}

const table = glyphs as { unitsPerEm: number; size: number; glyphs: Record<string, { advance: number; d: string }> };

function count(text: string, x: number, baseline: number, fill: string): { svg: string; width: number } {
  const s = table.size / table.unitsPerEm;
  let cx = 0;
  let paths = "";
  for (const ch of text) {
    const g = table.glyphs[ch];
    if (!g) throw new Error("glyph missing");
    paths += `<path transform="translate(${cx} 0)" d="${g.d}"/>`;
    cx += g.advance;
  }
  return { svg: `<g fill="${fill}" transform="translate(${r(x)} ${r(baseline)}) scale(${s})">${paths}</g>`, width: cx * s };
}

function r(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** The words of a state's image, in English: the comment's alt text and the SVG's title. */
export function buttonAlt(state: ButtonState, signed: number, total: number): string {
  const authors = total === 1 ? "author" : "authors";
  if (state === "none") return "No signature needed on this pull request";
  if (state === "signed") return total === 1 ? "Kleidos Contributor Agreement signed by its author" : `Kleidos Contributor Agreement signed by all ${total} authors`;
  return `Sign the Kleidos Contributor Agreement: ${signed} of ${total} ${authors} signed`;
}

/** The state of a pull request as the button draws it. */
export function buttonState(signed: number, total: number, clear: boolean): ButtonState {
  if (clear) return total === 0 ? "none" : "signed";
  return signed === 0 ? "needed" : "partial";
}

/** The path of a state's image; the counts are part of it, so every state has its own URL. */
export function buttonPath(state: ButtonState, signed: number, total: number): string {
  const s = state === "none" ? 0 : Math.min(signed, MAX_COUNT);
  const t = state === "none" ? 0 : Math.min(total, MAX_COUNT);
  return `/button/${BUTTON_VERSION}/${state}-${s}-${t}.svg`;
}

/**
 * Parses a button path; only the combinations the bot can write are served,
 * everything else is null (404). `v1` is the address of older comments.
 */
export function parseButtonPath(path: string): { state: ButtonState; signed: number; total: number } | null {
  const m = /^\/button\/v[12]\/(needed|partial|signed|none)-(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})\.svg$/.exec(path);
  if (!m) return null;
  const state = m[1] as ButtonState;
  const signed = Number(m[2]);
  const total = Number(m[3]);
  const ok = { needed: signed === 0, partial: signed >= 1 && signed <= total, signed: signed >= 1 && signed === total, none: signed === 0 && total === 0 }[state];
  return ok ? { state, signed, total } : null;
}

/** The SVG of a state: no script, no style element, no external reference. */
export function buttonSvg(state: ButtonState, signed: number, total: number): string {
  const look = LOOK[state];
  const p = parts(SOURCE[state]);
  let chip = "";
  let after = p.textEnd;
  if (look.chip) {
    const cx = p.textEnd + PAD;
    const tx = cx + 10 + (look.chip.check ? 14 : 0);
    const c = count(`${signed}/${total}`, tx, H / 2 + 4.5, look.chip.bg);
    const w = 10 + (look.chip.check ? 14 : 0) + c.width + 10;
    chip = `<rect width="${r(w)}" height="24" x="${r(cx)}" y="12" fill="${look.chip.fg}" rx="12"/>`;
    if (look.chip.check) chip += `<path fill="none" stroke="${look.chip.bg}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M${r(cx + 11)} 24l3.5 3.5 6.5-7"/>`;
    chip += c.svg;
    after = cx + w;
  }
  const w = Math.round(after + PAD);
  const title = `${buttonAlt(state, signed, total)}.`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-labelledby="t">` +
    `<!--SPDX-FileCopyrightText: 2026 José M. Requena Plens--><!--SPDX-License-Identifier: GPL-3.0-or-later-->` +
    `<!--Words drawn as outlines from Kleidos Sans and Kleidos Mono (Mona Sans, SIL OFL 1.1).-->` +
    `<title id="t">${title}</title>` +
    `<defs><clipPath id="c"><rect width="${w}" height="${H}" rx="10"/></clipPath></defs>` +
    `<g clip-path="url(#c)"><path fill="${look.fill}" d="M0 0h${w}v${H}H0z"/><path fill="${STAGE}" d="M0 0h${TILE}v${H}H0z"/>${p.mark}</g>` +
    `<rect width="${w - 1}" height="${H - 1}" x=".5" y=".5" fill="none" stroke="${look.stroke}" rx="9.5"/>` +
    p.words +
    chip +
    `</svg>`
  );
}
