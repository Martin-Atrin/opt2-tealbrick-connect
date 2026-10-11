import assert from "node:assert/strict";
import { test } from "node:test";

import { assertEndpointAllowed, isForbiddenAddress } from "../src/util/net-policy.ts";

test("private, local and metadata addresses are refused", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "ff02::1"]) {
    assert.equal(isForbiddenAddress(a), true, a);
  }
  for (const a of ["1.1.1.1", "8.8.8.8", "2606:4700::1111"]) assert.equal(isForbiddenAddress(a), false, a);
});

test("endpoint checks: scheme, names, DNS answers, test origins", async () => {
  const lookup = async (host: string) => (host === "relay.example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]);
  await assertEndpointAllowed("wss://relay.example.com", { schemes: ["wss:"], lookup });
  await assert.rejects(assertEndpointAllowed("ws://relay.example.com", { schemes: ["wss:"], lookup }), /scheme_not_allowed/u);
  await assert.rejects(assertEndpointAllowed("wss://internal.example.com", { schemes: ["wss:"], lookup }), /address_not_allowed/u);
  await assert.rejects(assertEndpointAllowed("wss://connect.railway.internal", { schemes: ["wss:"], lookup }), /hostname_not_allowed/u);
  await assert.rejects(assertEndpointAllowed("wss://localhost", { schemes: ["wss:"], lookup }), /hostname_not_allowed/u);
  await assert.rejects(assertEndpointAllowed("wss://u:p@relay.example.com", { schemes: ["wss:"], lookup }), /userinfo/u);
  await assertEndpointAllowed("ws://127.0.0.1:7777", { schemes: ["wss:"], allowOrigins: ["ws://127.0.0.1:7777"] });
});
