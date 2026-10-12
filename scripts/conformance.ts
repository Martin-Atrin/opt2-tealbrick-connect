/**
 * Connect checks the real suite (`tb-conformance app`, run first by `pnpm conformance`) does not cover:
 * 1. `validateAppFiles` (skill files on disk; manifest rules) from `@opt2-tealbrick/manifest`.
 * 2. Composio policy files parse (Connect data, not contract).
 * Handler/route coverage and every M-* rule are checked by the suite and by `startApp` itself (BSA-11).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateAppFiles } from "@opt2-tealbrick/manifest";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { loadPolicies } from "../src/sources/composio/policy.ts";

const root = join(import.meta.dirname, "..");
const failures: string[] = [];
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const files = await validateAppFiles(manifest, root);
if (!files.ok) for (const issue of files.errors) failures.push(`${issue.rule}: ${issue.path} ${issue.code} ${issue.message}`);
try {
  if (loadPolicies().size === 0) failures.push("connect-policy: no Composio policies");
} catch (error) {
  failures.push(`connect-policy: ${(error as Error).message}`);
}
if (failures.length > 0) {
  console.error(`connect checks: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("connect checks: ok (app files, Composio policies)");
