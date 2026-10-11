/**
 * Container entry point: `node src/main.ts` (Node 24 type stripping). Builds the Connect app definition and hands
 * it to the Miniapp SDK (`defineApp` + `startApp`, SDK-API §3). The SDK owns the HTTP server, claim, slices,
 * receipts, holds, scopes, keys, backups and the person session.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { App, AppDefinition, RunningApp, ScopeStore } from "@opt2-tealbrick/spec/sdk";

import { createConnectApp, type ErrorCtor } from "./app.ts";
import { parseKek } from "./secrets.ts";

interface SdkModule {
  defineApp(def: AppDefinition<string>): App;
  startApp(app: App, env: Record<string, string | undefined>): Promise<RunningApp>;
  TbError: ErrorCtor;
}

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

function readKek(): Buffer {
  if (process.env.TB_KEK) return parseKek(process.env.TB_KEK);
  const file = join(process.env.TB_DATA_DIR ?? "/data", "tb", "kek");
  if (existsSync(file)) return parseKek(readFileSync(file, "utf8"));
  throw new Error("kek_missing");
}

const sdkName = "@opt2-tealbrick/miniapp-sdk";
let sdk: SdkModule;
try {
  sdk = (await import(sdkName)) as SdkModule;
} catch {
  console.error(`${sdkName} is not installed: Connect runs only on the Miniapp SDK (see RELEASES.md).`);
  process.exit(1);
}

let running: RunningApp | null = null;
const definition = createConnectApp({
  manifest,
  migrationsDir: join(root, "migrations"),
  kek: readKek,
  publicOrigin: () => null,
  scopes: (): ScopeStore | null => running?.scopes ?? null,
  ErrorClass: sdk.TbError,
});
running = await sdk.startApp(sdk.defineApp(definition), process.env);

const stop = async () => {
  await running?.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
