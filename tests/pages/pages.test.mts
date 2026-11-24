// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The sign pages in a real browser (chromium), served by the deployed
 * Worker (harness.mts) at its real origin through the fence (fence.mts):
 * every page in English and Spanish, light and dark, at 390 px and on a
 * desktop, with scripts on and off. Each page: its status, `lang` and
 * policy, no script and no console error, no sideways scroll, the same DOM
 * with scripts off, every control named, the keyboard in document order,
 * and no axe violation but those tests/exclusions/pages.toml lists; then
 * the whole sign-in round trip against a fake GitHub, and the session
 * cookie as the browser keeps it. Nothing leaves the machine: a request to
 * any other host is a stray.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Browser, BrowserContext, Page } from "../../worker/node_modules/playwright-core/index.js";
import { ROOT, listed } from "../workflows/support.mts";
import { fence } from "./fence.mts";
import type { Fence } from "./fence.mts";
import { BUILD_COMMIT, ORIGIN, SANDBOX, cleanup, config, fake, gh, outside, server } from "./harness.mts";

const fromWorker = createRequire(join(ROOT, "worker", "package.json"));
const { chromium } = fromWorker("playwright-core") as typeof import("../../worker/node_modules/playwright-core/index.js");
const { AxeBuilder } = fromWorker("@axe-core/playwright") as typeof import("../../worker/node_modules/@axe-core/playwright/dist/index.js");

const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const alice = { id: 123456, login: "alice", type: "User" as const };
/** Who GitHub's fake sign-in page says the visitor is; each round trip has its own, as each account its own limits. */
let signer: { id: number; login: string; type: "User" } = alice;
const PR = 7;
const SIGN = `/sign/${SANDBOX}/${PR}`;

/** The pages a visitor can land on, signed out, and the status each answers. */
const PAGES: [string, number][] = [
  ["/agreement", 200],
  ["/agreement/entity", 200],
  ["/privacy", 200],
  ["/setup", 200],
  [SIGN, 200],
];
/** The addresses that only send the visitor on, and where. */
const MOVED: [string, string][] = [
  ["/", "/agreement"],
  ["/agreement/es", "/agreement?lang=es"],
  ["/privacy/es", "/privacy?lang=es"],
];

interface Variant {
  name: string;
  js: boolean;
  scheme: "light" | "dark";
  width: number;
  height: number;
  locale: string;
  lang: "en" | "es";
}
const VARIANTS: Variant[] = [];
for (const js of [true, false])
  for (const scheme of ["light", "dark"] as const)
    for (const [width, height] of [
      [390, 844],
      [1280, 800],
    ] as const)
      for (const [locale, lang] of [
        ["en-US", "en"],
        ["es-ES", "es"],
      ] as const)
        VARIANTS.push({ name: `${lang}, ${scheme}, ${width} px, scripts ${js ? "on" : "off"}`, js, scheme, width, height, locale, lang });

/** Each look of the pages (language, scheme and width), with scripts on and then off: one test holds both. */
const LOOKS = VARIANTS.filter((v) => v.js).map((on) => [on, VARIANTS.find((off) => !off.js && off.scheme === on.scheme && off.width === on.width && off.lang === on.lang)!] as const);

let browser: Browser;
let wall: Fence;
let ip = 0;

