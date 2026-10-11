// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots Connect with
// the env the suite gives it (fake bridge, enrolment code, TB_KEK, data dir) and drives it like the bridge does.
//
// Known-good fixture for the one agent receipt op (`buzz_post`, see conformance.inputs.json): every conformance agent
// gets a Buzz identity, and the relay is an in-process fake test relay (no network, no real people — C22).
// Product behaviour is unchanged: in production the owner creates identities in one action from the Buzz page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type AppSecrets, defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "./src/app.ts";
import { BuzzIdentities } from "./src/channels/buzz/identity.ts";
import { verifyEvent } from "./src/channels/buzz/nostr.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "tealbrick.manifest.json"), "utf8")) as Manifest;
const TEST_RELAY = "wss://relay.conformance.example";
const TEST_RELAY_HTTP = "https://relay.conformance.example";

/** Fake test relay: accepts signed events at POST /events; anything else is forwarded to the real fetch. */
const relayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== TEST_RELAY_HTTP) return fetch(input, init);
  if (url.pathname === "/events" && init?.method === "POST") {
    const event = JSON.parse(String(init.body)) as unknown;
    const ok = verifyEvent(event);
    return Response.json({ accepted: ok, message: ok ? "" : "invalid: bad event", event_id: ok ? (event as { id: string }).id : null });
  }
  if (url.pathname === "/query") return Response.json([]);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  const definition = createConnectApp({
    manifest,
    migrationsDir: join(import.meta.dirname, "migrations"),
    dataDir: env.TB_DATA_DIR ?? "/data",
    ErrorClass: TbError,
    fetchImpl: relayFetch,
    allowRelayOrigins: [TEST_RELAY, TEST_RELAY_HTTP],
  });
  // Ensure the calling agent has an identity before buzz_post runs (ctx.secrets exists only per call).
  const post = definition.handlers.buzz_post;
  const app = defineApp({
    ...definition,
    handlers: {
      ...definition.handlers,
      buzz_post: async (input, ctx) => {
        const sdkCtx = ctx as typeof ctx & { secrets: AppSecrets };
        const buzz = new BuzzIdentities({ db: ctx.db, secrets: sdkCtx.secrets, allowRelayOrigins: [TEST_RELAY, TEST_RELAY_HTTP], fetchImpl: relayFetch });
        if (!buzz.relayUrl()) await buzz.setRelayUrl(TEST_RELAY);
        await buzz.generateAll([{ id: ctx.caller.id, name: ctx.caller.name }]);
        if (typeof post !== "function") throw new TbError("handler_missing", "buzz_post handler missing", 500);
        return post(input, ctx);
      },
    },
  });
  const running = await startApp(app, env);
  return {
    url: `http://127.0.0.1:${manifest.runtime.port}`,
    stop: () => running.stop(),
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
