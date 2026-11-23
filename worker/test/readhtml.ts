// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { must } from "../src/util";

/**
 * Everything the Markdown renderer may write: one of its tags, with no
 * attribute but an id on a heading and an href on a link, one of the five
 * escapes, or text without a character that has to be escaped.
 */
const TOKEN = /<(?<close>\/?)(?<tag>p|ul|ol|li|h[1-6]|br|strong|em|code|a)(?: (?<name>id|href)="(?<value>[^"'<>]*)")?>|&(?<escape>amp|lt|gt|quot|#39);|(?<text>[^<>&"']+)/y;

const ESCAPES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["#39", "'"]]);
const BLOCK = /^(?:p|ul|ol|li|h[1-6]|br)$/;
const ATTRIBUTE_OF = new Map([["id", /^h[2-5]$/], ["href", /^a$/]]);

export interface ReadHtml {
  /** The text a reader sees, a block's edge as a space. */
  text: string;
  /** The tags, in order. */
  tags: string[];
  ids: string[];
  /** The link targets, decoded as a browser decodes them. */
  hrefs: string[];
}

/** An attribute value as a browser reads it; throws at an ampersand that starts none of the five escapes. */
function decode(value: string): string {
  return value.replace(/&([^;]*;?)/g, (whole, name: string) => {
    const c = name.endsWith(";") ? ESCAPES.get(name.slice(0, -1)) : undefined;
    if (c === undefined) throw new Error(`not one of the renderer's escapes: ${whole}`);
    return c;
  });
}

/**
 * Reads the renderer's HTML from its first character to its last. Throws at
 * the first one that is not a tag, an escape or text the renderer may write,
 * and at a tag that does not close the one it should: so what it returns is
 * the whole page, and nothing in it is markup of any other kind.
 */
export function readHtml(html: string): ReadHtml {
  const out: ReadHtml = { text: "", tags: [], ids: [], hrefs: [] };
  const open: string[] = [];
  let at = 0;
  while (at < html.length) {
    TOKEN.lastIndex = at;
    const g = TOKEN.exec(html)?.groups;
    if (!g) throw new Error(`not the renderer's HTML at ${at}: ${html.slice(at, at + 40)}`);
    at = TOKEN.lastIndex;
    const { tag, name, value } = g;
    if (tag === undefined) {
      out.text += g.text ?? must(ESCAPES.get(must(g.escape)));
      continue;
    }
    if (BLOCK.test(tag)) out.text += " ";
    if (g.close) {
      if (name !== undefined || open.pop() !== tag) throw new Error(`</${tag}> closes nothing at ${at}`);
      continue;
    }
    out.tags.push(tag);
    if (tag !== "br") open.push(tag);
    if (name === undefined) continue;
    if (!must(ATTRIBUTE_OF.get(name)).test(tag)) throw new Error(`${name} on <${tag}> at ${at}`);
    (name === "id" ? out.ids : out.hrefs).push(decode(must(value)));
  }
  if (open.length) throw new Error(`left open: ${open.join(", ")}`);
  return out;
}

/** The words a reader sees. */
export function htmlWords(html: string): string[] {
  return readHtml(html).text.split(/\s+/).filter(Boolean);
}
