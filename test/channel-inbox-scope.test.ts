/**
 * F35 (Connect 0.5.0): channel_inbox has no manifest scopeType, so its handler filter is the ONLY scope guard.
 * (1) no chat bot → empty inbox (not scope_denied); (2) read scope on bot A → only A's messages;
 * (3) never another agent's bot messages, even when the input names that account (and even with scope on it).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "../src/app.ts";
import type { ChannelNet, ChannelProvider, InboundMessage, InboundSink } from "../src/channels/provider.ts";
import { eventCtx, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01INBOXAGENT00000000000000";
const OTHER = "agt_01INBOXOTHER00000000000000";

type Inbox = { messages: { text: string }[]; untrusted: boolean };

async function setup() {
  // One sink per bot (keyed by its token), so each bot's inbound worker delivers to its own account.
  const sinks = new Map<string, InboundSink>();
  const provider: ChannelProvider = {
    service: "telegram",
    credentialFields: ["bot_token"],
    maxTextLength: 4096,
    verify: async (creds) => ({ botId: `bot-${String(creds.bot_token)}`, botName: "Test bot" }),
    conversations: async () => [],
    send: async () => ({ messageId: "m1" }),
    edit: async () => undefined,
    delete: async () => undefined,
    react: async () => undefined,
    openDirect: async (_c, _n, input) => ({ conversation: `dm-${input.personId}` }),
    inbound: {
      kind: "poll",
      run: async (creds, _net, _bot, sink, signal) => {
        sinks.set(String(creds.bot_token), sink);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  };
  const net: ChannelNet = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", provider]]), channelNet: net });
  for (const id of [AGENT, OTHER]) await app.events?.agentAdded?.({ id: id as `agt_${string}`, name: id, mode: "free", status: "active" }, eventCtx(db));
  const person = testCtx({ db, person: true });
  const bot = async (agent: string, token: string): Promise<string> => {
    const out = (await handlerOf(app, "channel_account_connect")({ service: "telegram", label: token, agent, credentials: { bot_token: token } }, person)) as { account: { id: string } };
    await new Promise((r) => setTimeout(r, 10));
    return out.account.id;
  };
  const deliver = (token: string, id: string, text: string) => {
    const m: InboundMessage = { conversation: "chan-1", conversationType: "channel", messageId: id, threadId: null, senderId: "u1", senderName: "Ann", text, sentAt: 1 };
    sinks.get(token)?.(m);
  };
  const inbox = async (agent: string, access: Record<string, "read" | "read_update">, input: Record<string, string> = {}) =>
    (await handlerOf(app, "channel_inbox")(input, testCtx({ db, agent, access }))) as Inbox;
  return { db, app, bot, deliver, inbox };
}

test("manifest: channel_inbox is agent read with no scopeType (the handler filters)", () => {
  const op = manifest.operations.find((o) => o.id === "channel_inbox");
  assert.deepEqual([op?.crud, op?.effect, op?.scopeType], [["read"], "read", undefined]);
});

test("(1) an agent with no chat bot (and no account scope at all) gets an empty inbox, not scope_denied", async () => {
  const s = await setup();
  const out = await s.inbox(AGENT, {});
  assert.deepEqual(out.messages, []);
  assert.equal(out.untrusted, true);
});

test("(2) read scope on bot A shows only A's messages; no scope on an own bot hides it", async () => {
  const s = await setup();
  const a = await s.bot(AGENT, "tok-a");
  s.deliver("tok-a", "1", "to bot A");
  const b = await s.bot(AGENT, "tok-b");
  s.deliver("tok-b", "2", "to bot B");
  assert.deepEqual((await s.inbox(AGENT, { [a]: "read" })).messages.map((m) => m.text), ["to bot A"]);
  assert.deepEqual((await s.inbox(AGENT, { [b]: "read" })).messages.map((m) => m.text), ["to bot B"]);
  assert.deepEqual((await s.inbox(AGENT, { [a]: "read", [b]: "read" })).messages.map((m) => m.text).sort(), ["to bot A", "to bot B"]);
  // Naming B without scope on it narrows to nothing (input can only narrow).
  assert.deepEqual((await s.inbox(AGENT, { [a]: "read" }, { account: b })).messages, []);
  assert.deepEqual((await s.inbox(AGENT, {})).messages, []);
});

test("(3) never another agent's bot messages, even when the input names that account or the caller has scope on it", async () => {
  const s = await setup();
  const mine = await s.bot(AGENT, "tok-mine");
  const theirs = await s.bot(OTHER, "tok-theirs");
  s.deliver("tok-mine", "1", "for AGENT");
  s.deliver("tok-theirs", "2", "for OTHER");
  assert.deepEqual((await s.inbox(OTHER, { [theirs]: "read" })).messages.map((m) => m.text), ["for OTHER"]);
  // AGENT names OTHER's bot: nothing, with or without a scope row on it.
  assert.deepEqual((await s.inbox(AGENT, { [mine]: "read" }, { account: theirs })).messages, []);
  assert.deepEqual((await s.inbox(AGENT, { [mine]: "read", [theirs]: "read_update" }, { account: theirs })).messages, []);
  assert.deepEqual((await s.inbox(AGENT, { [mine]: "read", [theirs]: "read_update" })).messages.map((m) => m.text), ["for AGENT"]);
});
