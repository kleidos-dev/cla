// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The Markdown renderer of the agreement and the notices: each inline rule
 * where it applies and where it does not, the lists as they nest and end,
 * the ids of the headings, and on any text whatever the HTML is the
 * renderer's own, with no link of a kind it does not keep.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { escapeHtml, renderInline, renderMarkdown } from "../../src/markdown";
import { readHtml } from "../readhtml";
import { restoring } from "./support";

restoring();

const html = (md: string) => renderMarkdown(md).html;

describe("escapeHtml", () => {
  it("escapes the five characters that can end a text or a value, and nothing else", () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
    expect(escapeHtml("ñ € \u2028 \\ / ` =")).toBe("ñ € \u2028 \\ / ` =");
  });
});

describe("an inline rule", () => {
  it("a backslash escapes a Markdown character, and is text before anything else or at the end", () => {
    expect(renderInline("\\*a\\* \\[b\\] \\`c\\` \\\\ \\#")).toBe("*a* [b] `c` \\ #");
    expect(renderInline("\\a \\ é\\")).toBe("\\a \\ é\\");
  });

  it("code is a run of backticks closed by one, or text when it is not closed", () => {
    expect(renderInline("`a <b>` c")).toBe("<code>a &lt;b&gt;</code> c");
    expect(renderInline("``x`")).toBe("`<code>x</code>");
    expect(renderInline("a ` b")).toBe("a ` b");
    expect(renderInline("``")).toBe("``");
  });

  it("strong is two stars around text, or text when they close nothing", () => {
    expect(renderInline("**a *b* c**")).toBe("<strong>a <em>b</em> c</strong>");
    expect(renderInline("**a")).toBe("**a");
    expect(renderInline("****")).toBe("****");
    expect(renderInline("*ab**")).toBe("<em>ab</em>*");
  });

  it("emphasis is a star that opens on a word and closes after one", () => {
    expect(renderInline("*a b*")).toBe("<em>a b</em>");
    expect(renderInline("* a*")).toBe("* a*");
    expect(renderInline("*a *")).toBe("*a *");
    expect(renderInline("*a\\*")).toBe("*a*");
    expect(renderInline("*a")).toBe("*a");
    expect(renderInline("** x")).toBe("** x");
    expect(renderInline("a** x")).toBe("a** x");
    expect(renderInline("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("a link keeps its label's formatting, and is only its label when its target is refused or it has none", () => {
    expect(renderInline("[**a** \\] b](https://x.example/p?q=1&r=2)")).toBe('<a href="https://x.example/p?q=1&amp;r=2"><strong>a</strong> ] b</a>');
    expect(renderInline("[a](javascript:x)")).toBe("a");
    expect(renderInline("[](https://x.example/)")).toBe("");
    expect(renderInline("[a](b c)")).toBe("[a](b c)");
    expect(renderInline("[a]")).toBe("[a]");
    expect(renderInline("[x] [a](/b)")).toBe('[x] <a href="/b">a</a>');
  });

  it("a link keeps only a target that is an address of a kept kind from its first character to its last", () => {
    for (const target of ["xhttps://a.example/", "xhttp://a.example/", "xmailto:a@b.example", 'http://a.example/"x', "http://a.example/'x", "http://a.example/<x", 'mailto:a@b.example"x', "MAILTO:a@b.example", "Mailto:a@b.example"]) expect(renderInline(`[x](${target})`), target).toBe("x");
  });

  it("a bare address is a link when a space or a bracket comes before it, without the punctuation after it", () => {
    expect(renderInline("see https://x.example/a.")).toBe('see <a href="https://x.example/a">https://x.example/a</a>.');
    expect(renderInline("(http://x.example/a), b")).toBe('(<a href="http://x.example/a">http://x.example/a</a>), b');
    expect(renderInline("https://x.example/?q=1!")).toBe('<a href="https://x.example/?q=1">https://x.example/?q=1</a>!');
    expect(renderInline("see https://x.example/a, b")).toBe('see <a href="https://x.example/a">https://x.example/a</a>, b');
    expect(renderInline("xhttps://x.example/")).toBe("xhttps://x.example/");
    expect(renderInline("x>https://x.example/")).toBe("x&gt;https://x.example/");
    expect(renderInline("https://")).toBe("https://");
    expect(renderInline("hello")).toBe("hello");
  });
});

describe("a heading", () => {
  it("of levels 2 to 5 after the shift has an id, and of 1 or 6 none", () => {
    const r = renderMarkdown("# a\n## b\n#### c\n##### d", { headingShift: 1, idPrefix: "p" });
    expect(r.headings.map((h) => [h.level, h.id])).toEqual([
      [2, "p-a"],
      [3, "p-b"],
      [5, "p-c"],
    ]);
    expect(r.html).toContain("<h6>d</h6>");
  });

  it("is shifted down by the page's level, never past h6", () => {
    expect(renderMarkdown("# a\n###### b", { headingShift: 1 }).html).toBe("<h2>a</h2>\n<h6>b</h6>");
    expect(renderMarkdown("#### a", { headingShift: 3 }).html).toBe("<h6>a</h6>");
  });

  it("has an id of its prefix and words, cut at sixty characters and never ending in a hyphen", () => {
    const w = "a".repeat(28);
    const r = renderMarkdown(`## ${"word ".repeat(20)}\n## ${w} ${w} ${w}\n## A — b`, { idPrefix: "x" });
    expect(r.headings.map((h) => h.id)).toEqual([`x-${"word-".repeat(11)}wor`, `x-${w}-${w}`, "x-a-b"]);
    expect(r.headings.every((h) => h.id.length <= 60 && !h.id.endsWith("-"))).toBe(true);
    expect(renderMarkdown("## é\n## e", { idPrefix: "" }).headings.map((h) => h.id)).toEqual(["-e", "-e-2"]);
    expect(renderMarkdown("## a\n## a\n## a", { idPrefix: "p" }).headings.map((h) => h.id)).toEqual(["p-a", "p-a-2", "p-a-3"]);
  });
});

describe("a list", () => {
  it("nests by indent and closes each level it leaves", () => {
    expect(html("- a\n  - b\n    - c\n- d")).toBe(["<ul>", "<li>", "a", "<ul>", "<li>", "b", "<ul>", "<li>", "c", "</li>", "</ul>", "</li>", "</ul>", "</li>", "<li>", "d", "</li>", "</ul>"].join("\n"));
  });

  it("changes kind at the same indent, closing the one it was", () => {
    expect(html("- a\n1. b")).toBe(["<ul>", "<li>", "a", "</li>", "</ul>", "<ol>", "<li>", "b", "</li>", "</ol>"].join("\n"));
  });

  it("keeps an indented line in its item, and ends at a line that is not indented", () => {
    expect(html("- a\n  b\nc")).toBe(["<ul>", "<li>", "a<br>\nb", "</li>", "</ul>", "<p>c</p>"].join("\n"));
  });

  it("ends at a heading, and goes on after a blank line", () => {
    expect(html("- a\n\n- b\n# h")).toBe(["<ul>", "<li>", "a", "</li>", "<li>", "b", "</li>", "</ul>", "<h1>h</h1>"].join("\n"));
  });

  it("ends a paragraph at a blank line, or a line of white space only", () => {
    expect(html("a\n\nb")).toBe("<p>a</p>\n<p>b</p>");
    expect(html("a\n  \t \nb")).toBe("<p>a</p>\n<p>b</p>");
  });

  it("keeps only an indented line in an item: a line that starts with text ends the list", () => {
    expect(html("- a\nb c")).toBe(["<ul>", "<li>", "a", "</li>", "</ul>", "<p>b c</p>"].join("\n"));
  });

  it("keeps the white space that opens a line of a paragraph outside a list", () => {
    expect(html("a\n  b")).toBe("<p>a<br>\n  b</p>");
  });

  it("reads carriage returns as line ends", () => {
    expect(html("a\r\nb\rc")).toBe("<p>a<br>\nb<br>\nc</p>");
  });
});

/** Text built from the pieces of Markdown and HTML that matter, so that a few hundred runs meet every rule. */
const markdownish = fc
  .array(fc.constantFrom("# ", "## ", "- ", "  - ", "1. ", "\n", "\n\n", "  ", "*", "**", "`", "\\", "[", "](", ")", "https://x.example/", "javascript:", "mailto:a@b", "/p", "//e", "<script>", "</p>", "&amp;", '"', "'", "a", "ñ", "\u2028", "\r", "\t", " "), { maxLength: 40 })
  .map((parts) => parts.join(""));

describe("rendering any text", () => {
  it("gives only the renderer's own HTML, links of a kept kind and ids of the prefix", () => {
    fc.assert(
      fc.property(fc.oneof(markdownish, fc.string({ maxLength: 60 })), (src) => {
        const r = renderMarkdown(src, { headingShift: 1, idPrefix: "p" });
        const read = readHtml(r.html);
        for (const h of read.hrefs) expect(h).toMatch(/^(?:https:\/\/|http:\/\/|mailto:|\/(?!\/))/);
        expect(read.ids).toEqual(r.headings.map((h) => h.id));
        for (const id of read.ids) expect(id).toMatch(/^p[a-z0-9-]*$/);
      }),
      { seed: 777, numRuns: 400 },
    );
  });

  it("writes no character of the source as markup: every < of the output is the renderer's", () => {
    fc.assert(
      fc.property(markdownish, (src) => {
        const out = renderMarkdown(src).html.replace(/<\/?(?:p|ul|ol|li|h[1-6]|br|strong|em|code|a)(?: href="[^"]*")?>/g, "");
        expect(out).not.toMatch(/[<>"']/);
      }),
      { seed: 778, numRuns: 400 },
    );
  });
});
