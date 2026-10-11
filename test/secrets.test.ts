import assert from "node:assert/strict";
import { test } from "node:test";

import { parseKek, SecretBox, SecretStore } from "../src/secrets.ts";
import { testDb } from "./helpers.ts";

test("sealed secrets round-trip and are bound to their name (AAD)", () => {
  const box = new SecretBox(Buffer.alloc(32, 7));
  const sealed = box.seal("buzz:agt_A", "s3cret-value");
  assert.equal(box.open("buzz:agt_A", sealed), "s3cret-value");
  assert.throws(() => box.open("buzz:agt_B", sealed));
  assert.ok(!sealed.includes("s3cret"));
});

test("a different KEK cannot open", () => {
  const sealed = new SecretBox(Buffer.alloc(32, 1)).seal("n", "v");
  assert.throws(() => new SecretBox(Buffer.alloc(32, 2)).open("n", sealed));
});

test("store keeps only ciphertext and a fingerprint", () => {
  const db = testDb();
  const store = new SecretStore(db, new SecretBox(Buffer.alloc(32, 3)));
  store.put("account:x:token", "plain-token-123");
  const row = db.prepare("SELECT * FROM connect_secrets").get();
  assert.ok(row && !String(row.sealed).includes("plain-token-123"));
  assert.equal(store.get("account:x:token"), "plain-token-123");
  store.delete("account:x:token");
  assert.equal(store.get("account:x:token"), null);
});

test("KEK parsing accepts 32-byte hex or base64url only", () => {
  assert.equal(parseKek("a".repeat(64)).length, 32);
  assert.equal(parseKek(Buffer.alloc(32, 9).toString("base64url")).length, 32);
  assert.throws(() => parseKek("short"));
  assert.throws(() => parseKek(undefined));
});
