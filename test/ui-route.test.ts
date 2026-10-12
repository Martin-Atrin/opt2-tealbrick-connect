/** C105b: every address an owner can arrive at maps to a Connect page; `/holds/<id>` (an app's ownerLink) is the Holds page. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BASE, hrefOf, parseWhere, ROUTES } from "../src/ui/route-parse.ts";

test("the launch path is Services, the configure path Accounts, hashes pick the other pages", () => {
  assert.deepEqual(parseWhere("/a/connect/", ""), { route: "services" });
  assert.deepEqual(parseWhere("/a/connect", ""), { route: "services" });
  assert.deepEqual(parseWhere("/a/connect/configure", ""), { route: "accounts" });
  assert.deepEqual(parseWhere("/a/connect/configure", "#buzz"), { route: "buzz" });
  assert.deepEqual(parseWhere("/a/connect/configure", "#nonsense"), { route: "accounts" });
  assert.deepEqual(parseWhere("/a/connect/something-else", ""), { route: "services" });
});

test("/holds/<id> opens the Holds page on that hold (the owner link of an app)", () => {
  assert.deepEqual(parseWhere("/a/connect/holds/hld_01JZ0000000000000000000000", ""), { route: "holds", holdId: "hld_01JZ0000000000000000000000" });
  assert.deepEqual(parseWhere("/a/connect/holds/hld_01JZ0000000000000000000000/", ""), { route: "holds", holdId: "hld_01JZ0000000000000000000000" });
  assert.deepEqual(parseWhere("/a/connect/holds/hld%5F1", ""), { route: "holds", holdId: "hld_1" });
  // `/holds` alone, and an id that is not a plain id, still land on the Holds page (never on Services)
  assert.deepEqual(parseWhere("/a/connect/holds", ""), { route: "holds" });
  assert.deepEqual(parseWhere("/a/connect/holds/", ""), { route: "holds" });
  assert.deepEqual(parseWhere("/a/connect/holds/%E0%A4%A", ""), { route: "holds" });
  assert.deepEqual(parseWhere("/a/connect/holds/a b", ""), { route: "holds" });
});

test("hrefOf is the inverse for every page", () => {
  for (const route of ROUTES) {
    const [path, hash = ""] = hrefOf(route).split("#");
    assert.ok(path?.startsWith(BASE.slice(0, -1)), route);
    assert.equal(parseWhere(path as string, hash ? `#${hash}` : "").route, route);
  }
});
