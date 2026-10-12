/**
 * One Buzz (Nostr) identity per agent, "as itself" (journey J3, DECISION-LOG C12/C22).
 * - ONE owner action generates keys for every agent of the workspace that has none (all-or-nothing transaction).
 * - The secret key is held in the SDK app secrets (ctx.secrets, C31) under `buzz:<agent>`; it is never shown, exported, logged or
 *   returned. There is no import. The owner sees npubs and copies them into Buzz (add agents to channels there).
 * - Rotation replaces the key (the old one is gone). Removing an identity deletes the sealed key.
 * - Relays (C73): the workspace has an ordered relay list (relays.ts); each agent uses all of them unless the owner
 *   limits it to a subset (table connect_buzz_agent_relays; no row = all workspace relays). The same identity is used
 *   on every relay. Network work (profiles, posts, reads) is in relay.ts.
 */


import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { generateSecretKey, nip98Header, npubEncode, publicKeyOf, signEvent } from "./nostr.ts";
import { BuzzRefusal, MAX_RELAYS, normalizeRelayUrl, type RelayList, workspaceRelayList } from "./relays.ts";

export { normalizeRelayUrl } from "./relays.ts";

const SECRET_PREFIX = "buzz:";
/**
 * Key of the workspace sender identity (C86): the Buzz identity companion APPS send from. Not an agent id (agents are
 * `agt_…`), so it never collides; the owner creates and clears it in Connect → Senders.
 */
export const WORKSPACE_SENDER = "workspace";
const NAME_MAX = 80;

export interface AgentRef {
  id: string;
  name: string;
}

export type BuzzIdentityView = {
  agent: string;
  displayName: string;
  pubkey: string;
  npub: string;
  createdAt: number;
  profilePublishedAt: number | null;
};

export interface BuzzDeps {
  db: Db;
  /** Manifest setting `buzz_relays` (env CONNECT_BUZZ_RELAYS): the ordered relay list (C73). */
  relayUrls?: string | null;
  /** Old manifest setting `buzz_relay_url` (env CONNECT_BUZZ_RELAY_URL): read for one release as the first list entry. */
  relayUrl?: string | null;
  secrets: AppSecrets;
  lookup?: Lookup;
  /** Exact relay origins allowed without the public-address check (test relay). */
  allowRelayOrigins?: readonly string[];
  now?: () => number;
}

function cleanName(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, NAME_MAX);
  return clean || "Agent";
}

function view(row: Record<string, unknown>): BuzzIdentityView {
  const pubkey = String(row.pubkey);
  return {
    agent: String(row.agent),
    displayName: String(row.display_name),
    pubkey,
    npub: npubEncode(pubkey),
    createdAt: Number(row.created_at),
    profilePublishedAt: row.profile_published_at === null ? null : Number(row.profile_published_at),
  };
}

const ensuring = new Map<string, Promise<BuzzIdentityView>>();

export class BuzzIdentities {
  readonly #d: BuzzDeps;

  constructor(deps: BuzzDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Date.now();
  }

  list(): BuzzIdentityView[] {
    return this.#d.db.prepare("SELECT * FROM connect_buzz_identities ORDER BY display_name, agent").all().map(view);
  }

  get(agent: string): BuzzIdentityView | null {
    const row = this.#d.db.prepare("SELECT * FROM connect_buzz_identities WHERE agent = ?").get(agent);
    return row ? view(row) : null;
  }

