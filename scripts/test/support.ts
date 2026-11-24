// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
// What the tests of the two setup scripts share: a GitHub that answers the
// manifest form and the conversion as told and records what it was sent,
// the output of main() caught line by line, the browser's round trip, and
// the calls the fake wrangler and gh logged. Nothing here reaches a network:
// every server listens on 127.0.0.1.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { hookArgs } from "../../tests/tools/node/child.mts";

export const here = dirname(fileURLToPath(import.meta.url));
export const WORKER_DIR = join(here, "..", "..", "worker") + "/";
export const FAKE_WRANGLER = join(here, "fake-wrangler");
export const FAKE_GH = join(here, "fake-gh");
export const BREAK_SPAWN = join(here, "break-spawn.ts");
export const ORG_ID = 357318718;
export const CODE = "abc123def456";

/** What a hostile answer tries on the terminal: a line of its own, colors, an 8-bit control sequence, a line separator, reversed text. */
export const FORGED = "x\r\nForged line \u001b[8m \u009b2J \u2028 \u202e";

/** Nothing of GitHub's answer made a line of its own, and no character of the output is other than visible ASCII. */
export function assertPlain(out: string): void {
  assert.doesNotMatch(out, /[^\n\x20-\x7e]/);
  assert.doesNotMatch(out, /^Forged line/m);
}

export function body(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString()));
    req.on("end", () => r(s));
  });
}

/** One request the mock received. */
export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface GitHub {
  server: Server;
  url: string;
  /** Every conversion request, in order. */
  conversions: Received[];
  /** The manifests the form posted, parsed. */
  manifests: Record<string, unknown>[];
  /** The conversion's answer: its fields over `base`, or the whole raw body. */
  answer: Record<string, unknown> | string;
  status: number;
  base: Record<string, unknown>;
  /** When set, the conversion waits for this before answering, and `asked` resolves as it arrives. */
  hold: Promise<void> | null;
  asked: () => void;
  close: () => Promise<void>;
}

