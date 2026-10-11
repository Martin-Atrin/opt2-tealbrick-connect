import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { root } from "./helpers.ts";

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("@opt2-tealbrick/spec/schemas/manifest.schema.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

test("manifest validates against the frozen schema", () => {
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
});

test("the schema check is live (a broken copy fails)", () => {
  const broken = structuredClone(manifest);
  broken.operations[0].effect = "teleport";
  broken.extra = true;
  assert.equal(validate(broken), false);
});

test("the tools op is the dynamic search family with the full ceiling; tier scope matches CORE §13", () => {
  const tools = manifest.operations.find((o: { id: string }) => o.id === "tools");
  assert.deepEqual(tools.dynamic, { mode: "search", crudCeiling: ["read", "create", "update", "delete"], effectCeiling: "money" });
  const account = manifest.scopes.find((s: { type: string }) => s.type === "account");
  assert.deepEqual(account.access.map((a: { id: string; crud: string[] }) => [a.id, a.crud]), [
    ["read", ["read"]],
    ["read_update", ["read", "create", "update"]],
    ["read_update_delete", ["read", "create", "update", "delete"]],
  ]);
});