  /** The one owner action: create identities for every listed agent that has none. Existing identities stay. */
  async generateAll(agents: readonly AgentRef[]): Promise<{ created: BuzzIdentityView[]; existing: BuzzIdentityView[] }> {
    const now = this.#now();
    const fresh = agents.filter((agent) => !this.get(agent.id)).map((agent) => ({ agent, secret: generateSecretKey() }));
    // Seal every key first; the identity rows are then written in one transaction (all agents or none).
    try {
      for (const { agent, secret } of fresh) await this.#d.secrets.put(`${SECRET_PREFIX}${agent.id}`, secret);
      this.#d.db.transaction(() => {
        for (const { agent, secret } of fresh) {
          this.#d.db
            .prepare("INSERT INTO connect_buzz_identities (agent, pubkey, display_name, created_at) VALUES (?, ?, ?, ?)")
            .run(agent.id, publicKeyOf(secret), cleanName(agent.name), now);
        }
      });
    } catch (error) {
      for (const { agent } of fresh) await this.#d.secrets.delete(`${SECRET_PREFIX}${agent.id}`).catch(() => undefined);
      throw error;
    }
    const createdIds = fresh.map((f) => f.agent.id);
    const all = this.list().filter((identity) => agents.some((a) => a.id === identity.agent));
    return {
      created: all.filter((i) => createdIds.includes(i.agent)),
      existing: all.filter((i) => !createdIds.includes(i.agent)),
    };
  }

  /**
   * F20: the identity of one agent (or the workspace sender), created on first use when it has none. Buzz ops call this,
   * so an agent never meets `buzz_identity_missing` and never needs to know an order of calls.
   */
  async ensure(agent: AgentRef): Promise<BuzzIdentityView> {
    const existing = this.get(agent.id);
    if (existing) return existing;
    // One creation per key at a time (one process): two first calls in parallel must not seal two keys.
    const pending = ensuring.get(agent.id);
    if (pending) return pending;
    const run = (async () => {
      const { created, existing: raced } = await this.generateAll([agent]);
      const identity = created[0] ?? raced[0] ?? this.get(agent.id);
      if (!identity) throw new BuzzRefusal("buzz_identity_missing", "Connect could not create a Buzz identity. Try again.", 500);
      return identity;
    })();
    ensuring.set(agent.id, run);
    try {
      return await run;
    } finally {
      ensuring.delete(agent.id);
    }
  }

  async rotate(agent: AgentRef): Promise<BuzzIdentityView> {
    const now = this.#now();
    const secret = generateSecretKey();
    await this.#d.secrets.put(`${SECRET_PREFIX}${agent.id}`, secret);
    this.#d.db.transaction(() => {
      this.#d.db
        .prepare(
          `INSERT INTO connect_buzz_identities (agent, pubkey, display_name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (agent) DO UPDATE SET pubkey = excluded.pubkey, display_name = excluded.display_name,
             created_at = excluded.created_at, profile_published_at = NULL`,
        )
        .run(agent.id, publicKeyOf(secret), cleanName(agent.name), now);
    });
    const rotated = this.get(agent.id);
    if (!rotated) throw new Error("buzz_identity_missing");
    return rotated;
  }

  async remove(agent: string): Promise<void> {
    await this.#d.secrets.delete(`${SECRET_PREFIX}${agent}`);
    this.#d.db.prepare("DELETE FROM connect_buzz_identities WHERE agent = ?").run(agent);
  }

  /** Workspace relays (C73): old `buzz_relay_url` first, then `buzz_relays`; normalised, deduplicated, at most 8. */
  relayList(): RelayList {
    return workspaceRelayList({ list: this.#d.relayUrls ?? null, legacy: this.#d.relayUrl ?? null, ...(this.#d.allowRelayOrigins ? { allowOrigins: this.#d.allowRelayOrigins } : {}) });
  }

  workspaceRelays(): string[] {
    return this.relayList().relays;
  }

  /** First workspace relay (single-relay callers and the old `relay` output field). */
  relayUrl(): string | null {
    return this.workspaceRelays()[0] ?? null;
  }

  /** The owner's subset for one agent, or null = all workspace relays. */
  agentRelaySelection(agent: string): string[] | null {
    const row = this.#d.db.prepare("SELECT relays FROM connect_buzz_agent_relays WHERE agent = ?").get(agent);
    if (!row) return null;
    try {
      const value = JSON.parse(String(row.relays)) as unknown;
      return Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];
    } catch {
      return [];
    }
  }

  /** Owner action: limit an agent to a subset of the workspace relays (null = all relays, also relays added later). */
  setAgentRelays(agent: string, relays: readonly string[] | null): string[] | null {
    if (relays === null) {
      this.#d.db.prepare("DELETE FROM connect_buzz_agent_relays WHERE agent = ?").run(agent);
      return null;
    }
    const workspace = this.workspaceRelays();
    const chosen: string[] = [];
    for (const entry of relays.slice(0, MAX_RELAYS * 2)) {
      let relay: string;
      try {
        relay = normalizeRelayUrl(entry, this.#d.allowRelayOrigins);
      } catch {
        throw new BuzzRefusal("buzz_relay_invalid", "Each relay must be a wss:// address from the workspace relay list.", 400);
      }
      if (!workspace.includes(relay)) throw new BuzzRefusal("buzz_relay_unknown", `${relay} is not in the workspace relay list. Add it in Connect's settings in Portal first.`, 400);
      if (!chosen.includes(relay)) chosen.push(relay);
    }
    if (chosen.length === 0) throw new BuzzRefusal("buzz_relays_empty", "Choose at least one relay, or choose all relays.", 400);
    const ordered = workspace.filter((r) => chosen.includes(r));
    this.#d.db
      .prepare("INSERT INTO connect_buzz_agent_relays (agent, relays, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent) DO UPDATE SET relays = excluded.relays, updated_at = excluded.updated_at")
      .run(agent, JSON.stringify(ordered), this.#now());
    return ordered;
  }

  /**
   * The relays one agent uses now: the workspace list, limited by the owner's subset, optionally narrowed further by the
   * agent's own `relays` argument (only within what it is allowed). Order = workspace order.
   */
  relaysFor(agent: string, requested?: readonly string[]): string[] {
    const workspace = this.workspaceRelays();
    if (workspace.length === 0) throw new BuzzRefusal("buzz_relay_missing", "No Buzz relay is set. The owner sets Buzz relays in Connect's settings in Portal.", 409);
    const selection = this.agentRelaySelection(agent);
    const allowed = selection === null ? workspace : workspace.filter((r) => selection.includes(r));
    if (allowed.length === 0) throw new BuzzRefusal("buzz_relays_none_selected", "None of the relays the owner chose for you is in the workspace relay list. Ask the owner to update your Buzz relays in Connect.", 409);
    if (!requested || requested.length === 0) return allowed;
    const wanted = requested.map((entry) => {
      try {
        return normalizeRelayUrl(entry, this.#d.allowRelayOrigins);
      } catch {
        throw new BuzzRefusal("buzz_relay_invalid", "relays must be wss:// addresses from buzz_identity.", 400);
      }
    });
    const unknown = wanted.find((r) => !allowed.includes(r));
    if (unknown) throw new BuzzRefusal("buzz_relay_not_allowed", `You cannot use ${unknown}. Your relays are listed by buzz_identity.`, 403);
    return allowed.filter((r) => wanted.includes(r));
  }

  #policy(): { allowOrigins?: readonly string[]; lookup?: Lookup } {
    return {
      ...(this.#d.allowRelayOrigins ? { allowOrigins: this.#d.allowRelayOrigins } : {}),
      ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}),
    };
  }

  /** Sign an allowed-kind event as the agent. The secret is opened only inside this call. */
  async sign(agent: string, input: { kind: number; tags: string[][]; content: string }) {
    const secret = await this.#d.secrets.get(`${SECRET_PREFIX}${agent}`);
    if (!secret) throw new Error("buzz_identity_missing");
    return signEvent(secret, { ...input, created_at: Math.floor(this.#now() / 1000) });
  }

  /** NIP-98 Authorization header signed by the agent's key for one relay HTTP request. */
  async authHeader(agent: string, input: { url: string; method: string; body?: string }): Promise<string> {
    const secret = await this.#d.secrets.get(`${SECRET_PREFIX}${agent}`);
    if (!secret) throw new Error("buzz_identity_missing");
    return nip98Header(secret, { ...input, now: Math.floor(this.#now() / 1000) });
  }

  /** Relay HTTP base (`https://<relay host>`), checked against the outbound policy on every use. */
  async relayHttpBase(relay: string | null = this.relayUrl()): Promise<string> {
    if (!relay) throw new BuzzRefusal("buzz_relay_missing", "No Buzz relay is set. The owner sets Buzz relays in Connect's settings in Portal.", 409);
    const base = relay.replace(/^wss:/u, "https:").replace(/^ws:/u, "http:");
    await assertEndpointAllowed(base, { schemes: ["https:"], ...this.#policy() });
    return base;
  }

  markProfilePublished(agent: string): BuzzIdentityView {
    this.#d.db.prepare("UPDATE connect_buzz_identities SET profile_published_at = ? WHERE agent = ?").run(this.#now(), agent);
    const published = this.get(agent);
    if (!published) throw new Error("buzz_identity_missing");
    return published;
  }

  /** Agent removed from the workspace: its relay subset goes too. */
  forgetAgent(agent: string): void {
    this.#d.db.prepare("DELETE FROM connect_buzz_agent_relays WHERE agent = ?").run(agent);
  }
}
