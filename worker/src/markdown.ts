// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { must, stripEnd } from "./util";
/**
 * A small Markdown renderer for the subset the agreement texts and notices
 * use: headings, paragraphs (soft line breaks kept as <br>), nested bullet
 * and numbered lists, strong and emphasis, inline code, backslash escapes,
 * links and bare URLs. A link keeps only an http(s), mailto or same-site
 * target. The source is parsed into nodes whose text is plain text, and the
 * nodes are serialized in one place: every text and every attribute value is
 * escaped there, and a tag is one of the fixed names below, so no character
 * of the source can become markup. Nothing is ever read back out of HTML:
 * what needs the words of a heading takes them from its nodes. A test reads
 * the HTML back and compares the words with the source, so the rendering can
 * neither drop nor change one.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => must(({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]));
}

export interface RenderOptions {
  /** Added to every heading level (the page has its own <h1>). */
  headingShift?: number;
  /** Gives every h2 to h5 an id (this prefix and a slug of its text) so a contents list can link it. */
  idPrefix?: string;
  /** Rewrites of relative link targets, such as PRIVACY.es.md → /privacy/es. */
  links?: Record<string, string>;
}

/** An inline node: plain text, never HTML, or an element with its children. */
type Inline = string | { tag: "a" | "code" | "em" | "strong"; href?: string; children: Inline[] };

/** What an inline rule found at a position: its nodes and where the source goes on. */
interface Match {
  nodes: Inline[];
  end: number;
}

type InlineRule = (src: string, at: number, opts: RenderOptions) => Match | null;

function safeHref(href: string, opts: RenderOptions): string | null {
  if (opts.links && Object.hasOwn(opts.links, href)) return must(opts.links[href]);
  if (/^https:\/\/[^\s"'<>]+$/.test(href) || /^http:\/\/[^\s"'<>]+$/.test(href)) return href;
  if (/^mailto:[^\s"'<>]+$/.test(href)) return href;
  if (/^\/(?!\/)[A-Za-z0-9/_.#-]*$/.test(href)) return href;
  return null;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>|]/;

const escapeRule: InlineRule = (src, at) => {
  const next = src[at + 1];
  return next !== undefined && ESCAPABLE.test(next) ? { nodes: [next], end: at + 2 } : null;
};

const codeRule: InlineRule = (src, at) => {
  const m = /^`([^`]+)`/.exec(src.slice(at));
  return m && { nodes: [{ tag: "code", children: [must(m[1])] }], end: at + m[0].length };
};

const linkRule: InlineRule = (src, at, opts) => {
  const m = /^\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/.exec(src.slice(at));
  if (!m) return null;
  const href = safeHref(must(m[2]), opts);
  const label = parseInline(must(m[1]), opts);
  const nodes: Inline[] = href !== null && label.length > 0 ? [{ tag: "a", href, children: label }] : label;
  return { nodes, end: at + m[0].length };
};

const strongRule: InlineRule = (src, at, opts) => {
  if (src[at + 1] !== "*") return null;
  const end = src.indexOf("**", at + 2);
  return end > at + 2 ? { nodes: [{ tag: "strong", children: parseInline(src.slice(at + 2, end), opts) }], end: end + 2 } : null;
};

const emphasisRule: InlineRule = (src, at, opts) => {
  if (src[at + 1] === " ") return null;
  // A second star closes nothing: it is at at + 1, which the check below refuses.
  const end = src.indexOf("*", at + 1);
  if (end <= at + 1 || src[end - 1] === " " || src[end - 1] === "\\") return null;
  return { nodes: [{ tag: "em", children: parseInline(src.slice(at + 1, end), opts) }], end: end + 1 };
};

const bareUrlRule: InlineRule = (src, at) => {
  if (at > 0 && !/[\s(]/.test(must(src[at - 1]))) return null;
  const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(src.slice(at));
  return m && { nodes: [{ tag: "a", href: m[0], children: [m[0]] }], end: at + m[0].length };
};

/** The rules that can apply at a character, in order; at any other character the source is text. */
const INLINE_RULES: ReadonlyMap<string, readonly InlineRule[]> = new Map([
  ["\\", [escapeRule]],
  ["`", [codeRule]],
  ["[", [linkRule]],
  ["*", [strongRule, emphasisRule]],
  ["h", [bareUrlRule]],
]);

function matchInline(src: string, at: number, opts: RenderOptions): Match | null {
  for (const rule of INLINE_RULES.get(must(src[at])) ?? []) {
    const m = rule(src, at, opts);
    if (m) return m;
  }
  return null;
}

/** Inline Markdown to nodes. */
function parseInline(src: string, opts: RenderOptions): Inline[] {
  const nodes: Inline[] = [];
  let text = "";
  let i = 0;
  while (i < src.length) {
    const m = matchInline(src, i, opts);
    if (!m) {
      text += must(src[i]);
      i++;
      continue;
    }
    if (text) nodes.push(text);
    text = "";
    nodes.push(...m.nodes);
    i = m.end;
  }
  if (text) nodes.push(text);
  return nodes;
}

/** The one place inline nodes become HTML. */
function inlineHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      if (typeof n === "string") return escapeHtml(n);
      const href = n.href === undefined ? "" : ` href="${escapeHtml(n.href)}"`;
      return `<${n.tag}${href}>${inlineHtml(n.children)}</${n.tag}>`;
    })
    .join("");
}

