/**
 * QA S2 (C78): a leftover sign-in at Composio must never block a new one.
 * - Every attempt sends a unique Composio alias; the label stays our own display field.
 * - A new attempt deletes only OUR OWN stale, non-ACTIVE pending sign-ins for the workspace and toolkit.
 * - Upstream errors reach the person as one plain message; the raw answer goes to the log.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import { AccountStore } from "../src/accounts.ts";
import { createConnectApp } from "../src/app.ts";
import { ComposioClient } from "../src/sources/composio/client.ts";
import { ComposioSource, composioAlias, STALE_PENDING_MS, START_FAILED_MESSAGE } from "../src/sources/composio/source.ts";
import { ToolRegistry } from "../src/tools.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const WS = "ws_01TESTWORKSPACE00000000000";
const OTHER_WS = "ws_01OTHERWORKSPACE0000000000";
const CALLBACK = "https://bridge.example.com/p/connect/oauth/composio/callback";

interface Upstream {
  status: string;
  user: string;
  toolkit: string;
  alias?: string;
}

/** Composio stand-in: refuses a duplicate alias per user like the real API, records every call. */
function composio(initial: Record<string, Upstream> = {}, options: { linkError?: { status: number; body: unknown } } = {}) {
  const accounts = new Map<string, Upstream>(Object.entries(initial));
  const calls: string[] = [];
  let n = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    calls.push(`${method} ${url.pathname}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/api/v3.1/toolkits/gmail") return json({ slug: "gmail", name: "Gmail", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] });
    if (method === "GET" && url.pathname === "/api/v3.1/auth_configs") return json({ items: [{ id: "ac_gmail", is_composio_managed: true, toolkit: { slug: "gmail" }, status: "ENABLED" }] });
    if (method === "POST" && url.pathname === "/api/v3/connected_accounts/link") {
      if (options.linkError) return json(options.linkError.body, options.linkError.status);
      const taken = [...accounts.values()].some((a) => a.user === body.user_id && a.alias === body.alias);
      if (taken) {
        return json({ error: { message: `Alias "${body.alias}" is already in use by another connection for this entity`, code: 1234, slug: "AliasConflict" } }, 400);
      }
      n += 1;
      const id = `ca_new${n}`;
      accounts.set(id, { status: "INITIATED", user: body.user_id ?? "", toolkit: "gmail", ...(body.alias ? { alias: body.alias } : {}) });
      return json({ connected_account_id: id, redirect_url: `https://connect.composio.dev/link/${id}` });
    }
    const m = /^\/api\/v3\.1\/connected_accounts\/([^/]+)$/u.exec(url.pathname);
    if (m) {
      const id = m[1] as string;
      const a = accounts.get(id);
      if (!a) return json({ error: "not found" }, 404);
      if (method === "GET") return json({ id, status: a.status, user_id: a.user, toolkit: { slug: a.toolkit }, auth_config: { id: "ac_gmail" } });
      if (method === "DELETE") {
        accounts.delete(id);
        return json({ success: true });
      }
    }
    return json({ error: "unexpected" }, 500);
  }) as typeof fetch;
  return { impl, calls, accounts };
}

function harness(upstream: ReturnType<typeof composio>, suffixes?: string[]) {
  const db = testDb();
  const accounts = new AccountStore(db);
  const logs: { level: string; msg: string; fields: Record<string, Json> }[] = [];
  const log = Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [level, (msg: string, fields: Record<string, Json> = {}) => void logs.push({ level, msg, fields })]),
  ) as unknown as import("@opt2-tealbrick/spec/sdk").Logger;
  const now = 1_800_000_000_000;
  const queue = suffixes ? [...suffixes] : null;
  const source = new ComposioSource({
    db,
    accounts,
    tools: new ToolRegistry(db),
    policies: new Map(),
    client: async () => new ComposioClient({ apiKey: "ck_test_key_value", fetchImpl: upstream.impl, sleep: async () => {} }),
    now: () => now,
    log,
    ...(queue ? { suffix: () => queue.shift() ?? "zzzzzz" } : {}),
  });
  const start = (label: string) => source.startConnect({ service: "gmail", label, kind: "as_me", workspaceId: WS, callbackUrl: CALLBACK });
  return { db, accounts, source, logs, start, now: () => now };
}

