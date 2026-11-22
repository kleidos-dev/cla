// SPDX-License-Identifier: MIT
/**
 * A small Markdown renderer for the subset the agreement texts and notices
 * use: headings, paragraphs (soft line breaks kept as <br>), nested bullet
 * and numbered lists, strong and emphasis, inline code, backslash escapes,
 * links and bare URLs. Every character of the source reaches the page
 * escaped; a link keeps only an http(s), mailto or same-site target. A test
 * strips the tags again and compares the words with the source, so the
 * rendering can neither drop nor change one.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface RenderOptions {
  /** Added to every heading level (the page has its own <h1>). */
  headingShift?: number;
  /** Rewrites of relative link targets, such as PRIVACY.es.md → /privacy/es. */
  links?: Record<string, string>;
}

function safeHref(href: string, opts: RenderOptions): string | null {
  const mapped = opts.links?.[href];
  if (mapped) return mapped;
  if (/^https:\/\/[^\s"'<>]+$/.test(href) || /^http:\/\/[^\s"'<>]+$/.test(href)) return href;
  if (/^mailto:[^\s"'<>]+$/.test(href)) return href;
  if (/^\/[A-Za-z0-9/_.#-]*$/.test(href)) return href;
  return null;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>|]/;

/** Inline Markdown to HTML. */
export function renderInline(src: string, opts: RenderOptions = {}): string {
  let out = "";
  let i = 0;
  let text = "";
  const flush = () => {
    out += escapeHtml(text);
    text = "";
  };
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      text += src[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === "`") {
      const m = /^`([^`]+)`/.exec(rest);
      if (m) {
        flush();
        out += `<code>${escapeHtml(m[1]!)}</code>`;
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/.exec(rest);
      if (m) {
        flush();
        const href = safeHref(m[2]!, opts);
        const label = m[1]!;
        if (label.length > 0) out += href ? `<a href="${escapeHtml(href)}">${renderInline(label, opts)}</a>` : renderInline(label, opts);
        i += m[0].length;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out += `<strong>${renderInline(src.slice(i + 2, end), opts)}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== " " && src[i + 1] !== "*") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && src[end - 1] !== " " && src[end - 1] !== "\\") {
        flush();
        out += `<em>${renderInline(src.slice(i + 1, end), opts)}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (ch === "h" && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest);
      if (m) {
        flush();
        out += `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

interface ListFrame {
  tag: "ul" | "ol";
  indent: number;
}

/** Block Markdown to HTML. */
export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  const shift = opts.headingShift ?? 0;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const lists: ListFrame[] = [];
  let itemOpen = false;

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
      if (itemOpen) out.push("</li>");
      out.push(`</${lists.pop()!.tag}>`);
      itemOpen = lists.length > 0;
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      closePara();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      closeLists(0);
      const level = Math.min(6, h[1]!.length + shift);
      out.push(`<h${level}>${renderInline(h[2]!, opts)}</h${level}>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,3}\.)\s+(.*)$/.exec(line);
    if (li) {
      closePara();
      const indent = li[1]!.length;
      const tag = /\d/.test(li[2]!) ? "ol" : "ul";
      while (lists.length && lists[lists.length - 1]!.indent > indent) {
        if (itemOpen) out.push("</li>");
        out.push(`</${lists.pop()!.tag}>`);
        itemOpen = true;
      }
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${tag}>`);
        lists.push({ tag, indent });
      } else {
        if (itemOpen) out.push("</li>");
        if (top.tag !== tag) {
          out.push(`</${lists.pop()!.tag}>`, `<${tag}>`);
          lists.push({ tag, indent });
        }
      }
      out.push("<li>");
      itemOpen = true;
      para.push(li[3]!);
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
  return out.join("\n");
}
