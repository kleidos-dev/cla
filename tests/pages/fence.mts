// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The browser's only way out: a local proxy whose every CONNECT ends in a
 * local TLS server, where each host the test serves has its handler and
 * every other request is answered 502 and kept in `stray`. Playwright's
 * route() is no fence (a redirect the browser follows itself goes past it),
 * and nothing here reaches a network. The certificate is made for the run
 * by openssl and thrown away; the browser is told to accept it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Handler = (url: URL, init: { method: string; headers: Headers; body: Buffer | undefined }) => Promise<Response> | Response;

export interface Fence {
  /** Every request the browser made to a host the test does not serve, or not through CONNECT. */
  stray: string[];
  /** The proxy to give the browser. */
  server: string;
  close: () => Promise<void>;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** A throwaway self-signed certificate. */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "cla-fence-"));
  try {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=fence.invalid"], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`openssl could not make the fence's certificate: ${made.stderr}`);
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HOP = /^(host|connection|content-length|accept-encoding|transfer-encoding|upgrade|te|keep-alive|proxy-connection)$/i;

export async function fence(hosts: Record<string, Handler>): Promise<Fence> {
  const stray: string[] = [];
  // A Map, not the object: a Host header such as "constructor" must find nothing.
  const routes = new Map(Object.entries(hosts));
  const tls = createTlsServer(certificate(), (req, res) => {
    void (async () => {
      const host = req.headers.host ?? "";
      const handler = routes.get(host);
      if (!handler) {
        stray.push(`${req.method ?? ""} https://${host}${req.url ?? ""}`);
        res.writeHead(502).end();
        return;
      }
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!HOP.test(req.rawHeaders[i]!)) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const method = req.method ?? "GET";
      const got = await body(req);
      const r = await handler(new URL(req.url ?? "/", `https://${host}`), { method, headers, body: method === "GET" || method === "HEAD" ? undefined : got });
      const out: string[] = [];
      for (const [k, v] of r.headers) if (!/^(set-cookie|content-encoding|transfer-encoding|content-length)$/.test(k)) out.push(k, v);
      for (const c of r.headers.getSetCookie()) out.push("set-cookie", c);
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
    })();
  });
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  const proxy = createServer((req, res) => {
    stray.push(`plain ${req.method ?? ""} ${req.url ?? ""}`);
    res.writeHead(502).end();
  });
  proxy.on("connect", (_req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const up = connect((tls.address() as AddressInfo).port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  return {
    stray,
    server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    close: async () => {
      proxy.closeAllConnections();
      tls.closeAllConnections();
      await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => tls.close(r))]);
    },
  };
}
