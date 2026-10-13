/** Buzz message actions (C58 #4): react, edit/delete own posts only, scheduled posts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { type ConnectError, createConnectApp, runDueBuzzPosts } from "../src/app.ts";
import { BuzzIdentities } from "../src/channels/buzz/identity.ts";
import { type NostrEvent, verifyEvent } from "../src/channels/buzz/nostr.ts";
import { BuzzRelay } from "../src/channels/buzz/relay.ts";
import { eventCtx, fakeFetch, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const CHANNEL = "0b7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const AGENT = "agt_01BUZZACTIONS0000000000000";
const RELAY = "wss://relay.test.example";
const ORIGINS = [RELAY, "https://relay.test.example"];

async function setup() {
  const events: NostrEvent[] = [];
  const relay = fakeFetch({
    "POST /events": ({ body }) => {
      assert.equal(verifyEvent(body), true);
      events.push(body as NostrEvent);
      return { body: { accepted: true, message: "" } };
    },
  });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: relay.impl, buzzRelays: RELAY, allowRelayOrigins: ORIGINS });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "A", mode: "free", status: "active" }, eventCtx(db));
  await handlerOf(app, "buzz_identities_generate")({}, testCtx({ db, person: true }));
  return { db, app, events, relay, ctx: testCtx({ db, agent: AGENT }) };
}

test("react: kind 7 with e + h tags; invalid emoji refused", async () => {
  const s = await setup();
  const target = "a".repeat(64);
  await handlerOf(s.app, "buzz_react")({ channel: CHANNEL, messageId: target, emoji: "👍" }, s.ctx);
  assert.deepEqual(s.events.at(-1)?.tags, [["e", target], ["h", CHANNEL]]);
  assert.equal(s.events.at(-1)?.kind, 7);
  await assert.rejects(handlerOf(s.app, "buzz_react")({ channel: CHANNEL, messageId: target, emoji: ":custom:" }, s.ctx), (e: ConnectError) => e.code === "buzz_reaction_invalid");
});

test("edit (kind 40003) and delete (kind 5) only for the agent's own posts", async () => {
  const s = await setup();
  const posted = (await handlerOf(s.app, "buzz_post")({ channel: CHANNEL, content: "draft" }, s.ctx)) as { id: string };
  await handlerOf(s.app, "buzz_edit")({ channel: CHANNEL, messageId: posted.id, content: "final" }, s.ctx);
  assert.equal(s.events.at(-1)?.kind, 40003);
  assert.deepEqual(s.events.at(-1)?.tags, [["h", CHANNEL], ["e", posted.id]]);
  await assert.rejects(handlerOf(s.app, "buzz_edit")({ channel: CHANNEL, messageId: "b".repeat(64), content: "x" }, s.ctx), (e: ConnectError) => e.code === "buzz_not_own_message");
  await handlerOf(s.app, "buzz_delete")({ channel: CHANNEL, messageId: posted.id }, s.ctx);
  assert.equal(s.events.at(-1)?.kind, 5);
  await assert.rejects(handlerOf(s.app, "buzz_delete")({ channel: CHANNEL, messageId: posted.id }, s.ctx), (e: ConnectError) => e.code === "buzz_not_own_message");
});

test("schedule: validated time, listed, cancelled, due posts sent once by the scheduler", async () => {
  const s = await setup();
  await assert.rejects(handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content: "x", sendAt: new Date(Date.now() - 1000).toISOString() }, s.ctx), (e: ConnectError) => e.code === "buzz_send_at_invalid");
  const a = (await handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content: "later A", sendAt: new Date(Date.now() + 60_000).toISOString() }, s.ctx)) as { id: string };
  const b = (await handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content: "later B", sendAt: new Date(Date.now() + 120_000).toISOString() }, s.ctx)) as { id: string };
  await handlerOf(s.app, "buzz_schedule_cancel")({ id: b.id }, s.ctx);
  await assert.rejects(handlerOf(s.app, "buzz_schedule_cancel")({ id: b.id }, s.ctx), (e: ConnectError) => e.code === "buzz_scheduled_unknown");
  const relay = new BuzzRelay(new BuzzIdentities({ db: s.db, secrets: secretsFor(s.db), relayUrls: RELAY, allowRelayOrigins: ORIGINS }), s.relay.impl);
  const before = s.events.length;
  assert.equal(await runDueBuzzPosts(s.db, relay, s.ctx.log, Date.now() + 61_000), 1);
  assert.equal(await runDueBuzzPosts(s.db, relay, s.ctx.log, Date.now() + 200_000), 0);
  assert.equal(s.events.length, before + 1);
  assert.equal(s.events.at(-1)?.content, "later A");
  const list = (await handlerOf(s.app, "buzz_scheduled")({}, s.ctx)) as { posts: { id: string; status: string; eventId: string | null }[] };
  assert.deepEqual(Object.fromEntries(list.posts.map((p) => [p.id, p.status])), { [a.id]: "sent", [b.id]: "cancelled" });
  // the scheduled post is an own message (editable)
  const sentId = list.posts.find((p) => p.id === a.id)?.eventId ?? "";
  await handlerOf(s.app, "buzz_edit")({ channel: CHANNEL, messageId: sentId, content: "edited" }, s.ctx);
});
