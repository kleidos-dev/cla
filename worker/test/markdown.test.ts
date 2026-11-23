// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { AGREEMENTS } from "../src/agreement";
import { renderInline, renderMarkdown } from "../src/markdown";
import { must } from "../src/util";
import { htmlWords, readHtml } from "./readhtml";

/** Markup an attacker would want on the page, none of it Markdown: all of it is text. */
const HOSTILE = [
  "<script>alert(1)</script>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<<script>script>alert(1)",
  "<script",
  "<script src=//evil.example/x.js",
  "</h2><script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  "<!--<script>-->alert(1)<!---->",
  "<a href=javascript:alert(1)>x</a>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&amp;lt;script&amp;gt;",
  "&#60;script&#62;",
  "\" onmouseover=alert(1) x=\"",
  "' onmouseover=alert(1) x='",
  "</li></ul><style>@import</style>",
  "<h2 id=x>not a heading</h2>",
];

describe("the test's HTML reader", () => {
  it("reads what the renderer writes", () => {
    expect(readHtml('<h2 id="p-a">A &amp; b</h2>\n<p>x<br>\n<a href="/y?a=1&amp;b=2"><em>z</em></a></p>')).toEqual({ text: " A & b \n x \nz ", tags: ["h2", "p", "br", "a", "em"], ids: ["p-a"], hrefs: ["/y?a=1&b=2"] });
  });

  it("refuses any other markup", () => {
    // Each is well formed but for one thing, so nothing else can refuse it.
    const bad = [
      // A tag: one of the renderer's, whole, in lower case, closed by its own.
      "<script>x</script>", "<b>x</b>", "<h7>x</h7>", "<img>", "<P>x</P>", "<p", "<p >x</p>", "<br/>", "<!-- x -->", "<p>", "</p>", "<p><em></p></em>",
      // An attribute: an id on h2 to h5 or an href on a link, once, and none on a closing tag.
      "<p onclick=x>y</p>", '<p id="x">y</p>', '<h1 id="x">y</h1>', '<h6 id="x">y</h6>', '<h2 href="/x">y</h2>', '<a href="/x" onclick="y">z</a>', '<h2 id="x" id="y">z</h2>', '<h2 id="x">y</h2 id="x">',
      // An attribute's value: every character escaped that has to be.
      '<a href="/x?a=1&b=2">z</a>', '<a href="/x?a&ampb">z</a>', '<a href="/x<y">z</a>', '<a href="/x>y">z</a>', '<a href="/x\'y">z</a>', '<a href="/x"">y</a>',
      // Text: the same.
      "a < b", "a > b", "a & b", "&lt", "&nbsp;", 'say "x"', "it's",
    ];
    for (const html of bad) expect(() => readHtml(html), html).toThrow();
  });
});

describe("block lines", () => {
  it("a heading is one to six number signs, a space and text, less the number signs that close it", () => {
    const html = (md: string) => renderMarkdown(md).html;
    for (const [md, out] of [
      ["# a", "<h1>a</h1>"],
      ["######\ta", "<h6>a</h6>"],
      ["##  a b  ##  ", "<h2>a b</h2>"],
      ["# a#", "<h1>a</h1>"],
      ["# a # #", "<h1>a #</h1>"],
      ["# # a", "<h1># a</h1>"],
      ["# ##", "<h1></h1>"],
      ["# ", "<h1></h1>"],
    ] as const)
      expect(html(md), md).toBe(out);
    for (const md of ["#", "#a", "####### a", " # a", "# a\u2028b"]) expect(html(md), md).toMatch(/^<p>/);
  });

  it("a list item is a marker, a space and text", () => {
    const html = (md: string) => renderMarkdown(md).html;
    for (const mark of ["-", "*", "+"]) expect(html(`${mark}  a -  b `), mark).toBe("<ul>\n<li>\na -  b \n</li>\n</ul>");
    for (const mark of ["1.", "12.", "123."]) expect(html(`  ${mark}\ta`), mark).toBe("<ol>\n<li>\na\n</li>\n</ol>");
    expect(html("- ")).toBe("<ul>\n<li>\n\n</li>\n</ul>");
    for (const md of ["-", "-a", "1.a", "1234. a", "1) a", "- a\u2029b"]) expect(html(md), md).toMatch(/^<p>/);
  });
});

