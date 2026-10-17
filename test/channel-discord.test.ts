/** Discord provider contract (C58): recorded REST/gateway fixtures, fake fetch, fake WebSocket, manual sleep. No network. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChannelCredentials, ChannelError, type ChannelNet, type InboundMessage } from "../src/channels/provider.ts";
import { DISCORD_GATEWAY_URL, discordProvider, discordReactionPath, parseDiscordMessage } from "../src/channels/providers/discord.ts";
import { fakeNet, fixture, flush, instantSleep, manualSleep, type RecordedRoute, recordedFetch } from "./channel-fakes.ts";

// Fake token (Discord shape, never valid anywhere).
const TOKEN = "MTEwMDAwMDAwMDAwMDAwMDAwMQ.FakeTk.FakeTokenForTestsOnlyxxxxxxxxxxxxxxxx";
const creds = { bot_token: TOKEN };
const fx = fixture("discord.json");
const gw = fx.gateway;
const bot = { botId: "1100000000000000001", botName: "teal-helper" };
const API = "/api/v10";

function setup(routes: Record<string, RecordedRoute>) {
  const fetch = recordedFetch(routes);
  const sleep = instantSleep();
  const { net } = fakeNet({ fetch: fetch.impl, sleep: sleep.sleep });
  return { net, calls: fetch.calls, waits: sleep.waits };
}

function assertChannelError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChannelError, String(error));
    assert.equal(error.code, code, error.message);
    assert.ok(!error.message.includes(TOKEN), "token leaked into the message");
    return true;
  };
}

test("discord: declaration and message_content setting", () => {
  assert.equal(discordProvider.service, "discord");
  assert.deepEqual(discordProvider.credentialFields, ["bot_token"]);
  assert.equal(discordProvider.maxTextLength, 2000);
  assert.equal(discordProvider.inbound.kind, "socket");
  assert.deepEqual(discordProvider.settingFields, [
    { key: "message_content", type: "boolean", default: false, label: "Read message text (needs the MESSAGE CONTENT intent in the Discord developer portal)" },
  ]);
});

test("discord: verify reads /users/@me with a Bot header and the application id as workspace", async () => {
  const { net, calls } = setup({
    [`GET ${API}/users/@me`]: { body: fx.usersMe },
    [`GET ${API}/oauth2/applications/@me`]: { body: fx.application },
  });
  assert.deepEqual(await discordProvider.verify(creds, net), { botId: "1100000000000000001", botName: "teal-helper", workspace: "1100000000000000001" });
  assert.equal(calls[0]?.url, "https://discord.com/api/v10/users/@me");
  assert.equal(calls[0]?.headers.get("authorization"), `Bot ${TOKEN}`);
  assert.match(calls[0]?.headers.get("user-agent") ?? "", /^DiscordBot \(/u);
});

test("discord: verify works without the application endpoint", async () => {
  const { net } = setup({
    [`GET ${API}/users/@me`]: { body: fx.usersMe },
    [`GET ${API}/oauth2/applications/@me`]: { status: 403, body: { message: "Missing Access", code: 50001 } },
  });
  assert.deepEqual(await discordProvider.verify(creds, net), { botId: "1100000000000000001", botName: "teal-helper" });
});

test("discord: a bad token shape is refused before any request; 401 is channel_credentials_rejected", async () => {
  const { net, calls } = setup({ [`GET ${API}/users/@me`]: { status: 401, body: { message: "401: Unauthorized", code: 0 } } });
  await assert.rejects(discordProvider.verify({ bot_token: "short" }, net), assertChannelError("channel_credentials_invalid"));
  await assert.rejects(discordProvider.verify({ bot_token: `Bot ${TOKEN}` }, net), assertChannelError("channel_credentials_invalid"));
  assert.equal(calls.length, 0);
  await assert.rejects(discordProvider.verify(creds, net), assertChannelError("channel_credentials_rejected"));
});

test("discord: conversations lists text and announcement channels per guild, skipping unreadable guilds", async () => {
  const { net, calls } = setup({
    [`GET ${API}/users/@me/guilds`]: { body: fx.guilds },
    [`GET ${API}/guilds/2200000000000000001/channels`]: { body: fx.guildChannels },
    [`GET ${API}/guilds/2200000000000000002/channels`]: { status: 403, body: { message: "Missing Access", code: 50001 } },
  });
  assert.deepEqual(await discordProvider.conversations(creds, net, bot), [
    { id: "3300000000000000001", name: "Acme HQ / #general", type: "channel" },
    { id: "3300000000000000002", name: "Acme HQ / #random", type: "channel" },
    { id: "3300000000000000005", name: "Acme HQ / #news", type: "channel" },
  ]);
  assert.equal(calls.length, 3);
});

test("discord: conversations caps the list at 200", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: String(9000000000000000000n + BigInt(i)), type: 0, position: i, name: `c${i}` }));
  const { net } = setup({
    [`GET ${API}/users/@me/guilds`]: { body: fx.guilds },
    [`GET ${API}/guilds/2200000000000000001/channels`]: { body: many },
    [`GET ${API}/guilds/2200000000000000002/channels`]: { body: many },
  });
  assert.equal((await discordProvider.conversations(creds, net, bot)).length, 200);
});

test("discord: send, edit, delete, react and openDirect request shapes", async () => {
  const { net, calls } = setup({
    [`POST ${API}/channels/3300000000000000001/messages`]: { body: fx.messageCreated },
    [`PATCH ${API}/channels/3300000000000000001/messages/4400000000000000009`]: { body: fx.messageCreated },
    [`DELETE ${API}/channels/3300000000000000001/messages/4400000000000000009`]: { status: 204 },
    [`PUT ${API}/channels/3300000000000000001/messages/4400000000000000009/reactions/%F0%9F%91%8D/@me`]: { status: 204 },
    [`PUT ${API}/channels/3300000000000000001/messages/4400000000000000009/reactions/party%3A1234567890/@me`]: { status: 204 },
    [`POST ${API}/users/@me/channels`]: { body: fx.dmChannel },
  });
  const c = "3300000000000000001";
  const m = "4400000000000000009";
  assert.deepEqual(await discordProvider.send(creds, net, { conversation: c, text: "hello from the agent", threadId: "4400000000000000001" }), { messageId: m });
  assert.deepEqual(calls[0]?.body, {
    content: "hello from the agent",
    allowed_mentions: { parse: [] },
    message_reference: { message_id: "4400000000000000001", fail_if_not_exists: true },
  });
  await discordProvider.send(creds, net, { conversation: c, text: "top level" });
  assert.deepEqual(calls[1]?.body, { content: "top level", allowed_mentions: { parse: [] } });
  await discordProvider.edit(creds, net, { conversation: c, messageId: m, text: "edited" });
  assert.deepEqual(calls[2]?.body, { content: "edited", allowed_mentions: { parse: [] } });
  await discordProvider.delete(creds, net, { conversation: c, messageId: m });
  await discordProvider.react(creds, net, { conversation: c, messageId: m, emoji: "👍" });
  await discordProvider.react(creds, net, { conversation: c, messageId: m, emoji: "<:party:1234567890>" });
  assert.deepEqual(await discordProvider.openDirect(creds, net, { personId: "6600000000000000001" }), { conversation: "5500000000000000001" });
  assert.deepEqual(calls[6]?.body, { recipient_id: "6600000000000000001" });
  assert.deepEqual(
    calls.map((x) => x.method),
    ["POST", "POST", "PATCH", "DELETE", "PUT", "PUT", "POST"],
  );
  assert.ok(calls.every((x) => x.headers.get("authorization") === `Bot ${TOKEN}`));
});

test("discord: input is validated before any request", async () => {
  const { net, calls } = setup({});
  await assert.rejects(discordProvider.send(creds, net, { conversation: "general", text: "x" }), assertChannelError("channel_conversation_invalid"));
  await assert.rejects(discordProvider.send(creds, net, { conversation: "1", text: "a".repeat(2001) }), assertChannelError("channel_text_too_long"));
  await assert.rejects(discordProvider.send(creds, net, { conversation: "1", text: "" }), assertChannelError("channel_message_empty"));
  await assert.rejects(discordProvider.react(creds, net, { conversation: "1", messageId: "2", emoji: "thumbsup" }), assertChannelError("channel_reaction_invalid"));
  await assert.rejects(discordProvider.openDirect(creds, net, { personId: "ada#0001" }), assertChannelError("channel_person_invalid"));
  assert.equal(calls.length, 0);
  assert.equal(discordReactionPath("party:1234567890"), "party%3A1234567890");
  assert.equal(discordReactionPath("1\ufe0f\u20e3"), encodeURIComponent("1\ufe0f\u20e3"));
});

test("discord: error mapping 403 codes, 404, 5xx", async () => {
  const cases: [number, unknown, string][] = [
    [403, { message: "Missing Permissions", code: 50013 }, "channel_not_member"],
    [403, { message: "Missing Access", code: 50001 }, "channel_not_member"],
    [403, { message: "Cannot send messages to this user", code: 50007 }, "channel_dm_not_allowed"],
    [403, { message: "Forbidden", code: 0 }, "channel_forbidden"],
    [404, { message: "Unknown Channel", code: 10003 }, "channel_not_found"],
    [401, { message: "401: Unauthorized", code: 0 }, "channel_credentials_rejected"],
    [503, { message: "upstream" }, "channel_provider_unavailable"],
    [400, { message: "Invalid Form Body", code: 50035 }, "channel_rejected"],
  ];
  for (const [status, body, code] of cases) {
    const { net } = setup({ [`POST ${API}/channels/3300000000000000001/messages`]: { status, body } });
    await assert.rejects(discordProvider.send(creds, net, { conversation: "3300000000000000001", text: "x" }), assertChannelError(code));
  }
  const { net } = setup({ [`POST ${API}/channels/3300000000000000001/messages`]: { status: 403, body: { message: "Missing Permissions", code: 50013 } } });
  await assert.rejects(discordProvider.send(creds, net, { conversation: "3300000000000000001", text: "x" }), (error) => {
    assert.match((error as Error).message, /Send Messages/u);
    return true;
  });
});

test("discord: 429 honours retry_after once; the token never reaches a message", async () => {
  const limited = { status: 429, body: { message: "You are being rate limited.", retry_after: 0.25, global: false } };
  const once = setup({ [`POST ${API}/channels/1/messages`]: [limited, { body: { ...fx.messageCreated, id: "12" } }] });
  assert.deepEqual(await discordProvider.send(creds, once.net, { conversation: "1", text: "x" }), { messageId: "12" });
  assert.deepEqual(once.waits, [250]);
  const twice = setup({ [`POST ${API}/channels/1/messages`]: [limited, limited] });
  await assert.rejects(discordProvider.send(creds, twice.net, { conversation: "1", text: "x" }), assertChannelError("channel_rate_limited"));
  const echo = setup({ [`POST ${API}/channels/1/messages`]: { status: 400, body: { message: `bad token ${TOKEN}`, code: 50035 } } });
  await assert.rejects(discordProvider.send(creds, echo.net, { conversation: "1", text: "x" }), (error) => {
    assertChannelError("channel_rejected")(error);
    assert.match((error as Error).message, /\[redacted\]/u);
    return true;
  });
});

test("discord: parseDiscordMessage normalises MESSAGE_CREATE and ignores bots and itself", () => {
  const ids = [bot.botId];
  assert.deepEqual(parseDiscordMessage(gw.messageGuild.d, ids, 1), {
    conversation: "3300000000000000001",
    conversationType: "channel",
    messageId: "4400000000000000001",
    threadId: null,
    senderId: "6600000000000000001",
    senderName: "Ada (ops)",
    text: "can the agent check the build?\n[attachment: build.log]",
    sentAt: Date.parse("2026-10-12T09:01:02.345Z"),
    mentions: [],
  });
  // R3: another bot is kept and flagged (data apps read it as author kind bot); the bot itself is still ignored.
  assert.deepEqual(
    [parseDiscordMessage(gw.messageOtherBot.d, ids, 1)?.senderIsBot, parseDiscordMessage(gw.messageOtherBot.d, ids, 1)?.senderId],
    [true, "8800000000000000001"],
  );
  assert.equal(parseDiscordMessage(gw.messageOwn.d, ids, 1), null);
  const dm = parseDiscordMessage(gw.messageDmReply.d, ids, 1);
  assert.equal(dm?.conversationType, "direct");
  assert.equal(dm?.threadId, "4400000000000000009");
  assert.equal(parseDiscordMessage({ ...gw.messageGuild.d, content: "", attachments: [] }, ids, 1), null, "empty without MESSAGE CONTENT");
  assert.equal(parseDiscordMessage({ ...gw.messageGuild.d, type: 7 }, ids, 1), null, "system message");
});

// ---------------------------------------------------------------- gateway

function gateway(credentials: ChannelCredentials = creds) {
  const sleep = manualSleep();
  const { net, sockets } = fakeNet({ sleep: sleep.sleep });
  const got: InboundMessage[] = [];
  const controller = new AbortController();
  if (discordProvider.inbound.kind !== "socket") throw new Error("expected socket");
  const running = discordProvider.inbound.run(credentials, net as ChannelNet, bot, (m) => got.push(m), controller.signal);
  return { sleep, sockets, got, controller, running };
}

const socketAt = (sockets: unknown[], i: number) => {
  const s = sockets[i] as import("./channel-fakes.ts").FakeSocket | undefined;
  if (!s) throw new Error(`no socket ${i}`);
  return s;
};

test("discord gateway: HELLO → IDENTIFY, heartbeat, MESSAGE_CREATE → sink, RECONNECT → RESUME, 4004 → credentials error", async () => {
  const { sleep, sockets, got, running } = gateway();
  await flush();
  const s0 = socketAt(sockets, 0);
  assert.equal(s0.url, DISCORD_GATEWAY_URL);
  s0.receive(gw.hello);
  assert.deepEqual(s0.sent[0], {
    op: 2,
    d: { token: TOKEN, intents: (1 << 0) | (1 << 9) | (1 << 12), properties: { os: "linux", browser: "tealbrick-connect", device: "tealbrick-connect" } },
  });
  // First heartbeat after a jittered delay (≤ interval), then every interval.
  const first = sleep.fireLatest();
  assert.ok(first >= 0 && first <= 41250);
  await flush();
  assert.deepEqual(s0.sent[1], { op: 1, d: null });
  s0.receive(gw.ack);
  s0.receive(gw.ready);
  s0.receive(gw.messageGuild);
  s0.receive(gw.messageOtherBot);
  s0.receive(gw.messageOwn);
  s0.receive(gw.messageDmReply);
  assert.deepEqual(
    got.map((m) => [m.conversation, m.messageId, m.conversationType]),
    [
      ["3300000000000000001", "4400000000000000001", "channel"],
      ["3300000000000000001", "4400000000000000002", "channel"],
      ["5500000000000000001", "4400000000000000004", "direct"],
    ],
  );
  assert.equal(sleep.fireLatest(), 41250);
  await flush();
  assert.deepEqual(s0.sent[2], { op: 1, d: 5 }, "heartbeat carries the last seq");
  s0.receive(gw.ack);

  // op 7 RECONNECT: close (non-1000, resumable), back off ≥ 1 s, RESUME on the resume URL.
  s0.receive({ op: 7, d: null });
  assert.equal(s0.closedWith, 4000);
  await flush();
  const backoff = sleep.fireLatest();
  assert.ok(backoff >= 1000, `backoff ${backoff}`);
  await flush();
  const s1 = socketAt(sockets, 1);
  assert.equal(s1.url, "wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json");
  s1.receive(gw.hello);
  assert.deepEqual(s1.sent[0], { op: 6, d: { token: TOKEN, session_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", seq: 5 } });

  s1.serverClose(4004);
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof ChannelError);
    assert.equal(error.code, "channel_credentials_rejected");
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test("discord gateway: message_content adds the MESSAGE_CONTENT intent; abort closes the socket and resolves", async () => {
  const { sockets, controller, running } = gateway({ ...creds, message_content: "true" });
  await flush();
  const s0 = socketAt(sockets, 0);
  s0.receive(gw.hello);
  assert.equal(s0.sent[0]?.d.intents, (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15));
  controller.abort();
  await running;
  assert.equal(s0.closedWith, 1000);
  assert.equal(sockets.length, 1);
});

test("discord gateway: message_content other than \"true\" keeps the intent off", async () => {
  const { sockets, controller, running } = gateway({ ...creds, message_content: "false" });
  await flush();
  socketAt(sockets, 0).receive(gw.hello);
  assert.equal(socketAt(sockets, 0).sent[0]?.d.intents, 4609);
  controller.abort();
  await running;
});

test("discord gateway: a missing heartbeat ACK is a zombie connection → reconnect", async () => {
  const { sleep, sockets, controller, running } = gateway();
  await flush();
  const s0 = socketAt(sockets, 0);
  s0.receive(gw.hello);
  sleep.fireLatest();
  await flush();
  assert.equal(s0.sent.length, 2);
  // No ACK; the next beat finds the connection dead.
  sleep.fireLatest();
  await flush();
  assert.equal(s0.closedWith, 4000);
  assert.ok(sleep.fireLatest() >= 1000);
  await flush();
  const s1 = socketAt(sockets, 1);
  assert.equal(s1.url, DISCORD_GATEWAY_URL, "no READY yet: nothing to resume");
  s1.receive(gw.hello);
  assert.equal(s1.sent[0]?.op, 2);
  controller.abort();
  await running;
  assert.equal(s1.closedWith, 1000);
});

test("discord gateway: a resume URL off discord.gg is not used; op 9 false identifies again", async () => {
  const { sleep, sockets, controller, running } = gateway();
  await flush();
  const s0 = socketAt(sockets, 0);
  s0.receive(gw.hello);
  s0.receive({ ...gw.ready, d: { ...gw.ready.d, resume_gateway_url: "wss://gateway.evil.example" } });
  s0.receive({ op: 7, d: null });
  await flush();
  sleep.fireLatest();
  await flush();
  const s1 = socketAt(sockets, 1);
  assert.equal(s1.url, DISCORD_GATEWAY_URL);
  s1.receive(gw.hello);
  assert.equal(s1.sent[0]?.op, 2, "fresh IDENTIFY");
  s1.receive(gw.ready);
  s1.receive({ op: 9, d: false });
  assert.equal(s1.closedWith, 4000);
  await flush();
  const wait = sleep.fireLatest();
  assert.ok(wait >= 1000 && wait <= 5000, `invalid session wait ${wait}`);
  await flush();
  const s2 = socketAt(sockets, 2);
  assert.equal(s2.url, DISCORD_GATEWAY_URL);
  s2.receive(gw.hello);
  assert.equal(s2.sent[0]?.op, 2);
  controller.abort();
  await running;
});

test("discord gateway: other closes reconnect with backoff ≥ 1 s that grows", async () => {
  const { sleep, sockets, controller, running } = gateway();
  const waits: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await flush();
    socketAt(sockets, i).serverClose(1006);
    await flush();
    waits.push(sleep.fireLatest());
  }
  await flush();
  assert.equal(sockets.length, 4);
  assert.ok(waits.every((w) => w >= 1000));
  assert.ok((waits[2] ?? 0) >= 2000, `backoff grows: ${waits.join(",")}`);
  controller.abort();
  await running;
});

test("discord gateway: 4014 throws channel_gateway_refused with a readable message", async () => {
  const { sockets, running } = gateway({ ...creds, message_content: "true" });
  await flush();
  socketAt(sockets, 0).receive(gw.hello);
  socketAt(sockets, 0).serverClose(4014);
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof ChannelError);
    assert.equal(error.code, "channel_gateway_refused");
    assert.match(error.message, /MESSAGE CONTENT/u);
    return true;
  });
});

test("R3 discord: MESSAGE_UPDATE with edited_timestamp is an edit; a partial update is ignored; MESSAGE_DELETE and MESSAGE_DELETE_BULK are deletions", async () => {
  const { parseDiscordDeletes, parseDiscordUpdate, discordProvider } = await import("../src/channels/providers/discord.ts");
  const ids = [bot.botId];
  const update = parseDiscordUpdate({ ...gw.messageGuild.d, content: "edited text", edited_timestamp: "2026-10-12T09:05:00.000000+00:00" }, ids, 1);
  assert.deepEqual(update?.change, { kind: "edit", at: Date.parse("2026-10-12T09:05:00.000Z") });
  assert.equal(update?.text, "edited text\n[attachment: build.log]");
  assert.equal(update?.messageId, "4400000000000000001");
  assert.equal(parseDiscordUpdate({ ...gw.messageGuild.d, edited_timestamp: null }, ids, 1), null, "a link preview update is not an edit");
  assert.equal(parseDiscordUpdate({ id: "4400000000000000001", channel_id: "3300000000000000001", edited_timestamp: "2026-10-12T09:05:00.000000+00:00" }, ids, 1), null, "no author, no text");
  const one = parseDiscordDeletes({ id: "4400000000000000001", channel_id: "3300000000000000001", guild_id: "2200000000000000001" }, 7);
  assert.deepEqual(one.map((m) => [m.conversation, m.messageId, m.change]), [["3300000000000000001", "4400000000000000001", { kind: "delete" }]]);
  const bulk = parseDiscordDeletes({ ids: ["4400000000000000001", "4400000000000000002", "nope"], channel_id: "3300000000000000001" }, 7);
  assert.deepEqual(bulk.map((m) => m.messageId), ["4400000000000000001", "4400000000000000002"]);
  assert.deepEqual(parseDiscordDeletes({ id: "x", channel_id: "bad" }, 7), []);
  assert.deepEqual(discordProvider.reports, { edits: true, deletions: true });
});
