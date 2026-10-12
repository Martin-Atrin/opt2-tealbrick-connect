/** C58 Teams provider: token cache, Bot Connector request shapes, serviceUrl allowlist, webhook JWT (keys made here). */
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { type BotIdentity, ChannelError, type ChannelNet } from "../src/channels/provider.ts";
import { parseTeamsConversationRef, resetTeamsCaches, teamsConversationRef, teamsProvider } from "../src/channels/providers/teams.ts";

const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "channels", "teams-activities.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;

const APP_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
// A fake secret shape only; nothing here is a real credential.
const SECRET = "test~client.secret_0000000000000000";
const CREDS = { app_id: APP_ID, client_secret: SECRET, tenant_id: TENANT };
const BOT: BotIdentity = { botId: `28:${APP_ID}`, botName: "Teams bot", workspace: TENANT };
const SERVICE = "https://smba.trafficmanager.net/amer";
const CONV = "19:testchannel0001@thread.tacv2";
const REF = `${SERVICE}|${CONV}`;
const ACCESS_TOKEN = String(fixtures.token?.access_token);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const jwkOf = (key: KeyObject, kid: string) => ({ ...key.export({ format: "jwk" }), kid, kty: "RSA", use: "sig", endorsements: ["msteams"] });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Call = { method: string; url: string; headers: Headers; body: string };

