/**
 * Connect conformance:
 * 1. `validateManifest` + `validateAppFiles` from the released `@opt2-tealbrick/manifest` (schema + every M-* rule).
 * 2. The app definition matches the manifest exactly as `startApp` requires (SDK-API §3): one handler per
 *    non-dynamic operation, dynamic handlers for dynamic ops, a handler per public route; baseline migration.
 * 3. Composio policy files parse.
 * The released `@opt2-tealbrick/conformance` suite (fake Portal + fake bridge) replaces part 2 when it ships.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateAppFiles, validateManifest } from "@opt2-tealbrick/manifest";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "../src/app.ts";
import { loadPolicies } from "../src/sources/composio/policy.ts";

const root = join(import.meta.dirname, "..");
const failures: string[] = [];
const check = (ok: boolean, rule: string, message: string) => {
  if (!ok) failures.push(`${rule}: ${message}`);
};

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
for (const result of [validateManifest(manifest), await validateAppFiles(manifest, root)]) {
  if (!result.ok) for (const issue of result.errors) failures.push(`${issue.rule}: ${issue.path} ${issue.code} ${issue.message}`);
}

const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations") });
const ops = manifest.operations;
const routes = manifest.publicRoutes ?? [];
const sorted = (xs: Iterable<string>) => JSON.stringify([...xs].sort());
check(sorted(Object.keys(app.handlers)) === sorted(ops.filter((o) => !o.dynamic).map((o) => o.id)), "SDK-3", "handlers do not match the non-dynamic operations");
check(sorted(Object.keys(app.dynamic ?? {})) === sorted(ops.filter((o) => o.dynamic).map((o) => o.id)), "SDK-3", "dynamic handlers do not match dynamic ops");
check(sorted(Object.keys(app.publicRoutes ?? {})) === sorted(routes.map((r) => r.path)), "SDK-3", "public route handlers do not match the manifest");
check(existsSync(join(root, "migrations", "0001_init.sql")), "SDK-7.1", "baseline migration missing");
for (const op of ops.filter((o) => o.scopeType && !o.dynamic)) {
  const handler = app.handlers[op.id];
  check(typeof handler === "object" && typeof handler.scope === "function", "SDK-3", `${op.id} has scopeType and needs a scope() function`);
}
try {
  check(loadPolicies().size > 0, "connect-policy", "no Composio policies");
} catch (error) {
  failures.push(`connect-policy: ${(error as Error).message}`);
}

if (failures.length > 0) {
  console.error(`conformance: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`conformance: ok (${ops.length} operations, ${routes.length} public route; validator @opt2-tealbrick/manifest)`);
