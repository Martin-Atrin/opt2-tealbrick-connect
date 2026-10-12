/** J3 channel work: an agent lists its Buzz channels, reads a channel, posts as itself (fake test relay). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { BuzzIdentities } from "../src/channels/buzz/identity.ts";

import { eventId, generateSecretKey, type NostrEvent, publicKeyOf, signEvent, verifyEvent } from "../src/channels/buzz/nostr.ts";
import { type BuzzRefusal, BuzzRelay, cleanText } from "../src/channels/buzz/relay.ts";
import { fakeFetch, memorySecrets, testDb } from "./helpers.ts";

const CHANNEL = "0b7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const OTHER_CHANNEL = "1c8e7d3f-2a4b-4d6c-8e9f-0a1b2c3d4e5f";
const human = generateSecretKey();

async function setup() {
  const db = testDb();
  const posted: NostrEvent[] = [];
  let agentPubkey = "";
  const relay = fakeFetch({
    "POST /query": ({ body, headers }) => {
      const auth = JSON.parse(Buffer.from((headers.get("authorization") ?? "").replace(/^Nostr /u, ""), "base64").toString("utf8"));
      assert.equal(verifyEvent(auth), true);
      assert.equal(auth.pubkey, agentPubkey);
      const filter = (body as Record<string, unknown>[])[0] ?? {};
      const kinds = filter.kinds as number[];
      if (kinds[0] === 39002) {
        return { body: [membersEvent(agentPubkey)] };
      }
      if (kinds[0] === 39000) return { body: [metaEvent(CHANNEL, "general", []), metaEvent(OTHER_CHANNEL, "not-mine", [])] };
      if (kinds[0] === 9) {
        const good = signEvent(human, { kind: 9, created_at: 100, tags: [["h", CHANNEL]], content: "hello ‮agent" });
        const forged = { ...good, content: "tampered" };
        const elsewhere = signEvent(human, { kind: 9, created_at: 101, tags: [["h", OTHER_CHANNEL]], content: "x" });
        return { body: [good, forged, elsewhere] };
      }
      return { body: [] };
    },
    "POST /events": ({ body }) => {
      posted.push(body as NostrEvent);
      return { body: { accepted: true, event_id: (body as NostrEvent).id } };
    },
  });
  const identities = new BuzzIdentities({
    relayUrl: "wss://relay.test.example",
    db,
    secrets: memorySecrets(),
    fetchImpl: relay.impl,
    allowRelayOrigins: ["wss://relay.test.example", "https://relay.test.example"],
  });
  const created = (await identities.generateAll([{ id: "agt_A", name: "A" }])).created[0];
  assert.ok(created);
  agentPubkey = created.pubkey;
  return { identities, relay: new BuzzRelay(identities, relay.impl), posted, agentPubkey };
}

/** Relay-signed replaceable events (kinds 39000/39002 are signed by the relay key, outside Connect's allowlist). */
const relayKey = generateSecretKey();
function relaySigned(kind: number, tags: string[][]): NostrEvent {
  const unsigned = { pubkey: publicKeyOf(relayKey), created_at: 5, kind, tags, content: "" };
  const id = eventId(unsigned);
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), Buffer.from(relayKey, "hex"))).toString("hex");
  return { id, ...unsigned, sig };
}
function membersEvent(pubkey: string) {
  return relaySigned(39002, [["d", CHANNEL], ["p", pubkey]]);
}
function metaEvent(id: string, name: string, flags: string[][]) {
  return relaySigned(39000, [["d", id], ["name", name], ...flags]);
}

test("channels: only channels whose member list names the agent", async () => {
  const s = await setup();
  assert.deepEqual(await s.relay.channels("agt_A"), [{ id: CHANNEL, name: "general", type: "channel" }]);
});

test("read: forged and off-channel events dropped, bidi stripped", async () => {
  const s = await setup();
  const messages = await s.relay.read("agt_A", { channel: CHANNEL, since: 50 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, "hello agent");
  assert.equal(messages[0]?.fromSelf, false);
  await assert.rejects(s.relay.read("agt_A", { channel: "not-a-uuid" }), /buzz_channel_invalid/u);
});

test("post: kind 9 signed by the agent with h tag and NIP-10 reply tags", async () => {
  const s = await setup();
  const root = "a".repeat(64);
  const reply = "b".repeat(64);
  const out = await s.relay.post("agt_A", { channel: CHANNEL, content: "on it", replyTo: { id: reply, root } });
  const event = s.posted[0];
  assert.ok(event);
  assert.equal(out.id, event.id);
  assert.equal(verifyEvent(event), true);
  assert.equal(event.pubkey, s.agentPubkey);
  assert.deepEqual(event.tags, [["h", CHANNEL], ["e", root, "", "root"], ["e", reply, "", "reply"]]);
  await assert.rejects(s.relay.post("agt_A", { channel: CHANNEL, content: "  " }), /buzz_content_invalid/u);
});

test("relay text cleaning keeps newlines and drops control and bidi characters", () => {
  assert.equal(cleanText("a\nb\u0007‮c"), "a\nbc");
});

test("posting to a channel the agent is not a member of is a clear refusal (QA S3)", async () => {
  const db = testDb();
  const relay = fakeFetch({
    "POST /events": () => ({ status: 400, body: { error: "restricted: not a channel member" } }),
  });
  const identities = new BuzzIdentities({ db, secrets: memorySecrets(), fetchImpl: relay.impl, relayUrl: "wss://relay.test.example", allowRelayOrigins: ["wss://relay.test.example", "https://relay.test.example"] });
  await identities.generateAll([{ id: "agt_A", name: "A" }]);
  const r = new BuzzRelay(identities, relay.impl);
  await assert.rejects(r.post("agt_A", { channel: CHANNEL, content: "hi" }), (e: BuzzRefusal) => e.code === "buzz_not_member" && e.httpStatus === 403);
});
