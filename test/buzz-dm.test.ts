/** Buzz direct messages (C57): first contact through buzz_dm_first (held family first_contact), later DMs via buzz_dm. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { type ConnectError, createConnectApp } from "../src/app.ts";
import { generateSecretKey, type NostrEvent, npubEncode, parsePubkey, publicKeyOf, verifyEvent } from "../src/channels/buzz/nostr.ts";
import { eventCtx, fakeFetch, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const DM_CHANNEL = "5a7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const AGENT = "agt_01AGENTDM0000000000000000000";

test("npub and hex parsing; nsec and junk refused", () => {
  const hex = publicKeyOf(generateSecretKey());
  assert.equal(parsePubkey(npubEncode(hex)), hex);
  assert.equal(parsePubkey(hex.toUpperCase()), hex);
  assert.equal(parsePubkey(`nsec1${npubEncode(hex).slice(5)}`), null);
  // Broken checksum: change the last character to a different bech32 one (it can already be "q": 1 in 32 keys).
  const npub = npubEncode(hex);
  assert.equal(parsePubkey(`${npub.slice(0, -1)}${npub.endsWith("q") ? "p" : "q"}`), null);
});

test("manifest: buzz_dm_first is outward + first_contact; buzz_dm is outward + outward (C107)", () => {
  const first = manifest.operations.find((o) => o.id === "buzz_dm_first");
  const later = manifest.operations.find((o) => o.id === "buzz_dm");
  assert.equal(first?.effect, "outward");
  assert.equal(first?.holdFamily, "first_contact");
  assert.equal(later?.effect, "outward");
  assert.equal(later?.holdFamily, "outward");
});

test("first DM opens the conversation (kind 41010) and posts (kind 9); later DMs need that first contact", async () => {
  const events: NostrEvent[] = [];
  const relay = fakeFetch({
    "POST /events": ({ body }) => {
      const e = body as NostrEvent;
      assert.equal(verifyEvent(e), true);
      events.push(e);
      return { body: e.kind === 41010 ? { accepted: true, message: `response:${JSON.stringify({ channel_id: DM_CHANNEL })}` } : { accepted: true, message: "" } };
    },
  });
  const db = testDb();
  const app = createConnectApp({
    manifest,
    migrationsDir: join(root, "migrations"),
    fetchImpl: relay.impl,
    buzzRelays: "wss://relay.test.example",
    allowRelayOrigins: ["wss://relay.test.example", "https://relay.test.example"],
  });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "Agent", mode: "free", status: "active" }, eventCtx(db));
  await handlerOf(app, "buzz_identities_generate")({}, testCtx({ db, person: true }));
  const person = publicKeyOf(generateSecretKey());
  const ctx = testCtx({ db, agent: AGENT });
  await assert.rejects(handlerOf(app, "buzz_dm")({ to: npubEncode(person), content: "hi" }, ctx), (e: ConnectError) => e.code === "buzz_first_contact_required");
  const first = (await handlerOf(app, "buzz_dm_first")({ to: npubEncode(person), content: "Hello, first contact" }, ctx)) as { channel: string; to: string };
  assert.equal(first.channel, DM_CHANNEL);
  assert.deepEqual(events.map((e) => e.kind), [41010, 9]);
  assert.deepEqual(events[0]?.tags, [["p", person]]);
  assert.deepEqual(events[1]?.tags, [["h", DM_CHANNEL]]);
  const later = (await handlerOf(app, "buzz_dm")({ to: person, content: "again" }, ctx)) as { channel: string };
  assert.equal(later.channel, DM_CHANNEL);
  await assert.rejects(handlerOf(app, "buzz_dm_first")({ to: "nope", content: "x" }, ctx), (e: ConnectError) => e.code === "buzz_recipient_invalid");
  const spec = app.handlers.buzz_dm_first as { holdView: (i: unknown) => string };
  assert.match(spec.holdView({ to: npubEncode(person), content: "Hello" }), /First direct message in Buzz[\s\S]*Hello/u);
});
