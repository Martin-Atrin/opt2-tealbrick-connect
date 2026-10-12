/**
 * Container entry point: `node src/main.ts` (Node 24 type stripping). Builds the Connect app definition and hands
 * it to the Miniapp SDK (`defineApp` + `startApp`, SDK-API §3). The SDK owns the HTTP server, claim, slices,
 * receipts, holds, scopes, keys, app secrets, backups and the person session.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "./app.ts";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

const running = await startApp(
  defineApp(
    createConnectApp({
      manifest,
      migrationsDir: join(root, "migrations"),
      dataDir: process.env.TB_DATA_DIR ?? "/data",
      buzzRelayUrl: process.env.CONNECT_BUZZ_RELAY_URL ?? null,
      ErrorClass: TbError,
    }),
  ),
  process.env,
);

const stop = async () => {
  await running.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
