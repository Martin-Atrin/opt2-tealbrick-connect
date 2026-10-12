/** C107: every Connect op with outward effects declares a hold family; dynamic rows written before 0.5.0 get one. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const ops = Object.fromEntries(manifest.operations.map((o) => [o.id, o]));

const OUTWARD = ["buzz_post", "buzz_dm", "buzz_react", "buzz_edit", "buzz_schedule", "channel_send", "channel_reply", "channel_dm", "channel_edit", "channel_react"];

test("C107: ordinary messages, posts, reactions and edits declare the outward family", () => {
  for (const id of OUTWARD) {
    assert.equal(ops[id]?.effect, "outward", id);
    assert.equal(ops[id]?.holdFamily, "outward", id);
    // Truthful text: these are not held by default, and the agent learns what to do when the owner turns approval on.
    assert.match(ops[id]?.description ?? "", /No owner approval by default/u, id);
    assert.match(ops[id]?.description ?? "", /connect__tb_hold_status/u, id);
  }
});

test("C107: first contact stays first_contact; profile publishing is identity; no outward op lacks a family", () => {
  assert.equal(ops.buzz_dm_first?.holdFamily, "first_contact");
  assert.equal(ops.channel_dm_first?.holdFamily, "first_contact");
  assert.equal(ops.buzz_profile_publish?.effect, "outward");
  assert.equal(ops.buzz_profile_publish?.holdFamily, "identity");
  const missing = manifest.operations.filter((o) => (o.effect === "outward" || o.effect === "money") && !o.holdFamily).map((o) => o.id);
  assert.deepEqual(missing, []);
});

test("C107: migration 0008 gives pre-0.5.0 outward tool rows the outward family and leaves the rest alone", () => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(join(root, "migrations")).filter((n) => n.endsWith(".sql")).sort();
  const before = files.filter((n) => n < "0008");
  for (const f of before) db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  const insert = db.prepare(
    "INSERT INTO connect_tools (name, source, service, upstream, title, description, input_schema, crud, effect, hold_family, updated_at) VALUES (?, 'composio', 'gmail', ?, ?, '', '{}', '[]', ?, ?, 0)",
  );
  insert.run("gmail_send_email", "GMAIL_SEND_EMAIL", "Send", "outward", null);
  insert.run("gmail_fetch_emails", "GMAIL_FETCH_EMAILS", "Fetch", "read", null);
  insert.run("gmail_delete_message", "GMAIL_DELETE_MESSAGE", "Delete", "destructive", "destructive");
  for (const f of files.filter((n) => n >= "0008")) db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  const rows = Object.fromEntries((db.prepare("SELECT name, hold_family FROM connect_tools").all() as { name: string; hold_family: string | null }[]).map((r) => [r.name, r.hold_family]));
  assert.deepEqual(rows, { gmail_send_email: "outward", gmail_fetch_emails: null, gmail_delete_message: "destructive" });
});
