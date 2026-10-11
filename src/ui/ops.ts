/** Typed wrappers over `callOp` for the Connect person operations (outputs follow the handlers in `src/app.ts`). */
import { callOp, type Json } from "./sdk.ts";

export type AccountKind = "as_me" | "as_itself";
export type AccountStatus = "pending" | "connected" | "failed" | "revoked";
export type ConnectMode = "api_key" | "no_auth" | "ready_managed" | "ready_user_key" | "needs_auth_config" | "not_supported";
export type AccessLevel = "read" | "read_update" | "read_update_delete";

export interface ServiceHit {
  service: string;
  name: string;
  description: string;
  logo: string | null;
  source: "composio" | "catalog";
  connectMode: ConnectMode;
  /** Catalog entries only: credential field names (["token"] or ["username", "password"]) and an address example. */
  fields?: string[];
  baseUrlExample?: string;
}

export interface Account {
  id: string;
  service: string;
  source: string;
  kind: AccountKind;
  label: string;
  ownerAgent: string | null;
  status: AccountStatus;
  detail: string;
}

export interface BuzzIdentity {
  agent: string;
  displayName: string;
  pubkey: string;
  npub: string;
  createdAt: number;
  profilePublishedAt: number | null;
}

export interface BuzzAgentRow {
  agent: string;
  name: string;
  identity: BuzzIdentity | null;
}

export const servicesSearch = (query: string) => callOp<{ composioKey: boolean; catalogAvailable?: boolean; services: ServiceHit[] }>("services_search", { query });
export const accountsOverview = () => callOp<{ accounts: Account[] }>("accounts_overview", {});
export const accountConnect = (input: { service: string; label: string; kind: AccountKind; agent?: string }) =>
  callOp<{ account: Account; redirectUrl: string }>("account_connect", input);
export const catalogAccountConnect = (input: {
  service: string;
  label: string;
  baseUrl: string;
  credentials: Record<string, string>;
  kind: AccountKind;
  agent?: string;
}) => callOp<{ account: Account }>("catalog_account_connect", input);
export const accountUpdate = (id: string, label: string) => callOp<{ account: Account }>("account_update", { id, label });
export const accountDisconnect = (id: string) => callOp<{ account: Account }>("account_disconnect", { id });
export const toolsRefresh = (service: string) => callOp<{ service: string; tools: Json }>("tools_refresh", { service });

export const buzzIdentitiesList = () => callOp<{ relay: string | null; agents: BuzzAgentRow[] }>("buzz_identities_list", {});
export const buzzIdentitiesGenerate = () => callOp<{ created: BuzzIdentity[]; existing: BuzzIdentity[] }>("buzz_identities_generate", {});
export const buzzIdentityRotate = (agent: string) => callOp<{ identity: BuzzIdentity }>("buzz_identity_rotate", { agent });
export const buzzRelaySet = (relayUrl: string) => callOp<{ relay: string | null }>("buzz_relay_set", { relayUrl });
export const buzzProfilePublish = (agent?: string) => callOp<{ published: Json[] }>("buzz_profile_publish", agent ? { agent } : {});

export interface AgentInfo {
  id: string;
  name: string;
  /** Account instance id → level; `null` when `tb.agents_list` did not say (shape not known). */
  levels: Record<string, AccessLevel> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const LEVELS: readonly string[] = ["read", "read_update", "read_update_delete"];

/**
 * `tb.agents_list` → "slice agents with their scope access" (SDK-API §6); the exact output shape is not frozen.
 * Accepted: an array or `{ agents }`; each entry `{ id | agent, name, access | scopes | grants: [{ type, instanceId | id, access }] }`.
 */
export function normalizeAgents(raw: unknown): AgentInfo[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.agents) ? raw.agents : [];
  const out: AgentInfo[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.agent === "string" ? entry.agent : null;
    if (!id) continue;
    const rows = [entry.access, entry.scopes, entry.grants].find(Array.isArray) as unknown[] | undefined;
    let levels: AgentInfo["levels"] = null;
    if (rows) {
      levels = {};
      for (const row of rows) {
        if (!isRecord(row) || (row.type !== undefined && row.type !== "account")) continue;
        const instance = typeof row.instanceId === "string" ? row.instanceId : typeof row.id === "string" ? row.id : null;
        if (instance && typeof row.access === "string" && LEVELS.includes(row.access)) levels[instance] = row.access as AccessLevel;
      }
    }
    out.push({ id, name: typeof entry.name === "string" && entry.name ? entry.name : id, levels });
  }
  return out;
}

export const agentsList = async (): Promise<AgentInfo[]> => normalizeAgents(await callOp<Json>("tb.agents_list", {}));
export const scopesSet = (agent: string, accountId: string, access: AccessLevel | null) =>
  callOp<Json>("tb.scopes_set", { agent, type: "account", id: accountId, access });