/** A GitHub whose manifest form redirects to the script's callback with CODE and the state it was given. */
export async function mockGitHub(base: Record<string, unknown>): Promise<GitHub> {
  const g: GitHub = { server: null as never, url: "", conversions: [], manifests: [], answer: {}, status: 201, base, hold: null, asked: () => undefined, close: () => Promise.resolve() };
  g.server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, "http://x");
      if (req.method === "POST" && url.pathname === "/organizations/kleidos-dev/settings/apps/new") {
        const form = new URLSearchParams(await body(req));
        const manifest = JSON.parse(form.get("manifest") ?? "{}") as Record<string, unknown>;
        g.manifests.push(manifest);
        res.writeHead(302, { location: `${String(manifest.redirect_url)}?code=${CODE}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` }).end();
        return;
      }
      if (url.pathname.startsWith("/app-manifests/")) {
        g.conversions.push({ method: req.method ?? "", path: url.pathname, headers: req.headers });
        g.asked();
        if (g.hold) await g.hold;
        res.writeHead(g.status, { "content-type": "application/json" });
        res.end(typeof g.answer === "string" ? g.answer : JSON.stringify({ ...g.base, ...g.answer }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", r));
  g.url = `http://127.0.0.1:${(g.server.address() as { port: number }).port}`;
  g.close = () => new Promise<void>((r) => g.server.close(() => r()));
  return g;
}

/** The output of main(), caught: each console.log and console.error call is one line. */
export interface Output {
  lines: { stream: "out" | "err"; text: string }[];
  /** All of it, one line each, as a terminal would show it. */
  text: () => string;
  /** Resolves with the first match of `re` in a line, now or when one is printed. */
  waitFor: (re: RegExp) => Promise<RegExpExecArray>;
}

/** Catches main()'s output for the rest of the test, or until t.mock.restoreAll(). */
export function capture(t: TestContext): Output {
  const lines: Output["lines"] = [];
  const waiting: { re: RegExp; resolve: (m: RegExpExecArray) => void }[] = [];
  const add = (stream: "out" | "err") => (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    lines.push({ stream, text });
    for (const w of [...waiting]) {
      const m = w.re.exec(text);
      if (m) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  t.mock.method(console, "log", add("out"));
  t.mock.method(console, "error", add("err"));
  return {
    lines,
    text: () => lines.map((l) => `${l.text}\n`).join(""),
    waitFor: (re) => {
      for (const l of lines) {
        const m = re.exec(l.text);
        if (m) return Promise.resolve(m);
      }
      return new Promise((resolve) => waiting.push({ re, resolve }));
    },
  };
}

/**
 * The headers of every page a setup script serves, the callback's answers included, whose address holds
 * GitHub's one-time code: kept from every cache and from a Referer, and able to load nothing and to post
 * only to GitHub.
 */
export function assertStrict(headers: Headers, web: string, what = ""): void {
  assert.deepEqual(
    ["content-type", "cache-control", "content-security-policy", "referrer-policy"].map((h) => headers.get(h)),
    ["text/html; charset=utf-8", "no-store", `default-src 'none'; form-action ${web}`, "no-referrer"],
    what,
  );
}

/** The local page as the browser gets it: the form's action and the manifest it posts, unescaped. */
export interface LocalPage {
  status: number;
  headers: Headers;
  html: string;
  action: string;
  manifest: string;
}

const unescape = (s: string): string => s.replace(/&(quot|amp|lt|gt|#39);/g, (_, e: string) => ({ quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" })[e]!);

export async function localPage(base: string): Promise<LocalPage> {
  const res = await fetch(base);
  const html = await res.text();
  const action = unescape(/action="([^"]+)"/.exec(html)![1]!);
  const manifest = unescape(/name="manifest" value="([^"]+)"/.exec(html)![1]!);
  return { status: res.status, headers: res.headers, html, action, manifest };
}

/** The browser: load the page, post its form to "GitHub", follow the redirect back; the callback's answer. */
export async function roundTrip(base: string): Promise<{ status: number; html: string; headers: Headers }> {
  const p = await localPage(base);
  const gh = await fetch(p.action, { method: "POST", body: new URLSearchParams({ manifest: p.manifest }), redirect: "manual" });
  const back = await fetch(gh.headers.get("location")!);
  return { status: back.status, html: await back.text(), headers: back.headers };
}

/** A GET with a Host header of the caller's choosing, which fetch does not allow. */
export function rawGet(url: string, host: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, type: String(res.headers["content-type"]) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * The addresses of this machine other than 127.0.0.1 a server bound to every interface would answer on:
 * the IPv6 loopback and every other address of an interface that is up.
 */
export function otherAddresses(): string[] {
  const all = Object.values(networkInterfaces()).flatMap((list) => list ?? []);
  return ["::1", ...all.map((i) => i.address).filter((a) => a !== "127.0.0.1" && a !== "::1" && !a.startsWith("fe80:"))];
}

/** Whether a TCP connection to the address and port is accepted. */
export function reaches(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** One call a fake logged. */
export interface Call {
  args: string[];
  input: string;
  cwd: string;
}

/** The calls a fake logged, in order: each line is its folder, its input and its arguments, each "-" and base64. */
export function readLog(path: string): Call[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [cwd, input, ...args] = line.split(" ").map((f) => Buffer.from(f.slice(1), "base64").toString("utf8"));
      return { cwd: cwd!, input: input!, args };
    });
}

/** A folder of its own for the test, removed when it ends. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** Sets environment variables for the fakes main() starts (it hands them process.env) until the returned function runs. */
export function setEnv(vars: Record<string, string>): () => void {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  };
}

/** A script run as the owner runs it: a child process in an unrelated directory, with a closed environment. */
export interface Child {
  code: number;
  out: string;
  stdout: string;
  stderr: string;
  work: string;
  tmp: string;
}

/** How a child is started: a module it loads first (--import), and the most file descriptors it may hold (ulimit -n). */
export interface ChildOptions {
  preload?: string;
  descriptors?: number;
}

export async function runChild(script: string, args: string[], env: Record<string, string>, drive?: (base: string) => Promise<void>, opts: ChildOptions = {}): Promise<Child> {
  const work = scratch("cla-work-");
  const tmp = scratch("cla-tmp-");
  const node = [...hookArgs(), ...(opts.preload ? ["--import", opts.preload] : []), script, ...args];
  const [cmd, argv] = opts.descriptors ? ["/bin/sh", ["-c", `ulimit -n ${opts.descriptors} && exec "$0" "$@"`, process.execPath, ...node]] : [process.execPath, node];
  const child = spawn(cmd, argv, { cwd: work, env: { PATH: process.env.PATH ?? "", HOME: work, TMPDIR: tmp, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let stdout = "";
  let stderr = "";
  let opened: ((base: string) => void) | null = null;
  const open = new Promise<string>((r) => (opened = r));
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    stdout += d.toString();
    const m = /Open (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
    if (m) opened?.(m[1]!);
  });
  child.stderr.on("data", (d: Buffer) => {
    out += d.toString();
    stderr += d.toString();
  });
  const exited = new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  const first = await Promise.race([open, exited.then(() => null)]);
  if (first !== null && drive) await drive(first);
  const code = await exited;
  return { code, out, stdout, stderr, work, tmp };
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
