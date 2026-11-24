// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The webhook sender: anybody on the internet can post to /webhook. Only a
 * delivery signed with the secret is read; its headers, its JSON and its
 * installation are checked before anything is queued, and what is queued is
 * identifiers only. mapEvent is the whole table from an event to the
 * messages it asks for.
 */
import { describe, expect, it, vi } from "vitest";
import { CHECK_NAME } from "../../src/assess";
import worker from "../../src/index";
import type { MapOptions } from "../../src/webhook";
import { MAX_WEBHOOK_BYTES, mapEvent, verifySignature } from "../../src/webhook";
import { must, utf8 } from "../../src/util";
import { APP_ID, ORG_ID, REGISTRY } from "../fakegh";
import { ORIGIN, SANDBOX, WEBHOOK_SECRET, call, lines, queueDown, restoring, sign, webhook, world } from "./support";
import type { World } from "./support";

restoring();

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DELIVERY = "3f1c2a90-aaaa-bbbb-cccc-000000000001";
const owner = { id: ORG_ID };
const repository = { full_name: SANDBOX, id: 77, owner };
const OPTS: MapOptions = { appId: APP_ID, registry: REGISTRY, allowed: new Set([ORG_ID]) };

/** A delivery with every header and the body as given, signed unless a signature is given. */
async function deliver(w: World, body: string, headers: Record<string, string | null> = {}): Promise<Response> {
  const h: Record<string, string> = {};
  const all: Record<string, string | null> = { "x-github-event": "pull_request", "x-github-delivery": DELIVERY, "x-github-hook-installation-target-id": String(APP_ID), "x-hub-signature-256": await sign(WEBHOOK_SECRET, body), "cf-connecting-ip": "198.51.100.9", ...headers };
  for (const [k, v] of Object.entries(all)) if (v !== null) h[k] = v;
  return call(w, "/webhook", { method: "POST", headers: h, body });
}

describe("an unsigned delivery", () => {
  it("is refused before its body is read as JSON, with nothing queued, nothing of it logged and nothing asked of GitHub", async () => {
    const w = await world();
    const r = await deliver(w, '{"action":"opened","secret_field":"ghu_leak"}', { "x-hub-signature-256": `sha256=${"0".repeat(64)}` });
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("bad signature\n");
    expect(w.queue.sent).toEqual([]);
    expect(w.gh.requests).toEqual([]);
    expect(lines(w)).toEqual([{ msg: "webhook refused", reason: "signature" }]);
    expect(w.logs.join("\n")).not.toContain("leak");
  });

  // A header value reaches the Worker without the white space around it (the Fetch standard strips it), so that is no way to be wrong.
  it("is refused for every way a signature header can be wrong", async () => {
    const w = await world();
    const body = "{}";
    const good = await sign(WEBHOOK_SECRET, body);
    const hex = good.slice("sha256=".length);
    for (const signature of [null, "", "sha256=", `sha1=${hex}`, `SHA256=${hex}`, `sha256=${hex.toUpperCase()}`, `sha256=${hex.slice(1)}`, `sha256=${hex}0`, `sha256=${hex.slice(0, 63)}g`, `sha256=${hex.slice(0, 62)}${hex.slice(63)}${hex.slice(62, 63)}`, `x${good}`, await sign("another-secret", body)]) {
      const r = await deliver(w, body, { "x-hub-signature-256": signature });
      expect(r.status, String(signature)).toBe(401);
    }
    expect(w.queue.sent).toEqual([]);
  });

  it("spends the budget of its address, and is answered 429 once that is spent", async () => {
    const w = await world();
    const limiter = must(w.limiters.RL_WEBHOOK);
    await deliver(w, "{}", { "x-hub-signature-256": "sha256=00" });
    await deliver(w, "{}", { "x-hub-signature-256": "sha256=00", "cf-connecting-ip": null });
    limiter.allow = false;
    const r = await deliver(w, "{}", { "x-hub-signature-256": "sha256=00" });
    expect(limiter.keys).toEqual(["ip:198.51.100.9", "ip:unknown", "ip:198.51.100.9"]);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.text()).toBe("rate limited\n");
  });
});

