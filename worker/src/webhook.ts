// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import { CHECK_NAME } from "./assess";
import type { ConfiguredEnv } from "./env";
import { log } from "./log";
import type { QueueMessage } from "./messages";
import { isRepoName } from "./messages";
import { allowedAccounts } from "./env";
import { clientIp, must, readCapped, utf8 } from "./util";

export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const SIG = /^sha256=([0-9a-f]{64})$/;

let hmacKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function keyFor(secret: string): Promise<CryptoKey> {
  if (hmacKey?.secret !== secret) hmacKey = { secret, key: crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]) };
  return hmacKey.key;
}

function hexToBytes(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** HMAC-SHA256 of the raw body, compared by crypto.subtle.verify (constant time). */
export async function verifySignature(secret: string, header: string | null, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const m = header ? SIG.exec(header) : null;
  if (!m) return false;
  return crypto.subtle.verify("HMAC", await keyFor(secret), hexToBytes(must(m[1])), body);
}

type Payload = Record<string, unknown>;

function obj(v: unknown): Payload | null {
  return typeof v === "object" && v !== null ? (v as Payload) : null;
}

function repoOf(p: Payload): string | null {
  const name = obj(p.repository)?.full_name;
  return typeof name === "string" && isRepoName(name) ? name : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

export interface MapOptions {
  appId: number;
  /** The register's repository: its Record runs re-evaluate the pull request they recorded. */
  registry: string;
  /** Accounts whose repositories are served; deliveries from any other are dropped. */
  allowed: Set<number>;
}

const RECORD_TITLE = /^Record sign ([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9}) [1-9][0-9]{0,14}$/;

/** What an event asks for, as identifier-only queue messages. Anything else is ignored. */
export function mapEvent(event: string, p: Payload, o: MapOptions): QueueMessage[] {
  const action = typeof p.action === "string" ? p.action : "";
  if (event !== "installation" && event !== "installation_repositories") {
    // A repository event from an account that is not served is dropped at once (anybody can install a public app).
    const owner = num(obj(obj(p.repository)?.owner)?.id);
    if (!owner || !o.allowed.has(owner)) return [];
  }
  switch (event) {
    case "pull_request": {
      const repo = repoOf(p);
      const pr = num(obj(p.pull_request)?.number);
      if (!repo || !pr) return [];
      if (["opened", "reopened", "synchronize", "closed"].includes(action)) return [{ kind: "evaluate", repo, pr }];
      if (action === "edited" && obj(obj(p.changes)?.base)) return [{ kind: "evaluate", repo, pr }];
      return [];
    }
    case "check_run": {
      const run = obj(p.check_run);
      const repo = repoOf(p);
      if (action !== "rerequested" || !run || !repo) return [];
      if (num(obj(run.app)?.id) !== o.appId || run.name !== CHECK_NAME) return [];
      const m = typeof run.external_id === "string" ? /^(\d{1,12})#(\d{1,10})$/.exec(run.external_id) : null;
      if (!m || Number(m[1]) !== num(obj(p.repository)?.id)) return [];
      return [{ kind: "evaluate", repo, pr: Number(m[2]) }];
    }
    case "workflow_run": {
      const run = obj(p.workflow_run);
      const repo = repoOf(p);
      if (!run || !repo) return [];
      if (repo === o.registry && run.event === "workflow_dispatch") {
        // A Record run that wrote a signature: re-evaluate its pull request now rather than at the next cron.
        if (action !== "completed" || run.conclusion !== "success" || run.path !== ".github/workflows/record.yml" || run.head_branch !== "main") return [];
        const m = typeof run.display_title === "string" ? RECORD_TITLE.exec(run.display_title) : null;
        return m ? [{ kind: "evaluate", repo: must(m[1]), pr: Number(m[2]) }] : [];
      }
      if (run.event !== "pull_request") return [];
      const sha = typeof run.head_sha === "string" && /^[0-9a-f]{40}$/.test(run.head_sha) ? run.head_sha : null;
      const heldRun = run.conclusion === "action_required" || run.status === "action_required" || run.status === "waiting";
      if (!sha || !(action === "requested" || (action === "completed" && heldRun))) return [];
      return [{ kind: "held", repo, sha }];
    }
    case "installation":
    case "installation_repositories": {
      const id = num(obj(p.installation)?.id);
      if (!id || !["created", "added", "new_permissions_accepted", "unsuspend"].includes(action)) return [];
      return [{ kind: "installation", installation: id }];
    }
    default:
      return [];
  }
}

export async function handleWebhook(req: Request, env: ConfiguredEnv): Promise<Response> {
  const body = await readCapped(req, MAX_WEBHOOK_BYTES);
  if (!body) return new Response("too large\n", { status: 413 });
  if (!(await verifySignature(env.WEBHOOK_SECRET, req.headers.get("x-hub-signature-256"), body))) {
    // Only unsigned traffic is limited by address: GitHub's deliveries share addresses with everybody's.
    const limited = await env.RL_WEBHOOK.limit({ key: `ip:${clientIp(req)}` });
    log("webhook refused", { reason: "signature" });
    return limited.success ? new Response("bad signature\n", { status: 401 }) : new Response("rate limited\n", { status: 429, headers: { "retry-after": "60" } });
  }
  const event = req.headers.get("x-github-event") ?? "";
  const delivery = req.headers.get("x-github-delivery") ?? "";
  const target = req.headers.get("x-github-hook-installation-target-id");
  if (!/^[a-z_]{1,64}$/.test(event) || !/^[0-9a-f-]{8,64}$/i.test(delivery)) return new Response("bad headers\n", { status: 400 });
  if (target !== null && target !== env.APP_ID) {
    log("webhook refused", { reason: "app_id", delivery });
    return new Response("wrong app\n", { status: 400 });
  }
  let payload: Payload;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!obj(parsed)) throw new Error("not an object");
    payload = parsed as Payload;
  } catch {
    return new Response("bad json\n", { status: 400 });
  }
  // Signed deliveries are limited per installation, so a stranger's installation cannot spend the budget of ours.
  const installation = num(obj(payload.installation)?.id);
  const limited = await env.RL_WEBHOOK.limit({ key: `installation:${installation ?? 0}` });
  if (!limited.success) return new Response("rate limited\n", { status: 429, headers: { "retry-after": "60" } });
  const messages = mapEvent(event, payload, { appId: Number(env.APP_ID), registry: env.REGISTRY_REPO, allowed: allowedAccounts(env) });
  if (messages.length) await env.CLA_QUEUE.sendBatch(messages.map((m) => ({ body: m })));
  log("webhook", { event, action: typeof payload.action === "string" ? payload.action : undefined, delivery, count: messages.length });
  return new Response("accepted\n", { status: 202 });
}
