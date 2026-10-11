/** MCP OAuth for custom connectors: RFC 9728 discovery, RFC 8414, DCR, PKCE S256, resource indicator, refresh. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { AccountStore } from "../src/accounts.ts";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { discover } from "../src/sources/mcp/oauth.ts";
import { handlerOf, publicCtx, root, testCtx, testDb } from "./helpers.ts";

const MCP = "https://mcp.example.com/mcp";
const AS = "https://auth.example.com/tenant";

function world(opts: { issuer?: string; expiresIn?: number } = {}) {
  const state = { challenge: "", tokens: 0, refreshes: 0, registered: [] as unknown[], access: "" };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
    if (url.toString() === MCP) {
      if (headers.get("authorization") !== `Bearer ${state.access}` || !state.access) {
        return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="notes.read"` } });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: [{ name: "list_notes", annotations: { readOnlyHint: true } }] } : { content: [{ type: "text", text: "ok" }] };
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: MCP, authorization_servers: [AS] });
    if (url.toString() === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
      return json({ issuer: opts.issuer ?? AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register`, code_challenge_methods_supported: ["S256"] });
    }
    if (url.toString() === `${AS}/register`) {
      state.registered.push(JSON.parse(String(init?.body)));
      return json({ client_id: "client-1", token_endpoint_auth_method: "none" }, 201);
    }
    if (url.toString() === `${AS}/token`) {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("resource"), MCP);
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url"), state.challenge);
        assert.equal(form.get("code"), "the-code");
        state.tokens += 1;
      } else {
        assert.equal(form.get("refresh_token"), "refresh-1");
        state.refreshes += 1;
      }
      state.access = `access-${state.tokens}-${state.refreshes}`;
      return json({ access_token: state.access, token_type: "Bearer", expires_in: opts.expiresIn ?? 3600, ...(form.get("grant_type") === "authorization_code" ? { refresh_token: "refresh-1" } : {}) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, state };
}

const allow = ["https://mcp.example.com", "https://auth.example.com"];
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

test("discovery refuses an issuer that does not match", async () => {
  const w = world({ issuer: "https://evil.example.com" });
  await assert.rejects(discover({ fetchImpl: w.impl, allowOrigins: allow }, MCP), /issuer/u);
});

test("OAuth connect: DCR public client, PKCE S256, minimal scope, single-use state, tools after callback, refresh", async () => {
  const w = world({ expiresIn: 30 });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: w.impl, catalogAllowOrigins: allow });
  const person = testCtx({ db, person: true });
  const started = (await handlerOf(app, "mcp_account_connect")({ label: "Notes", url: MCP, auth: "oauth" }, person)) as { account: { id: string; status: string }; redirectUrl: string };
  assert.equal(started.account.status, "pending");
  const authorize = new URL(started.redirectUrl);
  assert.equal(authorize.origin + authorize.pathname, `${AS}/authorize`);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("resource"), MCP);
  assert.equal(authorize.searchParams.get("scope"), "notes.read");
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://bridge.example.com/p/connect/oauth/mcp/callback");
  assert.deepEqual((w.state.registered[0] as { token_endpoint_auth_method: string }).token_endpoint_auth_method, "none");
  w.state.challenge = authorize.searchParams.get("code_challenge") ?? "";
  const callback = `https://bridge.example.com/p/connect/oauth/mcp/callback?code=the-code&state=${authorize.searchParams.get("state")}`;
  const res = await app.publicRoutes?.["/oauth/mcp/callback"]?.(new Request(callback), publicCtx(db));
  assert.equal(res?.status, 200);
  assert.equal(new AccountStore(db).get(started.account.id)?.status, "connected");
  const replay = await app.publicRoutes?.["/oauth/mcp/callback"]?.(new Request(callback), publicCtx(db));
  assert.equal(replay?.status, 400);
  const tool = String(db.prepare("SELECT name FROM connect_tools").get()?.name);
  // expires_in 30 s is inside the 60 s margin: the tool sync after the callback and the call each refresh first.
  const out = await app.dynamic?.tools?.call(tool, {}, testCtx({ db, access: { [started.account.id]: "read" } }));
  assert.deepEqual(out, { account: "Notes", untrusted: true, data: { content: [{ type: "text", text: "ok" }] } });
  assert.equal(w.state.refreshes, 2);
});

test("a denied sign-in marks the account failed", async () => {
  const w = world();
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: w.impl, catalogAllowOrigins: allow });
  const started = (await handlerOf(app, "mcp_account_connect")({ label: "Notes", url: MCP, auth: "oauth" }, testCtx({ db, person: true }))) as { account: { id: string }; redirectUrl: string };
  const s = new URL(started.redirectUrl).searchParams.get("state");
  const res = await app.publicRoutes?.["/oauth/mcp/callback"]?.(new Request(`https://bridge.example.com/p/connect/oauth/mcp/callback?error=access_denied&state=${s}`), publicCtx(db));
  assert.equal(res?.status, 400);
  assert.equal(new AccountStore(db).get(started.account.id)?.status, "failed");
  await assert.rejects(handlerOf(app, "mcp_account_connect")({ label: "X", url: MCP, auth: "oauth" }, testCtx({ db, person: true, publicUrl: null })), (e: ConnectError) => e.code === "public_origin_unknown");
});