describe("a signed delivery", () => {
  it("is refused when the event or the delivery header is missing or malformed, before any budget is spent", async () => {
    const w = await world();
    const refused: Record<string, string | null>[] = [
      { "x-github-event": null },
      { "x-github-event": "" },
      { "x-github-event": "pull-request" },
      { "x-github-event": "Pull_request" },
      { "x-github-event": "a".repeat(65) },
      { "x-github-delivery": null },
      { "x-github-delivery": "abcdef1" },
      { "x-github-delivery": "abcdefg1" },
      { "x-github-delivery": "a".repeat(65) },
    ];
    for (const headers of refused) {
      const r = await deliver(w, "{}", headers);
      expect(r.status, JSON.stringify(headers)).toBe(400);
      expect(await r.text()).toBe("bad headers\n");
    }
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual([]);
    expect(w.queue.sent).toEqual([]);
  });

  it("is read with an event of 64 letters and a delivery of 8 to 64 hex digits in either case", async () => {
    const w = await world();
    for (const headers of [{ "x-github-event": "a".repeat(64) }, { "x-github-delivery": "ABCDEF12" }, { "x-github-delivery": "a".repeat(64) }]) {
      expect((await deliver(w, "{}", headers)).status, JSON.stringify(headers)).toBe(202);
    }
  });

  it("is refused when it names another app, and the refusal names the delivery only", async () => {
    const w = await world();
    const r = await deliver(w, '{"installation":{"id":1}}', { "x-github-hook-installation-target-id": "42" });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("wrong app\n");
    expect(lines(w)).toEqual([{ msg: "webhook refused", reason: "app_id", delivery: DELIVERY }]);
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual([]);
  });

  it("is refused when it names the app's id in any other spelling: the id is compared as text", async () => {
    const w = await world();
    for (const target of [`0${APP_ID}`, `${APP_ID}.0`, `+${APP_ID}`, `${APP_ID}0`]) {
      const r = await deliver(w, '{"installation":{"id":1}}', { "x-github-hook-installation-target-id": target });
      expect([r.status, await r.text()], target).toEqual([400, "wrong app\n"]);
    }
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual([]);
  });

  it("is read when it names no app at all", async () => {
    const w = await world();
    expect((await deliver(w, "{}", { "x-github-hook-installation-target-id": null })).status).toBe(202);
  });

  it("is refused when its body is not a JSON object, with no budget spent", async () => {
    const w = await world();
    // JSON's own blanks are space, tab and the two line ends: no other space, nor a second byte order mark, comes before the object.
    for (const body of ["{not json", "", "7", '"text"', "null", "true", "\u00a0{}", "{}\u2028", "\ufeff\ufeff{}"]) {
      const r = await deliver(w, body);
      expect(r.status, body).toBe(400);
      expect(await r.text()).toBe("bad json\n");
    }
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual([]);
  });

  it("that is a JSON array is read as an object with no field, and asks for nothing", async () => {
    const w = await world();
    const r = await deliver(w, "[1,2]");
    expect(r.status).toBe(202);
    expect(w.queue.sent).toEqual([]);
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual(["installation:0"]);
  });

  it("spends the budget of its installation, or of installation 0 when it names none that is valid", async () => {
    const w = await world();
    for (const installation of [{ id: 66 }, { id: "66" }, { id: -1 }, null, undefined]) await deliver(w, JSON.stringify({ installation }));
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual(["installation:66", "installation:0", "installation:0", "installation:0", "installation:0"]);
  });

  it("over its installation's budget is answered 429 with nothing queued", async () => {
    const w = await world();
    must(w.limiters.RL_WEBHOOK).allow = false;
    const r = await webhook(w, "pull_request", { action: "opened", pull_request: { number: 7 }, repository, installation: { id: 1 } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.text()).toBe("rate limited\n");
    expect(w.queue.sent).toEqual([]);
  });

  it("queues the messages it asks for in one batch, and logs the event, its action, the delivery and the count only", async () => {
    const w = await world();
    const r = await webhook(w, "pull_request", { action: "opened", pull_request: { number: 7, title: "ghu_secret" }, repository, installation: { id: 1 } }, { delivery: DELIVERY });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("accepted\n");
    expect(w.queue.sent).toEqual([{ body: { kind: "evaluate", repo: SANDBOX, pr: 7 } }]);
    expect(lines(w)).toEqual([{ msg: "webhook", event: "pull_request", action: "opened", delivery: DELIVERY, count: 1 }]);
  });

  it("is not accepted when the queue refuses its messages, so GitHub records the delivery as failed", async () => {
    const w = await world();
    queueDown(w);
    const body = JSON.stringify({ action: "opened", pull_request: { number: 7 }, repository, installation: { id: 1 } });
    const headers = { "x-github-event": "pull_request", "x-github-delivery": DELIVERY, "x-github-hook-installation-target-id": String(APP_ID), "x-hub-signature-256": await sign(WEBHOOK_SECRET, body) };
    const r = await worker.fetch(new Request(`${ORIGIN}/webhook`, { method: "POST", headers, body }), w.env);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("internal error\n");
    expect(w.queue.sent).toEqual([]);
    expect(lines(w)).toEqual([{ msg: "unhandled", reason: "Error" }]);
  });

  it("with no action, or one that is not text, is logged without one, and queues nothing at all", async () => {
    const w = await world();
    const batches = vi.spyOn(w.queue, "sendBatch");
    await webhook(w, "ping", { zen: "x" }, { delivery: DELIVERY });
    await webhook(w, "ping", { action: 7 }, { delivery: DELIVERY });
    expect(lines(w)).toEqual([
      { msg: "webhook", event: "ping", delivery: DELIVERY, count: 0 },
      { msg: "webhook", event: "ping", delivery: DELIVERY, count: 0 },
    ]);
    expect(w.queue.sent).toEqual([]);
    expect(batches).not.toHaveBeenCalled();
  });

  it("delivered twice is queued twice: a repeated delivery only makes the state be computed again", async () => {
    const w = await world();
    const payload = { action: "synchronize", pull_request: { number: 7 }, repository, installation: { id: 1 } };
    await webhook(w, "pull_request", payload, { delivery: DELIVERY });
    await webhook(w, "pull_request", payload, { delivery: DELIVERY });
    expect(w.queue.sent.map((s) => s.body)).toEqual([
      { kind: "evaluate", repo: SANDBOX, pr: 7 },
      { kind: "evaluate", repo: SANDBOX, pr: 7 },
    ]);
  });
});

describe("a delivery too large to read", () => {
  it("is answered 413 by its declared length, before its signature is checked or a budget spent", async () => {
    const w = await world();
    const r = await call(w, "/webhook", { method: "POST", headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1), "x-github-event": "ping", "x-github-delivery": DELIVERY }, body: "{}" });
    expect(r.status).toBe(413);
    expect(await r.text()).toBe("too large\n");
    expect(w.limiters.RL_WEBHOOK?.keys).toEqual([]);
    expect(w.queue.sent).toEqual([]);
  });

  it("is read when it is exactly at the limit", async () => {
    const w = await world();
    const body = `{"pad":"${"x".repeat(MAX_WEBHOOK_BYTES - 10)}"}`;
    expect(body.length).toBe(MAX_WEBHOOK_BYTES);
    expect((await deliver(w, body)).status).toBe(202);
  });
});