function teamsNet(routes: Record<string, Reply | ((call: Call, n: number) => Reply)> = {}) {
  let now = 1_760_241_600_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const base: Record<string, Reply | ((call: Call, n: number) => Reply)> = {
    [`POST https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`]: { body: fixtures.token },
    "GET https://login.botframework.com/v1/.well-known/openidconfiguration": { body: fixtures.openid },
    "GET https://login.botframework.com/v1/.well-known/keys": { body: { keys: [jwkOf(publicKey, KID)] } },
    ...routes,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    calls.push(call);
    const key = `${call.method} ${call.url}`;
    const route = base[key];
    const n = calls.filter((c) => `${c.method} ${c.url}` === key).length;
    const out = typeof route === "function" ? route(call, n) : (route ?? { status: 404, body: { error: { code: "NotFound" } } });
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json", ...out.headers },
    });
  }) as typeof fetch;
  const net: ChannelNet = {
    fetch: fetchImpl,
    webSocket: () => {
      throw new Error("teams uses no socket");
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const count = (pattern: string) => calls.filter((c) => `${c.method} ${c.url}`.includes(pattern)).length;
  return {
    net,
    calls,
    sleeps,
    count,
    advance: (ms: number) => {
      now += ms;
    },
    nowSeconds: () => Math.floor(now / 1000),
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string, status?: number): Promise<ChannelError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ChannelError, `expected ChannelError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.httpStatus, status);
    assert.ok(!error.message.includes(SECRET) && !error.message.includes(ACCESS_TOKEN), "secret leaked into the error");
    return error;
  }
  assert.fail(`expected ${code}`);
}

beforeEach(() => resetTeamsCaches());

// ---------------------------------------------------------------- outbound

test("verify: a client-credentials token proves the app → 28:<app_id>, tenant as workspace; conversations is empty", async () => {
  const t = teamsNet();
  assert.deepEqual(await teamsProvider.verify(CREDS, t.net), BOT);
  const token = t.calls[0];
  assert.equal(token?.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  const form = new URLSearchParams(token?.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("client_id"), APP_ID);
  assert.equal(form.get("scope"), "https://api.botframework.com/.default");
  assert.deepEqual(await teamsProvider.conversations(CREDS, t.net, BOT), []);

  await rejectsWith(teamsProvider.verify({ ...CREDS, app_id: "not-a-guid" }, t.net), "channel_credentials_invalid");
  await rejectsWith(teamsProvider.verify({ app_id: APP_ID, tenant_id: TENANT }, t.net), "channel_credentials_missing");
  assert.equal(t.calls.length, 1, "no request for a malformed credential");
});

test("token: rejected credentials → channel_credentials_rejected without the secret", async () => {
  const t = teamsNet({ [`POST https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`]: { status: 401, body: fixtures.token_error } });
  await rejectsWith(teamsProvider.verify(CREDS, t.net), "channel_credentials_rejected", 401);
});

test("token: cached until expiry − 5 min, concurrent requests share one fetch, renewed after", async () => {
  const t = teamsNet({ [`POST ${SERVICE}/v3/conversations/${encodeURIComponent(CONV)}/activities`]: { status: 201, body: { id: "1760241700000" } } });
  await Promise.all([teamsProvider.verify(CREDS, t.net), teamsProvider.verify(CREDS, t.net)]);
  await teamsProvider.send(CREDS, t.net, { conversation: REF, text: "one" });
  assert.equal(t.count("oauth2/v2.0/token"), 1);
  t.advance(3599_000 - 5 * 60_000 - 1_000);
  await teamsProvider.send(CREDS, t.net, { conversation: REF, text: "two" });
  assert.equal(t.count("oauth2/v2.0/token"), 1, "still inside the cache window");
  t.advance(2_000);
  await teamsProvider.send(CREDS, t.net, { conversation: REF, text: "three" });
  assert.equal(t.count("oauth2/v2.0/token"), 2, "renewed 5 minutes before expiry");
  // A rotated secret is a different cache entry.
  await teamsProvider.verify({ ...CREDS, client_secret: `${SECRET}x` }, t.net);
  assert.equal(t.count("oauth2/v2.0/token"), 3);
});

test("send / reply / edit / delete: Bot Connector request shapes with the Bearer token", async () => {
  const activities = `${SERVICE}/v3/conversations/${encodeURIComponent(CONV)}/activities`;
  const t = teamsNet({
    [`POST ${activities}`]: { status: 201, body: { id: "1760241700000" } },
    [`POST ${activities}/1760241500000`]: { status: 201, body: { id: "1760241800000" } },
    [`PUT ${activities}/1760241700000`]: { body: { id: "1760241700000" } },
    [`DELETE ${activities}/1760241700000`]: { status: 200 },
  });
  assert.deepEqual(await teamsProvider.send(CREDS, t.net, { conversation: REF, text: "**hello**" }), { messageId: "1760241700000" });
  assert.deepEqual(await teamsProvider.send(CREDS, t.net, { conversation: REF, text: "reply", threadId: "1760241500000" }), { messageId: "1760241800000" });
  await teamsProvider.edit(CREDS, t.net, { conversation: REF, messageId: "1760241700000", text: "edited" });
  await teamsProvider.delete(CREDS, t.net, { conversation: REF, messageId: "1760241700000" });
  const connector = t.calls.filter((c) => c.url.startsWith(SERVICE));
  assert.deepEqual(
    connector.map((c) => `${c.method} ${c.url.slice(activities.length) || "/"}`),
    ["POST /", "POST /1760241500000", "PUT /1760241700000", "DELETE /1760241700000"],
  );
  for (const c of connector) assert.equal(c.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(connector[0]?.body ?? ""), { type: "message", text: "**hello**", textFormat: "markdown" });
  assert.deepEqual(JSON.parse(connector[2]?.body ?? ""), { type: "message", id: "1760241700000", text: "edited", textFormat: "markdown" });
  assert.equal(connector[3]?.body, "");

  await rejectsWith(teamsProvider.send(CREDS, t.net, { conversation: REF, text: "" }), "channel_text_empty");
  await rejectsWith(teamsProvider.send(CREDS, t.net, { conversation: REF, text: "x".repeat(28_001) }), "channel_text_too_long");
  await rejectsWith(teamsProvider.send(CREDS, t.net, { conversation: REF, text: "<at>Everyone</at> hi" }), "channel_input_invalid");
  await rejectsWith(teamsProvider.react(CREDS, t.net, { conversation: REF, messageId: "1760241700000", emoji: "like" }), "channel_action_unsupported");
});

test("connector errors: 401 renews the token once, 403 → not member, 429 Retry-After once", async () => {
  const activities = `${SERVICE}/v3/conversations/${encodeURIComponent(CONV)}/activities`;
  const renew = teamsNet({ [`POST ${activities}`]: (_c, n) => (n === 1 ? { status: 401 } : { status: 201, body: { id: "1" } }) });
  assert.deepEqual(await teamsProvider.send(CREDS, renew.net, { conversation: REF, text: "hi" }), { messageId: "1" });
  assert.equal(renew.count("oauth2/v2.0/token"), 2);

  resetTeamsCaches();
  const forbidden = teamsNet({ [`POST ${activities}`]: { status: 403, body: { error: { code: "BotNotInConversationRoster" } } } });
  const error = await rejectsWith(teamsProvider.send(CREDS, forbidden.net, { conversation: REF, text: "hi" }), "channel_not_member", 403);
  assert.match(error.message, /Install the app/u);

  resetTeamsCaches();
  const limited = teamsNet({ [`POST ${activities}`]: (_c, n) => (n === 1 ? { status: 429, headers: { "retry-after": "3" } } : { status: 201, body: { id: "2" } }) });
  assert.deepEqual(await teamsProvider.send(CREDS, limited.net, { conversation: REF, text: "hi" }), { messageId: "2" });
  assert.deepEqual(limited.sleeps, [3000]);
});

test("openDirect: POST /v3/conversations with bot, member, tenant; returns a conversation ref", async () => {
  const t = teamsNet({ [`POST ${SERVICE}/v3/conversations`]: { status: 201, body: { id: "a:1PersonalChatId-_x" } } });
  const person = teamsConversationRef(`${SERVICE}/`, "29:1TestUserAbc-_x");
  assert.equal(person, `${SERVICE}|29:1TestUserAbc-_x`);
  assert.deepEqual(await teamsProvider.openDirect(CREDS, t.net, { personId: person }), { conversation: `${SERVICE}|a:1PersonalChatId-_x` });
  const call = t.calls.find((c) => c.url === `${SERVICE}/v3/conversations`);
  assert.deepEqual(JSON.parse(call?.body ?? ""), {
    bot: { id: `28:${APP_ID}` },
    members: [{ id: "29:1TestUserAbc-_x" }],
    tenantId: TENANT,
    isGroup: false,
    channelData: { tenant: { id: TENANT } },
  });
  await rejectsWith(teamsProvider.openDirect(CREDS, t.net, { personId: `${SERVICE}|19:notaperson@thread.v2` }), "channel_input_invalid");
});

test("serviceUrl allowlist: only https Bot Connector hosts, no port; nothing is sent elsewhere", async () => {
  assert.deepEqual(parseTeamsConversationRef(`https://smba.trafficmanager.net/emea/|${CONV}`), { serviceUrl: "https://smba.trafficmanager.net/emea", id: CONV });
  assert.deepEqual(parseTeamsConversationRef(`https://smba.infra.gcc.teams.microsoft.com/gcc|${CONV}`).serviceUrl, "https://smba.infra.gcc.teams.microsoft.com/gcc");
  const t = teamsNet();
  for (const bad of [
    `https://evil.example.com/amer|${CONV}`,
    `http://smba.trafficmanager.net/amer|${CONV}`,
    `https://smba.trafficmanager.net:8443/amer|${CONV}`,
    `https://user:pw@smba.trafficmanager.net/amer|${CONV}`,
    `https://smba.trafficmanager.net.evil.com/amer|${CONV}`,
    `https://smba.trafficmanager.net/amer?x=1|${CONV}`,
    CONV,
    `${SERVICE}|`,
  ]) {
    await rejectsWith(teamsProvider.send(CREDS, t.net, { conversation: bad, text: "hi" }), "channel_input_invalid");
    await rejectsWith(teamsProvider.openDirect(CREDS, t.net, { personId: bad.replace(CONV, "29:1abc") }), "channel_input_invalid");
  }
  assert.equal(t.calls.length, 0, "no token fetched and no request made for a bad reference");
});

