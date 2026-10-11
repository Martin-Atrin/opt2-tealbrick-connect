/** UI network adapter: the create person ops carry an idempotency key; every other op goes through the SDK client. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CREATE_OPS, opOptions } from "../src/ui/sdk.ts";
import { root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as {
  operations: { id: string; audience: string; idempotency: string }[];
};

test("CREATE_OPS = exactly the person ops whose idempotency is required", () => {
  const required = manifest.operations.filter((o) => o.audience === "person" && o.idempotency === "required").map((o) => o.id).sort();
  assert.deepEqual([...CREATE_OPS].sort(), required);
});

test("create ops get a fresh key; other ops send none", () => {
  const a = opOptions("account_connect");
  const b = opOptions("account_connect");
  assert.match(a.idempotencyKey ?? "", /^[0-9a-f-]{36}$/u);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.deepEqual(opOptions("accounts_overview"), {});
});
