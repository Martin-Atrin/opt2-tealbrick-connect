/** F20 (C106 phase 2): an agent gets its Buzz identity when it reaches Connect's slice (tether), not on its first Buzz call. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "../src/app.ts";
import { eventCtx, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const A = "agt_01TETHERA000000000000000000";
const B = "agt_01TETHERB000000000000000000";
const added = (id: string, name: string) => ({ id: id as `agt_${string}`, name, mode: "free" as const, status: "active" as const });
const identities = (db: ReturnType<typeof testDb>) => db.prepare("SELECT agent FROM connect_buzz_identities ORDER BY agent").all().map((r) => String(r.agent));

test("F20: agents first seen before onStart get identities in the onStart sweep; later agents at agentAdded", async () => {
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations") });
  // Boot order: the stored slice is installed (first sight) before onStart builds the services with app secrets.
  await app.events?.agentAdded?.(added(A, "Agent A"), eventCtx(db));
  assert.deepEqual(identities(db), []);
  const start = testCtx({ db });
  await app.onStart?.({ ...eventCtx(db), secrets: start.secrets, getKey: start.getKey, callServiceHelper: start.callServiceHelper } as never);
  assert.deepEqual(identities(db), [A]);
  // Tether after boot: the identity exists before the agent makes any Buzz call (no relay traffic needed).
  await app.events?.agentAdded?.(added(B, "Agent B"), eventCtx(db));
  assert.deepEqual(identities(db), [A, B]);
  assert.equal(secretsFor(db).names().length, 2);
  // The agent's first read names the identity created at tether (no new key).
  const mine = (await handlerOf(app, "buzz_identity")({}, testCtx({ db, agent: B }))) as { npub: string };
  assert.match(mine.npub, /^npub1/u);
  assert.equal(secretsFor(db).names().length, 2);
  // Re-adding an agent (slice change) never replaces its key.
  const before = db.prepare("SELECT pubkey FROM connect_buzz_identities WHERE agent = ?").get(A)?.pubkey;
  await app.events?.agentAdded?.(added(A, "Agent A renamed"), eventCtx(db));
  assert.equal(db.prepare("SELECT pubkey FROM connect_buzz_identities WHERE agent = ?").get(A)?.pubkey, before);
});