// ---------------------------------------------------------------- inbound webhook

function jwt(claims: Record<string, unknown>, options: { kid?: string; alg?: string; key?: KeyObject } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT", x5t: options.kid ?? KID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = options.alg === "HS256" ? createHmac("sha256", APP_ID).update(data).digest() : sign("RSA-SHA256", Buffer.from(data), options.key ?? privateKey);
  return `${data}.${signature.toString("base64url")}`;
}

function claimsFor(t: ReturnType<typeof teamsNet>, overrides: Record<string, unknown> = {}) {
  return {
    serviceurl: "https://smba.trafficmanager.net/amer/",
    nbf: t.nowSeconds() - 10,
    exp: t.nowSeconds() + 3600,
    iss: "https://api.botframework.com",
    aud: APP_ID,
    ...overrides,
  };
}

function webhook() {
  if (teamsProvider.inbound.kind !== "webhook") assert.fail("teams inbound is a webhook");
  return teamsProvider.inbound.verifyWebhook;
}

function request(token: string | null, body: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return { headers, body: typeof body === "string" ? body : JSON.stringify(body) };
}

test("webhook: a valid Bot Framework token → message with refs, thread, bot mention stripped; 200 empty reply", async () => {
  const t = teamsNet();
  const out = await webhook()(request(jwt(claimsFor(t)), fixtures.message), CREDS, t.net, BOT);
  assert.deepEqual(out.reply, { status: 200, body: "" });
  assert.deepEqual(out.messages, [
    {
      conversation: REF,
      conversationName: "General",
      conversationType: "channel",
      messageId: "1760241600000",
      threadId: "1760241500000",
      senderId: `${SERVICE}|29:1TestUserAbc-_x`,
      senderName: "Ada Lovelace",
      text: "please summarise Grace's notes",
      sentAt: Date.parse("2026-10-12T04:00:00.000Z"),
    },
  ]);
  // senderId is directly usable as an openDirect personId
  assert.equal(parseTeamsConversationRef(out.messages[0]?.senderId ?? "").id, "29:1TestUserAbc-_x");
  assert.equal(t.count("openidconfiguration"), 1);
  assert.equal(t.count("well-known/keys"), 1);

  // keys are cached: a second request fetches nothing
  await webhook()(request(jwt(claimsFor(t)), fixtures.message), CREDS, t.net, BOT);
  assert.equal(t.count("well-known/keys"), 1);
});

