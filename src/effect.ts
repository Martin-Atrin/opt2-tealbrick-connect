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

const DESTRUCTIVE_PARTS = new Set(["delete", "remove", "purge", "revoke", "disconnect", "destroy", "trash", "erase", "wipe"]);
const WRITE_PARTS = new Set([
  "add", "append", "archive", "assign", "create", "draft", "dispatch", "execute", "import", "insert", "invite",
  "mark", "modify", "move", "mutate", "patch", "post", "publish", "put", "reply", "run", "send", "set", "share",
  "star", "submit", "sync", "trigger", "update", "upload", "upsert", "watch", "forward", "label", "batch", "stop",
]);
const OUTWARD_PARTS = new Set(["send", "reply", "forward", "post", "publish", "invite", "share", "notify", "message", "email", "tweet"]);

/**
 * Conservative name inference for a tool without labels (harvest: v1 connectors.ts:111-213, extended).
 * Unknown verbs read as `read`, so a source SHOULD label or use annotations; Composio policy files override this.
 */
export function inferFromName(name: string): ToolClass {
  const parts = name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const destructive = parts.some((part) => DESTRUCTIVE_PARTS.has(part));
  const outward = parts.some((part) => OUTWARD_PARTS.has(part));
  const write = parts.some((part) => WRITE_PARTS.has(part));
  return classify({ write, outward, destructive });
}

/** MCP tool annotations first (readOnlyHint / destructiveHint / openWorldHint), then name inference. */
export function classifyMcpTool(name: string, annotations: Record<string, unknown> | undefined): ToolClass {
  const a = annotations ?? {};
  if (a.readOnlyHint === true) return classify({ write: false, outward: false, destructive: false });
  if (a.destructiveHint === true) return classify({ write: true, outward: false, destructive: true });
  const inferred = inferFromName(name);
  if (a.readOnlyHint === false && inferred.effect === "read") {
    return classify({ write: true, outward: a.openWorldHint === true, destructive: false });
  }
  return inferred;
}
