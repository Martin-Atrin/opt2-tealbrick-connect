/** J3 at app level: one owner action creates Buzz identities for 16 agents; keys stay sealed; signing is allowlisted. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "../src/app.ts";
import { BuzzIdentities, normalizeRelayUrl } from "../src/channels/buzz/identity.ts";
import { eventId, KindNotAllowedError, npubEncode, publicKeyOf, signEvent, verifyEvent } from "../src/channels/buzz/nostr.ts";
import { BuzzRelay } from "../src/channels/buzz/relay.ts";
import { fakeFetch, handlerOf, memorySecrets, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const agents = Array.from({ length: 16 }, (_, i) => ({ id: `agt_01AGENT${String(i).padStart(19, "0")}`, name: `Agent ${i + 1}` }));

test("NIP-19 npub vector (NIP-19 spec example)", () => {
  assert.equal(npubEncode("3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"), "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6");
});

test("NIP-01 id and BIP-340 signature verify; tampering fails; kinds are allowlisted", () => {
  const sk = `${"0".repeat(63)}3`;
  const event = signEvent(sk, { kind: 9, created_at: 1_700_000_000, tags: [["h", "c1"]], content: "hi \"there\"\n" });
  assert.equal(event.pubkey, publicKeyOf(sk));
  assert.equal(event.id, eventId(event));
  assert.equal(verifyEvent(event), true);
  assert.equal(verifyEvent({ ...event, content: "changed" }), false);
  assert.throws(() => signEvent(sk, { kind: 3, created_at: 1, tags: [], content: "" }), KindNotAllowedError);
  assert.throws(() => signEvent(sk, { kind: 9000, created_at: 1, tags: [], content: "" }), KindNotAllowedError);
  assert.equal(signEvent(sk, { kind: 0, created_at: 1, tags: [], content: "{}" }).kind, 0);
});

test("J3: one owner action creates identities for 16 agents; a second run changes nothing", async () => {
  const db = testDb();
  const app = createConnectApp({
    manifest,
    migrationsDir: join(root, "migrations"),
  });
  for (const agent of agents) {
    await app.events?.agentAdded?.({ ...agent, id: agent.id as `agt_${string}`, mode: "free", status: "active" }, { db, scopes: null as never, log: testCtx({ db }).log });
  }
  const ctx = testCtx({ db });
  const first = (await handlerOf(app, "buzz_identities_generate")({}, ctx)) as { created: { agent: string; npub: string; pubkey: string }[]; existing: unknown[] };
  assert.equal(first.created.length, 16);
  assert.equal(first.existing.length, 0);
  assert.equal(new Set(first.created.map((i) => i.pubkey)).size, 16);
  for (const identity of first.created) assert.match(identity.npub, /^npub1[02-9ac-hj-np-z]{58}$/u);
  const second = (await handlerOf(app, "buzz_identities_generate")({}, ctx)) as { created: unknown[]; existing: unknown[] };
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 16);
  // Secret keys live only in the SDK app secrets (sealed by the SDK), one per agent; identity rows hold public data.
  assert.equal(secretsFor(db).names().length, 16);
  const rowText = JSON.stringify(db.prepare("SELECT * FROM connect_buzz_identities").all());
  for (const name of secretsFor(db).names()) assert.ok(!rowText.includes((await secretsFor(db).get(name)) ?? "-"));
  // The agent reads only its own identity.
  const mine = (await handlerOf(app, "buzz_identity")({}, testCtx({ db, agent: agents[3]?.id ?? "" }))) as { npub: string };
  assert.equal(mine.npub, first.created.find((i) => i.agent === agents[3]?.id)?.npub);
  const stranger = (await handlerOf(app, "buzz_identity")({}, testCtx({ db, agent: "agt_01NOBODY00000000000000000" }))) as { npub: null };
  assert.equal(stranger.npub, null);
});

test("rotation replaces the key; removal deletes the sealed key", async () => {
  const db = testDb();
  const secrets = memorySecrets();
  const buzz = new BuzzIdentities({ db, secrets });
  const [a] = (await buzz.generateAll([{ id: "agt_A", name: "A" }])).created;
  assert.ok(a);
  const rotated = await buzz.rotate({ id: "agt_A", name: "A" });
  assert.notEqual(rotated.pubkey, a.pubkey);
  await buzz.remove("agt_A");
  assert.equal(buzz.get("agt_A"), null);
  assert.deepEqual(secrets.names(), []);
});

test("relay URL: wss host only; private relays refused", async () => {
  assert.equal(normalizeRelayUrl("wss://relay.example.com/"), "wss://relay.example.com");
  assert.throws(() => normalizeRelayUrl("https://relay.example.com"), /relay_url_invalid/u);
  assert.throws(() => normalizeRelayUrl("wss://relay.example.com/path"), /relay_url_invalid/u);
  const db = testDb();
  const buzz = new BuzzIdentities({ db, secrets: memorySecrets(), relayUrl: "wss://relay.corp.example", lookup: async () => [{ address: "10.0.0.2", family: 4 }] });
  await assert.rejects(buzz.relayHttpBase(), /address_not_allowed|not allowed/u);
  const ws = new BuzzIdentities({ db, secrets: memorySecrets(), relayUrl: "ws://relay.example.com" });
  assert.equal(ws.relayUrl(), null);
  assert.match(ws.relayList().problems[0] ?? "", /wss:\/\//u);
  assert.equal(new BuzzIdentities({ db, secrets: memorySecrets() }).relayUrl(), null);
});

test("profile publish posts a signed kind 0 with a valid NIP-98 header to the test relay", async () => {
  const db = testDb();
  const relay = fakeFetch({
    "POST /events": ({ body, headers, url }) => {
      const auth = headers.get("authorization") ?? "";
      const nip98 = JSON.parse(Buffer.from(auth.replace(/^Nostr /u, ""), "base64").toString("utf8"));
      assert.equal(verifyEvent(nip98), true);
      assert.equal(nip98.kind, 27235);
      assert.deepEqual(nip98.tags.find((t: string[]) => t[0] === "u"), ["u", url.toString()]);
      assert.equal(verifyEvent(body), true);
      assert.equal((body as { kind: number }).kind, 0);
      assert.equal((body as { pubkey: string }).pubkey, nip98.pubkey);
      return { body: { event_id: (body as { id: string }).id, accepted: true, message: "" } };
    },
  });
  const buzz = new BuzzIdentities({
    db,
    secrets: memorySecrets(),
    relayUrl: "wss://relay.test.example",
    allowRelayOrigins: ["wss://relay.test.example", "https://relay.test.example"],
  });
  await buzz.generateAll([{ id: "agt_A", name: "Agent A" }]);
  const published = await new BuzzRelay(buzz, relay.impl).publishProfile("agt_A");
  assert.ok(published.identity.profilePublishedAt);
  assert.deepEqual(published.relays, [{ relay: "wss://relay.test.example", ok: true }]);
  assert.equal(relay.calls.length, 1);
  assert.equal(JSON.parse(((relay.calls[0]?.body ?? {}) as { content: string }).content).name, "Agent A");
});
