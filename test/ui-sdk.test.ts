import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { CREATE_OPS, callOp, resetSession, TbError, tbFetch } from "../src/ui/sdk.ts";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let csrfTokens: string[] = [];
let opAnswers: Response[] = [];

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  csrfTokens = ["csrf-1", "csrf-2"];
  opAnswers = [];
  resetSession();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.endsWith("/tb/v1/session")) return json(200, { principal: { type: "person", id: "per_x" }, csrf: csrfTokens.shift() ?? "csrf-n" });
    return opAnswers.shift() ?? json(200, { ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const opCalls = () => calls.filter((c) => c.url.includes("/tb/v1/ops/"));

test("callOp posts to the op route under /a/connect/ with the TB-CSRF header", async () => {
  opAnswers = [json(200, { accounts: [] })];
  const out = await callOp<{ accounts: unknown[] }>("accounts_overview", {});
  assert.deepEqual(out, { accounts: [] });
  const [session, op] = calls;
  assert.equal(session?.url, "/a/connect/tb/v1/session");
  assert.equal(session?.headers.get("TB-CSRF"), null);
  assert.equal(op?.url, "/a/connect/tb/v1/ops/accounts_overview");
  assert.equal(op?.method, "POST");
  assert.equal(op?.headers.get("TB-CSRF"), "csrf-1");
  assert.equal(op?.headers.get("content-type"), "application/json");
});

test("the session is read once and the token is reused", async () => {
  await callOp("accounts_overview", {});
  await callOp("buzz_identities_list", {});
  assert.equal(calls.filter((c) => c.url.endsWith("/tb/v1/session")).length, 1);
  assert.deepEqual(
    opCalls().map((c) => c.headers.get("TB-CSRF")),
    ["csrf-1", "csrf-1"],
  );
});

test("an error envelope becomes a TbError with its code", async () => {
  opAnswers = [json(409, { error: { code: "composio_key_missing", message: "Add your Composio API key first." } })];
  await assert.rejects(
    () => callOp("services_search", { query: "g" }),
    (error: unknown) => {
      assert.ok(error instanceof TbError);
      assert.ok(error instanceof Error);
      assert.equal(error.code, "composio_key_missing");
      assert.equal(error.message, "Add your Composio API key first.");
      assert.equal(error.httpStatus, 409);
      return true;
    },
  );
});

test("an answer that is not an envelope maps to an http_<status> code", async () => {
  opAnswers = [new Response("<html>bad gateway</html>", { status: 502 })];
  await assert.rejects(
    () => callOp("accounts_overview", {}),
    (error: unknown) => error instanceof TbError && error.code === "http_502",
  );
});

test("a failed network call maps to network_error", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(
    () => callOp("accounts_overview", {}),
    (error: unknown) => error instanceof TbError && error.code === "network_error",
  );
});

test("csrf_invalid fetches a fresh token once and retries", async () => {
  opAnswers = [json(403, { error: { code: "csrf_invalid", message: "Bad token." } }), json(200, { done: true })];
  const out = await callOp("account_update", { id: "acc_1", label: "Work" });
  assert.deepEqual(out, { done: true });
  assert.deepEqual(
    opCalls().map((c) => c.headers.get("TB-CSRF")),
    ["csrf-1", "csrf-2"],
  );
});

test("csrf_invalid twice is reported, not retried forever", async () => {
  const bad = () => json(403, { error: { code: "csrf_invalid", message: "Bad token." } });
  opAnswers = [bad(), bad(), bad()];
  await assert.rejects(
    () => callOp("account_update", { id: "acc_1", label: "Work" }),
    (error: unknown) => error instanceof TbError && error.code === "csrf_invalid",
  );
  assert.equal(opCalls().length, 2);
});

test("a missing session surfaces session_required", async () => {
  globalThis.fetch = (async () => json(401, { error: { code: "session_required", message: "Sign in again." } })) as typeof fetch;
  await assert.rejects(
    () => callOp("accounts_overview", {}),
    (error: unknown) => error instanceof TbError && error.code === "session_required",
  );
});

test("create ops carry { input, idempotencyKey } with a fresh key per call", async () => {
  assert.deepEqual([...CREATE_OPS].sort(), ["account_connect", "buzz_identities_generate", "buzz_profile_publish", "catalog_account_connect"]);
  const input = { service: "gmail", label: "Gmail", kind: "as_me" };
  await callOp("account_connect", input);
  await callOp("account_connect", input);
  const [first, second] = opCalls().map((c) => c.body as { input: unknown; idempotencyKey: string });
  assert.deepEqual(first?.input, input);
  assert.deepEqual(Object.keys(first ?? {}).sort(), ["idempotencyKey", "input"]);
  assert.ok((first?.idempotencyKey.length ?? 0) >= 8 && (first?.idempotencyKey.length ?? 0) <= 128);
  assert.notEqual(first?.idempotencyKey, second?.idempotencyKey);
});

test("buzz_identities_generate and buzz_profile_publish get a key too", async () => {
  await callOp("buzz_identities_generate", {});
  await callOp("buzz_profile_publish", {});
  for (const call of opCalls()) {
    const body = call.body as { input: unknown; idempotencyKey: string };
    assert.deepEqual(body.input, {});
    assert.equal(typeof body.idempotencyKey, "string");
  }
});

test("catalog_account_connect carries { input, idempotencyKey } and keeps the credentials inside input", async () => {
  const input = { service: "dolibarr", label: "ERP", baseUrl: "https://erp.example.com", credentials: { token: "test-token-value" }, kind: "as_me" };
  await callOp("catalog_account_connect", input);
  const body = opCalls()[0]?.body as { input: unknown; idempotencyKey: string };
  assert.deepEqual(body.input, input);
  assert.deepEqual(Object.keys(body).sort(), ["idempotencyKey", "input"]);
  assert.ok(body.idempotencyKey.length >= 8);
});

test("other ops send the plain input, no idempotency key", async () => {
  const sent: Record<string, unknown> = {
    services_search: { query: "mail" },
    accounts_overview: {},
    account_update: { id: "acc_1", label: "Work" },
    account_disconnect: { id: "acc_1" },
    tools_refresh: { service: "gmail" },
    buzz_identities_list: {},
    buzz_identity_rotate: { agent: "agt_1" },
    buzz_relay_set: { relayUrl: "wss://relay.example" },
    "tb.agents_list": {},
    "tb.scopes_set": { agent: "agt_1", type: "account", id: "acc_1", access: "read" },
  };
  for (const [op, input] of Object.entries(sent)) await callOp(op, input as never);
  const ops = opCalls();
  assert.equal(ops.length, Object.keys(sent).length);
  for (const [i, op] of Object.keys(sent).entries()) {
    assert.deepEqual(ops[i]?.body, sent[op]);
    assert.ok(!JSON.stringify(ops[i]?.body).includes("idempotencyKey"), op);
  }
  assert.equal(ops.at(-1)?.url, "/a/connect/tb/v1/ops/tb.scopes_set");
});

test("tbFetch sends TB-CSRF on non-GET only", async () => {
  await tbFetch("tb/v1/something");
  await tbFetch("/tb/v1/logout", { method: "POST" });
  const [get, , post] = calls;
  assert.equal(get?.url, "/a/connect/tb/v1/something");
  assert.equal(get?.headers.get("TB-CSRF"), null);
  assert.equal(post?.url, "/a/connect/tb/v1/logout");
  assert.equal(post?.headers.get("TB-CSRF"), "csrf-1");
});