describe("verifySignature", () => {
  it("is true for the HMAC of the body under the secret, and false for any other secret or body", async () => {
    const body = utf8('{"a":1}');
    const good = await sign("first-secret", '{"a":1}');
    expect(await verifySignature("first-secret", good, body)).toBe(true);
    expect(await verifySignature("second-secret", good, body)).toBe(false);
    expect(await verifySignature("first-secret", good, utf8('{"a":2}'))).toBe(false);
    // The key is kept per secret: after the second secret, the first is read again, not the one in hand.
    expect(await verifySignature("first-secret", good, body)).toBe(true);
    expect(await verifySignature("second-secret", await sign("second-secret", '{"a":1}'), body)).toBe(true);
  });

  it("reads every byte of the signature: one changed anywhere is refused", async () => {
    const body = utf8("{}");
    const good = await sign("s", "{}");
    for (const at of [7, 8, 38, 70]) {
      const flipped = good.slice(0, at) + (good[at] === "0" ? "1" : "0") + good.slice(at + 1);
      expect(await verifySignature("s", flipped, body), String(at)).toBe(false);
    }
    expect(await verifySignature("s", null, body)).toBe(false);
  });
});

describe("mapEvent, the table from an event to its messages", () => {
  const pr = (action: string, extra: Record<string, unknown> = {}) => mapEvent("pull_request", { action, pull_request: { number: 7 }, repository, ...extra }, OPTS);

  it("re-evaluates a pull request that is opened, reopened, pushed to or closed", () => {
    for (const action of ["opened", "reopened", "synchronize", "closed"]) expect(pr(action), action).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: 7 }]);
  });

  it("re-evaluates an edit only when the base changed", () => {
    expect(pr("edited", { changes: { base: { ref: { from: "dev" } } } })).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: 7 }]);
    expect(pr("edited", { changes: { title: { from: "x" } } })).toEqual([]);
    expect(pr("edited", { changes: { base: null } })).toEqual([]);
    expect(pr("edited")).toEqual([]);
    expect(pr("labeled", { changes: { base: { ref: { from: "dev" } } } })).toEqual([]);
  });

  it("ignores every other pull request action, and an action that is not text", () => {
    for (const action of ["labeled", "assigned", "review_requested", "ready_for_review", "", "OPENED"]) expect(pr(action), action).toEqual([]);
    expect(mapEvent("pull_request", { action: ["opened"], pull_request: { number: 7 }, repository }, OPTS)).toEqual([]);
  });

  it("ignores a pull request event whose repository or number is not valid", () => {
    for (const r of [{ ...repository, full_name: "not a repo" }, { ...repository, full_name: 7 }, { ...repository, full_name: [SANDBOX] }, { owner }]) expect(mapEvent("pull_request", { action: "opened", pull_request: { number: 7 }, repository: r }, OPTS)).toEqual([]);
    for (const number of [0, -7, 1.5, "7", null]) expect(mapEvent("pull_request", { action: "opened", pull_request: { number }, repository }, OPTS)).toEqual([]);
    expect(mapEvent("pull_request", { action: "opened", repository }, OPTS)).toEqual([]);
  });

  it("drops an event of a repository whose owner is not served, or names no owner", () => {
    for (const o of [{ id: 4242 }, { id: String(ORG_ID) }, { id: 0 }, {}, null]) expect(mapEvent("pull_request", { action: "opened", pull_request: { number: 7 }, repository: { ...repository, owner: o } }, OPTS)).toEqual([]);
    expect(mapEvent("pull_request", { action: "opened", pull_request: { number: 7 } }, OPTS)).toEqual([]);
    // The owner is the repository's own: a served organization named elsewhere in the payload does not stand for it.
    expect(mapEvent("pull_request", { action: "opened", pull_request: { number: 7 }, repository: { ...repository, owner: { id: 4242 } }, organization: { id: ORG_ID } }, OPTS)).toEqual([]);
    expect(mapEvent("pull_request", { action: "opened", pull_request: { number: 7 }, repository: { full_name: SANDBOX, id: 77 }, organization: { id: ORG_ID } }, OPTS)).toEqual([]);
  });

  describe("a check run asked to run again", () => {
    const run = { name: CHECK_NAME, app: { id: APP_ID }, external_id: "77#7" };
    const rerun = (r: unknown, extra: Record<string, unknown> = {}) => mapEvent("check_run", { action: "rerequested", check_run: r, repository, ...extra }, OPTS);

    it("re-evaluates the pull request its external id names", () => {
      expect(rerun(run)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: 7 }]);
    });

    it("is ignored unless it is our app's check of this repository", () => {
      expect(rerun({ ...run, app: { id: APP_ID + 1 } })).toEqual([]);
      expect(rerun({ ...run, app: null })).toEqual([]);
      expect(rerun({ ...run, name: "CLA" })).toEqual([]);
      expect(rerun({ ...run, external_id: "78#7" })).toEqual([]);
      expect(rerun({ ...run, external_id: 77 })).toEqual([]);
      expect(rerun({ ...run, external_id: ["77#7"] })).toEqual([]);
      expect(rerun({ ...run, external_id: "0#7" }, { repository: { ...repository, id: 0 } })).toEqual([]);
      for (const external_id of ["77", "77#", "#7", "77#7#7", "x77#7", "77#7 ", "1234567890123#7", "77#12345678901"]) expect(rerun({ ...run, external_id }), external_id).toEqual([]);
      expect(rerun(null)).toEqual([]);
      expect(rerun(run, { repository: { ...repository, full_name: "x" } })).toEqual([]);
      expect(rerun(run, { repository: { full_name: SANDBOX, owner } })).toEqual([]);
    });

    it("is ignored for any other check run action", () => {
      for (const action of ["created", "completed", "requested_action"]) expect(mapEvent("check_run", { action, check_run: run, repository }, OPTS), action).toEqual([]);
    });
  });

  describe("a workflow run of a served repository", () => {
    const flow = (action: string, r: Record<string, unknown> | null) => mapEvent("workflow_run", { action, workflow_run: r, repository }, OPTS);

    it("marks its head as held when it is requested, or completes waiting for approval", () => {
      const held = [{ kind: "held", repo: SANDBOX, sha: SHA }];
      expect(flow("requested", { event: "pull_request", head_sha: SHA })).toEqual(held);
      expect(flow("completed", { event: "pull_request", head_sha: SHA, conclusion: "action_required" })).toEqual(held);
      expect(flow("completed", { event: "pull_request", head_sha: SHA, status: "action_required" })).toEqual(held);
      expect(flow("completed", { event: "pull_request", head_sha: SHA, status: "waiting" })).toEqual(held);
    });

    it("is ignored when it completed and is not waiting, or for any other action", () => {
      expect(flow("completed", { event: "pull_request", head_sha: SHA, conclusion: "success", status: "completed" })).toEqual([]);
      expect(flow("in_progress", { event: "pull_request", head_sha: SHA, status: "waiting" })).toEqual([]);
    });

    it("is ignored when its head is not a commit, or it ran for another event", () => {
      for (const head_sha of [undefined, 7, [SHA], `z${SHA}`, SHA.toUpperCase(), SHA.slice(1), `${SHA}\n`]) expect(flow("requested", { event: "pull_request", head_sha }), String(head_sha)).toEqual([]);
      for (const event of ["push", "workflow_dispatch", "pull_request_target"]) expect(flow("requested", { event, head_sha: SHA }), event).toEqual([]);
      expect(flow("requested", null)).toEqual([]);
      expect(mapEvent("workflow_run", { action: "requested", workflow_run: { event: "pull_request", head_sha: SHA }, repository: { owner } }, OPTS)).toEqual([]);
    });
  });

  describe("a run of the register's Record workflow", () => {
    const record = { event: "workflow_dispatch", path: ".github/workflows/record.yml", head_branch: "main", conclusion: "success", display_title: `Record sign ${SANDBOX}#7 4242` };
    const registry = { full_name: REGISTRY, id: 5, owner };
    const done = (r: Record<string, unknown>, action = "completed") => mapEvent("workflow_run", { action, workflow_run: r, repository: registry }, OPTS);

    it("that succeeded re-evaluates the pull request its title names", () => {
      expect(done(record)).toEqual([{ kind: "evaluate", repo: SANDBOX, pr: 7 }]);
      expect(done({ ...record, display_title: `Record sign ${"o".repeat(39)}/${"r".repeat(100)}#1234567890 123456789012345` })).toEqual([{ kind: "evaluate", repo: `${"o".repeat(39)}/${"r".repeat(100)}`, pr: 1234567890 }]);
    });

    it("is ignored unless it completed with success, from record.yml on main", () => {
      expect(done(record, "requested")).toEqual([]);
      expect(done({ ...record, conclusion: "failure" })).toEqual([]);
      for (const path of [".github/workflows/verify.yml", ".github/workflows/x-record.yml", "record.yml", ".github/workflows/record.yml/", ".github/workflows/sub/record.yml"]) expect(done({ ...record, path }), path).toEqual([]);
      expect(done({ ...record, head_branch: "signatures" })).toEqual([]);
    });

    it("is ignored when its title is not one the recorder writes", () => {
      for (const display_title of [7, [`Record sign ${SANDBOX}#7 4242`], `Record coverage ${SANDBOX}#7 4242`, `Record sign ${SANDBOX}#0 4242`, `Record sign ${SANDBOX}#7 0`, `Record sign ${SANDBOX}#7`, `Record sign ${SANDBOX}#12345678901 1`, `Record sign ${SANDBOX}#7 4242 `, ` Record sign ${SANDBOX}#7 4242`, `Record sign ${"o".repeat(40)}/r#7 4242`, `Record sign o/${"r".repeat(101)}#7 4242`]) {
        expect(done({ ...record, display_title }), String(display_title)).toEqual([]);
      }
    });

    it("is read as a pull request run, not a Record run, when it ran for a pull request", () => {
      expect(done({ event: "pull_request", head_sha: SHA }, "requested")).toEqual([{ kind: "held", repo: REGISTRY, sha: SHA }]);
    });

    it("of another repository is not a Record run", () => {
      expect(mapEvent("workflow_run", { action: "completed", workflow_run: record, repository }, OPTS)).toEqual([]);
    });
  });

  describe("an installation", () => {
    it("is checked when it is created, added to, given new permissions or unsuspended, whoever owns it", () => {
      for (const event of ["installation", "installation_repositories"]) {
        for (const action of ["created", "added", "new_permissions_accepted", "unsuspend"]) expect(mapEvent(event, { action, installation: { id: 66 }, repository: { owner: { id: 4242 } } }, OPTS), `${event} ${action}`).toEqual([{ kind: "installation", installation: 66 }]);
      }
    });

    it("is ignored when it is deleted, suspended or loses repositories, or names no installation", () => {
      for (const action of ["deleted", "suspend", "removed", ""]) expect(mapEvent("installation", { action, installation: { id: 66 } }, OPTS), action).toEqual([]);
      for (const installation of [{ id: 0 }, { id: "66" }, null]) expect(mapEvent("installation", { action: "created", installation }, OPTS)).toEqual([]);
    });
  });

  it("ignores any other event, even from a served repository", () => {
    for (const event of ["issue_comment", "push", "github_app_authorization", "ping", "pull_request_review"]) expect(mapEvent(event, { action: "created", repository, installation: { id: 1 }, pull_request: { number: 7 } }, OPTS), event).toEqual([]);
  });
});
