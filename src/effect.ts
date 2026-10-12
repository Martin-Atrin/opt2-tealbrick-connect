/**
 * Effect classification for third-party tools, shared by every source (Composio, catalog, MCP).
 *
 * Vocabulary comes from the frozen spec (`@opt2-tealbrick/spec/manifest`); Connect holds no literals of its own
 * for effects or hold families. Tier = the manifest access level of the `account` scope:
 *   read → [read]; read_update → [read, create, update]; read_update_delete → [read, create, update, delete].
 * The SDK `authorize()` checks `crud ⊆ grant.crud ∩ access.crud`; Connect re-checks the exact account in `call`.
 */
import type { CrudAction, Effect, HoldFamily } from "@opt2-tealbrick/spec/manifest";

export const ACCESS_LEVELS = ["read", "read_update", "read_update_delete"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_CRUD: Readonly<Record<AccessLevel, readonly CrudAction[]>> = {
  read: ["read"],
  read_update: ["read", "create", "update"],
  read_update_delete: ["read", "create", "update", "delete"],
};

/** A resolved tool class: what the bridge gates and the SDK authorizes. Obeys MANIFEST M-OP-2…4. */
export interface ToolClass {
  crud: CrudAction[];
  effect: Effect;
  holdFamily?: HoldFamily;
}

const EFFECT_ORDER: readonly Effect[] = ["read", "write", "outward", "destructive", "money"];

export function effectRank(effect: Effect): number {
  return EFFECT_ORDER.indexOf(effect);
}

/**
 * Build a tool class from three facts. `write` = changes state, `outward` = reaches a third party (sends, posts,
 * notifies people), `destructive` = deletes or irreversibly overwrites. Result obeys M-OP-2/3/4:
 * read ⇔ ["read"]; destructive ⇒ delete ∈ crud and holdFamily "destructive"; outward has no family by default.
 */
export function classify(facts: { write: boolean; outward: boolean; destructive: boolean; money?: boolean }): ToolClass {
  if (facts.money) return { crud: ["create", "update", "delete"], effect: "money", holdFamily: "money" };
  if (facts.destructive) return { crud: ["update", "delete"], effect: "destructive", holdFamily: "destructive" };
  if (facts.outward) return { crud: ["create", "update"], effect: "outward" };
  if (facts.write) return { crud: ["create", "update"], effect: "write" };
  return { crud: ["read"], effect: "read" };
}

/** The lowest access level whose CRUD set contains every action of `crud`; null when none does. */
export function levelFor(crud: readonly CrudAction[]): AccessLevel | null {
  for (const level of ACCESS_LEVELS) {
    if (crud.every((action) => ACCESS_CRUD[level].includes(action))) return level;
  }
  return null;
}

export function levelAllows(level: AccessLevel, crud: readonly CrudAction[]): boolean {
  return crud.every((action) => ACCESS_CRUD[level].includes(action));
}

const MONEY_PARTS = new Set([
  "pay", "pays", "payment", "payments", "payout", "payouts", "charge", "charges", "refund", "refunds", "purchase",
  "purchases", "buy", "checkout", "withdraw", "withdrawal", "deposit", "transfer", "transfers", "remit", "wire",
  "invoice_pay", "capture", "subscribe", "donate", "tip", "trade", "swap",
]);
const DESTRUCTIVE_PARTS = new Set(["delete", "remove", "purge", "revoke", "disconnect", "destroy", "trash", "erase", "wipe", "drop", "truncate", "reset", "overwrite", "terminate"]);
const WRITE_PARTS = new Set([
  "add", "append", "archive", "assign", "create", "draft", "dispatch", "execute", "import", "insert", "mark", "modify",
  "move", "mutate", "patch", "put", "run", "set", "star", "submit", "sync", "trigger", "update", "upload", "upsert",
  "watch", "label", "batch", "stop", "rename", "edit", "save", "copy", "duplicate", "unarchive", "untrash", "tag",
]);
const OUTWARD_PARTS = new Set([
  "send", "reply", "forward", "post", "publish", "invite", "share", "notify", "message", "email", "tweet", "comment",
  "approve", "reject", "merge", "close", "reopen", "cancel", "lock", "unlock", "enable", "disable", "grant", "accept",
  "decline", "deploy", "release", "schedule", "book", "call", "dial", "sms", "dm", "broadcast", "announce",
]);
/** The only verbs that make a tool `read` (SEC-02: an explicit allow-list; anything else is not read). */
const READ_PARTS = new Set([
  "get", "list", "search", "fetch", "read", "find", "query", "lookup", "describe", "retrieve", "count", "view",
  "preview", "download", "export", "stats", "status", "info", "check", "validate", "verify",
]);

/** True when the name names money movement (always `money`: always held, CORE §7). */
export function namesMoney(name: string): boolean {
  return name.toLowerCase().split(/[^a-z0-9]+/u).some((part) => MONEY_PARTS.has(part));
}

/**
 * Name inference for a tool without labels (SEC-02, fail closed): money → `money`; destructive verbs → destructive;
 * outward verbs → outward; write verbs → write; read only when a read verb is present and no other class applies;
 * a name with no known verb → write + outward. Composio policy files and MCP annotations override this.
 */
export function inferFromName(name: string): ToolClass {
  const parts = name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (parts.some((part) => MONEY_PARTS.has(part))) return classify({ write: true, outward: true, destructive: false, money: true });
  const destructive = parts.some((part) => DESTRUCTIVE_PARTS.has(part));
  const outward = parts.some((part) => OUTWARD_PARTS.has(part));
  const write = parts.some((part) => WRITE_PARTS.has(part));
  if (destructive || outward || write) return classify({ write: true, outward, destructive });
  if (parts.some((part) => READ_PARTS.has(part))) return classify({ write: false, outward: false, destructive: false });
  return classify({ write: true, outward: true, destructive: false });
}

/** MCP tool annotations (readOnlyHint / destructiveHint), then fail-closed name inference; money words always win. */
export function classifyMcpTool(name: string, annotations: Record<string, unknown> | undefined): ToolClass {
  const a = annotations ?? {};
  if (namesMoney(name)) return classify({ write: true, outward: true, destructive: false, money: true });
  if (a.readOnlyHint === true) return classify({ write: false, outward: false, destructive: false });
  if (a.destructiveHint === true) return classify({ write: true, outward: false, destructive: true });
  const inferred = inferFromName(name);
  // The server says the tool is not read-only: never class it as read.
  if (a.readOnlyHint === false && inferred.effect === "read") return classify({ write: true, outward: a.openWorldHint !== false, destructive: false });
  return inferred;
}
