/** Tealbrick catalog lane: pinned artifact, compiled tools with labels, API-key accounts, safe HTTP execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { AccountStore } from "../src/accounts.ts";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { buildRequest } from "../src/sources/catalog/http.ts";
import { compile } from "../src/sources/catalog/openapi.ts";
import { parseBundle } from "../src/sources/catalog/source.ts";
import { fakeFetch, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const spec = {
  openapi: "3.0.3",
  servers: [{ url: "{baseUrl}/api", variables: { baseUrl: { default: "http://localhost:9000" } } }],
  components: { schemas: { Sub: { type: "object", properties: { email: { type: "string" }, lists: { type: "array", items: { $ref: "#/components/schemas/Sub" } } } } } },
  paths: {
    "/subscribers": {
      get: { operationId: "getSubscribers", summary: "List subscribers", parameters: [{ name: "page", in: "query", schema: { type: "integer" } }] },
      post: { operationId: "createSubscriber", summary: "Create subscriber", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Sub" } } } } },
    },
    "/subscribers/{id}": {
      delete: { operationId: "deleteSubscriberById", summary: "Delete", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }] },
      put: { operationId: "updateSubscriberById", summary: "Update", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "Authorization", in: "header", schema: { type: "string" } }] },
    },
    "/campaigns/{id}/preview": { post: { operationId: "previewCampaign", summary: "Preview", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }] } },
    "/events": { get: { operationId: "streamEvents", summary: "SSE" } },
    "/media": { post: { operationId: "uploadMedia", requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object" } } } } } },
  },
};
const labels = { outward: ["createSubscriber"], destructive: ["updateSubscriberById"], reads: ["previewCampaign"], excluded: [{ operation: "streamEvents", reason: "stream" }] };

function bundle() {
  const content = JSON.stringify(spec);
  const doc = {
    format: "tealbrick.catalog/1",
    version: "9.9.9",
    entries: [
      {
        id: "mailer",
        entry: { schema: 1, id: "mailer", displayName: "Mailer", description: "Lists", category: "Marketing", app: { version: "1.0" }, source: "openapi", openapi: { spec: "openapi.json", sha256: sha(content) }, auth: { type: "header", name: "Authorization", prefix: "token ", label: "API token" }, baseUrlExample: "https://mailer.example.com", ...labels },
        files: [{ name: "openapi.json", sha256: sha(content), content }],
      },
    ],
  };
  return gzipSync(Buffer.from(JSON.stringify(doc)));
}

test("compile: labels, read downgrade only for POST, excluded and binary ops skipped, refs inlined with a cycle guard", () => {
  const { basePath, operations } = compile(spec, labels);
  assert.equal(basePath, "/api");
  const by = Object.fromEntries(operations.map((o) => [o.operationId, o.effect]));
  assert.deepEqual(by, { getSubscribers: "read", createSubscriber: "outward", deleteSubscriberById: "destructive", updateSubscriberById: "destructive", previewCampaign: "read" });
  const create = operations.find((o) => o.operationId === "createSubscriber");
  assert.deepEqual(create?.inputSchema.required, ["body"]);
});

test("bundle must match the manifest pin and its per-file digests", () => {
  const gz = bundle();
  assert.equal(parseBundle(gz, sha(gz))[0]?.id, "mailer");
  assert.throws(() => parseBundle(gz, "0".repeat(64)), /does not match the pin/u);
});

test("request building: per-segment encoding, no path escape, caller cannot set the credential header", () => {
  const { operations } = compile(spec, labels);
  const update = operations.find((o) => o.operationId === "updateSubscriberById");
  assert.ok(update);
  const auth = { type: "header" as const, name: "Authorization", prefix: "token " };
  const built = buildRequest({ baseUrl: "https://mailer.example.com/base", basePath: "/api", op: update, args: { path: { id: 7 }, header: { Authorization: "evil" } }, auth, credentials: { token: "T0KEN-123" } });
  assert.equal(built.url.toString(), "https://mailer.example.com/base/api/subscribers/7");
  assert.equal((built.init.headers as Record<string, string>).Authorization, "token T0KEN-123");
  assert.throws(() => buildRequest({ baseUrl: "https://mailer.example.com", basePath: "", op: update, args: { path: { id: ".." } }, auth, credentials: { token: "x" } }), /single segment/u);
  assert.throws(() => buildRequest({ baseUrl: "https://mailer.example.com", basePath: "", op: update, args: { path: { id: "1/../../admin" } }, auth, credentials: { token: "x" } }), /single segment/u);
  assert.throws(() => buildRequest({ baseUrl: "https://mailer.example.com", basePath: "", op: update, args: { path: { id: 1 }, extra: {} }, auth, credentials: { token: "x" } }), /Unknown argument groups/u);
});

test("app: connect a catalog account with an API key, tiers apply, secrets scrubbed from responses", async () => {
  const gz = bundle();
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  manifest.artifacts = [{ id: "catalog", version: "9.9.9", sha256: sha(gz), url: "https://github.com/Martin-Atrin/opt2-tealbrick-connect/releases/download/catalog-9.9.9/x.json.gz" }];
  const upstream = fakeFetch({
    "GET /api/subscribers": ({ headers }) => ({ body: { results: [{ email: "a@example.com" }], echoAuth: headers.get("authorization") } }),
    "POST /api/subscribers": () => ({ body: { id: 1 } }),
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://github.com/")) return new Response(gz);
    return upstream.impl(input, init);
  }) as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), "connect-data-"));
  try {
    const db = testDb();
    const app = createConnectApp({
      manifest,
      migrationsDir: join(root, "migrations"),
      fetchImpl,
      dataDir,
      catalogAllowOrigins: ["https://mailer.example.com"],
    });
    const person = testCtx({ db, person: true });
    const search = (await handlerOf(app, "services_search")({ query: "mail" }, person)) as { composioKey: boolean; services: { service: string; source: string; fields: string[] }[] };
    assert.deepEqual(search.services.map((x) => [x.service, x.source, x.fields]), [["mailer", "catalog", ["token"]]]);
    await assert.rejects(handlerOf(app, "catalog_account_connect")({ service: "mailer", label: "M", baseUrl: "https://10.0.0.1", credentials: { token: "x" } }, person), (e: ConnectError) => e.code === "endpoint_not_allowed");
    const out = (await handlerOf(app, "catalog_account_connect")({ service: "mailer", label: "Newsletter", baseUrl: "https://mailer.example.com", credentials: { token: "SECRET-TOKEN-1" } }, person)) as { account: { id: string; status: string } };
    assert.equal(out.account.status, "connected");
    assert.deepEqual(secretsFor(db).names(), [`account:${out.account.id}`]);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM connect_accounts").all()).includes("SECRET-TOKEN-1"));
    const tools = db.prepare("SELECT name, effect FROM connect_tools ORDER BY name").all().map((r) => ({ ...r }));
    assert.deepEqual(tools.map((t) => t.name), ["cb_mailer_createsubscriber", "cb_mailer_deletesubscriberbyid", "cb_mailer_getsubscribers", "cb_mailer_previewcampaign", "cb_mailer_updatesubscriberbyid"]);
    const dyn = app.dynamic?.tools;
    assert.ok(dyn);
    const reader = testCtx({ db, access: { [out.account.id]: "read" } });
    const listed = (await dyn.call("cb_mailer_getsubscribers", { query: { page: 1 } }, reader)) as { data: { echoAuth: string }; untrusted: boolean };
    assert.equal(listed.untrusted, true);
    assert.equal(listed.data.echoAuth, "token [redacted]");
    await assert.rejects(dyn.call("cb_mailer_createsubscriber", { body: { email: "b@example.com" } }, reader), (e: ConnectError) => e.code === "scope_denied");
    const writer = testCtx({ db, access: { [out.account.id]: "read_update" } });
    assert.deepEqual(((await dyn.call("cb_mailer_createsubscriber", { body: { email: "b@example.com" } }, writer)) as { data: unknown }).data, { id: 1 });
    const disc = (await handlerOf(app, "account_disconnect")({ id: out.account.id }, person)) as { account: { status: string } };
    assert.equal(disc.account.status, "revoked");
    assert.deepEqual(secretsFor(db).names(), []);
    assert.equal(new AccountStore(db).get(out.account.id)?.status, "revoked");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
