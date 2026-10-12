/**
 * J3 smoke against a REAL Buzz relay that you run yourself as a TEST relay (never a relay with real people, C22):
 *
 *   node scripts/buzz-relay-smoke.ts --relay ws://localhost:3000 [--agents 16]
 *
 * 1. ONE owner action creates Buzz identities for N agents (Connect's BuzzIdentities, in-memory secrets).
 * 2. Connect publishes every agent's kind 0 profile through the relay HTTP bridge (NIP-98).
 * 3. A throwaway "owner" key (this script, standing in for the owner's Buzz client) creates a channel and adds
 *    every agent npub (NIP-29 kinds 9007 / 9000).
 * 4. Each agent lists its channels; agent 1 posts as itself; agent 2 reads the post; a reply threads.
 * Exit code 1 on any failed step. Writes nothing to disk.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { schnorr } from "@noble/curves/secp256k1.js";
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { BuzzIdentities } from "../src/channels/buzz/identity.ts";
import { eventId, generateSecretKey, nip98Header, publicKeyOf } from "../src/channels/buzz/nostr.ts";
import { BuzzRelay } from "../src/channels/buzz/relay.ts";

const { values } = parseArgs({ options: { relay: { type: "string" }, agents: { type: "string", default: "16" } } });
if (!values.relay) {
  console.error("usage: node scripts/buzz-relay-smoke.ts --relay ws://localhost:3000 [--agents 16]");
  process.exit(2);
}
const relayUrl = values.relay;
const httpBase = relayUrl.replace(/^wss:/u, "https:").replace(/^ws:/u, "http:");
const origins = [new URL(relayUrl).origin, new URL(httpBase).origin];

function memoryDb(): Db {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_drop_unused_tables.sql", "0003_buzz_contacts.sql", "0004_channels.sql"]) db.exec(readFileSync(join(import.meta.dirname, "..", "migrations", f), "utf8"));
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        run: (...p) => st.run(...(p as never[])) as { changes: number; lastInsertRowid: number | bigint },
        get: (...p) => st.get(...(p as never[])) as Record<string, unknown> | undefined,
        all: (...p) => st.all(...(p as never[])) as Record<string, unknown>[],
      };
    },
    transaction: <T>(fn: () => T) => {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const store = new Map<string, string>();
const secrets = { put: async (n: string, v: string) => void store.set(n, v), get: async (n: string) => store.get(n) ?? null, delete: async (n: string) => void store.delete(n) };
const identities = new BuzzIdentities({ db: memoryDb(), secrets, relayUrl, allowRelayOrigins: origins });
const relay = new BuzzRelay(identities);

/** The test owner signs group admin kinds directly (Connect's allowlist never signs them). */
async function ownerPublish(ownerSecret: string, kind: number, tags: string[][], content = ""): Promise<void> {
  const unsigned = { pubkey: publicKeyOf(ownerSecret), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = eventId(unsigned);
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), Buffer.from(ownerSecret, "hex"))).toString("hex");
  const body = JSON.stringify({ id, ...unsigned, sig });
  const url = `${httpBase}/events`;
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", authorization: nip98Header(ownerSecret, { url, method: "POST", body }) } });
  const answer = (await res.json().catch(() => ({}))) as { accepted?: boolean; message?: string };
  if (!res.ok || answer.accepted === false) throw new Error(`owner kind ${kind} rejected: ${res.status} ${answer.message ?? ""}`);
}

const steps: { step: string; ok: boolean; detail: string }[] = [];
async function step(name: string, fn: () => Promise<string>) {
  try {
    steps.push({ step: name, ok: true, detail: await fn() });
  } catch (error) {
    steps.push({ step: name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const n = Number(values.agents);
const agents = Array.from({ length: n }, (_, i) => ({ id: `agt_smoke_${String(i + 1).padStart(2, "0")}`, name: `Smoke agent ${i + 1}` }));
const channel = randomUUID();
const owner = generateSecretKey();
try {
  await step("one owner action: identities for all agents", async () => {
    const t0 = Date.now();
    const r = await identities.generateAll(agents);
    if (r.created.length !== n) throw new Error(`created ${r.created.length} of ${n}`);
    return `${n} identities in ${Date.now() - t0} ms`;
  });
  await step("relay from setting", async () => identities.relayUrl() ?? "not set");
  await step("kind 0 profiles published", async () => {
    for (const a of agents) await identities.publishProfile(a.id);
    return `${n} profiles`;
  });
  await step("owner creates a channel and adds every agent npub", async () => {
    await ownerPublish(owner, 9007, [["h", channel], ["name", "opt2-smoke"], ["channel_type", "stream"]]);
    for (const identity of identities.list()) await ownerPublish(owner, 9000, [["h", channel], ["p", identity.pubkey]]);
    return `channel ${channel.slice(0, 8)}…, ${n} members`;
  });
  await step("every agent sees the channel", async () => {
    let seen = 0;
    for (const a of agents) if ((await relay.channels(a.id)).some((c) => c.id === channel)) seen += 1;
    if (seen !== n) throw new Error(`${seen} of ${n} agents see the channel`);
    return `${seen}/${n}`;
  });
  let postId = "";
  await step("agent 1 posts as itself", async () => {
    postId = (await relay.post(agents[0]?.id ?? "", { channel, content: "Hello from agent 1 (opt2 smoke)" })).id;
    return postId.slice(0, 12);
  });
  await step("agent 2 reads the post and replies in thread", async () => {
    const messages = await relay.read(agents[1]?.id ?? "", { channel });
    const hit = messages.find((m) => m.id === postId);
    if (!hit || hit.author !== identities.get(agents[0]?.id ?? "")?.npub) throw new Error("post not visible with the right author");
    await relay.post(agents[1]?.id ?? "", { channel, content: "Reply from agent 2", replyTo: { id: postId } });
    const after = await relay.read(agents[0]?.id ?? "", { channel });
    if (!after.some((m) => m.threadId === postId)) throw new Error("reply not threaded");
    return `${after.length} messages`;
  });
  await step("agent 1 direct-messages agent 2 (kind 41010 + 9); agent 2 reads it; reopen reuses the conversation", async () => {
    const to = identities.get(agents[1]?.id ?? "")?.npub ?? "";
    const first = await relay.directMessage(agents[0]?.id ?? "", { to, content: "Direct hello from agent 1 (opt2 smoke)" });
    const seen = await relay.read(agents[1]?.id ?? "", { channel: first.channel });
    if (!seen.some((m) => m.id === first.id)) throw new Error("DM not visible to the recipient");
    const again = await relay.directMessage(agents[0]?.id ?? "", { to, content: "second DM" });
    if (again.channel !== first.channel) throw new Error("second DM opened a new conversation");
    return `channel ${first.channel.slice(0, 8)}…`;
  });
  await step("agent 2 reacts; agent 1 edits then deletes its own post", async () => {
    const react = await relay.react(agents[1]?.id ?? "", { channel, messageId: postId, emoji: "👍" });
    const edit = await relay.edit(agents[0]?.id ?? "", { channel, messageId: postId, content: "Hello from agent 1 (edited)" });
    const del = await relay.remove(agents[0]?.id ?? "", { channel, messageId: postId });
    return `reaction ${react.id.slice(0, 8)}…, edit ${edit.id.slice(0, 8)}…, delete ${del.id.slice(0, 8)}…`;
  });
} catch {
  // reported below
}
for (const s of steps) console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.step}: ${s.detail}`);
process.exit(steps.every((s) => s.ok) && steps.length === 9 ? 0 : 1);