test("webhook: conversationUpdate and bot senders carry no messages", async () => {
  const t = teamsNet();
  const update = await webhook()(request(jwt(claimsFor(t)), fixtures.conversationUpdate), CREDS, t.net, BOT);
  assert.deepEqual(update, { messages: [], reply: { status: 200, body: "" } });
  const fromBot = { ...fixtures.message, from: { id: "28:99999999-0000-0000-0000-000000000000", name: "Other bot" } };
  assert.deepEqual((await webhook()(request(jwt(claimsFor(t)), fromBot), CREDS, t.net, BOT)).messages, []);
  const personal = {
    ...fixtures.message,
    id: "1760241600001",
    text: "hi there",
    entities: [],
    conversation: { conversationType: "personal", tenantId: TENANT, id: "a:1PersonalChatId-_x" },
  };
  const direct = await webhook()(request(jwt(claimsFor(t)), personal), CREDS, t.net, BOT);
  assert.equal(direct.messages[0]?.conversationType, "direct");
  assert.equal(direct.messages[0]?.threadId, null);
  assert.equal(direct.messages[0]?.conversation, `${SERVICE}|a:1PersonalChatId-_x`);
});

test("webhook: every verification failure is the same generic 401", async () => {
  const t = teamsNet();
  // warm the key cache with one valid request so "unknown kid" is not just "no keys yet"
  await webhook()(request(jwt(claimsFor(t)), fixtures.message), CREDS, t.net, BOT);
  const message = fixtures.message as Record<string, unknown>;
  const cases: [string, ReturnType<typeof request>][] = [
    ["no header", request(null, message)],
    ["not a JWT", request("abc.def", message)],
    ["wrong audience", request(jwt(claimsFor(t, { aud: "11111111-2222-3333-4444-555555555555" })), message)],
    ["wrong issuer", request(jwt(claimsFor(t, { iss: "https://sts.windows.net/x/" })), message)],
    ["expired", request(jwt(claimsFor(t, { exp: t.nowSeconds() - 301 })), message)],
    ["not yet valid", request(jwt(claimsFor(t, { nbf: t.nowSeconds() + 301 })), message)],
    ["serviceurl mismatch", request(jwt(claimsFor(t, { serviceurl: "https://smba.trafficmanager.net/emea/" })), message)],
    ["serviceurl off the allowlist", request(jwt(claimsFor(t, { serviceurl: "https://evil.example.com/" })), { ...message, serviceUrl: "https://evil.example.com/" })],
    ["tenant mismatch", request(jwt(claimsFor(t)), { ...message, conversation: { ...(message.conversation as object), tenantId: "99999999-9999-9999-9999-999999999999" } })],
    ["recipient is another bot", request(jwt(claimsFor(t)), { ...message, recipient: { id: "28:99999999-0000-0000-0000-000000000000" } })],
    ["unknown kid", request(jwt(claimsFor(t), { kid: "unknown-kid" }), message)],
    ["signed by another key", request(jwt(claimsFor(t), { key: other.privateKey }), message)],
    ["HS256", request(jwt(claimsFor(t), { alg: "HS256" }), message)],
    ["not msteams", request(jwt(claimsFor(t)), { ...message, channelId: "webchat" })],
    ["body is not JSON", request(jwt(claimsFor(t)), "not json")],
    ["body tampered after signing", request(jwt(claimsFor(t)), { ...message, serviceUrl: "https://smba.trafficmanager.net/emea/" })],
  ];
  for (const [label, req] of cases) {
    try {
      await webhook()(req, CREDS, t.net, BOT);
      assert.fail(`${label}: accepted`);
    } catch (error) {
      assert.ok(error instanceof ChannelError, label);
      assert.equal(error.code, "channel_webhook_unauthorized", label);
      assert.equal(error.message, "unauthorized", label);
      assert.equal(error.httpStatus, 401, label);
    }
  }
  await rejectsWith(webhook()(request(jwt(claimsFor(t)), message), { ...CREDS, app_id: "bad" }, t.net, BOT), "channel_webhook_unauthorized", 401);
});