/** The words of inline nodes, without their formatting. */
function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : inlineText(n.children))).join("");
}

/** Inline Markdown to HTML. */
export function renderInline(src: string, opts: RenderOptions = {}): string {
  return inlineHtml(parseInline(src, opts));
}

export interface Heading {
  level: number;
  id: string;
  html: string;
}

export interface Rendered {
  html: string;
  /** The headings that have an id, in order. */
  headings: Heading[];
}

/** A heading's text as an id fragment; the characters HTML escapes are dropped, any other run outside a-z and 0-9 is one hyphen. */
function slug(text: string): string {
  return text
    .replace(/[&<>"']/g, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The id of a heading: its prefix and slug, numbered when an earlier heading has it already. */
function headingId(prefix: string, text: string, seen: Set<string>): string {
  const base = `${prefix}-${slug(text)}`.slice(0, 60).replace(/-$/, "");
  let id = base;
  for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
  seen.add(id);
  return id;
}

interface ListFrame {
  tag: "ul" | "ol";
  indent: number;
}

/** What ends a line inside one of the source's lines, which are cut at line feeds only: such a line is neither a heading nor a list item. */
const LINE_END = /[\u2028\u2029]/;

/** A heading line: its level, and its text without the number signs that may close it. */
function headingLine(line: string): { level: number; text: string } | null {
  const mark = /^#{1,6}(?=\s)/.exec(line);
  if (!mark) return null;
  const text = stripEnd(line.slice(mark[0].length).trim(), "#").trimEnd();
  return LINE_END.test(text) ? null : { level: mark[0].length, text };
}

/** A list item's first line: how far its marker is indented, its list's tag and its text. */
function listItemLine(line: string): { indent: number; tag: ListFrame["tag"]; text: string } | null {
  const m = /^(\s*)([-*+]|\d{1,3}\.)(?=\s)/.exec(line);
  if (!m) return null;
  const text = line.slice(m[0].length).trimStart();
  return LINE_END.test(text) ? null : { indent: must(m[1]).length, tag: /\d/.test(must(m[2])) ? "ol" : "ul", text };
}

/** Block Markdown to HTML, and its headings when idPrefix gives them ids. */
export function renderMarkdown(src: string, opts: RenderOptions = {}): Rendered {
  const shift = opts.headingShift ?? 0;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const headings: Heading[] = [];
  const ids = new Set<string>();
  let para: string[] = [];
  // Every open list has an open item: an item is closed only with its list or by the next item.
  const lists: ListFrame[] = [];

  const closePara = () => {
    if (para.length) {
      const inner = para.map((l) => renderInline(l, opts)).join("<br>\n");
      out.push(lists.length ? inner : `<p>${inner}</p>`);
      para = [];
    }
  };
  const closeLists = (toDepth: number) => {
    closePara();
    while (lists.length > toDepth) {
      out.push("</li>", `</${must(lists.pop()).tag}>`);
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      closePara();
      continue;
    }
    const h = headingLine(line);
    if (h) {
      closeLists(0);
      const level = Math.min(6, h.level + shift);
      const nodes = parseInline(h.text, opts);
      const html = inlineHtml(nodes);
      let attr = "";
      if (opts.idPrefix !== undefined && level >= 2 && level <= 5) {
        const id = headingId(opts.idPrefix, inlineText(nodes), ids);
        headings.push({ level, id, html });
        attr = ` id="${escapeHtml(id)}"`;
      }
      out.push(`<h${level}${attr}>${html}</h${level}>`);
      continue;
    }
    const li = listItemLine(line);
    if (li) {
      closePara();
      const { indent, tag, text } = li;
      while (lists.length && must(lists[lists.length - 1]).indent > indent) {
        out.push("</li>", `</${must(lists.pop()).tag}>`);
      }
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${tag}>`);
        lists.push({ tag, indent });
      } else {
        out.push("</li>");
        if (top.tag !== tag) {
          out.push(`</${must(lists.pop()).tag}>`, `<${tag}>`);
          lists.push({ tag, indent });
        }
      }
      out.push("<li>");
      para.push(text);
      continue;
    }
    if (lists.length && /^\s+/.test(line)) {
      para.push(line.trim());
      continue;
    }
    if (lists.length) closeLists(0);
    para.push(line);
  }
  closeLists(0);
  return { html: out.join("\n"), headings };
}
