import assert from "node:assert/strict";
import { test } from "node:test";

import { ACCESS_CRUD, classify, classifyMcpTool, inferFromName, levelAllows, levelFor } from "../src/effect.ts";
import { classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";

test("classify obeys M-OP-2/3/4", () => {
  assert.deepEqual(classify({ write: false, outward: false, destructive: false }), { crud: ["read"], effect: "read" });
  assert.deepEqual(classify({ write: true, outward: false, destructive: false }), { crud: ["create", "update"], effect: "write" });
  assert.deepEqual(classify({ write: true, outward: true, destructive: false }), { crud: ["create", "update"], effect: "outward", holdFamily: "outward" });
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

test("SEC-02: unknown verbs fail closed; money is always money; read only for read verbs", () => {
  const cases: [string, string][] = [
    ["GITHUB_MERGE_PULL_REQUEST", "outward"],
    ["JIRA_CLOSE_ISSUE", "outward"],
    ["SLACK_APPROVE_WORKFLOW_REQUEST", "outward"],
    ["LINEAR_ARCHIVE_PROJECT", "write"],
    ["ACME_FROBNICATE_WIDGET", "outward"],
    ["NOTION_RENAME_PAGE", "write"],
    ["STRIPE_CREATE_REFUND", "money"],
    ["PAYPAL_SEND_PAYMENT", "money"],
    ["BANK_TRANSFER_FUNDS", "money"],
    ["SHOP_CHECKOUT_CART", "money"],
    ["GITHUB_LIST_REPOSITORIES", "read"],
    ["NOTION_GET_PAGE", "read"],
    ["GITHUB_GET_AND_MERGE", "outward"],
  ];
  for (const [name, effect] of cases) assert.equal(inferFromName(name).effect, effect, name);
  const money = inferFromName("STRIPE_CREATE_REFUND");
  assert.equal(money.holdFamily, "money");
  assert.deepEqual(levelFor(money.crud), "read_update_delete");
  // READ tier never covers a fail-closed unknown tool.
  assert.equal(levelAllows("read", inferFromName("ACME_FROBNICATE_WIDGET").crud), false);
});

test("SEC-02: Composio without a policy fails closed; a policy never downgrades money; MCP money ignores readOnlyHint", () => {
  assert.equal(classifyComposioTool("TRELLO_CLOSE_BOARD", undefined).effect, "outward");
  assert.equal(classifyComposioTool("GMAIL_PAY_INVOICE", loadPolicies().get("gmail")).effect, "money");
  assert.equal(classifyMcpTool("charge_card", { readOnlyHint: true }).effect, "money");
  assert.equal(classifyMcpTool("frobnicate", undefined).effect, "outward");
  assert.equal(classifyMcpTool("frobnicate", { readOnlyHint: true }).effect, "read");
});

test("C107: every outward or money class carries a hold family (resolve answers never lack one)", () => {
  const names = ["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE", "GITHUB_MERGE_PULL_REQUEST", "ACME_FROBNICATE_WIDGET", "STRIPE_CREATE_REFUND", "NOTION_DELETE_PAGE", "NOTION_UPDATE_PAGE", "NOTION_GET_PAGE"];
  for (const name of names) {
    const cls = inferFromName(name);
    if (cls.effect === "outward") assert.equal(cls.holdFamily, "outward", name);
    if (cls.effect === "money") assert.equal(cls.holdFamily, "money", name);
    if (cls.effect === "read" || cls.effect === "write") assert.equal(cls.holdFamily, undefined, name);
  }
  assert.equal(classifyMcpTool("lookup", { readOnlyHint: false, openWorldHint: true }).holdFamily, "outward");
  assert.equal(classifyMcpTool("send_invoice_payment", undefined).holdFamily, "money");
});

test("F84: read-led names stay reads (drafts, labels, send-as); real verbs and sends still win", () => {
  const gmail = loadPolicies().get("gmail");
  assert.ok(gmail);
  for (const slug of ["GMAIL_LIST_LABELS", "GMAIL_LIST_DRAFTS", "GMAIL_GET_DRAFT", "GMAIL_GET_LABEL", "GMAIL_LIST_SEND_AS", "GMAIL_GET_SEND_AS", "GMAIL_GET_PROFILE", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_LIST_HISTORY", "GMAIL_SEARCH_PEOPLE"]) {
    const cls = classifyComposioTool(slug, gmail);
    assert.equal(cls.effect, "read", slug);
    assert.deepEqual(cls.crud, ["read"], slug);
    assert.equal(levelAllows("read", cls.crud), true, `READ tier can call ${slug}`);
  }
  for (const [slug, effect] of [
    ["GMAIL_CREATE_EMAIL_DRAFT", "write"], ["GMAIL_UPDATE_DRAFT", "write"], ["GMAIL_CREATE_LABEL", "write"], ["GMAIL_REMOVE_LABEL", "write"],
    ["GMAIL_SEND_DRAFT", "outward"], ["GMAIL_SEND_EMAIL", "outward"], ["GMAIL_GET_AND_SEND", "outward"], ["GMAIL_DELETE_DRAFT", "destructive"],
    ["GMAIL_DELETE_LABEL", "destructive"], ["GMAIL_MOVE_TO_TRASH", "destructive"],
  ] as const) assert.equal(classifyComposioTool(slug, gmail).effect, effect, slug);
  // The same name rule without a policy (catalog, MCP): a noun word after a leading read verb is not a verb.
  for (const name of ["list_drafts", "get_draft", "list_labels", "get_message", "fetch_email", "get_comment"]) assert.equal(inferFromName(name).effect, "read", name);
  for (const [name, effect] of [["create_draft", "write"], ["send_message", "outward"], ["get_and_send_message", "outward"], ["get_and_delete_draft", "destructive"], ["post_comment", "outward"]] as const)
    assert.equal(inferFromName(name).effect, effect, name);
});

test("F84: every curated toolkit policy classifies read-led list/get/fetch/search names as read", () => {
  const policies = loadPolicies();
  assert.ok(policies.size >= 2);
  const nouns = ["DRAFT", "DRAFTS", "LABEL", "LABELS", "MESSAGE", "MESSAGES", "EVENTS", "SETTINGS", "ACL", "CALENDARS", "PROFILE", "THREADS"];
  for (const [toolkit, policy] of policies) {
    const prefix = toolkit.toUpperCase();
    for (const verb of ["GET", "LIST", "FETCH", "SEARCH", "FIND"]) {
      for (const noun of nouns) assert.equal(classifyComposioTool(`${prefix}_${verb}_${noun}`, policy).effect, "read", `${prefix}_${verb}_${noun}`);
    }
  }
});

test("F84: Google Calendar policy: list/get reads (ACL, settings) stay reads; event writes and attendee changes keep their class", () => {
  const cal = loadPolicies().get("googlecalendar");
  assert.ok(cal);
  for (const slug of ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_ACL_LIST", "GOOGLECALENDAR_ACL_GET", "GOOGLECALENDAR_SETTINGS_GET", "GOOGLECALENDAR_SETTINGS_LIST", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_GET_CALENDAR"])
    assert.equal(classifyComposioTool(slug, cal).effect, "read", slug);
  for (const [slug, effect] of [
    ["GOOGLECALENDAR_CREATE_EVENT", "outward"], ["GOOGLECALENDAR_REMOVE_ATTENDEE", "outward"], ["GOOGLECALENDAR_ACL_INSERT", "outward"],
    ["GOOGLECALENDAR_DELETE_EVENT", "destructive"], ["GOOGLECALENDAR_BATCH_EVENTS", "destructive"], ["GOOGLECALENDAR_SETTINGS_WATCH", "outward"],
  ] as const) assert.equal(classifyComposioTool(slug, cal).effect, effect, slug);
});