test("webhook JWKS: jwks_uri must stay on login.botframework.com; unknown kids refresh within limits; stale keys survive a failed refresh", async () => {
  const hostile = teamsNet({
    "GET https://login.botframework.com/v1/.well-known/openidconfiguration": { body: { ...fixtures.openid, jwks_uri: "https://evil.example.com/keys" } },
  });
  await rejectsWith(webhook()(request(jwt(claimsFor(hostile)), fixtures.message), CREDS, hostile.net, BOT), "channel_webhook_unauthorized", 401);
  assert.equal(hostile.calls.some((c) => c.url.startsWith("https://evil.example.com")), false);

  resetTeamsCaches();
  let keysUp = true;
  const t = teamsNet({
    "GET https://login.botframework.com/v1/.well-known/keys": () => (keysUp ? { body: { keys: [jwkOf(publicKey, KID)] } } : { status: 503 }),
  });
  await webhook()(request(jwt(claimsFor(t)), fixtures.message), CREDS, t.net, BOT);
  assert.equal(t.count("well-known/keys"), 1);
  // unknown kid right after a fetch: attempts are spaced by 30 s
  await rejectsWith(webhook()(request(jwt(claimsFor(t), { kid: "rotated-1" }), fixtures.message), CREDS, t.net, BOT), "channel_webhook_unauthorized");
  assert.equal(t.count("well-known/keys"), 1);
  t.advance(31_000);
  await rejectsWith(webhook()(request(jwt(claimsFor(t), { kid: "rotated-1" }), fixtures.message), CREDS, t.net, BOT), "channel_webhook_unauthorized");
  assert.equal(t.count("well-known/keys"), 2, "an unknown kid refreshes once");
  t.advance(31_000);
  await rejectsWith(webhook()(request(jwt(claimsFor(t), { kid: "rotated-1" }), fixtures.message), CREDS, t.net, BOT), "channel_webhook_unauthorized");
  assert.equal(t.count("well-known/keys"), 2, "the same kid does not refresh again inside 5 minutes");

  // keys older than 24 h are refreshed; when that fails the stale keys still verify
  keysUp = false;
  t.advance(25 * 3_600_000);
  const out = await webhook()(request(jwt(claimsFor(t)), fixtures.message), CREDS, t.net, BOT);
  assert.equal(out.messages.length, 1);
  assert.equal(t.count("well-known/keys"), 3);
});
