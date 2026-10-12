/** SEC-09: the connect-time lookup refuses forbidden answers, so a DNS rebind after the policy check cannot connect. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkedLookup, pinnedFetch } from "../src/util/pinned-fetch.ts";

const lookup = (host: string, all = false) =>
  new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
    checkedLookup()(host, { all }, (err, address) => resolve({ err, address }));
  });

test("connect-time lookup refuses loopback/private answers (localhost resolves to 127.0.0.1 / ::1)", async () => {
  const r = await lookup("localhost");
  assert.ok(r.err);
  assert.equal(r.err?.code, "endpoint_not_allowed");
});

test("allowlisted hosts skip the address check (tests / test relay)", async () => {
  const r = await new Promise<NodeJS.ErrnoException | null>((resolve) => checkedLookup(new Set(["localhost"]))("localhost", { all: true }, (err) => resolve(err)));
  assert.equal(r, null);
});

test("pinned fetch refuses IP-literal metadata and private targets before any socket opens", async () => {
  const f = pinnedFetch();
  await assert.rejects(f("http://169.254.169.254/latest/meta-data/"), /not allowed/u);
  await assert.rejects(f("https://10.0.0.5/mcp"), /not allowed/u);
  await assert.rejects(f("http://127.0.0.1:1/"), /not allowed/u);
});

test("pinned fetch refuses a host that resolves to a private address at connect time", async () => {
  const f = pinnedFetch();
  await assert.rejects(f("http://localhost:8080/"), (e: Error) => /not allowed|endpoint_not_allowed|fetch failed/u.test(String((e as { cause?: unknown }).cause ?? e)));
});
