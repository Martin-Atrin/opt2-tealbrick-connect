/** A fresh agent edge (no account access yet) still has usable Connect tools: Buzz ops and an empty accounts list. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "../src/app.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

test("account-scoped ops are the tools family and the chat-bot ops; Buzz ops and accounts_list need no scope access", () => {
  const scoped = manifest.operations.filter((o) => o.audience === "agent" && o.scopeType).map((o) => o.id);
  assert.deepEqual(scoped.filter((id) => !id.startsWith("channel_")), ["tools"]);
  for (const id of ["buzz_identity", "buzz_channels", "buzz_read", "buzz_post", "buzz_react", "buzz_edit", "buzz_delete", "buzz_schedule", "buzz_dm_first", "buzz_dm", "accounts_list"]) {
    const op = manifest.operations.find((o) => o.id === id);
    assert.ok(op && op.audience === "agent" && !op.scopeType, id);
  }
});

test("accounts_list for an agent with no account access returns an empty list", async () => {
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations") });
  const out = await handlerOf(app, "accounts_list")({}, testCtx({ db, access: {} }));
  assert.deepEqual(out, { accounts: [] });
});
