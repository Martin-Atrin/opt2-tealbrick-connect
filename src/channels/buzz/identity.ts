/**
 * One Buzz (Nostr) identity per agent, "as itself" (journey J3, DECISION-LOG C12/C22).
 * - ONE owner action generates keys for every agent of the workspace that has none (all-or-nothing transaction).
 * - The secret key is sealed in `connect_secrets` under `buzz:<agent>`; it is never shown, exported, logged or
 *   returned. There is no import. The owner sees npubs and copies them into Buzz (add agents to channels there).
 * - Rotation replaces the key (the old one is gone). Removing an identity deletes the sealed key.
 * - Optional: publish a kind 0 profile ({name, display_name, about}) to the configured relay over the relay's
 *   HTTP endpoint with NIP-98 auth. During opt2 only to a test relay (C22).
 */


import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { type FetchLike, requestJson } from "../../util/http.ts";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { generateSecretKey, nip98Header, npubEncode, publicKeyOf, signEvent } from "./nostr.ts";

export const RELAY_SETTING = "buzz.relay_url";
const SECRET_PREFIX = "buzz:";
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
  secrets: AppSecrets;
  fetchImpl?: FetchLike;
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

/** `wss://host[:port]` only (no path, query, userinfo); returns the normalized URL. */
export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("relay_url_invalid");
  }
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("relay_url_invalid");
  }
  return `wss://${url.host}`;
}

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

  relayUrl(): string | null {
    const row = this.#d.db.prepare("SELECT value FROM connect_settings WHERE key = ?").get(RELAY_SETTING);
    return row ? String(row.value) : null;
  }

  async setRelayUrl(value: string): Promise<string> {
    const relay = normalizeRelayUrl(value);
    await assertEndpointAllowed(relay, { schemes: ["wss:"], ...this.#policy() });
    this.#d.db
      .prepare(
        `INSERT INTO connect_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(RELAY_SETTING, relay, this.#now());
    return relay;
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
  async relayHttpBase(): Promise<string> {
    const relay = this.relayUrl();
    if (!relay) throw new Error("buzz_relay_missing");
    const base = relay.replace(/^wss:/u, "https:");
    await assertEndpointAllowed(base, { schemes: ["https:"], ...this.#policy() });
    return base;
  }

  /** Publish the agent's kind 0 profile via the relay's HTTP endpoint (`POST https://<relay>/events`, NIP-98). */
  async publishProfile(agent: string, about = "Teal Brick agent"): Promise<BuzzIdentityView> {
    const identity = this.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    const relay = this.relayUrl();
    if (!relay) throw new Error("buzz_relay_missing");
    const httpUrl = `${relay.replace(/^wss:/u, "https:")}/events`;
    await assertEndpointAllowed(httpUrl, { schemes: ["https:"], ...this.#policy() });
    const event = await this.sign(agent, {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: identity.displayName, display_name: identity.displayName, about: about.slice(0, 280) }),
    });
    const body = JSON.stringify(event);
    const secret = await this.#d.secrets.get(`${SECRET_PREFIX}${agent}`);
    if (!secret) throw new Error("buzz_identity_missing");
    const authorization = nip98Header(secret, { url: httpUrl, method: "POST", body, now: Math.floor(this.#now() / 1000) });
    const answer = await requestJson<{ accepted?: boolean; message?: string }>({
      method: "POST",
      url: httpUrl,
      body: event,
      headers: { authorization },
      timeoutMs: 15_000,
      ...(this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {}),
    });
    if (answer?.accepted === false) throw new Error(`buzz_profile_rejected: ${String(answer.message ?? "").slice(0, 200)}`);
    this.#d.db.prepare("UPDATE connect_buzz_identities SET profile_published_at = ? WHERE agent = ?").run(this.#now(), agent);
    const published = this.get(agent);
    if (!published) throw new Error("buzz_identity_missing");
    return published;
  }
}