test("alias collision: the attempt succeeds with a unique alias and the label stays ours", async () => {
  const up = composio({ ca_old: { status: "INITIATED", user: WS, toolkit: "gmail", alias: "Gmail-same" } });
  const h = harness(up, ["same", "same", "fresh"]);
  const result = await h.start("Gmail");
  assert.equal(result.account.label, "Gmail");
  assert.equal(result.account.status, "pending");
  assert.equal(result.account.externalRef, "ca_new1");
  assert.match(result.redirectUrl, /^https:\/\/connect\.composio\.dev\/link\//u);
  assert.equal(up.accounts.get("ca_new1")?.alias, "Gmail-fresh");
  assert.equal(up.calls.filter((c) => c === "POST /api/v3/connected_accounts/link").length, 3);
  assert.equal(h.logs.filter((l) => l.fields.op === "create_link_alias_retry").length, 2);
});

test("two attempts with the same label both start (real random suffix)", async () => {
  const up = composio();
  const h = harness(up);
  const a = await h.start("Gmail");
  const b = await h.start("Gmail");
  assert.notEqual(a.account.externalRef, b.account.externalRef);
  const aliases = [...up.accounts.values()].map((x) => x.alias);
  assert.equal(new Set(aliases).size, 2);
  for (const alias of aliases) assert.match(alias ?? "", /^Gmail-[0-9a-f]{6}$/u);
  assert.equal(composioAlias("x".repeat(100), "abc123").length, 40 + 1 + 6);
});

test("stale cleanup deletes only our own old, non-ACTIVE sign-ins for this workspace and toolkit", async () => {
  const up = composio({
    ca_stale: { status: "INITIATED", user: WS, toolkit: "gmail" }, // ours, old, not active: DELETE
    ca_active: { status: "ACTIVE", user: WS, toolkit: "gmail" }, // ours, old, ACTIVE: keep
    ca_fresh: { status: "INITIATED", user: WS, toolkit: "gmail" }, // ours, too young: keep
    ca_connected: { status: "ACTIVE", user: WS, toolkit: "gmail" }, // ours, connected: keep
    ca_slack: { status: "INITIATED", user: WS, toolkit: "slack" }, // ours but another toolkit: keep
    ca_foreign_user: { status: "INITIATED", user: OTHER_WS, toolkit: "gmail" }, // our row, upstream is another user: keep
    ca_not_ours: { status: "INITIATED", user: WS, toolkit: "gmail" }, // no Connect row at all: never touched
  });
  const h = harness(up);
  const base = h.now();
  const seed = (id: string, ref: string, status: "pending" | "connected", service = "gmail", age = STALE_PENDING_MS + 1000) =>
    h.accounts.create({ service, source: "composio", kind: "as_me", label: id, externalRef: ref, status, now: base - age });
  const stale = seed("stale", "ca_stale", "pending");
  const active = seed("active", "ca_active", "pending");
  const fresh = seed("fresh", "ca_fresh", "pending", "gmail", 1000);
  const connected = seed("connected", "ca_connected", "connected");
  const slack = seed("slack", "ca_slack", "pending", "slack");
  const foreign = seed("foreign", "ca_foreign_user", "pending");
  const mcp = h.accounts.create({ service: "gmail", source: "mcp", kind: "as_me", label: "mcp", externalRef: "ca_not_ours", status: "pending", now: base - STALE_PENDING_MS - 5000 });

  await h.start("Gmail");

  assert.deepEqual(up.calls.filter((c) => c.startsWith("DELETE")), ["DELETE /api/v3.1/connected_accounts/ca_stale"]);
  assert.equal(up.accounts.has("ca_stale"), false);
  for (const kept of ["ca_active", "ca_fresh", "ca_connected", "ca_slack", "ca_foreign_user", "ca_not_ours"]) assert.equal(up.accounts.has(kept), true, kept);
  // The queries stay inside our own rows.
  assert.equal(up.calls.some((c) => c.endsWith("/ca_not_ours") || c.endsWith("/ca_slack") || c.endsWith("/ca_connected") || c.endsWith("/ca_fresh")), false);
  const status = (id: string) => h.accounts.get(id)?.status;
  assert.equal(status(stale.id), "failed");
  assert.equal(status(active.id), "pending");
  assert.equal(status(fresh.id), "pending");
  assert.equal(status(connected.id), "connected");
  assert.equal(status(slack.id), "pending");
  assert.equal(status(foreign.id), "pending");
  assert.equal(status(mcp.id), "pending");
  // Every delete is logged.
  const deleted = h.logs.filter((l) => l.msg === "composio stale sign-in deleted");
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.fields.ref, "ca_stale");
});

test("a stale sign-in that Composio no longer knows is closed locally; a failing cleanup never blocks the new attempt", async () => {
  const up = composio();
  const h = harness(up);
  const gone = h.accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "gone", externalRef: "ca_gone", status: "pending", now: h.now() - STALE_PENDING_MS - 1 });
  const started = await h.start("Gmail");
  assert.equal(h.accounts.get(gone.id)?.status, "failed");
  assert.equal(started.account.status, "pending");
  assert.equal(up.calls.some((c) => c.startsWith("DELETE")), false);
});

test("upstream errors become one plain message; the log keeps the upstream code", async () => {
  const raw = { error: { message: "Internal gremlin 0xBEEF", code: 9001, slug: "Boom" } };
  const up = composio({}, { linkError: { status: 400, body: raw } });
  const h = harness(up);
  await assert.rejects(h.start("Gmail"), (e: Error) => {
    assert.equal(e.message, START_FAILED_MESSAGE);
    assert.equal(e.message.includes("{"), false);
    assert.equal(e.message.includes("gremlin"), false);
    return true;
  });
  const line = h.logs.find((l) => l.fields.op === "create_link");
  assert.ok(line);
  assert.equal(line.fields.upstreamCode, "upstream_error");
  assert.equal(line.fields.upstreamStatus, 400);
  assert.match(String(line.fields.detail), /gremlin/u);
  const failed = h.accounts.list({ service: "gmail" })[0];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.detail, START_FAILED_MESSAGE);
});

test("app level: account_connect shows the plain message, never upstream JSON", async () => {
  const up = composio({}, { linkError: { status: 500, body: { error: { message: "db exploded", code: 5 } } } });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: up.impl });
  const ctx = testCtx({ db, person: true, ws: WS, keys: { COMPOSIO_API_KEY: "ck_test_key_value" } });
  await assert.rejects(handlerOf(app, "account_connect")({ service: "gmail", label: "Gmail" }, ctx), (e: Error) => {
    assert.equal(e.message, START_FAILED_MESSAGE);
    return true;
  });
});

test("an alias that keeps colliding still ends in the plain message, not raw JSON", async () => {
  const up = composio({ ca_x: { status: "INITIATED", user: WS, toolkit: "gmail", alias: "Gmail-same" } });
  const h = harness(up, ["same", "same", "same", "same"]);
  await assert.rejects(h.start("Gmail"), (e: Error) => e.message === START_FAILED_MESSAGE);
});
