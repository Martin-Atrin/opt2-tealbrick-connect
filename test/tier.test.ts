import assert from "node:assert/strict";
import { test } from "node:test";

import { tierAllows, tierForEffect } from "../src/index.ts";

test("effects map to the lowest tier that allows them", () => {
  assert.equal(tierForEffect("read"), "read");
  assert.equal(tierForEffect("write"), "read_update");
  assert.equal(tierForEffect("outward"), "read_update");
  assert.equal(tierForEffect("destructive"), "read_update_delete");
  assert.equal(tierForEffect("money"), "read_update_delete");
});

test("a tier allows itself and lower tiers only", () => {
  assert.equal(tierAllows("read", "read"), true);
  assert.equal(tierAllows("read", "read_update"), false);
  assert.equal(tierAllows("read_update", "read"), true);
  assert.equal(tierAllows("read_update", "read_update_delete"), false);
  assert.equal(tierAllows("read_update_delete", "read_update_delete"), true);
});
