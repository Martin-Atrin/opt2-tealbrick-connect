/**
 * Connect miniapp entry point.
 *
 * P0 scaffold: the app is built in P1 on the frozen Miniapp SDK
 * (manifest, authorization function, holds/receipts, launch, settings).
 * Module layout (one mechanism per concern):
 *
 * - accounts/   connected accounts per agent and service; per-account tier
 *               (read | read_update | read_update_delete); kind as_me | as_itself.
 * - sources/    one Source interface for every outside system:
 *     composio/ Composio toolkits, auth configs, connected accounts, tool execution.
 *     mcp/      custom and third-party remote MCP servers (client + URL policy).
 *     catalog/  Tealbrick catalog (sha256-pinned OpenAPI specs + labels; Company Box seed).
 * - oauth/      MCP OAuth (RFC 9728 / 8414 / 7591 / PKCE) and our own OAuth flows.
 * - channels/   Buzz first (per-agent Nostr identities), then Slack, Teams, Telegram, Discord.
 * - ui/         person UI opened through the bridge launch (search, Connect, accounts, tiers).
 */
export const CONNECT_APP_ID = "connect";

export type Tier = "read" | "read_update" | "read_update_delete";
export type ConnectionKind = "as_me" | "as_itself";
export type Effect = "read" | "write" | "outward" | "destructive" | "money";

/** Effect needed by a tool call → the lowest tier that allows it. Money is always held by the SDK. */
export function tierForEffect(effect: Effect): Tier {
  switch (effect) {
    case "read":
      return "read";
    case "write":
    case "outward":
      return "read_update";
    case "destructive":
    case "money":
      return "read_update_delete";
  }
}

const TIER_RANK: Record<Tier, number> = { read: 0, read_update: 1, read_update_delete: 2 };

/** True when an account at `granted` tier may run a call that needs `needed`. */
export function tierAllows(granted: Tier, needed: Tier): boolean {
  return TIER_RANK[granted] >= TIER_RANK[needed];
}