describe("hostile Markdown", () => {
  it("is text wherever it stands: no tag, no attribute and no id comes from the source", () => {
    const places: [string, (s: string) => string, string[]][] = [
      ["a paragraph", (s) => s, ["p"]],
      ["an h2, with an id", (s) => `# ${s}`, ["h2"]],
      ["an h6, without one", (s) => `##### ${s}`, ["h6"]],
      ["a list item", (s) => `- ${s}`, ["ul", "li"]],
      ["strong", (s) => `**${s}**`, ["p", "strong"]],
      ["emphasis", (s) => `*${s}*`, ["p", "em"]],
      ["code", (s) => `\`${s}\``, ["p", "code"]],
      ["a link's label", (s) => `[${s}](https://a.example/)`, ["p", "a"]],
      ["a refused link's label", (s) => `[${s}](javascript:x)`, ["p"]],
      ["emphasis in a heading", (s) => `## **${s}**`, ["h3", "strong"]],
    ];
    for (const s of HOSTILE)
      for (const [where, put, tags] of places) {
        const r = renderMarkdown(put(s), { headingShift: 1, idPrefix: "p" });
        const read = readHtml(r.html);
        expect(read.tags, `${s} in ${where}`).toEqual(tags);
        expect(read.text.trim(), `${s} in ${where}`).toBe(s.trim());
        expect(read.ids, `${s} in ${where}`).toEqual(r.headings.map((h) => h.id));
        for (const id of read.ids) expect(id, `${s} in ${where}`).toMatch(/^p[a-z0-9-]*$/);
        expect(read.hrefs.filter((h) => h !== "https://a.example/"), `${s} in ${where}`).toEqual([]);
      }
  });

  it("keeps a link's target in its attribute, and only a target of a kept kind", () => {
    const hrefs = (md: string) => readHtml(renderMarkdown(md).html).hrefs;
    for (const target of ["javascript:alert`1`", "JavaScript:x", "java\tscript:x", "\u0001javascript:x", "&#106;avascript:x", "data:text/html,<script>", "vbscript:x", "//evil.example", "//evil.example/sign", "///evil.example", "/\\evil.example", "https:evil.example", "https://", 'https://a.example/"onmouseover=x', "https://a.example/'x", "https://a.example/<script>", "mailto:", 'mailto:a@b.c"x', "x.html", "../x", "#x"])
      expect(hrefs(`[x](${target})`), target).toEqual([]);
    for (const target of ["https://a.example/?a=1&b=2", "http://a.example/", "mailto:a@b.example", "/", "/privacy", "/sign/a/b#c"]) expect(hrefs(`[x](${target})`), target).toEqual([target]);
    // A bare URL ends where text that is not a URL starts.
    expect(hrefs('https://a.example/"><script>alert(1)</script>')).toEqual(["https://a.example/"]);
    expect(hrefs("https://a.example/x\"onmouseover='y")).toEqual(["https://a.example/x\"onmouseover='y"]);
    expect(hrefs("https://a.example/?a=1&lt;b")).toEqual(["https://a.example/?a=1&lt;b"]);
    expect(hrefs("xhttps://a.example/")).toEqual([]);
  });

  it("looks a relative target up among the caller's rewrites alone", () => {
    const links = { "PRIVACY.md": "/privacy?lang=en" };
    expect(readHtml(renderInline("[x](PRIVACY.md)", { links })).hrefs).toEqual(["/privacy?lang=en"]);
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) expect(renderInline(`[x](${name})`, { links }), name).toBe("x");
  });

  it("gives every h2 to h5 an id of its own from its words, formatting aside", () => {
    const md = "# One\n\n## It's **bold** & *new*: `x<y>`\n\n## It's bold & new: x<y>\n\n## Ñandú\n\n## <script>\n\n## ***\n\n##### Deep";
    const r = renderMarkdown(md, { headingShift: 1, idPrefix: "p" });
    expect(r.headings.map((h) => [h.level, h.id])).toEqual([
      [2, "p-one"],
      [3, "p-its-bold-new-xy"],
      [3, "p-its-bold-new-xy-2"],
      [3, "p-nandu"],
      [3, "p-script"],
      [3, "p"],
    ]);
    expect(readHtml(r.html).ids).toEqual(r.headings.map((h) => h.id));
    expect(renderMarkdown("# One\n\n###### Six", { idPrefix: "p" })).toEqual({ html: "<h1>One</h1>\n<h6>Six</h6>", headings: [] });
    expect(renderMarkdown("## One")).toEqual({ html: "<h2>One</h2>", headings: [] });
  });

  it("stays well formed, its words kept, at every cut of a hostile document and of a published text", () => {
    const hostile = `# ${HOSTILE.join(" ")}\n\n${HOSTILE.map((s) => `- **${s}**\n  1. [${s}](https://a.example/"${s})`).join("\n")}\n\n${HOSTILE.join("\n")}`;
    const published = must(must(AGREEMENTS[2])["addendum.md"]);
    for (const [src, step] of [[hostile, 1], [published, 97]] as const)
      for (let n = 1; n <= src.length; n += step) {
        const r = renderMarkdown(src.slice(0, n), { headingShift: 1, idPrefix: "p" });
        const read = readHtml(r.html);
        expect(read.ids).toEqual(r.headings.map((h) => h.id));
        expect(read.hrefs.every((h) => /^(?:https?:\/\/|mailto:|\/(?!\/))/.test(h))).toBe(true);
      }
    expect(htmlWords(renderMarkdown(HOSTILE.join("\n")).html)).toEqual(HOSTILE.join(" ").split(/\s+/).filter(Boolean));
  });
});
