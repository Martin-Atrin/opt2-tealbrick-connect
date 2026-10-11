/**
 * Connect conformance (interim until `@opt2-tealbrick/conformance` and `@opt2-tealbrick/manifest` are released):
 * 1. `tealbrick.manifest.json` validates against the frozen schema shipped in `@opt2-tealbrick/spec`.
 * 2. The MANIFEST cross-field rules that apply to Connect (M-OP-1…10, M-SC-1…4, M-ST-5, M-SK-1, M-AR-1, M-PR-1, M-DOC-1/3).
 * 3. The app definition has exactly one handler per non-dynamic operation, dynamic handlers for dynamic ops,
 *    public route handlers for every declared route (SDK-API §3 boot rules).
 * 4. Skill files exist with matching frontmatter; Composio policy files parse.
 * Exit code 1 on any failure. Replace with the released conformance suite as soon as it exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Manifest, Operation } from "@opt2-tealbrick/spec/manifest";
import { Ajv2020 } from "ajv/dist/2020.js";

import { createConnectApp } from "../src/app.ts";
import { loadPolicies } from "../src/sources/composio/policy.ts";

const root = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const failures: string[] = [];
const check = (ok: boolean, rule: string, message: string) => {
  if (!ok) failures.push(`${rule}: ${message}`);
};

const raw = readFileSync(join(root, "tealbrick.manifest.json"), "utf8");
const manifest = JSON.parse(raw) as Manifest;
const schemaPath = require.resolve("@opt2-tealbrick/spec/schemas/manifest.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
if (!validate(manifest)) {
  for (const error of validate.errors ?? []) failures.push(`schema: ${error.instancePath || "/"} ${error.message ?? ""} ${JSON.stringify(error.params)}`);
}

// M-DOC
check(!/-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.|\btb[a-z]*_[A-Za-z0-9]{20,}/u.test(raw), "M-DOC-1", "secret material in manifest");
check(!/\b[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}\b/u.test(raw), "M-DOC-3", "instance id in manifest");

const ops = manifest.operations;
const scopes = manifest.scopes ?? [];
const toolName = (s: string) => `${manifest.id}__${s}`;
const isSubset = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));
const effects = ["read", "write", "outward", "destructive", "money"];

check(new Set(ops.map((o) => o.id)).size === ops.length, "M-OP-1", "operation ids not unique");
for (const op of ops as Operation[]) {
  const names = op.audience === "agent" ? [toolName(op.id), ...(op.dynamic?.mode === "search" ? [toolName(`${op.id}_search`), toolName(`${op.id}_call`)] : [])] : [];
  for (const n of names) check(n.length <= 64, "M-OP-1", `${n} longer than 64`);
  check((op.effect === "read") === (op.crud.length === 1 && op.crud[0] === "read"), "M-OP-2", `${op.id} effect/crud mismatch`);
  if (op.crud.includes("delete")) check(op.effect === "destructive" || op.effect === "money", "M-OP-3", `${op.id} delete needs destructive`);
  if (op.effect === "destructive") check(op.crud.includes("delete"), "M-OP-3", `${op.id} destructive needs delete`);
  if (op.effect === "read" || op.effect === "write") check(op.holdFamily === undefined, "M-OP-4", `${op.id} holdFamily not allowed`);
  if (op.effect === "destructive") check(op.holdFamily === "destructive", "M-OP-4", `${op.id} holdFamily must be destructive`);
  if (op.effect === "money") check(op.holdFamily === "money", "M-OP-4", `${op.id} holdFamily must be money`);
  if (op.crud.includes("create")) check(op.idempotency === "required", "M-OP-5", `${op.id} create needs idempotency required`);
  if (op.crud.length === 1 && op.crud[0] === "read") check(op.idempotency !== "required", "M-OP-5", `${op.id} read cannot require idempotency`);
  if (["outward", "destructive", "money"].includes(op.effect) || op.holdFamily) check(op.receipt, "M-OP-6", `${op.id} needs receipt`);
  if (op.scopeType) {
    const scope = scopes.find((s) => s.type === op.scopeType);
    check(Boolean(scope), "M-OP-7", `${op.id} scope ${op.scopeType} undeclared`);
    if (scope) check(isSubset(op.crud, scope.access.flatMap((a) => a.crud)), "M-OP-7", `${op.id} crud outside scope access`);
  }
  if (op.audience === "agent" && !op.dynamic) check(Boolean(op.input && op.output), "M-OP-8", `${op.id} needs input and output`);
  if (op.audience === "person") check(!op.dynamic, "M-OP-9", `${op.id} person op cannot be dynamic`);
  if (op.dynamic) {
    const d = op.dynamic;
    const ok = op.crud.length === 1 && op.crud[0] === "read" && op.effect === "read" && !op.holdFamily && op.idempotency === "supported" && !op.receipt && op.audience === "agent" && !op.input && !op.output;
    check(ok, "M-OP-10", `${op.id} dynamic op shape`);
    if (d.crudCeiling.length === 1 && d.crudCeiling[0] === "read") check(d.effectCeiling === "read", "M-OP-10", `${op.id} ceiling`);
    check(effects.includes(d.effectCeiling), "M-OP-10", `${op.id} effect ceiling`);
  }
}
check(new Set(scopes.map((s) => s.type)).size === scopes.length, "M-SC-1", "scope types not unique");
for (const s of scopes) {
  check(new Set(s.access.map((a) => a.id)).size === s.access.length, "M-SC-1", `${s.type} access ids not unique`);
  for (const g of s.defaultGrants) check(s.access.some((a) => a.id === g.access), "M-SC-2", `${s.type} default grant access`);
}
if (scopes.length > 0) check(Boolean(manifest.ui?.configurePath), "M-SC-4", "scopes need ui.configurePath");
for (const key of manifest.settings?.keys ?? []) {
  check(key.usedBy.every((u) => u === "app"), "M-ST-5", `${key.name} usedBy`);
  check(!manifest.runtime.env?.some((e) => e.name === key.name), "M-RT-5", `${key.name} must not be env`);
}
for (const skill of manifest.skills ?? []) {
  const file = join(root, skill.file);
  check(existsSync(file), "M-SK-2", `${skill.file} missing`);
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    check(new RegExp(`^---\\nname: ${skill.id}\\ndescription: .+\\n---\\n`, "u").test(text), "M-SK-2", `${skill.file} frontmatter`);
    check(!/<script|<\/?html/iu.test(text) && Buffer.byteLength(text) <= 65_536, "M-SK-2", `${skill.file} content`);
  }
}
for (const artifact of manifest.artifacts ?? []) {
  check(artifact.url.startsWith(`${manifest.source.repo}/releases/download/`), "M-AR-1", `${artifact.id} url`);
}
const routes = manifest.publicRoutes ?? [];
check(new Set(routes.map((r) => r.path)).size === routes.length, "M-PR-1", "public routes not unique");

// App definition vs manifest (SDK boot rules).
const app = createConnectApp({
  manifest,
  migrationsDir: join(root, "migrations"),
  kek: Buffer.alloc(32, 1),
  publicOrigin: () => null,
  scopes: () => null,
});
const staticOps = ops.filter((o) => !o.dynamic).map((o) => o.id).sort();
const dynamicOps = ops.filter((o) => o.dynamic).map((o) => o.id).sort();
check(JSON.stringify(Object.keys(app.handlers).sort()) === JSON.stringify(staticOps), "SDK-3", `handlers ${Object.keys(app.handlers).sort().join(",")} != ops ${staticOps.join(",")}`);
check(JSON.stringify(Object.keys(app.dynamic ?? {}).sort()) === JSON.stringify(dynamicOps), "SDK-3", "dynamic handlers do not match dynamic ops");
check(JSON.stringify(Object.keys(app.publicRoutes ?? {}).sort()) === JSON.stringify(routes.map((r) => r.path).sort()), "SDK-3", "public route handlers do not match manifest");
check(existsSync(join(root, "migrations", "0001_init.sql")), "SDK-7.1", "baseline migration missing");

try {
  const policies = loadPolicies();
  check(policies.size > 0, "connect-policy", "no Composio policies");
} catch (error) {
  failures.push(`connect-policy: ${(error as Error).message}`);
}

if (failures.length > 0) {
  console.error(`conformance: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`conformance: ok (${ops.length} operations, ${scopes.length} scope, ${routes.length} public route)`);
