/** UI network adapter: idempotency keys exactly where the manifest requires them (facts written by scripts/build-ui.ts). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { opOptions, requiredIdempotency } from "../src/ui/sdk.ts";
import { root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as {
  operations: { id: string; audience: string; idempotency: string }[];
};
const required = requiredIdempotency({ operations: manifest.operations.filter((o) => o.audience === "person") });

test("idempotency keys follow the manifest", () => {
  assert.ok(required.has("account_connect"));
  assert.ok(!required.has("accounts_overview"));
  const a = opOptions("account_connect", required);
  const b = opOptions("account_connect", required);
  assert.match(a.idempotencyKey ?? "", /^[0-9a-f-]{36}$/u);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.deepEqual(opOptions("accounts_overview", required), {});
});
