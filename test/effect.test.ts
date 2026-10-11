import assert from "node:assert/strict";
import { test } from "node:test";

import { ACCESS_CRUD, classify, classifyMcpTool, inferFromName, levelAllows, levelFor } from "../src/effect.ts";
import { classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";

test("classify obeys M-OP-2/3/4", () => {
  assert.deepEqual(classify({ write: false, outward: false, destructive: false }), { crud: ["read"], effect: "read" });
  assert.deepEqual(classify({ write: true, outward: false, destructive: false }), { crud: ["create", "update"], effect: "write" });
  assert.deepEqual(classify({ write: true, outward: true, destructive: false }), { crud: ["create", "update"], effect: "outward" });
  assert.deepEqual(classify({ write: true, outward: true, destructive: true }), { crud: ["update", "delete"], effect: "destructive", holdFamily: "destructive" });
  assert.deepEqual(classify({ write: true, outward: false, destructive: false, money: true }).holdFamily, "money");
});

test("access levels map to the frozen tier CRUD sets (CORE §13)", () => {
  assert.deepEqual(ACCESS_CRUD.read, ["read"]);
  assert.deepEqual(ACCESS_CRUD.read_update, ["read", "create", "update"]);
  assert.deepEqual(ACCESS_CRUD.read_update_delete, ["read", "create", "update", "delete"]);
  assert.equal(levelFor(["read"]), "read");
  assert.equal(levelFor(["create", "update"]), "read_update");
  assert.equal(levelFor(["update", "delete"]), "read_update_delete");
  assert.equal(levelAllows("read", ["create"]), false);
  assert.equal(levelAllows("read_update", ["create", "update"]), true);
  assert.equal(levelAllows("read_update", ["delete"]), false);
});

test("name inference is conservative", () => {
  assert.equal(inferFromName("SLACK_SEND_MESSAGE").effect, "outward");
  assert.equal(inferFromName("NOTION_DELETE_PAGE").effect, "destructive");
  assert.equal(inferFromName("NOTION_UPDATE_PAGE").effect, "write");
  assert.equal(inferFromName("NOTION_GET_PAGE").effect, "read");
});

test("MCP annotations win over the name", () => {
  assert.equal(classifyMcpTool("delete_everything", { readOnlyHint: true }).effect, "read");
  assert.equal(classifyMcpTool("lookup", { destructiveHint: true }).effect, "destructive");
  assert.equal(classifyMcpTool("lookup", { readOnlyHint: false, openWorldHint: true }).effect, "outward");
});

test("Gmail policy: send outward, delete destructive, label removal is a write, fetch is read", () => {
  const gmail = loadPolicies().get("gmail");
  assert.ok(gmail);
  assert.equal(classifyComposioTool("GMAIL_SEND_EMAIL", gmail).effect, "outward");
  assert.equal(classifyComposioTool("GMAIL_REPLY_TO_THREAD", gmail).effect, "outward");
  assert.equal(classifyComposioTool("GMAIL_CREATE_EMAIL_DRAFT", gmail).effect, "write");
  assert.equal(classifyComposioTool("GMAIL_REMOVE_LABEL", gmail).effect, "write");
  assert.equal(classifyComposioTool("GMAIL_DELETE_MESSAGE", gmail).effect, "destructive");
  assert.equal(classifyComposioTool("GMAIL_MOVE_TO_TRASH", gmail).effect, "destructive");
  assert.equal(classifyComposioTool("GMAIL_FETCH_EMAILS", gmail).effect, "read");
  assert.equal(classifyComposioTool("GMAIL_LIST_THREADS", gmail).effect, "read");
});