before(async () => {
  await server.listen();
  gh.pulls.set(`${SANDBOX}#${PR}`, { repo: SANDBOX, number: PR, state: "open", merged: false, locked: false, user: alice, head: { sha: fake.sha(), repo: "alice/cla-sandbox" }, files: [{ filename: "README.md" }], commits: [fake.commit(alice)] });
  wall = await fence([
    ["cla.kleidos.dev", (url, init) => {
      // Each context is its own visitor, so the rate limits of one never reach another.
      init.headers.set("cf-connecting-ip", `203.0.113.${(ip % 250) + 1}`);
      return server.fetch(url.href, { method: init.method, headers: init.headers, redirect: "manual", ...(init.body ? { body: init.body } : {}) });
    }],
    ["github.com", (url) => {
      if (url.pathname !== "/login/oauth/authorize") return new Response("", { status: 404 });
      const code = gh.issueCode(signer, url.searchParams.get("code_challenge") ?? "", url.searchParams.get("client_id") ?? "");
      return new Response(null, { status: 302, headers: { location: `${ORIGIN}/auth/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
    }],
  ]);
  browser = await chromium.launch({ proxy: { server: wall.server } });
});

after(async () => {
  await browser.close();
  await wall.close();
  await server.close();
  cleanup();
});

async function open(v: Variant): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  ip++;
  const ctx = await browser.newContext({ javaScriptEnabled: v.js, colorScheme: v.scheme, viewport: { width: v.width, height: v.height }, locale: v.locale, serviceWorkers: "block", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}

/** The controls a keyboard reaches, in document order, and the order Tab really takes. */
async function keyboard(page: Page): Promise<{ order: string[]; tabbed: string[] }> {
  const describe = "e => (e.tagName + ' ' + (e.getAttribute('href') || e.getAttribute('name') || e.textContent.trim().slice(0, 40)))";
  const order = (await page.$$eval("a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]", new Function("els", `return els.filter(e => !e.disabled && e.tabIndex >= 0 && e.checkVisibility({ visibilityProperty: true })).map(${describe})`) as (els: unknown[]) => string[])).filter(Boolean);
  const tabbed: string[] = [];
  await page.focus("body");
  for (let i = 0; i < order.length; i++) {
    await page.keyboard.press("Tab");
    tabbed.push(await page.evaluate(new Function(`const e = document.activeElement; return (${describe})(e);`) as () => string));
  }
  return { order, tabbed };
}

/** Posts the agreement form and waits for the page that answers it. */
async function submit(page: Page): Promise<void> {
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/agree" && r.request().method() === "POST");
  await page.locator('form#accept button[type="submit"]').click();
  await answered;
  await page.waitForLoadState("load");
}

/** Everything one page must be, in one variant; `dom` holds what each page looked like with scripts on, for the same page with them off. */
async function checkPage(v: Variant, page: Page, errors: string[], path: string, status: number, dom: Map<string, string>): Promise<void> {
  const res = await page.goto(ORIGIN + path);
  assert.ok(res, path);
  assert.equal(res.status(), status, path);
  const headers = await res.allHeaders();
  assert.equal(headers["content-security-policy"], CSP, path);
  assert.equal(headers["content-type"], "text/html; charset=utf-8", path);
  assert.equal(await page.getAttribute("html", "lang"), v.lang, path);
  assert.equal(await page.locator("script").count(), 0, `${path} has a script`);
  assert.ok((await page.title()).length > 0, `${path} has no title`);
  const html = await page.content();
  if (v.js) {
    dom.set(path, html);
    // On a phone the page fits its width: nothing to scroll sideways.
    const fits = (await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")) as [number, number];
    assert.ok(fits[0] <= fits[1], `${path} is ${fits[0]} px wide in a viewport of ${fits[1]}`);
    const k = await keyboard(page);
    assert.deepEqual(k.tabbed, k.order, `${path}: Tab does not follow the document`);
    assert.equal(await page.locator("[tabindex]:not([tabindex='0']):not([tabindex='-1'])").count(), 0, path);
  } else {
    // The pages run no script, so what the browser built must not depend on one.
    assert.equal(html, dom.get(path), `${path}: another DOM with scripts off`);
  }
  for (const control of await page.locator("input:not([type=hidden]), button, select, textarea").all()) {
    const name = (await control.getAttribute("aria-label")) ?? (await control.textContent()) ?? "";
    const id = await control.getAttribute("id");
    const named = name.trim() !== "" || (id !== null && (await page.locator(`label[for="${id}"]`).count()) > 0) || (await control.locator("xpath=ancestor::label").count()) > 0;
    assert.ok(named, `${path}: a control with no name`);
  }
  assert.deepEqual(errors, [], path);
}

describe("every page, in every variant", () => {
  for (const [on, off] of LOOKS) {
    it(`${on.lang}, ${on.scheme}, ${on.width} px, scripts on and then off`, async () => {
      const dom = new Map<string, string>();
      for (const v of [on, off]) {
        const { ctx, page, errors } = await open(v);
        try {
          for (const [path, status] of PAGES) await checkPage(v, page, errors, path, status, dom);
          for (const [from, to] of MOVED) {
            await page.goto(ORIGIN + from);
            assert.equal(page.url(), ORIGIN + to, from);
          }
          const missing = await page.goto(`${ORIGIN}/no-such-page`);
          assert.deepEqual([missing?.status(), (await missing?.allHeaders())?.["content-type"]], [404, "text/plain; charset=utf-8"]);
          assert.deepEqual(errors.filter((e) => !/404/.test(e)), [], v.name);
        } finally {
          await ctx.close();
        }
      }
      assert.deepEqual(wall.stray, []);
    });
  }

  it("no axe violation but the listed ones, each still there", async () => {
    // Every page in every look with scripts on, here and not gathered by the tests above: this one passes alone.
    const violations = new Set<string>();
    for (const [v] of LOOKS) {
      const { ctx, page } = await open(v);
      try {
        for (const [path] of PAGES) {
          await page.goto(ORIGIN + path);
          for (const x of (await new AxeBuilder({ page }).analyze()).violations) violations.add(`${x.id} ${path}`);
        }
      } finally {
        await ctx.close();
      }
    }
    const list = listed("pages");
    assert.deepEqual([...violations].sort(), list.map((e) => `${e.text} ${e.function}`).sort());
    for (const e of list) assert.ok(e.kind === "axe rule" && ["unreachable", "equivalent", "boundary", "tool"].includes(e.reason) && e.why.trim() !== "", `${e.text} ${e.function}`);
  });

  it("the Worker asked GitHub nothing the real one would refuse, and nothing else at all", () => {
    assert.deepEqual(gh.strays, []);
    assert.deepEqual(outside, []);
  });
});

describe("signing in", () => {
  const round = [
    { v: VARIANTS.find((x) => x.js && x.lang === "en" && x.width === 1280 && x.scheme === "light")!, who: alice },
    { v: VARIANTS.find((x) => !x.js && x.lang === "es" && x.width === 390 && x.scheme === "dark")!, who: { id: 234567, login: "bob", type: "User" as const } },
  ];
  for (const { v, who } of round) {
    it(`goes to GitHub and back, signed in, with the session in a __Host- cookie (${v.name})`, async () => {
      signer = who;
      gh.pulls.get(`${SANDBOX}#${PR}`)!.commits.push(fake.commit(who));
      const { ctx, page, errors } = await open(v);
      const DISPATCH = /\/actions\/workflows\/record\.yml\/dispatches$/;
      const earlier = gh.seen(DISPATCH).length;
      try {
        await page.goto(ORIGIN + SIGN);
        assert.deepEqual(await ctx.cookies(), []);
        await page.locator('form[action^="/auth/login"] button, a[href^="/auth/login"]').first().click();
        await page.waitForURL(`${ORIGIN}${SIGN}*`);
        const cookies = await ctx.cookies();
        assert.equal(cookies.length, 1, JSON.stringify(cookies.map((c) => c.name)));
        const c = cookies[0]!;
        // The OAuth transaction's cookie is gone; the session's is host-only, secure, out of scripts' reach, with an end.
        assert.deepEqual([c.name, c.domain, c.path, c.secure, c.httpOnly, c.sameSite, c.expires > 0], ["__Host-cla", "cla.kleidos.dev", "/", true, true, "Lax", true]);
        assert.equal(await page.getAttribute("html", "lang"), v.lang);
        assert.equal(await page.locator("script").count(), 0);
        assert.match(await page.content(), new RegExp(`@${who.login}\\b`));
        // The agreement form posts to this origin, with its token, and the sentence is its checkbox's label.
        const form = page.locator("form#accept");
        assert.deepEqual([await form.getAttribute("action"), await form.getAttribute("method")], ["/agree#accept", "post"]);
        assert.equal(await form.locator('input[type="hidden"][name="csrf"]').count(), 1);
        if (v.js) assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map((x) => x.id), [], "the signed-in page");
        assert.equal((await page.locator('label[for="accept-box"]').textContent())?.trim(), config.versions["2"]!.sentence);
        // Without the box ticked nothing is recorded, and the page says so where the box is.
        await submit(page);
        assert.equal(await page.locator("#accept-error[role=alert]").count(), 1);
        assert.equal(await page.locator('#accept-box[aria-invalid="true"]').count(), 1);
        assert.equal(gh.seen(DISPATCH).length, earlier);
        // Ticked, the signature goes to the recorder: one dispatch of record.yml for alice.
        await page.locator("#accept-box").check();
        await submit(page);
        const dispatched = gh.seen(DISPATCH).slice(earlier);
        assert.equal(dispatched.length, 1);
        const { ref, inputs } = dispatched[0]!.body as { ref: string; inputs: Record<string, string> };
        assert.equal(ref, "main");
        assert.match(inputs.signin_token ?? "", /^ghu_/);
        assert.deepEqual({ ...inputs, signin_token: "" }, { kind: "signin", repo: SANDBOX, pr: String(PR), github_id: String(who.id), version: "2", lang: v.lang, site_commit: BUILD_COMMIT, signin_token: "" });
        // Back on the sign page, thanked, in the visitor's language.
        assert.equal(page.url(), `${ORIGIN}${SIGN}?lang=${v.lang}#accept`);
        assert.equal(await page.locator("h1").first().textContent(), v.lang === "en" ? "Thank you for signing" : "Gracias por firmar");
        if (v.js) assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map((x) => x.id), [], "the signed page");
        assert.equal(await page.getAttribute("html", "lang"), v.lang);
        assert.equal(await page.locator("script").count(), 0);
        // The one failed load is the refusal of the unticked form, a 400 by design.
        assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
        // Only GitHub's sign-in page was asked for at github.com; everything else stayed at the origin.
        assert.deepEqual(wall.stray, []);
        assert.deepEqual(outside, []);
        assert.deepEqual(gh.strays, []);
      } finally {
        await ctx.close();
      }
    });
  }
});

describe("the harness", () => {
  it("serves the build this suite named, and the fence lets nothing else out", async () => {
    const health = (await (await server.fetch(`${ORIGIN}/healthz`)).json()) as { commit: string };
    assert.equal(health.commit, BUILD_COMMIT);
    const { ctx, page } = await open(VARIANTS[0]!);
    try {
      const before = wall.stray.length;
      const res = await page.goto("https://example.com/").catch(() => null);
      assert.ok(res === null || res.status() === 502);
      assert.deepEqual(wall.stray.slice(before), ["GET https://example.com/"]);
      wall.stray.length = before;
    } finally {
      await ctx.close();
    }
  });
});
